ALTER TABLE "decision_log" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "decision_log" ADD COLUMN "cost_nanodollars" integer;--> statement-breakpoint
ALTER TABLE "decision_log" ADD COLUMN "cost_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_decision_log_purpose_created_at" ON "decision_log" USING btree ("purpose","created_at");