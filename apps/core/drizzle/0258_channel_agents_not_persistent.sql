-- Channel consultants were created with persist=true so dormant retention could
-- never terminate them, which also kept them from ever going dormant. Retention
-- now reclaims a channel-bound agent's storage instead of terminating it, so
-- they no longer need persist: idle dormancy applies to them like any consultant.
-- Same predicate as channelBoundAgentSql (entities/agent-queries.ts).
UPDATE "agents"
SET "persist" = false, "updated_at" = now()
WHERE "persist" = true
  AND "agent_type_id" = 'consultant'
  AND "parent_agent_id" IS NULL
  AND "context"->'channelInstance'->>'id' IS NOT NULL;
