CREATE TABLE "github_relay_deliveries" (
	"connection_id" uuid NOT NULL,
	"repository" varchar(200) NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_relay_deliveries_connection_id_repository_pk" PRIMARY KEY("connection_id","repository")
);
--> statement-breakpoint
ALTER TABLE "github_relay_deliveries" ADD CONSTRAINT "github_relay_deliveries_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;