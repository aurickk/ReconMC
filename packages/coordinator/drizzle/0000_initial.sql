-- Scan batches (groups of servers to scan)
CREATE TABLE IF NOT EXISTS "batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255),
  "status" varchar(50) DEFAULT 'pending' NOT NULL,
  "total_tasks" integer DEFAULT 0 NOT NULL,
  "completed_tasks" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT NOW() NOT NULL,
  "completed_at" timestamp
);

-- Individual scan tasks
CREATE TABLE IF NOT EXISTS "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid REFERENCES "batches"("id") ON DELETE CASCADE,
  "server_address" varchar(255) NOT NULL,
  "resolved_ip" varchar(45),
  "port" integer DEFAULT 25565 NOT NULL,
  "status" varchar(50) DEFAULT 'pending' NOT NULL,
  "assigned_agent_id" varchar(100),
  "assigned_proxy_id" uuid,
  "assigned_account_id" uuid,
  "result" jsonb,
  "error_message" text,
  "created_at" timestamp DEFAULT NOW() NOT NULL,
  "started_at" timestamp,
  "completed_at" timestamp
);

-- Proxy pool
CREATE TABLE IF NOT EXISTS "proxies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "host" varchar(255) NOT NULL,
  "port" integer NOT NULL,
  "username" varchar(255),
  "password" varchar(255),
  "protocol" varchar(10) DEFAULT 'socks5' NOT NULL,
  "current_usage" integer DEFAULT 0 NOT NULL,
  "max_concurrent" integer DEFAULT 3 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT NOW() NOT NULL
);

-- Account pool
CREATE TABLE IF NOT EXISTS "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" varchar(50) NOT NULL,
  "username" varchar(255),
  "access_token" text,
  "refresh_token" text,
  "current_usage" integer DEFAULT 0 NOT NULL,
  "max_concurrent" integer DEFAULT 3 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT NOW() NOT NULL
);

-- Active agents registry
CREATE TABLE IF NOT EXISTS "agents" (
  "id" varchar(100) PRIMARY KEY NOT NULL,
  "status" varchar(50) DEFAULT 'idle' NOT NULL,
  "current_task_id" uuid REFERENCES "tasks"("id"),
  "last_heartbeat" timestamp DEFAULT NOW() NOT NULL,
  "registered_at" timestamp DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_tasks_status" ON "tasks" ("status");
CREATE INDEX IF NOT EXISTS "idx_tasks_resolved_ip" ON "tasks" ("resolved_ip");
CREATE INDEX IF NOT EXISTS "idx_tasks_batch_id" ON "tasks" ("batch_id");
CREATE INDEX IF NOT EXISTS "idx_proxies_available" ON "proxies" ("is_active", "current_usage") WHERE "current_usage" < "max_concurrent";
CREATE INDEX IF NOT EXISTS "idx_accounts_available" ON "accounts" ("is_active", "current_usage") WHERE "current_usage" < "max_concurrent";
