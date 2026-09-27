# Webhook Event Handling

GitHub account setup, account selection, and credential lifecycle are described in [GitHub integrations](github-integrations.md).

Workflows consume typed integration outputs. Squad event rules decide what to do when an event is not already owned by a work stream: notify the manager, notify a new consultant, start a work stream with a chosen workflow, or ignore it. Configure these under **Squad settings → Integrations → Event rules**. The same rule and action model serves GitHub and Linear; provider adapters supply events and resource bindings. See [Workflows: integration updates and triggers](workflows.md#integration-updates-and-new-work-triggers).

Extensible system for receiving, verifying, and processing webhooks from external providers (GitHub, etc.). Provider-agnostic routing with provider-specific processors.

## Architecture

```
POST /api/webhooks/:provider
     │
     ▼
webhooksRouter          (parse body, normalize headers)
     │
     ▼
WebhookProcessor        (provider-specific: verify signature, extract event type)
     │
     ▼
storeWebhookEvent()     (persist to DB for audit)
     │
     ▼
WebhookRegistry         (lookup handlers by provider:eventType)
     │
     ├─► Handler 1      (e.g., auto-deploy on push)
     ├─► Handler 2      (e.g., create task from PR)
     └─► Wildcard *     (e.g., logging all events)
     │
     ▼
markWebhookProcessed()  (or markWebhookError on failure)
```

Handlers run asynchronously after the HTTP response is sent (GitHub enforces a 10-second timeout). Webhooks can notify squads or trigger other system actions.

## Key Files

| File                                                   | Purpose                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `apps/core/src/services/webhooks/types.ts`             | Core interfaces: `WebhookProcessor`, `WebhookHandler`, `WebhookContext`, `WebhookRegistry` |
| `apps/core/src/services/webhooks/registry.ts`          | Singleton registry mapping providers to processors and handlers                            |
| `apps/core/src/services/webhooks/store.ts`             | Database CRUD for webhook events (audit trail)                                             |
| `apps/core/src/services/webhooks/index.ts`             | Entry point, `initializeWebhooks()` wires up all processors/handlers                       |
| `apps/core/src/services/webhooks/processors/github.ts` | GitHub processor + push/ping handlers                                                      |
| `apps/core/src/routes/webhooks.ts`                     | HTTP route: `POST /api/webhooks/:provider`, `GET /api/webhooks/:provider/status`           |

## Core Interfaces

### WebhookProcessor

Each provider implements this interface to handle its specific signature scheme and event type extraction:

```typescript
interface WebhookProcessor {
  provider: string
  verifySignature(ctx: WebhookContext, secret: string): Promise<boolean>
  getEventType(ctx: WebhookContext): string
  getSecret(): string | null
}
```

### WebhookHandler

A function that processes a specific event type:

```typescript
type WebhookHandler = (ctx: WebhookContext) => Promise<void>
```

### WebhookContext

The context passed to every handler:

```typescript
interface WebhookContext {
  provider: string // e.g., "github"
  eventType: string // e.g., "push", "pull_request"
  payload: Record<string, unknown>
  headers: Record<string, string> // lowercase keys
  rawBody: string // for signature verification
}
```

## Configurable Webhook Actions

Webhook actions are configured via YAML at `config/webhooks/actions.yaml`. This lets you change deploy commands, add branch-specific actions, and configure timeouts — all without code changes.

### Config Format

```yaml
github:
  push:
    # First matching rule wins
    - branches: ['refs/heads/main']
      commands:
        - run: 'git pull'
        - run: 'bun install'
        - run: 'bun run build'

    # Staging gets a lighter deploy
    - branches: ['refs/heads/staging']
      commands:
        - run: 'git pull'
        - run: 'bun run build'

    # Wildcard: log all other pushes
    - branches: ['*']
      commands:
        - run: "echo 'Push received'"
```

Structure: `provider > eventType > rules[]`. Each rule has:

| Field                | Required | Description                                                                              |
| -------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `branches`           | No       | Array of ref patterns. Supports exact match and `*` glob. Defaults to `["*"]` if omitted |
| `commands`           | Yes      | Array of commands to run sequentially                                                    |
| `commands[].run`     | Yes      | Shell command to execute                                                                 |
| `commands[].timeout` | No       | Timeout in milliseconds                                                                  |
| `cwd`                | No       | Working directory for commands (defaults to the monorepo root)                           |
| `env`                | No       | Object of environment variables. Supports `{{ payload.dot.path }}` templates             |

Rules are evaluated top-to-bottom; the first matching rule wins. The GitHub PR review request action uses the YAML action key `pull_request_review_requested`. If no rule matches, the push is logged and skipped.

If the config file is missing or fails to load, a warning is logged at startup and push events are skipped (non-fatal).

## Environment Templates

Rules can define an `env` block with template expressions that resolve values from the webhook payload into environment variables:

```yaml
github:
  pull_request_review:
    - env:
        PR_NUMBER: '{{ payload.pull_request.number }}'
        REVIEW_STATE: '{{ payload.review.state }}'
      commands:
        - run: echo "PR $PR_NUMBER got $REVIEW_STATE"
```

Template syntax: `{{ payload.dot.path }}`. The path is walked through the payload object. Missing paths resolve to empty strings. Non-string values (numbers, booleans) are stringified.

Environment variables from templates are merged with `process.env` and passed to all commands in the rule.

Webhook scripts receive `FICUS_WEBHOOK_CONTEXT=1`, the local Core listener as `FICUS_API_URL`, and a scoped system token. The CLI uses that injected identity directly, even if the host user has a different active login or matching values in `.env`. Missing credentials or an API URL fail closed; `--backend` cannot substitute a saved human login. Bootstrap scripts may receive the instance's legacy password when a system token cannot yet be persisted.

## GitHub Provider

**Processor:** `githubProcessor` in `processors/github.ts`

- **Signature:** HMAC-SHA256 via `X-Hub-Signature-256` header, timing-safe comparison
- **Event type:** Extracted from `X-GitHub-Event` header
- **Secret:** Settings → Integrations → GitHub → Webhook delivery

GitHub events enter the integration output system before optional custom commands.
Webhooks, the managed relay, and polling share event identities and routing:

- **Squad settings → Integrations → Event rules** selects event filters and one action: notify manager, notify new consultant, start work stream with a chosen workflow, or ignore. The first matching enabled rule applies. Existing repository/team routing supplies editable defaults.
- The default review-request rule creates or reuses a work stream with the squad's workflow. It can be changed to a different workflow or action. Creation is recorded transactionally by resource, so retries do not create duplicate work.
- Existing workflow work streams use their configured code-host destination or explicit subscriptions. Inactive consumers retain events; disabled routing does not fall back to another agent.
- Pre-flow work streams retain native assignee/reviewer/manager notifications for their linked resources. CI ordering still uses durable per-workflow run/attempt watermarks. Finished streams do not notify.
- Review line comments include the file, line, and thread URL. Their durable event identities prevent duplicate deliveries; they no longer depend on the shell review batcher.

The integration layer verifies the squad's assigned account and resource access before routing. A repository metadata match alone grants no access. Removing routing entries disables rules limited to those entries. Removing every event rule disables squad actions; existing work-stream subscriptions stay independent.

### Stages

A GitHub event passes through four stages, in order:

1. **Receipt** — the raw webhook is verified and persisted in `webhook_events`, tagged with `activity_squad_ids` for every squad it can reach.
2. **Normalized output event** — the payload becomes a provider-neutral fact in `integration_output_events`, carrying the authority (which connection observed it) that later authorization checks use.
3. **Activity projection** — independent of any work-stream delivery, the fact is projected into `squad_activity` under the `github-pr` or `github-issue` family. Projection runs whether or not a work stream or agent is listening; it dedupes by the logical row identity of the change (so a retried webhook and a poll observation of the same close collapse into one row), while genuinely distinct transitions (an edit, then a close, then a reopen) stay separate rows. Every work stream in the squad that tracks the issue or PR gets its own row for the event, so an event shared by two streams appears under both. Polling produces the same families through the same dedupe — a polled event is timed by its own occurrence, including its own close time — so a webhook and a poll of the same event never double up.
4. **Subscription deliveries** — separately, the event is matched against work-stream and squad subscriptions and recorded in `integration_output_deliveries`, each with a reason (delivered, retained, skipped, and why).

Activity (stage 3) and delivery (stage 4) are independent: an issue or PR can show up in a squad's Activity feed with no agent ever notified, and a delivery can be skipped (work stream ended, not following changes, resource rebound) without affecting the Activity record.

Bundled notification scripts have been retired. The default `actions.yaml` contains no notification rules. On upgrade, references to the old bundled notification commands are ignored, including their review batch, while custom commands remain intact. Native notifications need neither a CLI subprocess nor a host-user login. Custom webhook commands that invoke Ficus still receive the instance-bound identity described above.

### GitHub webhook setup

GitHub delivers events over the internet, so the API needs a **public URL**
first — see [reverse-proxy.md](reverse-proxy.md) for serving ficus on a real
origin.

#### 1. Configure direct delivery in Ficus

Open **Settings → Integrations → GitHub → Webhook delivery**. Generate or enter
a secret, copy it to GitHub's webhook configuration, and save it in Ficus. Saved
values cannot be revealed; rotation means entering a new secret on both sides.
No API restart is needed. Copy the endpoint URL shown in this panel.

#### 2a. Create the webhook — Option A: `gh` CLI

```bash
# Get the repo from git remote
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Supply the same new secret you entered in the integration settings.
# Read it without echoing it to the terminal (Bash).
read -rs -p "New webhook secret: " WEBHOOK_SECRET

# Create the webhook
gh api repos/$REPO/hooks --method POST \
  -f name=web \
  -f config[url]='https://YOUR-DOMAIN/api/webhooks/github' \
  -f config[content_type]=json \
  -f config[secret]="$WEBHOOK_SECRET" \
  -f config[insecure_ssl]='0' \
  --jq '{id: .id, active: .active, events: .events, url: .config.url}'
```

#### 2b. Create the webhook — Option B: GitHub UI

1. Go to your repository **Settings > Webhooks > Add webhook**
2. **Payload URL:** `https://YOUR-DOMAIN/api/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** the same secret you entered in Ficus’s GitHub integration settings
5. **Events:** select "Let me select individual events", then enable **Pushes**,
   **Pull request reviews**, **Pull request comments**, **Pull requests** (for
   merges and conflict detection), **Issues**, **Issue comments**, and
   **Workflow runs**
6. **Active:** check the box, then click **Add webhook**

#### 3. Verify it is working

The status route requires the `webhooks:read` permission, so it needs a
credential. Before the first admin passkey exists, the bootstrap `FICUS_PASSWORD`
from `.env` works as a bearer token; afterwards it stops being accepted and you
need a signed-in session or a system token.

```bash
curl -H "Authorization: Bearer $FICUS_PASSWORD" https://YOUR-DOMAIN/api/webhooks/github/status
# {"provider":"github","registered":true,"secretConfigured":true}
```

GitHub sends a `ping` event immediately. Check the logs for confirmation:

```bash
ficus server logs | grep "GitHub Webhook"
```

### Automatic GitHub watches

GitHub polling discovers current PR metadata automatically, including custom metadata paths declared by flow subscriptions. No manual watch registration is needed. Exact repository bindings on issue-assignment triggers also establish repository event watches before any stream exists; assignee-only triggers can use exact repositories already configured in squad `metadata.github`. Repository assignment watches use the same credential bridge and bounded polling runner. They baseline existing history, then emit new assignment/removal and supported state/label/title events into the generic output router. Issue comments still require webhooks. These repository watches remain enabled alongside webhooks because a recent PR delivery does not establish that issue events are configured. See [workflows](workflows.md#github-polling-without-webhooks) for setup and limits.

### GitHub PR event polling fallback

The integration runtime polls PRs referenced by metadata on non-terminal work streams when that repository has no verified webhook delivery in the preceding seven days. A subsequent real delivery removes the repository from the next watch set; an already-running scan can overlap by at most one scan interval. When suppression expires, a verified delivery newer than the cursor's last successful poll becomes the replacement scan's cutoff. That scan fingerprints activity at or before the delivery and emits only activity after it when the REST object provides an action-specific authoritative timestamp: `closed_at`/`merged_at` for PR closure, `created_at`/`updated_at` for issue and review comments, and `submitted_at` for new reviews. Equality is suppressed. Missing or unrelated timestamps are never guessed, so synchronize and reopen transitions and review edits/dismissals that occurred during suppression remain a residual recovery gap; their generic PR `updated_at` or original review `submitted_at` is not treated as the transition time. Later ordinary polling remains change-based.

Durable cursors stay scoped by squad and canonical repository/PR identity so one squad's credential failure cannot defer another. Synthetic logical-event identities are provider-global, with mutable edit/transition versions fingerprinted; a durable leased completion record prevents two squad cursors or replicas from globally dispatching the same version twice while allowing a later edit or transition. Dispatch still precedes cursor save: a failure before dispatch completion is retryable after release/lease expiry, while a crash after handler side effects but before durable completion can duplicate under the documented at-least-once boundary. Real webhook deliveries do not use this synthetic dedupe path. The squad's indirect `githubIdentity.githubTokenSecretKey` credential is used, with the normal GitHub token fallbacks; tokens are never copied into work-stream metadata or polling cursors.

Polling uses conditional GitHub REST requests and durable provider/resource cursors for PR state, issue comments, reviews, and review comments. New activity is wrapped in GitHub's native `pull_request`, `issue_comment`, `pull_request_review`, or `pull_request_review_comment` payload shape, marked synthetic only in envelope metadata, and sent through the same verified-event registry as HTTP webhooks. Active or in-review streams poll every 60–120 seconds; other non-terminal streams every 5–10 minutes, with jitter and a global scan budget. Failed resources receive lease-token-fenced, jittered retry backoff so unhealthy credentials cannot starve healthy watches. Cursors retain compact comparison fingerprints rather than historical REST bodies; missing ETags fall back to page-content fingerprints, and each claimed poll derives its deadline from the returned database-clock lease. Timed-out non-cancellable dispatch/save work keeps that lease heartbeating until it settles, preventing a second claimant from overlapping side effects. Real-delivery suppression uses one batched, indexed repository lookup per scan.

`workflow_run` polling is intentionally deferred. Two v1 caveats are expected: events found in one poll batch are not guaranteed to preserve GitHub webhook delivery ordering, and notification latency is bounded by the applicable polling interval for ordinary scans. Exceptionally large histories resume from a durable page cursor across ticks to respect the hard request guard, so their initial baseline or event batch can span multiple polling intervals. Multi-page issue-comment scans conditionally revalidate every page before committing, cap the update watermark at the server-reported scan start, and overlap timestamp ties so concurrent edits remain eligible for the next scan.

Synthetic `pull_request` synchronize, closed, and reopened events intentionally omit top-level `sender`: the required REST reads do not identify the authoritative actor, and using `pull_request.user` would misattribute the PR author. Comment and review events retain their authoritative object user as sender. A future provider may populate the PR sender only when it has an authoritative actor source.

## GitHub auto-deploy

Ficus can redeploy itself when you push to `main`. This is **opt-in**: the rule
ships commented out in `config/webhooks/actions.yaml`. Uncomment it (adjusting
the repo) and restart the API:

```yaml
github:
  push:
    - branches: ['refs/heads/main']
      repos: ['owner/repo']
      commands:
        - run: config/webhooks/scripts/push-deploy.sh
```

`config/webhooks/scripts/push-deploy.sh` runs `git pull`, exits early when the
pull reports "Already up to date", and otherwise runs
`bun install && bun run build && bun reload`. Any other command list works
too — see [Configurable Webhook Actions](#configurable-webhook-actions).

The webhook itself must include the `push` event. `scripts/setup-github-webhook.sh`
creates or updates the repository webhook with the issue/PR/workflow events ficus
uses, but not `push` — add that one in the GitHub UI (or with `gh`) when you
want auto-deploy:

```bash
export FICUS_GITHUB_HOOK_SETUP_SECRET='same-new-secret-entered-in-integration-settings'
scripts/setup-github-webhook.sh owner/repo https://your-domain.com
```

The script checks `gh auth status` and your repo permission first, then points
the hook at `https://your-domain.com/api/webhooks/github` with JSON payloads and
the secret above.

What ficus does with each event:

- **Pushes** — auto-deploy on push to main (this section)
- **Pull requests** — merge and conflict detection
- **Pull request reviews** and **pull request comments** — the PR feedback loop
- **Issues** — notify squads of issue assignments
- **Issue comments** — PR feedback loop (PRs are issues to GitHub)
- **Workflow runs** — CI failure feedback loop

## Linear Provider

**Processor:** `linearProcessor` in `processors/linear.ts`

- **Signature:** HMAC-SHA256 via `Linear-Signature` header (raw hex, no prefix), timing-safe comparison
- **Event type:** Extracted from `Linear-Event` header
- **Secret:** managed by integration settings (`GET`/`PUT /api/integrations/providers/linear/webhook`), not an env var — see [Linear integrations](linear-integrations.md) and `apps/core/src/services/integrations/linear/webhook-settings.ts`. The legacy `LINEAR_WEBHOOK_SECRET` env var is imported once on startup into that encrypted setting and is not read again afterward. `LINEAR_USER_ID` is retired: identity comes from each squad's connected account, checked live per event (see Stages below), not a single configured user.

**Handled events:** `Issue` (assignment, unassignment, state/title/label/other updates) and `Comment` (created and edited). Issue creation and removal are received but produce no output or Activity row. There is no polling fallback for Linear — a missed or failed webhook delivery is not recovered.

### Stages

A Linear event passes through four stages, in order, mirroring GitHub's:

1. **Receipt** — the raw webhook is verified and persisted in `webhook_events`, tagged with `activity_squad_ids` for every squad that owns it: either a work stream that already names the issue (a `tracked` entry's `externalId`, or the legacy `metadata.linear.issueId`), or a squad with matching team routing (`metadata.linear[].teamId`). Team routing only owns deliveries that name a team: a `Comment` payload carries no `data.teamId`, so a comment receipt is owned through a tracking stream alone. Ownership is not a row either way — see stage 4.
2. **Per-squad access probe** — a valid signature only proves the payload came from Linear. For every squad with an enabled, assigned Linear connection, Ficus queries that squad's own connection to confirm it can currently read the issue — and, for assignment/unassignment, that the connected account is the (previous) assignee — before publishing the event under that squad's authority. A squad whose connection cannot read the issue never receives it, even when another squad's connection can.
3. **Outputs** — the payload becomes the provider-neutral `issue.assigned`, `issue.unassigned`, `issue.updated`, or `issue.comment` fact in `integration_output_events`, published once per authorized squad. See [Linear integrations → Outputs](linear-integrations.md#outputs) for the full field list.
4. **Activity and delivery** — independent of each other: the fact projects into `squad_activity` under the `linear-issue` family (lane 71, kind `issue`), one row per stream tracking the issue, so an owned receipt with no tracking stream produces no rows (and produces them later if a stream starts tracking it); separately, the event is matched against work-stream and squad subscriptions and recorded in `integration_output_deliveries`. See [Linear integrations → Activity](linear-integrations.md#activity).

### Linear Webhook Setup

#### 1. Configure the signing secret in Ficus

Open **Settings → Integrations → Linear → Webhook delivery**, generate or enter a secret, and save it. Saved values cannot be revealed; rotation means entering a new secret on both sides. Copy the endpoint URL shown in this panel (`https://your-domain.com/api/webhooks/linear`, path-prefixed if applicable).

#### 2. Create webhook in Linear

1. Go to **Settings → API → Webhooks** (requires admin)
2. Click **New webhook**
3. **Label:** `Ficus Integration`
4. **URL:** the endpoint URL from step 1
5. **Signing secret:** paste the same secret you entered in Ficus
6. **Data change events:** check **Issues** and **Comments**
7. **Team:** select specific team(s) or "All public teams"
8. Save

#### 3. Verify setup

```bash
# webhooks:read required — the bootstrap FICUS_PASSWORD works until the first admin passkey exists
curl -H "Authorization: Bearer $FICUS_PASSWORD" https://your-domain.com/api/webhooks/linear/status
# {"provider":"linear","registered":true,"secretConfigured":true}
```

Then assign yourself an issue in Linear and check the logs:

```bash
ficus server logs | grep "Linear Webhook"
```

## Adding a New Handler (Same Provider)

To handle a new GitHub event type (e.g., `pull_request`), add a handler function and register it in `initializeWebhooks()`:

**1. Create the handler** in `processors/github.ts`:

```typescript
export const handleGithubPullRequest: WebhookHandler = async (ctx) => {
  const payload = ctx.payload as {
    action?: string
    pull_request?: { number?: number; title?: string }
  }

  console.log(`[GitHub Webhook] PR #${payload.pull_request?.number}: ${payload.action}`)
  // ... your logic here
}
```

**2. Register it** in `webhooks/index.ts`:

```typescript
import { githubProcessor, handleGithubPush, handleGithubPing, handleGithubPullRequest } from './processors'

export function initializeWebhooks(): void {
  webhookRegistry.registerProcessor(githubProcessor)
  webhookRegistry.registerHandler('github', 'push', handleGithubPush)
  webhookRegistry.registerHandler('github', 'ping', handleGithubPing)
  webhookRegistry.registerHandler('github', 'pull_request', handleGithubPullRequest) // new
}
```

**Wildcard handlers** can be registered with `"*"` to receive all events from a provider:

```typescript
webhookRegistry.registerHandler('github', '*', myLoggingHandler)
```

## Adding a New Provider

To add a completely new provider (e.g., Stripe):

**1. Create** `apps/core/src/services/webhooks/processors/stripe.ts`:

```typescript
import type { WebhookProcessor, WebhookHandler, WebhookContext } from '../types'

export const stripeProcessor: WebhookProcessor = {
  provider: 'stripe',

  async verifySignature(ctx: WebhookContext, secret: string): Promise<boolean> {
    // Implement Stripe's signature verification scheme
    // (Stripe uses a different HMAC scheme with timestamps)
  },

  getEventType(ctx: WebhookContext): string {
    // Stripe puts the event type in the payload body
    return (ctx.payload as any).type || 'unknown'
  },

  getSecret(): string | null {
    return process.env.STRIPE_WEBHOOK_SECRET || null
  },
}

export const handleStripePayment: WebhookHandler = async (ctx) => {
  // Handle payment events
}
```

**2. Export** from `processors/index.ts`.

**3. Register** in `webhooks/index.ts`:

```typescript
import { stripeProcessor, handleStripePayment } from './processors'

export function initializeWebhooks(): void {
  // ...existing GitHub setup...

  webhookRegistry.registerProcessor(stripeProcessor)
  webhookRegistry.registerHandler('stripe', 'payment_intent.succeeded', handleStripePayment)
}
```

The route `POST /api/webhooks/stripe` will automatically work — no route changes needed.

## HTTP Endpoints

### `POST /api/webhooks/:provider`

Receives webhook payloads. Returns immediately with `200`:

```json
{ "received": true, "eventType": "push", "handlers": 1 }
```

Error responses:

- `404` — Unknown provider
- `400` — Invalid JSON
- `401` — Signature verification failed

### `GET /api/webhooks/:provider/status`

Health check for debugging:

```json
{ "provider": "github", "registered": true, "secretConfigured": true }
```

## Database Schema

All webhook events are persisted in `webhook_events` for audit:

| Column        | Type         | Description                        |
| ------------- | ------------ | ---------------------------------- |
| `id`          | UUID         | Primary key                        |
| `provider`    | varchar(50)  | Provider name                      |
| `eventType`   | varchar(100) | Event type (e.g., `push`)          |
| `payload`     | JSONB        | Full webhook payload               |
| `headers`     | JSONB        | Request headers                    |
| `signature`   | text         | Raw signature header value         |
| `verified`    | boolean      | Whether signature was valid        |
| `processedAt` | timestamp    | When processing completed          |
| `error`       | text         | Error message if processing failed |
| `createdAt`   | timestamp    | When event was received            |

## Debugging

Every delivery is stored, verified or not, so the database is the first place to
look:

```sql
SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT 10;
```

Check whether a provider is registered and holds a secret (needs the
`webhooks:read` permission):

```bash
curl -H "Authorization: Bearer $FICUS_PASSWORD" https://your-domain.com/api/webhooks/github/status
```

Common causes: a `401` means the integration webhook secret and the one on the provider
differ; a `404` means the provider never registered — check that the API started
cleanly (`ficus server logs -c api`).

Without a configured integration webhook secret, the receiver rejects deliveries
with `503`. Invalid signatures return `401`. Local tests also require a signing
secret; unsigned events never execute handlers.
