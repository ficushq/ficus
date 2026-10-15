ALTER TABLE "squads" ALTER COLUMN "consultant_idle_dormancy_days" SET DEFAULT 30;--> statement-breakpoint
-- Idle-consultant dormancy becomes on by default. Until now null meant both "never configured" and "off", so every
-- unset squad starts at the 30-day default; squads with their own number keep it. From here on null means the squad
-- turned it off in Squad Settings, and the column default (above) covers new squads.
-- Rollout: many consultants become eligible at once; the lifecycle sweep makes at most 10 dormant per minute.
-- Rollback: the previous Core treats any non-null value as on, so squads stay on at 30 until set to off.
UPDATE "squads" SET "consultant_idle_dormancy_days" = 30 WHERE "consultant_idle_dormancy_days" IS NULL;
