import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  text,
  jsonb,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const proxies = pgTable('proxies', {
  id: uuid('id').primaryKey().defaultRandom(),
  host: varchar('host', { length: 255 }).notNull(),
  port: integer('port').notNull(),
  username: varchar('username', { length: 255 }),
  password: varchar('password', { length: 255 }),
  protocol: varchar('protocol', { length: 10 }).default('socks5').notNull(),
  currentUsage: integer('current_usage').default(0).notNull(),
  maxConcurrent: integer('max_concurrent').default(3).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 50 }).notNull(),
  username: varchar('username', { length: 255 }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  currentUsage: integer('current_usage').default(0).notNull(),
  maxConcurrent: integer('max_concurrent').default(3).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  isValid: boolean('is_valid').default(true).notNull(),
  lastValidatedAt: timestamp('last_validated_at'),
  lastValidationError: text('last_validation_error'),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agents = pgTable('agents', {
  id: varchar('id', { length: 100 }).primaryKey(),
  name: varchar('name', { length: 100 }),
  secret: varchar('secret', { length: 128 }), // Agent authentication secret (hashed)
  status: varchar('status', { length: 50 }).default('idle').notNull(),
  currentQueueId: uuid('current_queue_id').references(() => scanQueue.id),
  lastHeartbeat: timestamp('last_heartbeat').defaultNow().notNull(),
  registeredAt: timestamp('registered_at').defaultNow().notNull(),
});

export const taskLogs = pgTable('task_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  queueId: uuid('queue_id').references(() => scanQueue.id, { onDelete: 'cascade' }),
  agentId: varchar('agent_id', { length: 100 }),
  level: varchar('level', { length: 20 }).default('info').notNull(),
  message: text('message').notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

// IP pool + server history system

export const scanQueue = pgTable('scan_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverAddress: varchar('server_address', { length: 255 }).notNull(),
  hostname: varchar('hostname', { length: 255 }),
  resolvedIp: varchar('resolved_ip', { length: 45 }),
  port: integer('port').default(25565).notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  assignedAgentId: varchar('assigned_agent_id', { length: 100 }),
  assignedProxyId: uuid('assigned_proxy_id').references(() => proxies.id, { onDelete: 'set null' }),
  assignedAccountId: uuid('assigned_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  // Group by resolved IP + port only, not by hostname
  uniqueEntry: unique('idx_scan_queue_unique').on(table.resolvedIp, table.port),
}));

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverAddress: varchar('server_address', { length: 255 }).notNull(),
  hostname: varchar('hostname', { length: 255 }),
  resolvedIp: varchar('resolved_ip', { length: 45 }),
  port: integer('port').default(25565).notNull(),
  hostnames: jsonb('hostnames').default([]).$type<string[]>(), // All discovered hostnames for this IP
  primaryHostname: varchar('primary_hostname', { length: 255 }), // First discovered hostname
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastScannedAt: timestamp('last_scanned_at'),
  scanCount: integer('scan_count').default(0).notNull(),
  latestResult: jsonb('latest_result'),
  scanHistory: jsonb('scan_history').default([]).$type<{ timestamp: string; result: unknown; errorMessage?: string; duration?: number | null; logs?: Array<{ level: string; message: string; timestamp: string }> }[]>(),
}, (table) => ({
  // Group by resolved IP + port only, not by hostname
  // This allows multiple hostnames resolving to the same IP to be treated as one server
  uniqueServer: unique('servers_unique').on(table.resolvedIp, table.port),
}));

export type TaskLog = typeof taskLogs.$inferSelect;
export type NewTaskLog = typeof taskLogs.$inferInsert;
export type Proxy = typeof proxies.$inferSelect;
export type NewProxy = typeof proxies.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type ScanQueue = typeof scanQueue.$inferSelect;
export type NewScanQueue = typeof scanQueue.$inferInsert;
export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
