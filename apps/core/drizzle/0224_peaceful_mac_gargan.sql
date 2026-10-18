CREATE TABLE "local_deployment_alias_releases" (
	"alias" varchar(63) PRIMARY KEY NOT NULL,
	"local_deployment_id" uuid NOT NULL,
	"released_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_deployments" ADD COLUMN "alias" varchar(63);--> statement-breakpoint
CREATE UNIQUE INDEX "local_deployments_alias_uniq" ON "local_deployments" USING btree ("alias");