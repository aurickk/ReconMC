-- Add name column to agents table
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "name" varchar(100);

-- Generate friendly names for existing agents (Agent 1, Agent 2, etc.)
UPDATE "agents" SET "name" = 'Agent ' || subq.row_num
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY registered_at) as row_num
  FROM "agents"
  WHERE "name" IS NULL
) as subq
WHERE "agents"."id" = subq."id";
