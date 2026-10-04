CREATE TABLE "live_activity_relay_installations" (
	"activation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"state_enc" text NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_activity_relay_installations" ADD CONSTRAINT "live_activity_relay_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_activity_relay_due_idx" ON "live_activity_relay_installations" USING btree ("next_attempt_at");