CREATE TABLE "passkey_enrollment_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"issued_origin" text,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"revoked_at" timestamp,
	"redeemed_origin" text,
	"redeemed_credential_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "passkey_enrollment_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sign_in_origin" text;--> statement-breakpoint
ALTER TABLE "passkey_enrollment_codes" ADD CONSTRAINT "passkey_enrollment_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_passkey_enrollment_codes_user" ON "passkey_enrollment_codes" USING btree ("user_id");