-- ============================================
-- Migration 0008: IP-based Server Grouping
-- ============================================
-- This migration changes server grouping from hostname-based to IP-based.
-- Multiple hostnames resolving to the same IP will now be treated as one server.

-- 1. Add new columns for hostname tracking
ALTER TABLE servers ADD COLUMN IF NOT EXISTS hostnames jsonb DEFAULT '[]'::jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS primary_hostname varchar(255);

-- 2. Migrate existing data: populate hostnames array from existing hostname values
UPDATE servers
SET
  hostnames = CASE WHEN hostname IS NOT NULL THEN jsonb_build_array(hostname) ELSE '[]'::jsonb END,
  primary_hostname = hostname
WHERE hostnames = '[]'::jsonb;

-- 3. Drop old unique constraint (included hostname)
-- Note: servers_unique was created as a CONSTRAINT, not an index
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_unique;

-- 4. Create new unique constraint (IP + port only)
ALTER TABLE servers ADD CONSTRAINT servers_unique UNIQUE(resolved_ip, port);

-- 5. Apply same changes to scan_queue for consistency
DROP INDEX IF EXISTS idx_scan_queue_unique;
CREATE UNIQUE INDEX idx_scan_queue_unique ON scan_queue(resolved_ip, port);

-- 6. Add index for hostname lookups (to speed up queries by hostname in hostnames array)
CREATE INDEX IF NOT EXISTS idx_servers_hostnames ON servers USING gin(hostnames);
