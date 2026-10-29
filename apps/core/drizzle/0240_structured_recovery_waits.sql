CREATE TABLE "recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recovery_id" uuid NOT NULL,
	"execution_id" uuid,
	"invocation_id" varchar(256) NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"restart_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_attempt_once" UNIQUE("recovery_id","invocation_id")
);
--> statement-breakpoint
CREATE TABLE "recovery_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recovery_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"agent_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_decision_once" UNIQUE("recovery_id","version")
);
--> statement-breakpoint
CREATE TABLE "recovery_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"execution_id" uuid,
	"work_stream_id" uuid,
	"flow_attempt_id" integer,
	"operation_key" varchar(128) NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"wait_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_version_nonnegative" CHECK ("recovery_episodes"."version" >= 0),
	CONSTRAINT "recovery_budget_valid" CHECK (("recovery_episodes"."state"->>'managerCycles')::integer BETWEEN 0 AND 1 AND ("recovery_episodes"."state"->>'cycleFailures')::integer BETWEEN 0 AND 3)
);
--> statement-breakpoint
-- Bound locks on the existing high-traffic tables while adding the column and foreign keys.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "work_stream_waits" ADD COLUMN "structured" jsonb;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_recovery_id_recovery_episodes_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."recovery_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_decisions" ADD CONSTRAINT "recovery_decisions_recovery_id_recovery_episodes_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."recovery_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_decisions" ADD CONSTRAINT "recovery_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_decisions" ADD CONSTRAINT "recovery_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_episodes" ADD CONSTRAINT "recovery_episodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_episodes" ADD CONSTRAINT "recovery_episodes_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_episodes" ADD CONSTRAINT "recovery_episodes_wait_id_work_stream_waits_id_fk" FOREIGN KEY ("wait_id") REFERENCES "public"."work_stream_waits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_recovery_active_operation" ON "recovery_episodes" USING btree ("agent_id","operation_key") WHERE "recovery_episodes"."state"->>'state' <> 'resolved';--> statement-breakpoint
CREATE INDEX "idx_recovery_stream" ON "recovery_episodes" USING btree ("work_stream_id");