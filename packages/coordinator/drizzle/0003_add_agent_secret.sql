-- Add secret column to agents table for authentication
-- Stores a hashed secret used to verify agent identity during heartbeats and task claims
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "secret" varchar(128);
