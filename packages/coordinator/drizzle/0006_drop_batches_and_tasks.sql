-- Migration 0006: Drop batches and tasks tables
-- This migration removes the old batch-centric task system

-- Clear agent references to tasks before dropping foreign key constraint
UPDATE agents SET current_task_id = NULL WHERE current_task_id IS NOT NULL;

-- Clear task_logs references to queue entries (optional cleanup)
DELETE FROM task_logs WHERE queue_id IS NULL AND task_id IS NULL;

-- Drop the old batches table (CASCADE will drop related tasks)
DROP TABLE IF EXISTS batches CASCADE;

-- Drop the old tasks table (if not already dropped by CASCADE)
DROP TABLE IF EXISTS tasks CASCADE;

-- Note: scan_queue and servers tables are now the primary tables
-- Agents now use current_queue_id instead of current_task_id
