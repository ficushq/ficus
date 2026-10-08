CREATE TABLE "github_feedback_screenings" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"squad_id" uuid NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"decision_version" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"outcome" varchar(32),
	"verdict" jsonb,
	"screened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_feedback_screening_state" CHECK ("github_feedback_screenings"."state" in ('queued', 'running', 'passed', 'held')),
	CONSTRAINT "github_feedback_screening_lease_pair" CHECK (("github_feedback_screenings"."lease_token" is null) = ("github_feedback_screenings"."lease_expires_at" is null)),
	CONSTRAINT "github_feedback_screening_counters" CHECK ("github_feedback_screenings"."attempts" >= 0 AND "github_feedback_screenings"."decision_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" DROP CONSTRAINT "github_feedback_revision_decision";--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" DROP CONSTRAINT "github_feedback_revision_human_decision";--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "github_untrusted_handling" text DEFAULT 'hold' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_feedback_screenings" ADD CONSTRAINT "github_feedback_screenings_revision_id_github_feedback_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."github_feedback_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_feedback_screenings" ADD CONSTRAINT "github_feedback_screenings_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_feedback_screening_due" ON "github_feedback_screenings" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "github_feedback_screening_squad" ON "github_feedback_screenings" USING btree ("squad_id");--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" ADD CONSTRAINT "github_feedback_revision_decision" CHECK ("github_feedback_revisions"."decision" in ('pending', 'allow_once', 'allow_trust', 'deny', 'automatic', 'historical', 'screened'));--> statement-breakpoint
ALTER TABLE "github_feedback_revisions" ADD CONSTRAINT "github_feedback_revision_human_decision" CHECK (("github_feedback_revisions"."decision" in ('allow_once', 'allow_trust', 'deny') AND "github_feedback_revisions"."decided_by_user_id" is not null AND "github_feedback_revisions"."decided_at" is not null) OR ("github_feedback_revisions"."decision" in ('pending', 'automatic', 'historical', 'screened') AND "github_feedback_revisions"."decided_by_user_id" is null AND "github_feedback_revisions"."decided_at" is null));