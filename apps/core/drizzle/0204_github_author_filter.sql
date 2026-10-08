-- Squads that exist at rollout keep their current GitHub routing (filter OFF); new squads default ON.
ALTER TABLE "squads" ADD COLUMN "github_author_filter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "squads" ALTER COLUMN "github_author_filter" SET DEFAULT true;
