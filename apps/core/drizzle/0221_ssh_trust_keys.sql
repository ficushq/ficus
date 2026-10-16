CREATE TABLE "ssh_trust_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"decision_note" text,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_trust_keys_target_id_key_type_public_key_unique" UNIQUE("target_id","key_type","public_key")
);
--> statement-breakpoint
CREATE TABLE "ssh_trust_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"squad_id" text,
	"label" text NOT NULL,
	"ssh_host" text NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"adoption_pending" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp,
	"check_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_trust_targets_scope_unique" UNIQUE("scope")
);
--> statement-breakpoint
ALTER TABLE "ssh_trust_keys" ADD CONSTRAINT "ssh_trust_keys_target_id_ssh_trust_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ssh_trust_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssh_trust_keys_target_idx" ON "ssh_trust_keys" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "ssh_trust_targets_squad_idx" ON "ssh_trust_targets" USING btree ("squad_id");--> statement-breakpoint
-- Endpoints Core already connected to while ssh used accept-new adopt the keys
-- Core already trusts for them (services/ssh-trust) instead of
-- waiting for a person. New endpoints are created later, not adopting.
INSERT INTO "ssh_trust_targets" ("scope", "kind", "label", "ssh_host", "ssh_port", "adoption_pending")
SELECT 'machine:' || "id"::text, CASE WHEN "provider" = 'exe' THEN 'exe-machine' ELSE 'machine' END, 'Machine ' || "name", "ssh_host", "ssh_port", true
FROM "machines"
ON CONFLICT ("scope") DO NOTHING;--> statement-breakpoint
INSERT INTO "ssh_trust_targets" ("scope", "kind", "label", "ssh_host", "ssh_port", "adoption_pending")
SELECT 'exe-api', 'exe-api', 'exe.dev API', 'exe.dev', 22, true
WHERE EXISTS (SELECT 1 FROM "machines" WHERE "provider" = 'exe')
ON CONFLICT ("scope") DO NOTHING;--> statement-breakpoint
INSERT INTO "ssh_trust_targets" ("scope", "kind", "squad_id", "label", "ssh_host", "ssh_port", "adoption_pending")
SELECT DISTINCT 'memory-git:' || s."id"::text || ':' || h.host, 'memory-git', s."id"::text, 'Memory sync (' || h.host || ')', h.host, 22, true
FROM "squads" s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(s."metadata"->'memory'->'sync'->'providers') = 'array'
    THEN s."metadata"->'memory'->'sync'->'providers' ELSE '[]'::jsonb END
) AS p(provider)
CROSS JOIN LATERAL (
  SELECT lower(coalesce(
    substring(p.provider->>'repoUrl' from '^git@([A-Za-z0-9_.-]+):'),
    substring(p.provider->>'repoUrl' from '^ssh://([A-Za-z0-9_.-]+)/')
  )) AS host
) AS h
WHERE p.provider->>'type' = 'git' AND h.host IS NOT NULL
ON CONFLICT ("scope") DO NOTHING;
