import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

// Default DATABASE_URL for Docker Compose setup
// Uses the postgres service name and defaults from docker-compose.yml
const defaultDatabaseUrl = `postgres://reconmc:${process.env.POSTGRES_PASSWORD || 'reconmc'}@postgres:5432/reconmc`;
const connectionString = process.env.DATABASE_URL || defaultDatabaseUrl;

// Singleton connection pool - created once and reused
let dbInstance: ReturnType<typeof createDb> | null = null;
let poolInstance: pg.Pool | null = null;

export function createDb() {
  // Return existing instance if already created
  if (dbInstance) {
    return dbInstance;
  }

  // Create new pool and drizzle instance
  poolInstance = new pg.Pool({ connectionString });
  dbInstance = drizzle(poolInstance, { schema });

  return dbInstance;
}

/**
 * Close the database connection pool
 * Call this during graceful shutdown
 */
export async function closeDb(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
    dbInstance = null;
  }
}

export type Db = ReturnType<typeof createDb>;
export * from './schema.js';
