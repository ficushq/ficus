CREATE TABLE "known_hosts_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squad_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"host" text NOT NULL,
	"key_type" text NOT NULL,
	"box_key" text NOT NULL,
	"box_fingerprint" text NOT NULL,
	"core_key" text NOT NULL,
	"core_fingerprint" text NOT NULL,
	"box_line" integer NOT NULL,
	"wildcard" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_user_id" text,
	CONSTRAINT "known_hosts_conflicts_sandbox_id_host_key_type_box_key_core_key_unique" UNIQUE("sandbox_id","host","key_type","box_key","core_key")
);
--> statement-breakpoint
CREATE TABLE "remote_host_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
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
	CONSTRAINT "remote_host_keys_host_id_key_type_public_key_unique" UNIQUE("host_id","key_type","public_key")
);
--> statement-breakpoint
ALTER TABLE "remote_hosts" ADD COLUMN "host_key_adoption_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_hosts" ADD COLUMN "host_key_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "remote_hosts" ADD COLUMN "host_key_check_error" text;--> statement-breakpoint
ALTER TABLE "remote_host_keys" ADD CONSTRAINT "remote_host_keys_host_id_remote_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."remote_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "known_hosts_conflicts_squad_idx" ON "known_hosts_conflicts" USING btree ("squad_id");--> statement-breakpoint
CREATE INDEX "remote_host_keys_host_idx" ON "remote_host_keys" USING btree ("host_id");--> statement-breakpoint
-- Hosts registered before host keys were pinned adopt their keys from existing trust
-- (remote-hosts/host-key-adoption.ts) instead of waiting for a person to confirm a scan.
UPDATE "remote_hosts" SET "host_key_adoption_pending" = true;
