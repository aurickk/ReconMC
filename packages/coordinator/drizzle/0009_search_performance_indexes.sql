-- ============================================
-- Migration 0009: Search Performance Indexes for 180k+ Scale
-- ============================================
-- This migration adds critical indexes for fast server searches
-- and full-text search support for large datasets (180k+ servers)

-- 1. Composite indexes for server lookups (by-address endpoint)
-- These are critical for fast hostname and IP lookups with port
CREATE INDEX IF NOT EXISTS idx_servers_resolved_ip_port ON servers(resolved_ip, port);
CREATE INDEX IF NOT EXISTS idx_servers_hostname ON servers(hostname);
CREATE INDEX IF NOT EXISTS idx_servers_server_address ON servers(server_address);

-- 2. Resource allocation optimization (composite indexes for ORDER BY)
-- These speed up proxy/account selection during queue claiming
DROP INDEX IF EXISTS idx_proxies_last_used;
DROP INDEX IF EXISTS idx_accounts_last_used;
CREATE INDEX IF NOT EXISTS idx_proxies_allocation ON proxies(current_usage, last_used_at)
    WHERE is_active = true AND current_usage < max_concurrent;
CREATE INDEX IF NOT EXISTS idx_accounts_allocation ON accounts(current_usage, last_used_at)
    WHERE is_active = true AND is_valid = true AND current_usage < max_concurrent;

-- 3. Stuck task recovery optimization
-- Speeds up the periodic stuck task check
CREATE INDEX IF NOT EXISTS idx_scan_queue_stuck_check ON scan_queue(started_at)
    WHERE status = 'processing';

-- 4. Enable pg_trgm extension for trigram-based fuzzy search
-- This allows fast partial matching on hostnames and server addresses
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 5. Trigram indexes for fast partial text search
-- These support LIKE '%query%' patterns efficiently
CREATE INDEX IF NOT EXISTS idx_servers_hostname_trgm ON servers USING gin(hostname gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_servers_server_address_trgm ON servers USING gin(server_address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_servers_resolved_ip_trgm ON servers USING gin(resolved_ip gin_trgm_ops);

-- 6. Index on latest_result for JSONB queries (online status, player count, etc.)
CREATE INDEX IF NOT EXISTS idx_servers_latest_result ON servers USING gin(latest_result)
    WHERE latest_result IS NOT NULL;

-- 7. Partial index for online servers (most common query)
CREATE INDEX IF NOT EXISTS idx_servers_online ON servers(last_scanned_at DESC)
    WHERE (latest_result->>'online')::boolean = true;
