# GitHub account connections

GitHub accounts live in the integration connection pool. Open **Settings → Integrations → GitHub → Settings → Connect account**. Authorize the account, and install the GitHub App on the repositories that Ficus should access. Account authorization alone does not give the app repository access.

For Ficus's app, choose **Grant repository access** in the same settings card, or open the [public installation page](https://github.com/apps/ficus-integration/installations/new). Select your personal account or organization and the repositories to grant access to. You do not need access to the app's developer settings. If GitHub offers **Request** instead of **Install**, an organization owner must approve the request before private repository access works. Existing installations can be changed through **Manage GitHub App installations**. If using a custom GitHub App, install that app instead.

Standalone instances use device login with Ficus's public app client ID. Enter the displayed code at GitHub; Ficus stores the resulting credential locally, encrypted in its secret store. No private app credential or manual personal access token is needed. Hosted instances use the Platform OAuth broker and return to the tenant after authorization.

## Squad accounts and operation selection

In a squad's **Integrations** settings, attach the accounts it can use and choose a default. Changing the default retains the other attached accounts. Detaching the default does not silently select another identity.

```sh
ficus integration connect github
ficus integration list --provider github
ficus integration assign github --squad <squad-id> --connection <connection-id>
ficus integration assign github --squad <squad-id> --connection <another-id> --additional
ficus integration exec github --squad <squad-id> --connection <another-id> -- gh pr list
ficus integration unassign github --squad <squad-id> --connection <connection-id>
```

Squad shells resolve the default account when `gh` runs or Git requests HTTPS credentials for github.com. Credentials are fetched for each operation, so refresh, disable, and detach take effect without restarting an agent. Local Git operations such as status, diff, and commit do not require a connection. Scripts that intentionally bypass shell functions can use `ficus integration exec` explicitly.

The execution endpoint requires squad-scoped `integrations:use` permission. Connection IDs do not grant access: the requested account must be attached to that squad, enabled, and currently authenticated. Ordinary list/settings responses never contain credentials.

For completion checks, set `github.connectionId` in work-stream metadata to select an attached account, or omit it for the squad default. Flow subscriptions and squad event triggers can set `source.connectionId`. Repository and PR metadata establish polling interest; they do not grant repository access. Polling cursors include the connection identity, and normalized outputs retain it through delivery. Signed webhook ingress verifies repository access before attributing an event to a connection.

## Refresh and disconnect

Ficus refreshes expiring user tokens centrally. GitHub refresh invalidates the previous pair, so Ficus saves the replacement before validating account identity. A failed identity check disables access; a transient provider failure preserves the replacement refresh token for recovery. Each connection remains bound to its issuing app configuration even after an operator changes the default app.

Disconnect removes access in Ficus. GitHub requires a client secret for remote revocation; public-client device logins cannot perform that step automatically. To revoke the authorization on GitHub, open **GitHub Settings → Applications → Authorized GitHub Apps**. Removing an installation affects its repository access separately.

Legacy `GH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN_*`, `GITHUB_TOKEN_*`, `GITHUB_USER`, and squad `githubTokenSecretKey` configuration are retired. Reconnect accounts through Integrations. Stored historical values are not automatically deleted. Git commit author overrides remain separate from the account used to authenticate.

## Commit signing

Agents' commits and annotated tags are signed with an SSH key Ficus registers on the connected GitHub account, so GitHub shows them as **Verified**. The GitHub card shows the state per account and turns it on or off; connecting an account turns it on automatically unless it was turned off for that account before.

- **Key custody.** Core generates an ed25519 key per connection, registers the public half with `POST /user/ssh_signing_keys` (the App's **SSH signing keys** account permission) and keeps the private half in the secret store under `__integration-github-signing:<connectionId>`. The private key never enters a sandbox. Turning signing off or disconnecting the account deletes the key from GitHub and from Ficus; an explicit off is remembered so connect-time setup does not re-enable it.
- **How git signs.** When signing is on for a squad's default GitHub connection, the squad env's `git` wrapper adds `-c gpg.format=ssh -c commit.gpgsign=true -c tag.gpgsign=true -c user.signingkey=key::<public key> -c gpg.ssh.program=ficus`. Command-line settings outrank repository config. Git runs `ficus -Y sign …`, which sends the object git is signing to `POST /api/squads/:squadId/integrations/github/sign` with the agent's own token and writes the returned signature. Other `-Y` operations (`git verify-commit`, `git log --show-signature`) pass through to the real `ssh-keygen`.
- **What Core signs.** Only for agent identities with `integrations:use` on the squad, only git commit or tag objects, and only when the committer (or tagger) email is the squad's configured git identity or the account's `users.noreply.github.com` address. GitHub marks a signature Verified only when that email is verified on the account, which the noreply address always is.
- **Where it applies.** Everywhere Ficus already provides GitHub credentials: agent commands in squad shells on every sandbox runtime. Shells without an agent token (human terminals) keep committing unsigned rather than failing.

## App configuration

The default public client ID is `Iv23liN16iuEh5lT1PYV`. In a standalone instance, expand **Use your own GitHub App** (in onboarding, **Use your own GitHub App instead**) to configure another public client ID. A client ID alone uses device login and needs no public URL. An optional client secret switches to browser authorization; use the callback URL displayed in settings. Webhook delivery is configured only in Settings. Existing connections retain their issuing app reference.

Failed authorization requests return a stable `code` and a user-safe `error` message, and Core logs each rejection at warn with its code (never provider bodies, tokens, or secrets). GitHub failures map as follows: `provider_unavailable` 502 and `provider_timeout` 504 (GitHub unreachable from the instance), `rate_limited` 429 with `Retry-After`, `device_flow_disabled` 400, `incorrect_client_credentials` and `invalid_auth` 400, `capability_or_resource_denied` 502 (GitHub refused the app, for example an unknown client ID), and `invalid_response` or other provider errors 502. Authorization flow rejections keep their code in `error`, for example `oauth_app_unconfigured`.

Enable device flow and expiring user authorization tokens. Leave “Request user authorization during installation” unchecked so Ficus initiates authorization with bound state. Configure repository permissions: Contents, Pull requests, Issues, Actions, and Workflows read/write; Checks, Commit statuses, and Metadata read-only. Configure the account permission **SSH signing keys** read/write for commit signing. Users choose which repositories to install the app on.

Ficus uses user access tokens. GitHub App ownership still permits the owner to generate a private key and obtain installation tokens independently; this design does not remove that GitHub capability. Operators who want to control the app themselves can use the custom-app option.

App-level webhooks are optional: Ficus continues polling repositories referenced by flow bindings and work-stream metadata. Existing tenant-specific signed webhooks remain supported.

### Automatic delivery for managed cloud instances

Managed instances automatically register exact repositories found in unfinished work-stream metadata, GitHub flow subscriptions, squad GitHub Routing repositories, and squad integration triggers. Repository matches can use literals or work-stream metadata bindings; triggers without a repository match use the squad's declared GitHub repositories. This does not enumerate every repository a connected account can see. Install the App on the relevant repositories and assign a GitHub connection to the squad. No tenant webhook URL or signing secret is needed.

Core consumes Platform's durable queue every five seconds (up to four connections per tick), using its instance credential. Platform checks that the supplied user token belongs to the shared App and still has repository and access to the specific event resource before releasing any payload. Events whose underlying resource is no longer readable are discarded; this does not remove the subscription to other events from that repository. Core then rechecks the connection revision, squad assignment, and declared interest. Events enter the same typed integration outputs used by polling; existing flow subscriptions select recipients, triggers can create work, and native squad routing handles assignments, mentions, and review requests. Relay events do not run legacy instance-wide webhook shell rules. Direct tenant webhooks still run them for non-feedback events such as `push`; GitHub feedback events (comments, reviews, issues, pull requests, workflow runs) no longer run shell or batch rules (see [Author trust and held feedback](#author-trust-and-held-feedback)).

Subscriptions renew every five minutes and expire after 24 hours offline. Encrypted payloads and delivery receipts expire after 72 hours; acknowledged payloads are cleared earlier. A lost acknowledgment retries after a two-minute lease, and output fact keys deduplicate flow consumption. Each connection supports up to 100 exact repositories, with 100 connections per tenant and a tenant budget of 3,600 relay GitHub API requests per hour. Empty queue polls make no GitHub API calls.

GitHub does not automatically retry a failed webhook request to Platform. Operators can redeliver from the App's delivery log; provider polling remains the fallback for missed events and Platform downtime. Payloads over 1 MiB are rejected. Self-hosted instances do not consume the managed queue: they use polling or their own signed webhook endpoint.

## Instance updates and GitHub Pages

GitHub Pages uses the same squad connection; the old `DEPLOY_GITHUB_PAGES_TOKEN` is retired. Pages API configuration requires Pages write permission on the app, or a human can configure Pages directly in GitHub. Actions workflows can deploy with their own repository-scoped workflow token.

For privileged local Ficus updates, the updater uses the sole usable GitHub connection. With multiple accounts, set `githubConnectionId` in the update settings API to select one explicitly. It never falls back to the host's `gh auth login` credentials.

## Direct webhook delivery

In **Settings → Integrations → GitHub → Webhook delivery**, copy the webhook
URL and generate or enter a signing secret. Copy the new secret into your own
GitHub App's webhook settings (or a repository webhook), then save it in Ficus.
Use JSON delivery and subscribe to the events your flows consume. Your public
`APP_URL` must point to this instance; path prefixes are included in the displayed
URL. The receiver is `/api/webhooks/github` beneath that public base path.

Signing secrets are encrypted under integration-owned storage, never returned
by the settings API or exposed to squads. You can replace the secret or disable
direct webhooks here without restarting Ficus. Disabled direct delivery does not
disable polling or a managed platform relay.

Existing `GITHUB_WEBHOOK_SECRET` database/environment values are imported on
startup. Once imported, use integration settings for changes and remove the old
environment entry. Rotation and explicit disable survive restarts even if that
old variable remains. Legacy secret APIs no longer expose or modify this setting.
An encryption key must be configured for the import and integration settings.
The Platform's shared-App `GITHUB_APP_WEBHOOK_SECRET` remains a Platform setting,
independent of each instance's optional direct webhook receiver.

## Squad event routing

Under **Squad settings → Integrations → GitHub → Event rules**, choose an event, account, repository/label filters, and action:

- **Notify manager:** send the event to the squad’s manager.
- **Notify new consultant:** start a fresh consultant chat for the event, with the same squad context as a manager chat. Retrying delivery reuses that chat.
- **Create work stream:** save a selected workflow, or the squad default, paused for owner preparation. The event’s repository and issue/PR references are attached automatically; a Git checkout is prepared separately before resume. Existing bound work is reused.
- **Ignore:** take no squad action.

A repository filter is an exact `owner/repository`, or a pattern with `*`
(`owner/*`, `owner/svc-*`). Patterns match incoming events directly, and they
also establish polling watches and hosted-relay subscriptions: the pattern is
expanded against the repositories the selected account can see (`GET /user/repos`
under that account, listed once per connection and refreshed every ten minutes
or when the account reconnects), and each match is watched exactly once even
when several rules or squads overlap. Expansion fails closed — a pattern that
matches more than 100 repositories, or whose account is revoked or has no
usable credential and no cached listing, establishes no watches and is
recorded as a `repository_pattern_expansion` integration audit event and a
worker log warning; exact filters on the same account are unaffected.
Repositories that stop being visible or stop matching drop out on the next
discovery cycle.

The **Shared repository scope** is a reusable filter, not an action. A rule with **Use shared repository scope** enabled must match one of those repository entries **and** its own filters. Shared labels apply only to non-comment issue events (assignment, unassignment, and updates) and match any listed label; comments and PR events use only the shared repository restriction. When the checkbox is off, the shared scope is ignored. Blank rule filters add no restriction; rule labels match any listed label on the issue or PR. All access still comes from the assigned integration account.

**Account involvement** selects how the event relates to the selected connection:

- **Assigned account or requested reviewer**: for issue assignment/unassignment, the affected person must be that account; for review requests, the account must be requested (team review requests delivered to the connection also match). For other events, use the same assignee/mention check below.
- **Account is assigned or @mentioned**: the account is an assignee on the issue/PR or appears as an @mention in the event text. Events authored by that account or a bot are ignored.
- **Any matching event**: no assignment or mention check. Bot events can match, but comments and reviews authored by the connected account are always ignored. The other filters still apply.

With any account selected, one attached account matching is enough. **Notify manager**, **Notify new consultant**, and **Create work stream** accept optional **Instructions**, included as instructions from the squad’s event rule alongside the external event details. For example, tell the manager to create an engineering workflow for the issue, prepare an isolated worktree, and then start it. Updating instructions affects future events, not previously delivered messages or existing work streams.

**Create work stream** saves the chosen workflow in a queued, paused stream and notifies its owner (the squad manager). No worker agents are spawned and no admission slot is consumed during preparation. The owner reviews the event, attaches a workspace if needed using `ficus workstream update <id> --repository <checkout-path>`, and runs `ficus workstream resume <id>` to start it under the normal concurrency limits. Tasks without a Git workspace can be resumed after review. If the squad has no manager, an operator must prepare and resume the stream. Repository replacement after workflow agents have started remains prohibited.

The first matching enabled rule wins. Move rules up or down to set priority. Deleting every rule disables squad actions for that provider. Events already bound to a work stream still follow its own subscriptions, including pause and wait behavior; squad rules do not override them. Changing rules does not replay already handled events.

If a previously started work stream is parked, subscribed events such as a PR merge are retained for its workers and also sent once to its current owner. The owner can review the event and explicitly resolve any wait whose condition is satisfied. This notice does not approve, finish, resume, or clear waits automatically, and does not start parked workers. Ownership determines the recipient, even when the owner is not the squad manager. Explicit pauses and never-started streams continue holding events. If no owner is available, or the owner is itself part of the parked crew, the delivery history explains the hold rather than substituting the manager.

Existing repository/team routing and saved event triggers appear as editable rules on upgrade. No notification shell scripts are needed. Squad update permission is required to save rules. The CLI/API can also update `metadata.integrationRules.github` or `metadata.integrationRules.linear` on a squad. Each ordered rule has an `id`, `enabled`, `source` (`integration`, `output`, `version`, optional `connectionId`), `filters`, and one of the four `action.type` values: `notify-manager`, `notify-consultant`, `start-workstream`, `ignore`. The start action’s optional `workflow` uses the same preset/inline reference as work-stream creation.

### Agent notification content

GitHub notifications describe the event rather than replaying the parent issue or
PR description on every update. Lifecycle and branch updates include the action,
state, resource link, current head when available, and merge-conflict warning.
An `edited` event explicitly points to the current title and description at that
link, including when a description was cleared; it does not claim to know which
field changed or provide a historical diff. Agents can retrieve full details with
`gh pr view <url>` or `gh issue view <url>` using their squad connection.

Opening, assignment, and review-request events retain their description context
in squads with the author filter OFF. With it ON, assignment and review-request
deliveries are fixed action projections without the parent title or description
(see [Author trust and held feedback](#author-trust-and-held-feedback)).
Comments (including edits), submitted reviews, review-thread file/line links, and
CI results retain their existing event text and identifiers. Unchanged parent
descriptions are not added to feedback. Existing provider text-size limits still
apply; this policy is not a new blanket truncation limit.

Presentation is stateless and shared by worker delivery, parked-owner notices,
manager/consultant and legacy fallback notices, and event-created work. It does
not depend on a recipient having seen an earlier event. The original normalized
fact and provider evidence remain unchanged, as do rule matching (including
mentions), Event reference blocks, subscriptions, delivery receipts, and waits.
Retained facts use the compact presentation when an inbox message is first
created; already-created inbox messages and existing work descriptions are not
rewritten.

This policy does not expand event coverage: PR polling currently detects
lifecycle/head transitions and feedback, not description-only edits. The output
adapter admits submitted reviews, not edited or dismissed review events. Webhook
and polling presentation is identical for the same admitted fact. Operator-defined
webhook shell commands no longer run for GitHub feedback events.

### Typed conditions and match preview

**Typed conditions** add an optional `predicates` array to each rule. Conditions are ANDed with one another, the existing per-rule filters and saved legacy equality matches. Shared scope is an additional AND only when enabled. Rules run in their stored array order, not ID order; the first enabled match wins, including `ignore`. Later rules are shown as **shadowed**, not as additional actions.

```json
{
  "id": "review-changes",
  "enabled": true,
  "source": { "integration": "github", "output": "pull_request.reviewed", "version": 1 },
  "filters": { "squadRouting": true, "audience": "any" },
  "predicates": [{ "field": "state", "op": "in", "value": ["changes_requested"] }],
  "action": { "type": "notify-manager" }
}
```

Fields are allowlisted per provider, event and version in the authenticated output catalog (`GET /api/integrations/outputs`, `predicateFields`). GitHub examples include review `state`, CI `workflow`/`state`, numeric issue/PR numbers, label/assignee collections, review-comment `path`/`line`, and `mergeConflict` on PR updates. Linear issue assignment supports `issue.id`, `issue.title`, `teamId` and `assignee`. Only fields actually present in the normalized event can match. Existing subscription `fields` and legacy `match` behavior are unchanged.

| Field type              | Operators                     |
| ----------------------- | ----------------------------- |
| String, number, boolean | `eq`, `neq`, `in`, `exists`   |
| Number                  | Also `gt`, `gte`, `lt`, `lte` |
| String array            | `contains`, `exists`          |

- `in` takes a nonempty array of the field's scalar type; `contains` takes one string and checks for an **exact member**, not a substring. No regular expressions, expression trees, coercion or arbitrary payload traversal.
- All comparisons, **including `neq`**, fail for absent/null values. `exists: true` checks non-null presence; `exists: false` checks missing or null. Empty strings, false, zero and empty arrays are present; an empty array never satisfies `contains`.
- GitHub repository/login fields and assignee collection members compare case-insensitively. Labels, review states, workflow names, paths and Linear identifiers are case-sensitive. Only the existing repository-pattern filter interprets `*` as a wildcard; typed equality does not.
- At most 16 conditions per rule, 100 operands per `in`, and 2,000 characters per string. Unsupported fields/operators, wrong operand types, null operands and extra properties are rejected on squad configuration writes. Changing the event in the editor clears incompatible conditions. An omitted or empty conditions list adds no restriction.

**Match preview** runs locally against unsaved rules and shared scope using the same evaluator as live rule selection. Enter a synthetic JSON object with flat field-name keys (for example `{"repository":"owner/repo","issue.number":15,"labels":["bug"]}`). The supported-fields disclosure lists types. Omit absent fields or use null. Select an attached connection if testing an account-specific rule; enter a hypothetical GitHub login and mention checkbox for account-involvement checks. The login is not read from the connection.

The trace explains failed filters, empty/ignored shared scope, disabled rules, self-comment suppression, the selected action, and first-match shadowing. It contains no event values, configured operands or additional instructions. The preview reads no stored events, accepts no raw bodies/credentials, saves nothing and sends nothing. Legacy matches on fields outside the sample allowlist cannot be populated in a synthetic sample.

This is a **rule-selection preview, not a delivery guarantee**. It assumes an authorized normalized event; connection access, provider suppression, existing work-stream subscriptions, paused/waiting work, resource bindings, and deduplication still govern actual dispatch. Changing rules or previewing an event never replays previously handled events.

A squad must have an assigned, usable connection with access to the event resource. Exact repositories in routing or rules declare relay and issue-polling interests. Wildcard patterns filter received webhooks but do not enumerate an account’s repositories. New PR review requests need webhook/relay delivery; polling follows already tracked PRs and issue assignments. Linear currently supplies issue-assignment events. Additional providers can supply their own event adapters while using the same actions.

### Follow an attached issue or pull request

With **Code hosting** enabled, a work stream automatically subscribes to updates for
every resource in its canonical tracked set: the primary delivery PR (`codeHost.changeRequest`),
plus anything recorded in `metadata.tracked[]`. Event-created streams already have the
triggering issue or PR attached. Attach more resources explicitly instead of
hand-writing metadata:

```bash
# Attach the resource an integration event observed (idempotent; the squad
# must own the connection that observed it)
ficus workstream track <ws-id> --event <event-id>

# Attach by explicit reference
ficus workstream track <ws-id> --issue owner/repo#12
ficus workstream track <ws-id> --pr owner/repo#34

# Attach a PR and flag it as an additional delivery pull request — it must
# also be merged before the stream can complete
ficus workstream track <ws-id> --pr owner/repo#35 --delivery

# Attach by resource URL
ficus workstream track <ws-id> --url https://github.com/owner/repo/issues/12
```

`--delivery` is rejected together with `--issue` or `--event` — only a pull
request can be a delivery change request.

A URL merely mentioned in the description, or attached with `create --from-url`,
is reference material only — it is not tracked and receives no updates. Use
`ficus workstream tracked <ws-id>` (alias `links`) to see what a stream tracks, its
source (delivery PR or tracked), whether a tracked PR is flagged for delivery,
its observed merge state, and whether each has an active subscription.
`ficus workstream untrack <ws-id>` removes one (the delivery PR itself
cannot be untracked this way — change `codeHost.changeRequest` instead).

A stale `metadata.github.repo` + `metadata.github.issue` pair — the old way of
following a single issue — is converted automatically at startup into a
`tracked` issue entry and the `github.issue` key is removed; it is never read
afterward, so new work should always use `track`.

Issue events use the same recipient setting and retained-delivery rules as PR events. Active workflows deliver to their configured recipient; parked started workflows can notify their owner while retaining worker delivery; explicit pauses and never-started workflows stay held. Tracked resources may coexist with the delivery PR binding in the same or a different repository; tracking or untracking one never changes another.

An issue closing, or any non-delivery tracked resource's activity, is
information only — it never completes the work stream, clears an open wait, or
bypasses admission and pauses. Only the delivery PR(s)' own merge/completion
evidence, verified live at `ficus workstream finish`, does that — the primary
delivery PR plus any tracked PR flagged `delivery: true` must all be merged.

Comments, review line comments, and submitted reviews authored by the connected GitHub account are recorded but do not notify agents or start work streams. This echo protection applies to Code hosting, explicit workflow subscriptions, and squad rules (including **Any matching event**), and is rechecked before queued delivery. Other accounts' comments still reach linked work streams, including review bots. Assignment, merge, and CI events are unaffected. Legacy instance-level ingress without a connected account cannot identify self-authored events.

Set `github.connectionId` to choose an attached account explicitly. Otherwise the code-host connection, or the original event's connection when it refers to this issue, pins routing; without a pinned connection, normal squad authorization applies. Removing or rebinding the issue invalidates pending delivery. Disabling **Code hosting** disables inferred PR and issue subscriptions; explicit workflow subscriptions remain available. Squad manager rules remain fallbacks and do not override a linked stream's subscription settings.

## Author trust and held feedback

Public GitHub authors can write prose that reaches fully privileged agents. Each
squad therefore has an **author filter** (`squads.github_author_filter`, a column
rather than metadata so generic squad updates cannot change it). Migration
`0204_github_author_filter` sets it OFF for squads that existed at rollout and ON
for new squads. User documentation: `apps/docs/src/content/docs/connect/github.mdx`.

- **OFF** keeps pre-feature routing: no capture, hold, queue or trust lookup.
  Exact connection and repository authorization still apply.
- **ON** gates otherwise-matching feedback (issue and PR comments, reviews,
  inline review comments, issue and PR text) before any agent effect: inbox
  delivery, wake, consultant creation, work creation and trigger runs. This
  covers squad rules, tracked issue/PR subscriptions, workflow subscriptions,
  parked-owner notices, webhook, relay and polling paths, and retries.

**Trust** (`feedback-trust.ts`) is evaluated fresh for each event and never cached as
a derived allowlist. An author is trusted when either:

- **Dynamic:** a Ficus human with a verified personal GitHub link
  (`github_personal_identities`) has effective `squads:update` in THAT squad.
- **Manual:** `github_trusted_authors` holds an entry for the squad. Entries are
  keyed by numeric GitHub account ID and record the login and `User`/`Bot` type
  for display.

Usernames, `author_association` labels and the webhook sender are never
authority. The content author is attributed per item (`feedback-envelope.ts`).
An edit is attributed to its editor only when the provider proves who edited;
otherwise the edit is held. Unknown or unresolvable authors are held, not
allowed.

**Actions** (`objectKind: 'action'`): issue `assigned`, `unassigned`, `labeled`,
`unlabeled`, `closed`, `reopened` and pull request `assigned`, `unassigned`,
`labeled`, `unlabeled`, `review_requested`, `review_request_removed`
(`GITHUB_ACTION_EVENTS`). The authority is the signed webhook sender, attributed
as the creator, so a trusted actor's assignment or review request is delivered
automatically and an untrusted actor's is held. The delivered fact is a fixed
projection: repository, number, action, actor, assignee, requested reviewer or
team, label names, assignee logins and the canonical URL. It never includes the
parent's title or body, whoever wrote them; agents fetch those themselves. Each
action is its own object (parent ID plus a digest of action, target and time),
so out-of-order actions are not stale versions of each other. Rule matching and
work-stream bindings still read the source fact, so predicates such as
`requestedReviewer`, `assignee` and `issue.title` keep working. Polled actions
have no signed actor and are held (`unknown_editor`). Issue and PR `edited`
events stay content and are held without a verified editor, because the payload
does not prove who changed which field. PR `closed`, `reopened`, `synchronize`
and draft changes are status facts.

Personal linking (`routes/github-identity.ts`, `personal-identity.ts`) reuses the
GitHub OAuth/device transport with a separate `github_identity` purpose. It
stores only the verified account ID and login, never assigns a connection or
signing key, and disposes of the token locally without remote revocation. The
provider token may be shared with other consumers of the same OAuth app, so
local disposal is the conservative choice.

**Held events** are captured as immutable revisions (`github_feedback_objects`,
`github_feedback_revisions`, `github_feedback_sources`) bound to a content hash.
They produce no agent effect and no prose in inbox subjects, summaries, history
or alerts. Moderation (`feedback-moderation.ts`, `routes/github-feedback.ts`) is
`allow_once`, `deny` or `allow_trust` on selected revision versions. Bulk
requests of up to 50 are compare-and-set on the decision version and idempotent
per request ID. A stale version returns 409. `allow_trust` adds manual trust
and releases only the selected revisions; other held events stay held. A later
edit creates a new revision that is evaluated again.

**Release** (`feedback-release*.ts`) runs normal output routing when the decision
is made. The approved event reaches the current recipients, which may differ from
the recipients at hold time; hold-time routing is kept for display only. Delivery
is receipt-based and exactly once. It respects pauses, parking and waits, never
approves workflow gates, and ends `obsolete` when nobody should receive it. The
**Releasing** queue shows `retry` and `retained` states.

Turning the filter OFF (`author-filter-setting.ts`) records a one-time allow by
that human for each held revision with readable content, released the same way.
Held revisions with unavailable content stay pending. Turning it back ON never
re-holds released events.

**Decision-model screening** (`feedback-screen-policy.ts`, `feedback-screening.ts`)
is opt-in per squad: `squads.github_untrusted_handling` is `hold` (default for new
and existing squads) or `screen`, set by `PUT .../github-feedback/untrusted-handling`
with the same human-only authority as the filter. With the filter ON and `screen`,
a new revision held only for `untrusted_author` gets a `github_feedback_screenings`
row in the capture transaction. The screen runs off the webhook path (an
immediate kick plus the worker's `github-feedback-screening` sweep) and calls
`decide('github-firewall', …)` with fixed questions; the feedback (title, body,
path, line, review state, author login) goes only in `state`. It passes only when
`instructs_agent` is below 0.2 and `intent` is `benign` with confidence of at least
0.8; state over 24,000 characters is held without asking. A pass is one
compare-and-set from `pending` at the queued decision version and content hash to
decision `screened` (`releaseState: ready`, reason `decision_model_allowed`, no
`decided_by_user_id`), which the release worker delivers exactly like
`allow_once`; no trust is added. Every other outcome (unsafe, uncertain,
`unavailable`, `unconfigured`, `too_long`, or `skipped` because a human decided
first, the content changed or the squad switched back to `hold`) leaves the
revision pending and records the verdict for the review window. A lease makes
retries safe; a screen that crashes three times is left held as `unavailable`.
Audit rows use actor `decision-model` and action `github.feedback.screen`.

**Human-only authority.** Trust edits, moderation and the filter setting require a
literal enabled human identity with effective `squads:update` in the squad.
Agents are rejected and audited, including delegated user-associated tokens.
`trust-mutation-guard.ts` also serializes the user and role routes (profile,
enable, disable, delete, roles and role assignments). Any change that would
alter a linked user's effective dynamic trust needs that human authority. The
guard compares effective trust before and after, so agents' unrelated role
tools keep working. Generic squad updates reject the filter column, and trust
lives in its own tables, not in squad metadata. Decision and audit rows record
the actual human.

**Status facts** (`feedback-status.ts`) keep flowing while feedback is held:
PR updated, closed and merged, CI completed and Dependabot alert updates. They
are rendered from an allowlist of numeric and state fields with no titles,
descriptions, workflow names or log text. Dependabot stays webhook-only.

**Managed reads** honor the same decisions. Memory indexing projects GitHub
threads with held or denied items replaced by placeholders (`managed-content.ts`).
Search, outline and backlinks withhold documents without provenance in ON
squads. `resolveEventTrackedResource` refuses held events. Activity drops issue
titles. Legacy YAML shell and batch handlers for feedback events are retired.

**Rollout fence** (`feedback-upgrade.ts`): undelivered legacy GitHub prose already
in agent inboxes of an ON squad is hidden from list, search, count, read and
attachment reads, and final acceptance refuses it. Delivered rows stay readable
history and are never re-sent. Nothing is backfilled or replayed.

**Limits and residual risk.** Revisions and decisions are kept with no retention
sweep yet, like the raw output events they reference. Agents keep their
unrestricted tools: direct `gh` or API fetches and repository content can still
carry untrusted text. The filter governs what Ficus delivers and indexes; it is
not prompt-injection immunity.

## Dependabot dependency-security webhooks

**Squad settings → Integrations → GitHub → Event rules → Dependabot alert**
uses the existing actions, account selector, enabled checkbox, repository scope
and typed conditions. The inherited default is enabled and notifies the manager
for **high or critical, open** alerts. It never starts a consultant by default. Low/medium
webhook events are still accepted; change the severity condition to route them.
Explicit saved rule arrays are preserved: add the Dependabot rule yourself if
that squad already has saved rules. An explicit empty array disables defaults.

Conditions include `severity`, `state`, `action`, `repositoryId`, alert number,
GHSA advisory, package, ecosystem, manifest, affected range and first patched
version. Native actions are `created`, `reopened`, `reintroduced`,
`auto_reopened`, `fixed`, `dismissed`, `auto_dismissed`, and
`assignees_changed`. Shared issue label filters do not apply to security alerts.

Webhook intake requires a GitHub App's **Dependabot alerts: read-only** repository
permission, an installation on the selected repositories, and a connected
user who can read their security alerts. For direct delivery, subscribe the
App/repository webhook to **`dependabot_alert`** and configure the existing
signed webhook receiver. Account repository visibility alone is insufficient.
Ficus checks the exact alert under the squad's connection before accepting
private security details. It does not route every installation alert to every
squad: declare a shared repository scope or per-rule repository filter.

Dependabot intake is **webhook-only**. Enabling a rule, assigning an account,
subscribing to an alert, or tracking an alert does not list existing alerts or
schedule polling. There is no automatic backfill, daily reconciliation, or
missed-delivery recovery: existing alerts and missed webhooks are intentionally
not discovered. Retired polling cursors and dispatch records remain inert;
pending API observations cannot route new work or notifications. A later real
webhook can refine historical evidence under the same identity without repeating
already handled notifications. Existing inbox history is not changed.

Permission failures, unavailable accounts, rate limits, and other intake errors
do not create manager health/housekeeping messages or wakeups. Failed exact-alert
authorization remains fail-closed; it never reports zero vulnerabilities or
releases private alert details. Actual authorized webhook events continue to
follow the configured rules (manager notification by default).

Webhook replays use immutable repository ID + alert number +
snapshot timestamp/state, within connection/squad authority. Renames/transfers
retain alert identity; update repository routing names when needed. A later
reopen remains distinct from an earlier open snapshot. Notices include a
stable same-package/advisory grouping key across manifests for consolidated
triage. Workflow-created streams and event references track a typed
`dependabot_alert` resource, never a delivery PR. Use the notification's
`--from-event` / `workstream track --event` commands, or an alert URL with
`workstream track --url`; do not hand-write GitHub metadata.

**Create work stream** uses normal workflow selection and owner preparation /
admission. It creates remediation work only for open alerts, not fixed,
dismissed or assignment-only events, and reuses existing resource receipts.
Fixed/dismissed updates can inform tracked work but never complete it, approve
a merge, or prove acceptance criteria. Webhook intake does not dismiss alerts,
upgrade dependencies, change security settings, merge, or deploy anything.

Managed shared-App delivery additionally requires Platform support for
`dependabot_alert` ingress and exact alert-resource authorization, plus the
operator's App permission/subscription setup. Do not assume managed relay
coverage until both are verified. Direct signed webhooks operate independently
of managed relay support.

References: [GitHub Dependabot webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#dependabot_alert)
and [REST exact-alert authorization](https://docs.github.com/en/rest/dependabot/alerts#get-a-dependabot-alert).
