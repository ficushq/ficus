CREATE TABLE "agent_secret_exposures" (
	"agent_id" uuid NOT NULL,
	"squad_id" uuid,
	"secret_key" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_secret_exposures_agent_id_secret_key_unique" UNIQUE("agent_id","secret_key")
);
--> statement-breakpoint
ALTER TABLE "agent_secret_exposures" ADD CONSTRAINT "agent_secret_exposures_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secret_exposures" ADD CONSTRAINT "agent_secret_exposures_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_secret_exposures_agent_idx" ON "agent_secret_exposures" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_secret_exposures_secret_key_idx" ON "agent_secret_exposures" USING btree ("secret_key");