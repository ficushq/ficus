ALTER TABLE "retained_assets" ADD COLUMN "cleanup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retained_assets" ADD COLUMN "cleanup_retry_at" timestamp;--> statement-breakpoint
ALTER TABLE "retained_assets" ADD COLUMN "cleanup_failed_at" timestamp;--> statement-breakpoint
ALTER TABLE "retained_assets" ADD COLUMN "cleanup_error" varchar(200);