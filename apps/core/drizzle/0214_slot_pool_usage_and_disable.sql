ALTER TYPE "public"."slot_notification_kind" ADD VALUE 'pool_disabled';--> statement-breakpoint
ALTER TABLE "slot_notifications" ALTER COLUMN "claim_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD COLUMN "waiter_id" uuid;--> statement-breakpoint
ALTER TABLE "slot_pools" ADD COLUMN "usage" text;--> statement-breakpoint
ALTER TABLE "slot_pools" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD CONSTRAINT "slot_notifications_waiter_id_slot_waiters_id_fk" FOREIGN KEY ("waiter_id") REFERENCES "public"."slot_waiters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD CONSTRAINT "slot_notifications_subject" CHECK (("slot_notifications"."kind"::text = 'pool_disabled' AND "slot_notifications"."waiter_id" IS NOT NULL AND "slot_notifications"."claim_id" IS NULL) OR ("slot_notifications"."kind"::text <> 'pool_disabled' AND "slot_notifications"."claim_id" IS NOT NULL AND "slot_notifications"."waiter_id" IS NULL));--> statement-breakpoint
ALTER TABLE "slot_pools" ADD CONSTRAINT "slot_pools_usage_length" CHECK (char_length("slot_pools"."usage") <= 1000);