CREATE TABLE "linear_activity_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"scope_key" varchar(220) NOT NULL,
	"session_id" varchar(200),
	"work_stream_id" uuid,
	"projection_key" varchar(400) NOT NULL,
	"activity_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"collapsible" boolean DEFAULT false NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_activity_outbox_kind_check" CHECK ("linear_activity_outbox"."kind" in ('activity', 'session_update', 'attachment')),
	CONSTRAINT "linear_activity_outbox_status_check" CHECK ("linear_activity_outbox"."status" in ('pending', 'sending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "linear_question_mirrors" (
	"question_id" uuid PRIMARY KEY NOT NULL,
	"session_id" varchar(200) NOT NULL,
	"activity_id" uuid NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_question_mirrors_state_check" CHECK ("linear_question_mirrors"."state" in ('open', 'answered_in_linear', 'answered_in_ficus', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "user_linear_identities" (
	"user_id" uuid NOT NULL,
	"organization_id" varchar(200) NOT NULL,
	"linear_user_id" varchar(200) NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_linear_identities_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" DROP CONSTRAINT "integration_auth_receipts_purpose_context";--> statement-breakpoint
ALTER TABLE "integration_oauth_states" DROP CONSTRAINT "integration_oauth_states_purpose_context";--> statement-breakpoint
ALTER TABLE "integration_oauth_states" DROP CONSTRAINT "integration_oauth_states_authority_flow_check";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "answer_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD COLUMN "projection_attempt_floor" integer;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD COLUMN "auth_link_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_activity_outbox" ADD CONSTRAINT "linear_activity_outbox_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_activity_outbox" ADD CONSTRAINT "linear_activity_outbox_session_id_linear_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."linear_agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_activity_outbox" ADD CONSTRAINT "linear_activity_outbox_work_stream_id_work_streams_id_fk" FOREIGN KEY ("work_stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_question_mirrors" ADD CONSTRAINT "linear_question_mirrors_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_question_mirrors" ADD CONSTRAINT "linear_question_mirrors_session_id_linear_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."linear_agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_linear_identities" ADD CONSTRAINT "user_linear_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_linear_activity_outbox_projection" ON "linear_activity_outbox" USING btree ("connection_id","scope_key","projection_key");--> statement-breakpoint
CREATE INDEX "idx_linear_activity_outbox_due" ON "linear_activity_outbox" USING btree ("next_attempt_at") WHERE "linear_activity_outbox"."status" IN ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "idx_linear_activity_outbox_sent" ON "linear_activity_outbox" USING btree ("connection_id","sent_at");--> statement-breakpoint
CREATE INDEX "idx_linear_activity_outbox_session" ON "linear_activity_outbox" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "idx_linear_activity_outbox_work_stream" ON "linear_activity_outbox" USING btree ("work_stream_id");--> statement-breakpoint
CREATE INDEX "idx_linear_activity_outbox_retention" ON "linear_activity_outbox" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_linear_question_mirrors_session" ON "linear_question_mirrors" USING btree ("session_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_linear_identities_linear_user" ON "user_linear_identities" USING btree ("organization_id","linear_user_id");--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_purpose_context" CHECK (("integration_authorization_flow_receipts"."purpose" = 'integration' AND "integration_authorization_flow_receipts"."link_generation" IS NULL) OR ("integration_authorization_flow_receipts"."purpose" = 'github_identity' AND "integration_authorization_flow_receipts"."provider_key" = 'github' AND "integration_authorization_flow_receipts"."intent" = 'connect' AND "integration_authorization_flow_receipts"."link_generation" IS NOT NULL AND "integration_authorization_flow_receipts"."link_generation" >= 0) OR ("integration_authorization_flow_receipts"."purpose" = 'linear_identity' AND "integration_authorization_flow_receipts"."provider_key" = 'linear' AND "integration_authorization_flow_receipts"."intent" = 'connect' AND "integration_authorization_flow_receipts"."link_generation" IS NULL));--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_purpose_context" CHECK (("integration_oauth_states"."purpose" = 'integration' AND "integration_oauth_states"."link_generation" IS NULL) OR ("integration_oauth_states"."purpose" = 'github_identity' AND "integration_oauth_states"."provider_key" = 'github' AND "integration_oauth_states"."intent" = 'connect' AND "integration_oauth_states"."link_generation" IS NOT NULL AND "integration_oauth_states"."link_generation" >= 0) OR ("integration_oauth_states"."purpose" = 'linear_identity' AND "integration_oauth_states"."provider_key" = 'linear' AND "integration_oauth_states"."intent" = 'connect' AND "integration_oauth_states"."link_generation" IS NULL));--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_authority_flow_check" CHECK (("integration_oauth_states"."authority" = 'local' AND (("integration_oauth_states"."purpose" IN ('integration', 'linear_identity') AND "integration_oauth_states"."local_flow_id" IS NULL) OR ("integration_oauth_states"."purpose" = 'github_identity' AND "integration_oauth_states"."local_flow_id" IS NOT NULL))) OR ("integration_oauth_states"."authority" = 'platform_broker' AND "integration_oauth_states"."local_flow_id" IS NOT NULL));