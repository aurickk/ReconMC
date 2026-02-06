import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  text,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const batches = pgTable('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  totalTasks: integer('total_tasks').default(0).notNull(),
  completedTasks: integer('completed_tasks').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'cascade' }),
  serverAddress: varchar('server_address', { length: 255 }).notNull(),
  resolvedIp: varchar('resolved_ip', { length: 45 }),
  port: integer('port').default(25565).notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  assignedAgentId: varchar('assigned_agent_id', { length: 100 }),
  assignedProxyId: uuid('assigned_proxy_id'),
  assignedAccountId: uuid('assigned_account_id'),
  result: jsonb('result'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

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
  currentTaskId: uuid('current_task_id').references(() => tasks.id),
  lastHeartbeat: timestamp('last_heartbeat').defaultNow().notNull(),
  registeredAt: timestamp('registered_at').defaultNow().notNull(),
});

export const taskLogs = pgTable('task_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  agentId: varchar('agent_id', { length: 100 }),
  level: varchar('level', { length: 20 }).default('info').notNull(),
  message: text('message').notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export type TaskLog = typeof taskLogs.$inferSelect;
export type NewTaskLog = typeof taskLogs.$inferInsert;

export const batchesRelations = relations(batches, ({ many }) => ({
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  batch: one(batches),
}));

export type Batch = typeof batches.$inferSelect;
export type NewBatch = typeof batches.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Proxy = typeof proxies.$inferSelect;
export type NewProxy = typeof proxies.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
