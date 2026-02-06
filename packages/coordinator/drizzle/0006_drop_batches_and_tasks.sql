-- Migration 0006: Drop batches and tasks tables
-- This migration removes the old batch-centric task system

-- Add current_queue_id column to agents if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'current_queue_id'
    ) THEN
        ALTER TABLE agents ADD COLUMN current_queue_id uuid;
    END IF;
END $$;

-- Add queue_id column to task_logs if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'task_logs' AND column_name = 'queue_id'
    ) THEN
        ALTER TABLE task_logs ADD COLUMN queue_id uuid;

        -- Add foreign key constraint to scan_queue
        ALTER TABLE task_logs
        ADD CONSTRAINT task_logs_queue_id_fkey
        FOREIGN KEY (queue_id) REFERENCES scan_queue(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Drop the old batches table (CASCADE will drop related tasks and foreign keys)
DROP TABLE IF EXISTS batches CASCADE;

-- Drop the old tasks table (if not already dropped by CASCADE)
DROP TABLE IF EXISTS tasks CASCADE;

-- Drop the old current_task_id column from agents if it still exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'current_task_id'
    ) THEN
        ALTER TABLE agents DROP COLUMN current_task_id;
    END IF;
END $$;

-- Drop the old task_id column from task_logs if it still exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'task_logs' AND column_name = 'task_id'
    ) THEN
        ALTER TABLE task_logs DROP COLUMN task_id;
    END IF;
END $$;

-- Note: scan_queue and servers tables are now the primary tables
-- Agents now use current_queue_id instead of current_task_id
