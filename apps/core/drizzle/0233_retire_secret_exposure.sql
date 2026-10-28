CREATE TABLE "sandbox_exposure_cleanup" (
	"target_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"squad_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "agent_secret_exposures" CASCADE;--> statement-breakpoint
DROP TABLE "global_secret_exposures" CASCADE;--> statement-breakpoint
DROP TABLE "squad_secret_exposures" CASCADE;--> statement-breakpoint
CREATE INDEX "sandbox_exposure_cleanup_retry_idx" ON "sandbox_exposure_cleanup" USING btree ("status","next_attempt_at");