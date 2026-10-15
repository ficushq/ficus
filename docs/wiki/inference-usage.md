# Inference usage and spend

Every model call Ficus makes on the server is recorded in one ledger, written through one helper. Settings → Spend reads it.

- Code: `apps/core/src/services/inference-usage/` (ledger, pricing, billing, subscriptions, queries, retention, backfill), `apps/core/src/routes/spend.ts`, `apps/web/src/components/settings/spend/`.
- Shared types, the feature registry and the price tables: `packages/shared/src/inference-usage.ts`.

## Recording a feature's cost

One call, after the provider answers:

```ts
import { recordInferenceUsage } from '../services/inference-usage'

recordInferenceUsage({
  feature: 'my-feature', // an id from INFERENCE_FEATURES
  provider: 'openai',
  model: 'gpt-x',
  accountId: 'openai-services', // the provider account, when known
  tokens: { input, output, cacheRead, cacheWrite },
  attribution: { squadId, agentId, workStreamId, userId },
})
```

- It is synchronous and never throws: billing, pricing and the insert happen in the background, and a failed write is logged.
- Add the feature id to `INFERENCE_FEATURES` in `packages/shared/src/inference-usage.ts` so the viewer can name it. Use `<prefix>:<purpose>` for families (`decision:<purpose>`, `lite:<purpose>`).
- Pass `listCostUsd` when you already know the list price (pi's `usage.cost.total`). Otherwise the ledger looks it up: pi's model registry, then `SERVICE_PRICES` for transcription, embeddings and TTS.
- Pass `units: { audioSeconds | characters | images }` for services billed by something other than tokens.
- Set `tokensEstimated: true` when the provider did not report usage. The row is then marked as an estimate.
- Tests: `setInferenceUsageSinkForTest(sink)` captures events without a database, and `await flushInferenceUsage()` waits for pending writes.

Features built on an agent session need nothing extra. `AgentSession.create` records every assistant message and every compaction summary. Name the feature and attribution with the `usage` option:

```ts
AgentSession.create({ ..., usage: { feature: 'my-feature', attribution: () => ({ userId }) } })
```

Without it, a session's calls count as `agent-turn` for its `storage.agentId`.

## What is recorded where

| Path                                                   | Feature                               | Where                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Agent turns (every runner)                             | `agent-turn`                          | Session hook: one row per assistant message, so failover counts against the model that answered                          |
| pi compaction (threshold, overflow, manual `/compact`) | `compaction`                          | Session hook, on `compaction_end`                                                                                        |
| Pre-compaction bakes, fit-fallback summaries           | `precompaction`, `compaction`         | `onSummarized` in `precompaction/baker.ts`. A bake pi later uses is not counted again (its `usage` object is remembered) |
| Decision models                                        | `decision:<purpose>`                  | `decide()` and `recordProviderAnswer` (answered calls). `decision_log` still keeps answers                               |
| Lite tier (`completeWithTier`)                         | `lite:<purpose>`                      | `light-completion-runtime.ts`: one row per candidate that reached a provider                                             |
| AI extract, TTS speech rewrite                         | `ai-extract`, `tts-reformat`          | Session hook                                                                                                             |
| TTS synthesis (Google)                                 | `tts`                                 | `routes/tts.ts`, by characters                                                                                           |
| Transcription (Whisper)                                | `transcription`                       | `routes/transcribe.ts`, by audio seconds (`verbose_json` duration)                                                       |
| Memory embeddings                                      | `embedding:index`, `embedding:search` | `EmbeddingService`                                                                                                       |

Realtime voice is not recorded yet: its usage happens in the browser.

Attribution: agent turns carry the agent, its execution, squad, workflow step (work stream, attempt, step), the dispatching agent and execution for subagents, and the person whose message the agent is working on. Rows have no foreign keys, so spend survives deleting agents, squads and work streams. The viewer shows deleted ones as "Deleted (id)".

## Billing and pricing

`billing` says how a call was paid for. It comes from the account that served the call (`billing.ts`):

| Account                                                       | Billing                           | Billed per call | List price kept |
| ------------------------------------------------------------- | --------------------------------- | --------------- | --------------- |
| API key                                                       | `api`                             | list price      | yes             |
| OAuth sign-in (ChatGPT/Codex, Copilot, ...) and Claude Code   | `subscription`                    | $0              | yes             |
| OpenAI-compatible endpoint, a free self-hosted decision model | `self-hosted`                     | $0              | no              |
| No stored account (environment key)                           | `api` when priced, else `unknown` | list price      | yes             |

`cost_nanodollars` is what was billed and `list_cost_nanodollars` is the same call at list price. Claude Code is priced as Anthropic's model of the same name, so its list price is real even though the bridge reports $0.

## Subscriptions

A subscription account's calls bill $0. Its monthly fee shows as its own line item in the period's total, so a month's total is what was actually paid.

- **Prices**: `SUBSCRIPTION_PLANS` holds the default monthly prices of well-known Claude and ChatGPT plans. An admin can override the price per account in Settings → Spend. A plan without a list price (Enterprise) needs a price before its fee counts.
- **Detection**: the plan is detected where the provider says. The account shows "Detected" or "Set by you".
  - ChatGPT/Codex: the access token's `https://api.openai.com/auth.chatgpt_plan_type` claim, read when the account signs in and whenever the token refreshes (`team` maps to Business). pi keeps no id_token, but the access token carries the same claim.
  - Claude Code: `subscriptionType` from `claude auth status`. `max` does not say whether it is 5x or 20x, so the admin picks one. Until then no fee is counted.
  - Anthropic OAuth through pi is not stored at all: Claude subscriptions only reach Ficus through Claude Code.
  - Anything else shows "plan unknown". No fee is counted until a plan or price is chosen; nothing is guessed.
- **Fee rule**: for a range `[from, to)` and a monthly price `P`, the fee is the sum over every UTC calendar month the range touches of `P × days(month ∩ range ∩ active) / daysInMonth(month)`. A whole calendar month therefore counts the full fee, and any other range is prorated by day. A partial day counts as a whole day. The active window starts when the account was added (or, for accounts added before that was recorded, at its first subscription call) and ends now, so future days are never charged.
- **Projection**: this month's billed spend so far divided by the share of the month elapsed, plus every priced subscription's full monthly fee.
- **Preview without subscriptions**: the sum of every call's list price, with no fees. It is approximate when some calls have no known price.
- Fees are left out when the view is filtered to a slice of calls that fees cannot be split by (a squad, agent, feature, model or person).
- Deleting a subscription account drops its fee from past totals. Disable the account instead to keep its history.

## Storage, rollups and retention

- `inference_usage` has one row per call.
- `inference_usage_daily` holds daily totals per (feature, provider, model, account, billing, squad, work stream, agent, person). It is kept indefinitely.
- Retention: per-call rows are kept `INFERENCE_USAGE_RETENTION_DAYS` days (180 by default, 1–365; Settings → Spend, needs `settings:write`).
- The worker's hourly job (`services/inference-usage/maintenance.ts`) brings yesterday's and today's rollups up to date, plus any day in the last week that got rows late. It then rolls up and deletes the per-call rows of every day older than the retention window, one day per transaction.
- **Prune watermark** (`INFERENCE_USAGE_PRUNED_BEFORE` in the settings table): the UTC day before which per-call rows have been rolled up and deleted. It moves in the same transaction that seals a day, and only forwards. A day at or after it is rebuilt whole (delete its rollup, insert its totals). Rows that arrive for a day before it (a very long turn, the first backfill) are flushed instead: added to the rollup and deleted together, so they are counted once. Each day is processed under an advisory lock, so concurrent jobs cannot double it.
- **Reading rule**: every spend query reads rollups for days before the watermark and per-call rows from it on, in one snapshot. One day is never read from both. The read boundary follows what pruning actually did, not the retention setting, so raising or lowering retention never hides or double counts history: after a raise, already pruned days stay in their rollups and later days are kept longer.

## Backfill

Usage recorded before the ledger existed is imported once by the worker (`backfill.ts`; progress is kept in the `INFERENCE_USAGE_BACKFILL_STATE` setting, so it resumes after a restart):

- Execution usage deltas. Legacy rows with only cumulative snapshots get their deltas reconstructed in memory, the same way as `bun usage:backfill`; `executions.usage` itself is not changed.
- An agent's session total beyond its executions (for example a manual compaction), for agents with no live ledger rows.
- Every answered `decision_log` row with tokens or a cost.

Backfilled rows have `source.backfilled = true` and billing `unknown`. Their provider and model are empty when not known. Only usage from before the cutoff is imported: the first live ledger row's time, worked out once and saved in the backfill state, so live calls are never imported again. Rows inside the read window have a dedupe key (`exec:<id>`, `agent-gap:<agentId>`, `decision_log:<id>`). Rows for days already pruned are left out on every run after the worker's first (their dedupe keys are gone with the per-call rows, and their days' rollups already count them). Running it again therefore writes nothing new.

To check or re-run by hand: `bun run --filter core usage:ledger-backfill [--squad <uuid> | --agent <uuid>...] [--apply]`. Without `--apply` it is a dry run.

## API and permission

- `GET /api/spend/summary`: totals, daily series, subscription line items, projection and retention metadata.
- `GET /api/spend/breakdown?by=<dimension>[&by2=<dimension>][&limit=]`: grouped spend, largest first.

Both take `from`/`to` (ISO; the last 30 days by default, at most 400 days) and filters: `squadId`, `workStreamId`, `agentId`, `userId`, `feature`, `provider`, `model`, `accountId` (`provider/id`) and `billing`. An empty filter value matches calls with no value.

Both need `usage:read`. No default role has it, so only admins (`*`) see spend until it is granted. Existing per-agent and per-work-stream usage displays keep their own permissions and still read `executions.usage`. `GET /api/decisions/spend` (Decision Providers → Features, `provider-auth:read`) now reads the ledger too, including Lite-tier rows.
