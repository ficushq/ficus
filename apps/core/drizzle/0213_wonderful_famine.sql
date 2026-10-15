ALTER TABLE "decision_log" ADD COLUMN "tier" varchar(32);--> statement-breakpoint
ALTER TABLE "decision_log" ADD COLUMN "output_tokens" integer;