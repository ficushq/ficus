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
ALTER TABLE "github_personal_identities" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_personal_identities" ALTER COLUMN "login" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_personal_identities" ALTER COLUMN "linked_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_identity_proofs" ADD CONSTRAINT "github_identity_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_identity_proof_user" ON "github_identity_proofs" USING btree ("user_id","expires_at");--> statement-breakpoint
ALTER TABLE "github_personal_identities" ADD CONSTRAINT "github_personal_identity_link_tuple" CHECK (("github_personal_identities"."account_id" IS NULL AND "github_personal_identities"."login" IS NULL AND "github_personal_identities"."unlinked_at" IS NOT NULL) OR ("github_personal_identities"."account_id" IS NOT NULL AND "github_personal_identities"."login" IS NOT NULL AND "github_personal_identities"."linked_at" IS NOT NULL));