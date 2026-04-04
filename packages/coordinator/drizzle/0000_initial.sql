-- ============================================
-- Combined initial migration (final schema state)
-- ============================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Sessions (authentication tokens)
CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" varchar(255),
  "access_token" text,
  "uuid" varchar(36),
  "current_usage" integer DEFAULT 0 NOT NULL,
  "max_concurrent" integer DEFAULT 3 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT NOW() NOT NULL
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

-- Active agents registry
CREATE TABLE IF NOT EXISTS "agents" (
  "id" varchar(100) PRIMARY KEY NOT NULL,
  "name" varchar(100),
  "secret" varchar(128),
  "status" varchar(50) DEFAULT 'idle' NOT NULL,
  "current_queue_id" uuid,
  "last_heartbeat" timestamp DEFAULT NOW() NOT NULL,
  "registered_at" timestamp DEFAULT NOW() NOT NULL
);

-- Scan queue: IP pool for pending/processing scans
CREATE TABLE IF NOT EXISTS "scan_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "server_address" varchar(255) NOT NULL,
  "hostname" varchar(255),
  "resolved_ip" varchar(45),
  "port" integer DEFAULT 25565 NOT NULL,
  "status" varchar(50) DEFAULT 'pending' NOT NULL,
  "assigned_agent_id" varchar(100),
  "assigned_proxy_id" uuid,
  "assigned_session_id" uuid,
  "error_message" text,
  "retry_count" integer DEFAULT 0,
  "created_at" timestamp DEFAULT NOW(),
  "started_at" timestamp,
  "completed_at" timestamp,
  CONSTRAINT scan_queue_assigned_proxy_id_fkey FOREIGN KEY (assigned_proxy_id) REFERENCES proxies(id) ON DELETE SET NULL,
  CONSTRAINT scan_queue_assigned_session_id_fkey FOREIGN KEY (assigned_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- Servers: persistent server scan history
CREATE TABLE IF NOT EXISTS "servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "server_address" varchar(255) NOT NULL,
  "hostname" varchar(255),
  "resolved_ip" varchar(45),
  "port" integer DEFAULT 25565 NOT NULL,
  "hostnames" jsonb DEFAULT '[]'::jsonb,
  "primary_hostname" varchar(255),
  "first_seen_at" timestamp DEFAULT NOW(),
  "last_scanned_at" timestamp,
  "scan_count" integer DEFAULT 0,
  "latest_result" jsonb,
  "scan_history" jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT servers_unique UNIQUE(hostname, port)
);

-- Task logs for agent output during scans
CREATE TABLE IF NOT EXISTS "task_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "queue_id" uuid REFERENCES "scan_queue"("id") ON DELETE CASCADE,
  "agent_id" varchar(100),
  "level" varchar(20) DEFAULT 'info' NOT NULL,
  "message" text NOT NULL,
  "timestamp" timestamp DEFAULT NOW() NOT NULL
);

-- ============================================
-- Indexes
-- ============================================

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_available ON sessions(is_active, current_usage) WHERE current_usage < max_concurrent;
CREATE INDEX IF NOT EXISTS idx_sessions_allocation ON sessions(current_usage, last_used_at) WHERE is_active = true AND current_usage < max_concurrent;

-- Proxies
CREATE INDEX IF NOT EXISTS idx_proxies_available ON proxies(is_active, current_usage) WHERE current_usage < max_concurrent;
CREATE INDEX IF NOT EXISTS idx_proxies_allocation ON proxies(current_usage, last_used_at) WHERE is_active = true AND current_usage < max_concurrent;

-- Scan queue
CREATE INDEX IF NOT EXISTS idx_scan_queue_status ON scan_queue(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_queue_unique ON scan_queue(hostname, port);
CREATE INDEX IF NOT EXISTS idx_scan_queue_created_at ON scan_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_queue_started_at ON scan_queue(started_at) WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_queue_completed_at ON scan_queue(completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_queue_agent_status ON scan_queue(assigned_agent_id, status) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_queue_pending ON scan_queue(id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scan_queue_processing ON scan_queue(id) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_scan_queue_completed ON scan_queue(id) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_scan_queue_failed ON scan_queue(id) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_scan_queue_stuck_check ON scan_queue(started_at) WHERE status = 'processing';

-- Servers
CREATE INDEX IF NOT EXISTS idx_servers_last_scanned ON servers(last_scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_first_seen ON servers(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_hostnames ON servers USING gin(hostnames);
CREATE INDEX IF NOT EXISTS idx_servers_resolved_ip_port ON servers(resolved_ip, port);
CREATE INDEX IF NOT EXISTS idx_servers_hostname ON servers(hostname);
CREATE INDEX IF NOT EXISTS idx_servers_server_address ON servers(server_address);
CREATE INDEX IF NOT EXISTS idx_servers_hostname_trgm ON servers USING gin(hostname gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_servers_server_address_trgm ON servers USING gin(server_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_servers_resolved_ip_trgm ON servers USING gin(resolved_ip gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_servers_latest_result ON servers USING gin(latest_result) WHERE latest_result IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_servers_online ON servers(last_scanned_at DESC) WHERE (latest_result->>'online')::boolean = true;

-- Task logs
CREATE INDEX IF NOT EXISTS idx_task_logs_queue_timestamp ON task_logs(queue_id, timestamp DESC) WHERE queue_id IS NOT NULL;
