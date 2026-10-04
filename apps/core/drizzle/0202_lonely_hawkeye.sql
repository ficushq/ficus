ALTER TABLE "live_activity_relay_installations" DROP CONSTRAINT "live_activity_relay_installations_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "live_activity_relay_installations" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "live_activity_relay_installations" ADD CONSTRAINT "live_activity_relay_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;