CREATE TABLE "decision_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"provider_id" varchar(64),
	"model" varchar(128),
	"latency_ms" integer NOT NULL,
	"input_tokens" integer,
	"cost_nanodollars" integer,
	"cost_estimated" boolean DEFAULT false NOT NULL,
	"input_sha256" varchar(64) NOT NULL,
	"answers" jsonb,
	"errors" jsonb,
	"source" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_decision_log_created_at" ON "decision_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_decision_log_purpose_created_at" ON "decision_log" USING btree ("purpose","created_at");