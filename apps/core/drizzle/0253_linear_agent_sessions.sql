CREATE TABLE "linear_agent_sessions" (
	"id" varchar(200) PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"organization_id" varchar(200) NOT NULL,
	"issue_id" varchar(200),
	"issue_identifier" varchar(100),
	"team_id" varchar(200),
	"url" varchar(2000),
	"root_comment_id" varchar(200),
	"creator_linear_user_id" varchar(200),
	"trigger" varchar(16) NOT NULL,
	"ack_state" varchar(16) DEFAULT 'pending' NOT NULL,
	"disposition" varchar(16) DEFAULT 'pending' NOT NULL,
	"disposition_state" varchar(16) DEFAULT 'pending' NOT NULL,
	"work_stream_id" uuid,
	"primary" boolean DEFAULT false NOT NULL,
	"last_flow_version" integer,
	"last_projected_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_agent_sessions_trigger_check" CHECK ("linear_agent_sessions"."trigger" in ('delegation', 'mention', 'proactive')),
	CONSTRAINT "linear_agent_sessions_ack_state_check" CHECK ("linear_agent_sessions"."ack_state" in ('pending', 'sent', 'failed')),
	CONSTRAINT "linear_agent_sessions_disposition_check" CHECK ("linear_agent_sessions"."disposition" in ('pending', 'bound', 'notified', 'ignored', 'unrouted', 'inaccessible', 'closed')),
	CONSTRAINT "linear_agent_sessions_disposition_state_check" CHECK ("linear_agent_sessions"."disposition_state" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "linear_team_access" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"can_access_all_public_teams" boolean DEFAULT false NOT NULL,
	"team_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" varchar(16) NOT NULL,
	CONSTRAINT "linear_team_access_source_check" CHECK ("linear_team_access"."source" in ('webhook', 'probe'))
);
--> statement-breakpoint
ALTER TABLE "integration_output_trigger_runs" ADD COLUMN "outcome_code" varchar(64);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "delivery_id" varchar(200);--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_team_access" ADD CONSTRAINT "linear_team_access_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_linear_agent_sessions_work_stream" ON "linear_agent_sessions" USING btree ("work_stream_id") WHERE "linear_agent_sessions"."work_stream_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_linear_agent_sessions_connection_issue" ON "linear_agent_sessions" USING btree ("connection_id","issue_id");--> statement-breakpoint
CREATE INDEX "idx_linear_agent_sessions_organization_created" ON "linear_agent_sessions" USING btree ("organization_id","created_at");