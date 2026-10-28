CREATE TABLE "integration_credential_retirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"iv" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "squad_env_detections" (
	"squad_id" uuid PRIMARY KEY NOT NULL,
	"content_hash" varchar(64),
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "env_detection_bootstrapped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "squad_env_detections" ADD CONSTRAINT "squad_env_detections_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_credential_retirements_expiry_idx" ON "integration_credential_retirements" USING btree ("expires_at");