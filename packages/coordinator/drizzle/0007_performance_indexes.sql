-- ============================================
-- Migration 0007: Performance Indexes for 1k-100k Scale
-- ============================================

-- 1. Time-based indexes for scan_queue ordering
CREATE INDEX IF NOT EXISTS idx_scan_queue_created_at ON scan_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_queue_started_at ON scan_queue(started_at) WHERE started_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scan_queue_completed_at ON scan_queue(completed_at DESC) WHERE completed_at IS NOT NULL;

-- 2. Agent-specific queue lookups (composite index)
CREATE INDEX IF NOT EXISTS idx_scan_queue_agent_status ON scan_queue(assigned_agent_id, status)
    WHERE assigned_agent_id IS NOT NULL;

-- 3. Task logs by queue item (for log retrieval)
CREATE INDEX IF NOT EXISTS idx_task_logs_queue_timestamp ON task_logs(queue_id, timestamp DESC)
    WHERE queue_id IS NOT NULL;

-- 4. Servers by first_seen (for sorting by discovery date)
CREATE INDEX IF NOT EXISTS idx_servers_first_seen ON servers(first_seen_at DESC);

-- 5. Partial indexes for status-based counts
CREATE INDEX IF NOT EXISTS idx_scan_queue_pending ON scan_queue(id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scan_queue_processing ON scan_queue(id) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_scan_queue_completed ON scan_queue(id) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_scan_queue_failed ON scan_queue(id) WHERE status = 'failed';

-- 6. Proxy/account allocation optimization
-- Add last_used_at for resource rotation (complementing existing partial indexes)
CREATE INDEX IF NOT EXISTS idx_proxies_last_used ON proxies(last_used_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_accounts_last_used ON accounts(last_used_at) WHERE is_active = true;
