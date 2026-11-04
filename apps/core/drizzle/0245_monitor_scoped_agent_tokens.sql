ALTER TABLE "agent_tokens" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "monitor_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;