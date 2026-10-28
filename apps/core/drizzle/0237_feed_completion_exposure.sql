CREATE TABLE "feed_completion_views" (
	"user_id" uuid NOT NULL,
	"work_stream_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_completion_views_user_id_work_stream_id_completed_at_pk" PRIMARY KEY("user_id","work_stream_id","completed_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "feed_updates_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_completion_views" ADD CONSTRAINT "feed_completion_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_completion_views" ADD CONSTRAINT "feed_completion_views_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Preserve the old client's last known visit once. Never advance this boundary again:
-- row receipts, rather than a high-water mark, acknowledge all subsequent exposure.
UPDATE "users" SET "feed_updates_after" = "last_feed_visit_at";
