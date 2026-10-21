ALTER TABLE "managed_bigbrain_vaults" ADD COLUMN "read_sync_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "managed_bigbrain_vaults" ADD COLUMN "read_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_bigbrain_vaults" ADD COLUMN "read_sync_next_at" timestamp with time zone;