import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

// Default DATABASE_URL for Docker Compose setup
// Uses the postgres service name and defaults from docker-compose.yml
const defaultDatabaseUrl = `postgres://reconmc:${process.env.POSTGRES_PASSWORD || 'reconmc'}@postgres:5432/reconmc`;
const connectionString = process.env.DATABASE_URL || defaultDatabaseUrl;

export function createDb() {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from './schema.js';
