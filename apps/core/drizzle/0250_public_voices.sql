CREATE TABLE "public_voices" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"base" text NOT NULL,
	"surfaces" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"yaml_template" jsonb,
	"yaml_field_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "public_voice_id" varchar(100);--> statement-breakpoint
ALTER TABLE "squads" ADD COLUMN "public_voice" jsonb;--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_public_voice_id_public_voices_id_fk" FOREIGN KEY ("public_voice_id") REFERENCES "public"."public_voices"("id") ON DELETE set null ON UPDATE no action;