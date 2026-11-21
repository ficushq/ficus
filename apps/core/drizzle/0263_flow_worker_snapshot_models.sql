-- Workflow workers whose participant had no tier were created with the binding
-- snapshot's model copied into model_override, so the agent info tab showed a
-- workflow's model as a user-set "Agent model override". Model resolution now
-- reads that model from the workflow binding, so the copy is redundant: clear it
-- where it still equals the snapshot model. The worker keeps running the same
-- chain. An override someone changed since stays.
UPDATE "agents"
SET "model_override" = NULL, "updated_at" = now()
FROM "workflow_bindings"
WHERE "workflow_bindings"."agent_id" = "agents"."id"
  AND "agents"."model_override" IS NOT NULL
  AND "agents"."tier_override" IS NULL
  AND COALESCE("workflow_bindings"."agent_snapshot"->>'tier', '') = ''
  AND "agents"."model_override" = "workflow_bindings"."agent_snapshot"->>'model';
