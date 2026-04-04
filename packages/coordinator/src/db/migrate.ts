import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use the same default DATABASE_URL as db/index.ts for Docker Compose setup consistency
const defaultDatabaseUrl = `postgres://reconmc:${process.env.POSTGRES_PASSWORD || 'reconmc'}@postgres:5432/reconmc`;
const connectionString = process.env.DATABASE_URL || defaultDatabaseUrl;

/**
 * Track which migrations have been applied
 */
interface MigrationRecord {
  filename: string;
  applied_at: Date;
}

/**
 * Run all pending database migrations in order
 * Migrations are applied atomically and tracked in a _migrations table
 */
export async function runMigrations(): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    // Create migrations tracking table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "filename" varchar(255) PRIMARY KEY,
        "applied_at" timestamp DEFAULT NOW() NOT NULL
      );
    `);

    // Get all migration files in order
    const migrationsDir = join(__dirname, '../../drizzle');
    const migrationFiles = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // Get already applied migrations
    const { rows: appliedRows } = await pool.query<MigrationRecord>(
      'SELECT filename FROM "_migrations" ORDER BY filename'
    );
    const appliedFilenames = new Set(appliedRows.map(r => r.filename));

    // Run pending migrations
    for (const file of migrationFiles) {
      if (appliedFilenames.has(file)) {
        continue; // Skip already applied migrations
      }

      logger.info(`[Coordinator] Applying migration: ${file}`);
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');

      try {
        await pool.query('BEGIN');
        await pool.query(sql);
        // Mark migration as applied
        await pool.query('INSERT INTO "_migrations" (filename) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        logger.info(`[Coordinator] Migration applied successfully: ${file}`);
      } catch (error) {
        await pool.query('ROLLBACK');
        logger.error(`[Coordinator] Migration failed: ${file}`, error);
        throw error;
      }
    }

    logger.info('[Coordinator] Database migrations up to date');
  } finally {
    await pool.end();
  }
}
