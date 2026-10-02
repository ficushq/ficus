ALTER TABLE "integration_audit_events" ADD COLUMN "actor_key" text;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD COLUMN "target_kind" varchar(64);--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD COLUMN "target_id" text;