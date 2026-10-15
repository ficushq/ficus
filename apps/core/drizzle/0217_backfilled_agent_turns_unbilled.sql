-- Agent turns imported by the one-time ledger backfill bill $0. Their cost was the session's list-price estimate
-- from pi, counted as billed even when a ChatGPT/Codex or Claude Code subscription paid for the turn. Their list
-- cost is kept, so they still count in the preview without subscriptions and in call and token totals. No row is
-- deleted. Re-runnable: a second run matches nothing.
-- Per-call rows: the backfill's agent turns carry the dedupe keys exec:<executionId> and agent-gap:<agentId>.
-- Decision rows (decision_log:<id>) keep their billing and cost.
UPDATE "inference_usage" SET "cost_nanodollars" = 0
WHERE "billing" = 'unknown' AND "feature" = 'agent-turn' AND "cost_nanodollars" <> 0
  AND ("dedupe_key" LIKE 'exec:%' OR "dedupe_key" LIKE 'agent-gap:%');--> statement-breakpoint
-- Daily rollups have no dedupe key. The backfill's agent turns are the only agent turns without a provider and
-- with unknown billing that bill anything: a live turn with unknown billing has no list price, so it bills $0.
UPDATE "inference_usage_daily" SET "cost_nanodollars" = 0
WHERE "billing" = 'unknown' AND "feature" = 'agent-turn' AND "provider" IS NULL AND "cost_nanodollars" <> 0;
