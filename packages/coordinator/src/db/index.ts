import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const defaultDatabaseUrl = `postgres://reconmc:${process.env.POSTGRES_PASSWORD || 'reconmc'}@postgres:5432/reconmc`;
const connectionString = process.env.DATABASE_URL || defaultDatabaseUrl;

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let poolInstance: pg.Pool | null = null;

export function createDb() {
  if (!dbInstance) {
    poolInstance = new pg.Pool({ connectionString });
    dbInstance = drizzle(poolInstance, { schema });
  }
  return dbInstance;
}

export function closeDb(): Promise<void> {
  if (poolInstance) {
    const p = poolInstance.end();
    poolInstance = null;
    dbInstance = null;
    return p;
  }
  return Promise.resolve();
}

export type Db = ReturnType<typeof createDb>;
export * from './schema.js';
