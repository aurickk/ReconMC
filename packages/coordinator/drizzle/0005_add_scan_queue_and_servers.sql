-- Migration 0005: Add scan_queue and servers tables
-- This migration adds the new IP pool and server history tables

-- scan_queue table: IP pool for pending/processing scans
CREATE TABLE "scan_queue" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_address varchar(255) NOT NULL,
  hostname varchar(255),
  resolved_ip varchar(45),
  port integer DEFAULT 25565 NOT NULL,
  status varchar(50) DEFAULT 'pending' NOT NULL,
  assigned_agent_id varchar(100),
  assigned_proxy_id uuid,
  assigned_account_id uuid,
  error_message text,
  retry_count integer DEFAULT 0,
  created_at timestamp DEFAULT NOW(),
  started_at timestamp,
  completed_at timestamp,
  CONSTRAINT scan_queue_assigned_proxy_id_fkey FOREIGN KEY (assigned_proxy_id) REFERENCES proxies(id) ON DELETE SET NULL,
  CONSTRAINT scan_queue_assigned_account_id_fkey FOREIGN KEY (assigned_account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

-- Index for fast status queries
CREATE INDEX idx_scan_queue_status ON scan_queue(status);

-- Unique constraint to prevent duplicate scans for same server
CREATE UNIQUE INDEX idx_scan_queue_unique ON scan_queue(resolved_ip, port, hostname);

-- servers table: Persistent server scan history
CREATE TABLE "servers" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_address varchar(255) NOT NULL,
  hostname varchar(255),
  resolved_ip varchar(45),
  port integer DEFAULT 25565 NOT NULL,
  first_seen_at timestamp DEFAULT NOW(),
  last_scanned_at timestamp,
  scan_count integer DEFAULT 0,
  latest_result jsonb,
  scan_history jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT servers_unique UNIQUE(resolved_ip, port, hostname)
);

-- Index for sorting by last scan time
CREATE INDEX idx_servers_last_scanned ON servers(last_scanned_at DESC);
