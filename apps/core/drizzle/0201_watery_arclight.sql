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
CREATE TABLE "github_personal_identities" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"host" text DEFAULT 'github.com' NOT NULL,
	"account_id" text NOT NULL,
	"login" varchar(100) NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	CONSTRAINT "github_personal_identity_host" CHECK ("github_personal_identities"."host" = 'github.com'),
	CONSTRAINT "github_personal_identity_account_id" CHECK ("github_personal_identities"."account_id" ~ '^[1-9][0-9]{0,15}$' AND "github_personal_identities"."account_id"::numeric <= 9007199254740991),
	CONSTRAINT "github_personal_identity_generation" CHECK ("github_personal_identities"."generation" >= 0)
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
ALTER TABLE "github_feedback_objects" ADD CONSTRAINT "github_feedback_objects_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_objects" ADD CONSTRAINT "github_feedback_objects_current_revision_id_github_feedback_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."github_feedback_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" ADD CONSTRAINT "github_feedback_revisions_object_id_github_feedback_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."github_feedback_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" ADD CONSTRAINT "github_feedback_revisions_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_sources" ADD CONSTRAINT "github_feedback_sources_revision_id_github_feedback_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."github_feedback_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_sources" ADD CONSTRAINT "github_feedback_sources_event_id_integration_output_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_sources" ADD CONSTRAINT "github_feedback_sources_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_personal_identities" ADD CONSTRAINT "github_personal_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_trusted_authors" ADD CONSTRAINT "github_trusted_authors_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_feedback_decision_squad_created" ON "github_feedback_decisions" USING btree ("squad_id","created_at");--> statement-breakpoint
CREATE INDEX "github_feedback_revision_pending" ON "github_feedback_revisions" USING btree ("squad_id","decision","first_observed_at","id");--> statement-breakpoint
CREATE INDEX "github_feedback_revision_release" ON "github_feedback_revisions" USING btree ("release_state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "github_feedback_source_event" ON "github_feedback_sources" USING btree ("squad_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_personal_identity_active_account" ON "github_personal_identities" USING btree ("host","account_id") WHERE "github_personal_identities"."unlinked_at" is null;