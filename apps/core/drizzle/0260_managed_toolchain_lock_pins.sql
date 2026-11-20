CREATE TABLE "managed_toolchain_lock_pins" (
	"squad_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"lock_content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_toolchain_lock_pins_squad_id_fingerprint_pk" PRIMARY KEY("squad_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "managed_toolchain_lock_pins" ADD CONSTRAINT "managed_toolchain_lock_pins_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;