ALTER TABLE "integration_connections" ADD COLUMN "authorization_kind" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_authorization_kind_check" CHECK ("integration_connections"."authorization_kind" in ('manual', 'oauth2'));--> statement-breakpoint
-- Backfill: every connection of an OAuth2 plugin (github, notion) and every Slack connection installed through
-- the platform broker ("Add to Slack") holds OAuth material. Everything else, including manually entered Slack
-- apps, stays 'manual'. Re-runnable: a second run matches nothing new.
UPDATE "integration_connections" SET "authorization_kind" = 'oauth2'
WHERE "authorization_kind" <> 'oauth2'
  AND ("provider_key" IN ('github', 'notion') OR ("provider_key" = 'slack' AND "client_authority" = 'platform_broker'));
