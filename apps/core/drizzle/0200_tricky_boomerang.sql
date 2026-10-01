ALTER TABLE "executions" ADD COLUMN "latest_text" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "latest_text_at" timestamp with time zone;