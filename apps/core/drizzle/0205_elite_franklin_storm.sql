CREATE TABLE "decision_eval_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_name" varchar(64) NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"request" jsonb NOT NULL,
	"context" jsonb,
	"expected" jsonb NOT NULL,
	"model_answers" jsonb,
	"summary" text NOT NULL,
	"source" jsonb,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_decision_eval_candidates_status_created_at" ON "decision_eval_candidates" USING btree ("status","created_at");