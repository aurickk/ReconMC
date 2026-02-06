-- Task logs table for storing agent output during scans
CREATE TABLE IF NOT EXISTS "task_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE CASCADE NOT NULL,
  "agent_id" varchar(100),
  "level" varchar(20) DEFAULT 'info' NOT NULL,
  "message" text NOT NULL,
  "timestamp" timestamp DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_task_logs_task_id" ON "task_logs" ("task_id");
