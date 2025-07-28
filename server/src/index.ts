import "dotenv/config";
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { query, initializeTables } from './db';
import { parse } from 'csv-parse';
import { createReadStream } from 'fs';
import { analyzeTable } from './tableAnalyzer';
import { processQuery } from './process-query';

// Helper functions
function isValidDate(value: string): boolean {
  const date = new Date(value);
  return date instanceof Date && !isNaN(date.getTime()) && 
         (value.includes('-') || value.includes('/'));
}

function guessSqlType(values: any[]): string {
  let hasText = false;
  let hasTimestamp = false;
  let hasNumeric = false;
  let hasInteger = false;

  for (const value of values) {
    if (value === null || value === undefined) continue;
    
    if (typeof value === 'string' && isValidDate(value)) {
      hasTimestamp = true;
    } else if (!isNaN(value) && value.toString().includes('.')) {
      hasNumeric = true;
    } else if (!isNaN(value)) {
      hasInteger = true;
    } else {
      hasText = true;
      break; // Text is most general, no need to check further
    }
  }

  if (hasText) return 'TEXT';
  if (hasTimestamp) return 'TIMESTAMP';
  if (hasNumeric) return 'NUMERIC';
  if (hasInteger) return 'INTEGER';
  return 'TEXT';
}

function normalizeColumnName(column: string): string {
  const reservedKeywords = ['user', 'group', 'order', 'select', 'where', 'from', 'table', 'column'];
  let normalized = column.trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    
  // If it's a reserved keyword, append '1'
  if (reservedKeywords.includes(normalized.toLowerCase())) {
    normalized += '1';
  }
  
  return normalized;
}

function validateTableName(tableName: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(tableName);
}

function validateColumnNames(columns: string[]): boolean {
  return columns.every(column => /^[a-zA-Z0-9_]+$/.test(column));
}

function validateFilePath(filePath: string, uploadDir: string): boolean {
  const resolvedUploadDir = path.resolve(uploadDir);
  const resolvedFilePath = path.resolve(filePath);
  const relative = path.relative(resolvedUploadDir, resolvedFilePath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Table operation locks to prevent race conditions using proper mutex
interface TableMutex {
  locked: boolean;
  queue: Array<() => void>;
}

const tableMutexes = new Map<string, TableMutex>();

async function acquireTableLock(tableName: string): Promise<() => void> {
  if (!tableMutexes.has(tableName)) {
    tableMutexes.set(tableName, { locked: false, queue: [] });
  }
  
  const mutex = tableMutexes.get(tableName)!;
  
  if (!mutex.locked) {
    mutex.locked = true;
    return () => {
      mutex.locked = false;
      const next = mutex.queue.shift();
      if (next) {
        next();
      } else if (mutex.queue.length === 0) {
        tableMutexes.delete(tableName);
      }
    };
  }
  
  return new Promise<() => void>((resolve) => {
    mutex.queue.push(() => {
      mutex.locked = true;
      resolve(() => {
        mutex.locked = false;
        const next = mutex.queue.shift();
        if (next) {
          next();
        } else if (mutex.queue.length === 0) {
          tableMutexes.delete(tableName);
        }
      });
    });
  });
}

async function insertBatch(records: any[], columns: string[], originalColumns: string[], tableName: string): Promise<void> {
  const values: any[] = [];
  const placeholders: string[] = [];
  
  records.forEach((record, batchIndex) => {
    const recordValues = originalColumns.map(c => record[c]);
    values.push(...recordValues);
    const recordPlaceholders = columns.map((_, colIndex) => 
      `$${batchIndex * columns.length + colIndex + 1}`
    ).join(', ');
    placeholders.push(`(${recordPlaceholders})`);
  });
  
  const insertSQL = `
    INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
    VALUES ${placeholders.join(', ')}
  `;
  
  await query(insertSQL, values);
}

async function startServer() {
  // Initialize database tables
  await initializeTables();

  const app = express();
  app.use(cors());
  const upload = multer({ dest: 'uploads/' });

  app.post('/upload-csv', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const tableName = req.body.tableName;
      if (!tableName) {
        return res.status(400).json({ error: 'Table name is required' });
      }

      // Validate table name to prevent SQL injection
      if (!validateTableName(tableName)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      // Validate file path to prevent path traversal
      const uploadDir = 'uploads';
      if (!validateFilePath(req.file.path, uploadDir)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      // Acquire table lock to prevent race conditions
      const releaseLock = await acquireTableLock(tableName);
      
      try {
        // Streaming CSV processing with reduced memory usage
        const csvStream = createReadStream(req.file.path);
        const parser = parse({
          columns: true,
          skip_empty_lines: true
        });

        // Add error handling for parser
        parser.on('error', (err) => {
          console.error('CSV parser error:', err);
          throw new Error('Invalid or corrupted CSV file');
        });

        const sampleRows: any[] = [];
        const columnSamples = new Map<string, any[]>();
        let batchRecords: any[] = [];
        let isInitialized = false;
        let columns: string[] = [];
        let originalColumns: string[] = [];
        let recordCount = 0;
        const batchSize = 500; // Increased batch size for better performance
        const sampleSize = 100; // Increased sample size for better schema inference
        
        try {
          for await (const record of csvStream.pipe(parser)) {
            recordCount++;
            
            // Collect sample rows for schema inference (increased from 10 to 100)
            if (sampleRows.length < sampleSize) {
              sampleRows.push(record);
              
              // Collect samples for each column
              Object.keys(record).forEach(key => {
                if (!columnSamples.has(key)) {
                  columnSamples.set(key, []);
                }
                columnSamples.get(key)!.push(record[key]);
              });
            }
            
            // Initialize table after collecting enough samples
            if (sampleRows.length === sampleSize && !isInitialized) {
              originalColumns = Object.keys(sampleRows[0]);
              columns = originalColumns.map(normalizeColumnName);
              
              // Validate column names to prevent SQL injection
              if (!validateColumnNames(columns)) {
                return res.status(400).json({ error: 'Invalid column names detected' });
              }
              
              if (columns.length === 0) {
                return res.status(400).json({ error: 'CSV file has no columns' });
              }

              // Determine column types from sample data using multiple rows
              const columnTypes = new Map<string, string>();
              originalColumns.forEach((originalColumn, index) => {
                const column = columns[index];
                const samples = columnSamples.get(originalColumn) || [];
                columnTypes.set(column, guessSqlType(samples));
              });

              // Drop existing table if it exists (done only once)
              await query(`DROP TABLE IF EXISTS "${tableName}"`);

              // Create new table with quoted identifiers (done only once)
              const createTableSQL = `
                CREATE TABLE "${tableName}" (
                  ${columns.map(column => `"${column}" ${columnTypes.get(column)}`).join(',\n')}
                )
              `;
              console.log(createTableSQL);
              await query(createTableSQL);
              isInitialized = true;
            }
            
            // Add record to batch only after table is initialized or if still sampling
            if (isInitialized || sampleRows.length < sampleSize) {
              batchRecords.push(record);
            }
            
            // Process batch when it reaches batch size
            if (batchRecords.length >= batchSize && isInitialized) {
              await insertBatch(batchRecords, columns, originalColumns, tableName);
              batchRecords = []; // Clear batch to reduce memory usage
            }
          }
        } catch (err) {
          console.error('Error reading CSV:', err);
          return res.status(400).json({ error: 'Invalid or corrupted CSV file' });
        }

        // Handle case where we have fewer than sampleSize rows but still need to initialize
        if (!isInitialized && sampleRows.length > 0) {
          originalColumns = Object.keys(sampleRows[0]);
          columns = originalColumns.map(normalizeColumnName);
          
          // Validate column names to prevent SQL injection
          if (!validateColumnNames(columns)) {
            return res.status(400).json({ error: 'Invalid column names detected' });
          }
          
          if (columns.length === 0) {
            return res.status(400).json({ error: 'CSV file has no columns' });
          }

          // Determine column types from available sample data
          const columnTypes = new Map<string, string>();
          originalColumns.forEach((originalColumn, index) => {
            const column = columns[index];
            const samples = columnSamples.get(originalColumn) || [];
            columnTypes.set(column, guessSqlType(samples));
          });

          // Drop existing table if it exists (done only once)
          await query(`DROP TABLE IF EXISTS "${tableName}"`);

          // Create new table with quoted identifiers (done only once)
          const createTableSQL = `
            CREATE TABLE "${tableName}" (
              ${columns.map(column => `"${column}" ${columnTypes.get(column)}`).join(',\n')}
            )
          `;
          console.log(createTableSQL);
          await query(createTableSQL);
          isInitialized = true;
        }

        if (recordCount === 0) {
          return res.status(400).json({ error: 'CSV file is empty' });
        }

        if (!isInitialized || columns.length === 0) {
          return res.status(400).json({ error: 'Failed to initialize table - CSV may be invalid' });
        }

        // Insert remaining records in batch
        if (batchRecords.length > 0) {
          await insertBatch(batchRecords, columns, originalColumns, tableName);
        }

        // After successful upload, analyze the table and store the results
        const analysis = await analyzeTable(tableName);
        
        // Store the analysis in TABLE_SCHEMA with safe table name handling
        // tableName is already validated with validateTableName function
        const safeTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
        await query(
          `INSERT INTO TABLE_SCHEMA (table_name, analysis)
           VALUES ($1, $2)
           ON CONFLICT (table_name) 
           DO UPDATE SET 
             analysis = $2,
             updated_at = CURRENT_TIMESTAMP`,
          [safeTableName, analysis]
        );

        res.json({ 
          message: 'CSV data successfully imported to database',
          tableName,
          recordCount,
          columnCount: columns.length,
          analysis
        });
      } finally {
        // Always release the table lock
        releaseLock();
      }
    } catch (error) {
      console.error('Error processing CSV:', error);
      res.status(500).json({ error: 'Failed to process CSV file' });
    }
  });

  app.post('/query', express.json(), async (req, res) => {
    try {
      const { message } = req.body;
      
      // Validate message parameter
      if (typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({ error: 'Invalid query message' });
      }
      
      // Process the query using our new function
      const result = await processQuery(message);
      
      res.json(result);
    } catch (error) {
      console.error('Error processing query:', error);
      res.status(500).json({ error: 'Failed to process query' });
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Start the server and handle any errors
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
}); 