ALTER TYPE "public"."slot_notification_kind" ADD VALUE 'expiring';--> statement-breakpoint
ALTER TABLE "slot_notifications" ADD COLUMN "claim_expires_at" timestamp with time zone;