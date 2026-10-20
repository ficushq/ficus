CREATE TABLE "managed_bigbrain_vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"connection_id" uuid,
	"upstream_vault_id" uuid,
	"state" varchar(16) DEFAULT 'requested' NOT NULL,
	"read_access" varchar(16) DEFAULT 'pending' NOT NULL,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"applied_generation" integer DEFAULT 0 NOT NULL,
	"operation_id" uuid,
	"create_request_id" uuid NOT NULL,
	"create_request_hash" varchar(64) NOT NULL,
	"last_error_code" varchar(64),
	"retryable" boolean DEFAULT false NOT NULL,
	"platform_updated_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_bigbrain_vaults_state_check" CHECK ("managed_bigbrain_vaults"."state" in ('requested', 'provisioning', 'ready', 'degraded', 'failed', 'deleting', 'deleted')),
	CONSTRAINT "managed_bigbrain_vaults_read_access_check" CHECK ("managed_bigbrain_vaults"."read_access" in ('pending', 'active', 'revoked')),
	CONSTRAINT "managed_bigbrain_vaults_generation_check" CHECK ("managed_bigbrain_vaults"."desired_generation" >= 1 and "managed_bigbrain_vaults"."applied_generation" >= 0 and "managed_bigbrain_vaults"."applied_generation" <= "managed_bigbrain_vaults"."desired_generation")
);
--> statement-breakpoint
ALTER TABLE "managed_bigbrain_vaults" ADD CONSTRAINT "managed_bigbrain_vaults_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_bigbrain_vaults" ADD CONSTRAINT "managed_bigbrain_vaults_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_bigbrain_vaults" ADD CONSTRAINT "managed_bigbrain_vaults_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_managed_bigbrain_vaults_create_request" ON "managed_bigbrain_vaults" USING btree ("create_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_managed_bigbrain_vaults_connection" ON "managed_bigbrain_vaults" USING btree ("connection_id") WHERE "managed_bigbrain_vaults"."connection_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_managed_bigbrain_vaults_live_display_name" ON "managed_bigbrain_vaults" USING btree ("display_name") WHERE "managed_bigbrain_vaults"."state" <> 'deleted';