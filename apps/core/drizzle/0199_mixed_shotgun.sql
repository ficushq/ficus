ALTER TABLE "work_stream_waits" ADD COLUMN "actor" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD COLUMN "actor_changes" jsonb;