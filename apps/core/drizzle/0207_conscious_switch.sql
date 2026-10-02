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
ALTER TABLE "github_output_proofs" ADD CONSTRAINT "github_output_proofs_event_id_integration_output_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_output_proofs" ADD CONSTRAINT "github_output_proofs_source_event_id_integration_output_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."integration_output_events"("id") ON DELETE cascade ON UPDATE no action;