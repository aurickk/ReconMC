-- Add validation fields to accounts table
-- These fields support Microsoft account validation during account addition

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "username" varchar(255),
  ADD COLUMN IF NOT EXISTS "is_valid" boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "last_validated_at" timestamp,
  ADD COLUMN IF NOT EXISTS "last_validation_error" text;

-- Update index for available accounts to include validation status
DROP INDEX IF EXISTS "idx_accounts_available";
CREATE INDEX "idx_accounts_available" ON "accounts" ("is_active", "is_valid", "current_usage") WHERE "current_usage" < "max_concurrent";
