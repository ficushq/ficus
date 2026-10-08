CREATE TABLE "github_feedback_decisions" (
	"request_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"squad_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"decision_version" integer NOT NULL,
	"action" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_feedback_decisions_request_id_revision_id_pk" PRIMARY KEY("request_id","revision_id"),
	CONSTRAINT "github_feedback_decision_hashes" CHECK ("github_feedback_decisions"."content_hash" ~ '^[0-9a-f]{64}$' AND "github_feedback_decisions"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_feedback_decision_action" CHECK ("github_feedback_decisions"."action" in ('allow_once', 'deny', 'allow_trust')),
	CONSTRAINT "github_feedback_decision_version" CHECK ("github_feedback_decisions"."decision_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "github_feedback_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"object_kind" text NOT NULL,
	"native_id" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"current_revision_id" uuid,
	"provider_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_feedback_object_identity" UNIQUE("squad_id","repository_id","object_kind","native_id"),
	CONSTRAINT "github_feedback_object_sequence" CHECK ("github_feedback_objects"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "github_feedback_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid NOT NULL,
	"squad_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"normalization_version" integer DEFAULT 1 NOT NULL,
	"envelope" jsonb,
	"byte_count" integer NOT NULL,
	"author" jsonb,
	"editor" jsonb,
	"attribution" text NOT NULL,
	"provider_version" text,
	"routing_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decision_version" integer DEFAULT 0 NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"release_state" text DEFAULT 'held' NOT NULL,
	"reason" varchar(64),
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_feedback_revision_sequence" UNIQUE("object_id","sequence"),
	CONSTRAINT "github_feedback_revision_hash" CHECK ("github_feedback_revisions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_feedback_revision_sequence_positive" CHECK ("github_feedback_revisions"."sequence" > 0 AND "github_feedback_revisions"."normalization_version" > 0),
	CONSTRAINT "github_feedback_revision_counters" CHECK ("github_feedback_revisions"."decision_version" >= 0 AND "github_feedback_revisions"."byte_count" >= 0 AND "github_feedback_revisions"."attempts" >= 0),
	CONSTRAINT "github_feedback_revision_attribution" CHECK ("github_feedback_revisions"."attribution" in ('creation', 'verified_edit', 'unknown')),
	CONSTRAINT "github_feedback_revision_decision" CHECK ("github_feedback_revisions"."decision" in ('pending', 'allow_once', 'allow_trust', 'deny', 'automatic', 'historical')),
	CONSTRAINT "github_feedback_revision_release_state" CHECK ("github_feedback_revisions"."release_state" in ('held', 'ready', 'retry', 'retained', 'delivered', 'obsolete')),
	CONSTRAINT "github_feedback_revision_human_decision" CHECK (("github_feedback_revisions"."decision" in ('allow_once', 'allow_trust', 'deny') AND "github_feedback_revisions"."decided_by_user_id" is not null AND "github_feedback_revisions"."decided_at" is not null) OR ("github_feedback_revisions"."decision" in ('pending', 'automatic', 'historical') AND "github_feedback_revisions"."decided_by_user_id" is null AND "github_feedback_revisions"."decided_at" is null)),
	CONSTRAINT "github_feedback_revision_lease_pair" CHECK (("github_feedback_revisions"."lease_token" is null) = ("github_feedback_revisions"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "github_feedback_sources" (
	"revision_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"squad_id" uuid NOT NULL,
	"authority" jsonb NOT NULL,
	"transport_key" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_feedback_sources_revision_id_event_id_pk" PRIMARY KEY("revision_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "github_identity_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"flow_key" varchar(64) NOT NULL,
	"generation" integer NOT NULL,
	"account_id" text NOT NULL,
	"login" varchar(100) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "github_identity_proofs_flow_key_unique" UNIQUE("flow_key"),
	CONSTRAINT "github_identity_proof_generation" CHECK ("github_identity_proofs"."generation" >= 0),
	CONSTRAINT "github_identity_proof_flow_hash" CHECK ("github_identity_proofs"."flow_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_identity_proof_account_id" CHECK ("github_identity_proofs"."account_id" ~ '^[1-9][0-9]{0,15}$' AND "github_identity_proofs"."account_id"::numeric <= 9007199254740991),
	CONSTRAINT "github_identity_proof_lifetime" CHECK ("github_identity_proofs"."expires_at" > "github_identity_proofs"."verified_at")
);
--> statement-breakpoint
CREATE TABLE "github_output_proofs" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"source_event_id" uuid NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"effect_hash" varchar(64) NOT NULL,
	"authority_hash" varchar(64) NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_personal_identities" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"host" text DEFAULT 'github.com' NOT NULL,
	"account_id" text,
	"login" varchar(100),
	"generation" integer DEFAULT 0 NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now(),
	"unlinked_at" timestamp with time zone,
	CONSTRAINT "github_personal_identity_host" CHECK ("github_personal_identities"."host" = 'github.com'),
	CONSTRAINT "github_personal_identity_account_id" CHECK ("github_personal_identities"."account_id" ~ '^[1-9][0-9]{0,15}$' AND "github_personal_identities"."account_id"::numeric <= 9007199254740991),
	CONSTRAINT "github_personal_identity_generation" CHECK ("github_personal_identities"."generation" >= 0),
	CONSTRAINT "github_personal_identity_link_tuple" CHECK (("github_personal_identities"."account_id" IS NULL AND "github_personal_identities"."login" IS NULL AND "github_personal_identities"."unlinked_at" IS NOT NULL) OR ("github_personal_identities"."account_id" IS NOT NULL AND "github_personal_identities"."login" IS NOT NULL AND "github_personal_identities"."linked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "github_trusted_authors" (
	"squad_id" uuid NOT NULL,
	"host" text DEFAULT 'github.com' NOT NULL,
	"account_id" text NOT NULL,
	"login" varchar(100) NOT NULL,
	"account_type" text NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_trusted_authors_squad_id_host_account_id_pk" PRIMARY KEY("squad_id","host","account_id"),
	CONSTRAINT "github_trusted_author_host" CHECK ("github_trusted_authors"."host" = 'github.com'),
	CONSTRAINT "github_trusted_author_account_id" CHECK ("github_trusted_authors"."account_id" ~ '^[1-9][0-9]{0,15}$' AND "github_trusted_authors"."account_id"::numeric <= 9007199254740991),
	CONSTRAINT "github_trusted_author_type" CHECK ("github_trusted_authors"."account_type" in ('User', 'Bot'))
);
--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" DROP CONSTRAINT "integration_auth_receipts_install_terminal_exclusive";--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" DROP CONSTRAINT "integration_auth_receipts_obligation_disposition";--> statement-breakpoint
ALTER TABLE "integration_oauth_states" DROP CONSTRAINT "integration_oauth_states_authority_flow_check";--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD COLUMN "actor_key" text;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD COLUMN "target_kind" varchar(64);--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD COLUMN "purpose" text DEFAULT 'integration' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD COLUMN "link_generation" integer;--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD COLUMN "identity_proof_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD COLUMN "identity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD COLUMN "purpose" text DEFAULT 'integration' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD COLUMN "link_generation" integer;--> statement-breakpoint
ALTER TABLE "github_feedback_objects" ADD CONSTRAINT "github_feedback_objects_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_objects" ADD CONSTRAINT "github_feedback_objects_current_revision_id_github_feedback_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."github_feedback_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" ADD CONSTRAINT "github_feedback_revisions_object_id_github_feedback_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."github_feedback_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" ADD CONSTRAINT "github_feedback_revisions_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_sources" ADD CONSTRAINT "github_feedback_sources_revision_id_github_feedback_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."github_feedback_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_sources" ADD CONSTRAINT "github_feedback_sources_event_id_integration_output_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_sources" ADD CONSTRAINT "github_feedback_sources_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_identity_proofs" ADD CONSTRAINT "github_identity_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_output_proofs" ADD CONSTRAINT "github_output_proofs_event_id_integration_output_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_output_proofs" ADD CONSTRAINT "github_output_proofs_source_event_id_integration_output_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_personal_identities" ADD CONSTRAINT "github_personal_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_trusted_authors" ADD CONSTRAINT "github_trusted_authors_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_feedback_decision_squad_created" ON "github_feedback_decisions" USING btree ("squad_id","created_at");--> statement-breakpoint
CREATE INDEX "github_feedback_revision_pending" ON "github_feedback_revisions" USING btree ("squad_id","decision","first_observed_at","id");--> statement-breakpoint
CREATE INDEX "github_feedback_revision_release" ON "github_feedback_revisions" USING btree ("release_state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "github_feedback_source_event" ON "github_feedback_sources" USING btree ("squad_id","event_id");--> statement-breakpoint
CREATE INDEX "github_identity_proof_user" ON "github_identity_proofs" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_personal_identity_active_account" ON "github_personal_identities" USING btree ("host","account_id") WHERE "github_personal_identities"."unlinked_at" is null;--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_purpose_context" CHECK (("integration_authorization_flow_receipts"."purpose" = 'integration' AND "integration_authorization_flow_receipts"."link_generation" IS NULL) OR ("integration_authorization_flow_receipts"."purpose" = 'github_identity' AND "integration_authorization_flow_receipts"."provider_key" = 'github' AND "integration_authorization_flow_receipts"."intent" = 'connect' AND "integration_authorization_flow_receipts"."link_generation" IS NOT NULL AND "integration_authorization_flow_receipts"."link_generation" >= 0));--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_connection_purpose" CHECK ("integration_authorization_flow_receipts"."purpose" = 'integration' OR ("integration_authorization_flow_receipts"."install_kind" IS NULL AND "integration_authorization_flow_receipts"."installed_connection_id" IS NULL AND "integration_authorization_flow_receipts"."installed_material_revision" IS NULL));--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_identity_result" CHECK (("integration_authorization_flow_receipts"."identity_proof_id" IS NULL AND "integration_authorization_flow_receipts"."identity_verified_at" IS NULL) OR ("integration_authorization_flow_receipts"."purpose" = 'github_identity' AND "integration_authorization_flow_receipts"."identity_proof_id" IS NOT NULL AND "integration_authorization_flow_receipts"."identity_verified_at" IS NOT NULL AND "integration_authorization_flow_receipts"."staging_started_at" IS NOT NULL AND "integration_authorization_flow_receipts"."adapter_version" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_install_terminal_exclusive" CHECK ("integration_authorization_flow_receipts"."terminal_at" IS NULL OR ("integration_authorization_flow_receipts"."installed_at" IS NULL AND "integration_authorization_flow_receipts"."identity_verified_at" IS NULL));--> statement-breakpoint
ALTER TABLE "integration_authorization_flow_receipts" ADD CONSTRAINT "integration_auth_receipts_obligation_disposition" CHECK (("integration_authorization_flow_receipts"."revocation_required_at" IS NULL AND "integration_authorization_flow_receipts"."cleanup_required_at" IS NULL) OR "integration_authorization_flow_receipts"."terminal_at" IS NOT NULL OR "integration_authorization_flow_receipts"."installed_at" IS NOT NULL OR "integration_authorization_flow_receipts"."identity_verified_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_purpose_context" CHECK (("integration_oauth_states"."purpose" = 'integration' AND "integration_oauth_states"."link_generation" IS NULL) OR ("integration_oauth_states"."purpose" = 'github_identity' AND "integration_oauth_states"."provider_key" = 'github' AND "integration_oauth_states"."intent" = 'connect' AND "integration_oauth_states"."link_generation" IS NOT NULL AND "integration_oauth_states"."link_generation" >= 0));--> statement-breakpoint
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_authority_flow_check" CHECK (("integration_oauth_states"."authority" = 'local' AND (("integration_oauth_states"."purpose" = 'integration' AND "integration_oauth_states"."local_flow_id" IS NULL) OR ("integration_oauth_states"."purpose" = 'github_identity' AND "integration_oauth_states"."local_flow_id" IS NOT NULL))) OR ("integration_oauth_states"."authority" = 'platform_broker' AND "integration_oauth_states"."local_flow_id" IS NOT NULL));