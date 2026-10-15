CREATE TABLE "inference_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feature" varchar(64) NOT NULL,
	"provider" varchar(64),
	"model" varchar(128),
	"account_id" varchar(64),
	"billing" varchar(16) DEFAULT 'unknown' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"units" jsonb,
	"cost_nanodollars" bigint DEFAULT 0 NOT NULL,
	"list_cost_nanodollars" bigint,
	"cost_estimated" boolean DEFAULT false NOT NULL,
	"squad_id" uuid,
	"work_stream_id" uuid,
	"attempt_id" integer,
	"step_id" varchar(100),
	"agent_id" uuid,
	"execution_id" uuid,
	"parent_agent_id" uuid,
	"parent_execution_id" uuid,
	"user_id" uuid,
	"source" jsonb,
	"dedupe_key" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_usage_billing_valid" CHECK ("inference_usage"."billing" IN ('api', 'subscription', 'self-hosted', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "inference_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"feature" varchar(64) NOT NULL,
	"provider" varchar(64),
	"model" varchar(128),
	"account_id" varchar(64),
	"billing" varchar(16) NOT NULL,
	"squad_id" uuid,
	"work_stream_id" uuid,
	"agent_id" uuid,
	"user_id" uuid,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_nanodollars" bigint DEFAULT 0 NOT NULL,
	"list_cost_nanodollars" bigint DEFAULT 0 NOT NULL,
	"list_unknown_calls" integer DEFAULT 0 NOT NULL,
	"estimated_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_inference_usage_occurred_at" ON "inference_usage" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_squad_occurred" ON "inference_usage" USING btree ("squad_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_work_stream_occurred" ON "inference_usage" USING btree ("work_stream_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_agent_occurred" ON "inference_usage" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_execution" ON "inference_usage" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inference_usage_dedupe_key" ON "inference_usage" USING btree ("dedupe_key") WHERE "inference_usage"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_inference_usage_daily_day" ON "inference_usage_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_daily_squad_day" ON "inference_usage_daily" USING btree ("squad_id","day");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_daily_work_stream_day" ON "inference_usage_daily" USING btree ("work_stream_id","day");--> statement-breakpoint
CREATE INDEX "idx_inference_usage_daily_agent_day" ON "inference_usage_daily" USING btree ("agent_id","day");