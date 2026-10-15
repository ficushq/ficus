ALTER TABLE "monitors" ADD COLUMN "restart_policy" varchar(20) DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "restart_limit" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "restart_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "rapid_restart_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "launched_at" timestamp;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "deadline_at" timestamp;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "next_restart_at" timestamp;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_restart_at" timestamp;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_restart_reason" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "log_offset" bigint;