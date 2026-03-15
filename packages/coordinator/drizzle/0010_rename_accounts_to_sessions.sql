-- ============================================
-- Migration 0010: Rename accounts to sessions
-- ============================================
-- Replace the multi-step Microsoft OAuth "accounts" model with a simpler
-- consumable "sessions" model.  Session tokens are externally provided,
-- validated on import, used until invalid, then auto-removed.
--
-- Changes:
--   1. Rename table accounts -> sessions
--   2. Drop columns no longer needed (refresh_token, type, is_valid,
--      last_validated_at, last_validation_error)
--   3. Add uuid column for Minecraft profile UUID
--   4. Rename FK column in scan_queue (assigned_account_id -> assigned_session_id)
--   5. Rename indexes for clarity

-- 1. Rename table
ALTER TABLE "accounts" RENAME TO "sessions";

-- 2. Drop columns no longer needed
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "refresh_token";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "type";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "is_valid";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "last_validated_at";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "last_validation_error";

-- 3. Add Minecraft profile UUID column
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "uuid" VARCHAR(36);

-- 4. Rename FK column in scan_queue
ALTER TABLE "scan_queue" RENAME COLUMN "assigned_account_id" TO "assigned_session_id";

-- 5. Rename indexes
ALTER INDEX IF EXISTS "idx_accounts_available" RENAME TO "idx_sessions_available";
ALTER INDEX IF EXISTS "idx_accounts_allocation" RENAME TO "idx_sessions_allocation";
