---
name: setup-github-webhooks
description: 'Set up GitHub webhook integration for a Ficus instance — create the webhook on a repo, configure secrets, and set squad metadata for event routing.'
---

# Setting Up GitHub Webhooks

## Overview

GitHub webhooks let Ficus receive events from GitHub repositories — issue
assignments, PR review requests, PR reviews/comments, CI failures, merge conflicts, merges, and more. Events are
routed to the correct squad based on metadata you configure.

## Who Uses This

This skill has two audiences:

- **System Manager** — Initial setup: create the webhook, configure
  secrets (Steps 1–3). Done once per repo. Either agent can walk the human through it.
- **Squad Manager** — Squad-specific config: set routing metadata and track
  issues/PRs on work streams (Steps 4–6). Done per squad.

## Configure direct delivery

For managed cloud instances, prefer the platform's shared GitHub App webhook
relay when configured. Polling also works automatically. Direct delivery is
optional and useful for self-hosting or a custom GitHub App.

1. Ask the human to open **Settings → Integrations → GitHub → Webhook delivery**.
2. They can generate a secret there, copy it into their GitHub App's webhook
   settings (or a repository webhook), then save it in Ficus. Saved secrets are
   never revealed. Do not use `ficus secret` or ask them to paste secrets in chat.
3. Copy the webhook URL from the integration panel. It includes the instance's
   public base path. Do not infer an `api-` hostname from `APP_URL`.
4. Use JSON delivery and the events below. No Ficus restart is required.

The human must have GitHub integration write permission to change this setting.
The integration settings API is `GET/PUT /api/integrations/providers/github/webhook`;
PUT accepts `{ "secret": "new value" }` or `{ "secret": null }` to disable direct
delivery. GET returns only `configured` and `webhookUrl`. It never returns a saved
secret. Agents can read status with integration read permission; writes require
a human identity. Use `ficus webhook status github` to verify the receiver is ready.

Existing legacy webhook secrets are imported automatically on startup. Configure
future changes through Integrations and remove the obsolete environment entry.
Never change the shared GitHub App's hosted webhook URL to test one local instance;
use a custom App or a repository webhook for that instance.

**Events explained:**

| Event                         | What it triggers                                                             |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `issues`                      | Issue assigned/unassigned → routed to matching squad                         |
| `issue_comment`               | Comments on issues/PRs → routed to assigned agent                            |
| `pull_request`                | PR review requests and merge/conflict detection → notifies work stream agent |
| `pull_request_review`         | PR review submitted → batched with line comments                             |
| `pull_request_review_comment` | PR line comments → batched with review                                       |
| `workflow_run`                | Terminal CI conclusion → notifies work stream agent                          |

Workflow-run attempt high-water suppression is sequential-delivery only. Concurrent delivery, crash-safe settlement, partial metadata recovery, and per-workflow state require the database-backed work tracked in `25da8cd9-55c3-40b2-a74c-42bf358cecb2`.

## Step 3: Verify the Webhook

```bash
ficus webhook status github
```

Expected: `registered: true, secretConfigured: true`

GitHub sends a `ping` event immediately after creation. Check logs to confirm
it was received.

## Step 4: Configure Squad Routing

For a squad to receive GitHub events, set its `github` metadata with the
repos and optional label filters:

```bash
# Route all issues from a repo to this squad
ficus squad set-meta <squad-id> github '[{"repo": "owner/repo-name"}]'

# Route only issues with specific labels
ficus squad set-meta <squad-id> github '[{"repo": "owner/repo-name", "labels": ["backend", "api"]}]'

# Watch multiple repos
ficus squad set-meta <squad-id> github '[{"repo": "owner/repo-a", "labels": ["backend"]}, {"repo": "owner/repo-b"}]'

# Watch repos with safe glob-style wildcards
ficus squad set-meta <squad-id> github '[{"repo": "owner/*"}]'
ficus squad set-meta <squad-id> github '[{"repo": "owner/prefix*", "labels": ["backend"]}]'
```

**How routing works:**

- When a GitHub issue is assigned, Ficus finds squads whose `metadata.github`
  entries match the repo AND at least one label (if labels are configured).
- `repo` supports exact `owner/repo` values and safe `*` wildcards matched
  against the full `owner/repo` string. Wildcards are anchored glob-style
  matches, not regex. Examples: `owner/*`, `owner/prefix*`, `owner/*-suffix`,
  `owner/*-api-*`, and `*/repo-name`.
- If a squad's entry has no `labels` array (or it's empty), it matches all
  issues for that repo.
- The squad's manager receives an inbox message with the issue details.

PR `review_requested` events also use `metadata.github` repo matching. Label filters are ignored for PR review requests because GitHub PR review request payloads are not issue-label driven.

When GitHub requests review from the connected GitHub account, or requests review from a GitHub team on a routed repo, Ficus creates a reviewer work stream. That work stream is automatically tagged with `github.pr.number`, `github.pr.url`, and `github.repo` so later PR comments, reviews, CI failures, merge conflicts, and merge notifications route back to the reviewer.

## Step 5: Configure PR Tracking on Work Streams

The work stream's own delivery PR (`codeHost.changeRequest`) is normally recorded
automatically when a reviewer agent creates the PR through the git/worktree flow —
do not hand-write it. To follow an _additional_ PR (a related PR, or one observed
from an integration event) so its webhook events route to the right agent, track
it instead of writing metadata directly:

```bash
# From an integration event (e.g. a review request or comment notification)
ficus workstream track <ws-id> --event <event-id>

# By explicit reference
ficus workstream track <ws-id> --pr owner/repo-name#<pr-number>

# Flag an additional PR as a delivery change request — it must also be merged
# before the stream can finish, alongside the primary codeHost PR
ficus workstream track <ws-id> --pr owner/repo-name#<pr-number> --delivery
```

Ficus resolves and records the tracked PR atomically, and validates the squad has
an authorized connection for it. Legacy `github.pr.number`/`github.pr.url`/`github.repo`
metadata set with `set-meta` is still recognized (for the primary delivery PR only).

## Step 6: Configure Issue Tracking on Work Streams

To start or attach work from a GitHub issue, use the event reference from the
routed notification rather than hand-writing issue metadata:

```bash
# Create a new work stream idempotently from the issue-assignment event
ficus workstream create "<title>" --squad <squad-id> --from-event <event-id>

# Or attach the issue to a work stream you already chose
ficus workstream track <ws-id> --event <event-id>

# By explicit reference, when there is no event to replay
ficus workstream track <ws-id> --issue owner/repo-name#<issue-number>
```

`ficus workstream tracked <ws-id>` (alias `links`) lists everything a stream
tracks, whether each PR counts toward delivery, its observed merge state, and
whether its subscriptions are active. A stale `github.repo`/`github.issue`
pair from before tracked resources existed is converted automatically at
startup into a `tracked` issue entry; `github.issue` itself is never read, so
always use `track`/`set-meta tracked` for new work.

## Setting Up for Multiple Repos

Repeat Step 2 for each repository that should send events to Ficus. All repos
use the same webhook secret and endpoint — routing is handled by squad metadata.

## Troubleshooting

| Problem                               | Solution                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook returns 401                   | Secret mismatch — verify the integration webhook secret matches GitHub                                                                                                            |
| Events not reaching squad             | Check squad metadata: `ficus squad get <id>` → verify `github` array                                                                                                              |
| PR events not reaching agent          | Verify work stream has `github.pr.number` and `github.repo` set                                                                                                                   |
| Review request creates no work stream | Verify webhook includes Pull request events, a connected GitHub account matches the requested user for user review requests, and squad `metadata.github` repo matches the PR repo |
| Webhook shows as failing              | Check the API is reachable at the configured URL                                                                                                                                  |
