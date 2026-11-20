# Linear integration

Manage Linear in **Settings → Integrations → Linear**. One `linear` integration offers two kinds of connection, described in [Connections](#connections): the Ficus **agent app**, installed in a Linear workspace with OAuth, and a **personal API key**. Squad rules, team routing, tracked issues, outputs, the CLI and the skill are the same for both.

## Connections

A squad uses exactly one Linear connection, of either kind. Both kinds can exist on one instance; moving a squad from a key to the app is an ordinary reassignment in its Integrations tab, and tracked issues keep matching because they match on the Linear issue ID.

**Agent app (OAuth).** Ficus appears in the Linear workspace as its own app member, so people can delegate issues to it and mention it. **Install Ficus in Linear** opens Linear's consent page with `actor=app` and the scopes `read`, `issues:create`, `comments:create`, `app:assignable` and `app:mentionable`; a Linear workspace admin must approve it. The connection is named `<Workspace name> (Ficus app)` and identified by the Linear organization ID, so installing again in the same workspace (or **Reconnect** on the connection) updates the same connection instead of adding another one. Validation reads `viewer { id name app }` and `organization { id name urlKey }`, and fails with `workspace_identity_mismatch` unless the token's viewer is an app user with the stored app user ID in the stored organization; a person's own (`actor=user`) token is never accepted as an app connection. Workspace renames are picked up on the next validation.

App connections get the full OAuth lifecycle (see [Integration contracts](integration-contracts.md)). Linear access tokens last 24 hours and every refresh rotates the pair, so Ficus refreshes proactively before expiry, persists the new pair before validating it, and serializes refreshes per connection. A refresh that Linear refuses with `invalid_grant` marks the connection **Reconnect required**. An expired access token is never handed to a command. Removing or replacing an app connection revokes its access token. Revoking a token is token cleanup only: to remove the app from the workspace, uninstall it in Linear's settings.

- **Ficus Cloud:** the hosted Ficus app is used through the Platform OAuth broker; nothing needs configuring on the instance.
- **Self-hosted:** create your own OAuth application in Linear's API settings (it can have any name; it appears in Linear under that name). Under **Agent app** in the Linear card, Ficus shows the callback URL (`<public URL>/settings/integrations/oauth/callback/linear`) and the app webhook URL (`<public URL>/api/webhooks/linear-app`) to copy into that application. Enable webhooks with the categories Agent session events, Inbox notifications, Permission changes, Issues and Comments. Then save the application's client ID, client secret and webhook signing secret in Ficus and choose **Install Ficus in Linear**. Both secrets are stored encrypted in `__integration-oauth-app:linear` and are never returned; **Replace application settings** overwrites all three. App connections authorized by a previous client ID need **Reconnect** after it changes. The instance needs a public URL for the callback.

**Personal API key.** Create a named account with a personal API key, validate it, and enable the account. Keys can be limited to specific teams in Linear. Read access is enough for issue search and assignment routing; give the key write access as well (creating issues and comments) so agents can update issues with the [Linear CLI](#agent-cli). Validation proves only that the key can read, and is recorded as `issues:read`; a read-only key fails when an agent tries to write. API-key connections are never refreshed, revoked or expiry-checked, and the stored key is kept exactly as entered. See [Linear’s API documentation](https://linear.app/docs/api-and-webhooks).

**Credential shape.** An API-key connection stores the raw key and its configuration is `{ version: 1 }`. An app connection stores an OAuth credential bundle and its configuration is `{ version: 2, mode: "app", organizationId, organizationName, organizationUrlKey, appUserId, appUserName, scopes }`, where `scopes` lists what Ficus requested at install (it is not shown in the settings API). A connection whose credential does not match its configuration's mode fails validation. Every Linear call Ficus makes, and the CLI's `LINEAR_API_KEY`, use one `Authorization` value: the raw key for an API-key connection, `Bearer <access token>` for the app.

## Squads and webhooks

In a squad’s **Integrations** tab, enable Linear and choose an account. Add team IDs to route assigned issues to its manager. Disabling the squad integration preserves the account choice; re-enabling restores it. Global disable preserves all account and squad settings while stopping use.

For webhook delivery, configure an Issue webhook in Linear with the URL shown in the global card and the same signing secret in both applications. Save a signing secret to enable delivery; disabling clears it. Stored secrets are never returned to the browser. Rotate by entering a new value in both places.

The connected account supplies the assignee identity. Ficus verifies current issue access, team, and assignee before delivering an event. Workflow subscriptions and squad triggers can consume the typed outputs below. When a flow handles the event, the same squad’s legacy team-based manager notification is suppressed.

## Agent CLI

A squad with an enabled, assigned Linear connection gets the `linear` command ([schpet/linear-cli](https://github.com/schpet/linear-cli), ISC license) and the `linear` agent skill (`config/skills/linear/SKILL.md`), the same way Notion provides `ntn`. Agents can view, query, create and update issues, comment, and send raw GraphQL with `linear api`.

**Installation.** The plugin's sandbox setup step installs pinned release 3.1.0 from the GitHub release assets, not from npm: the npm package `@schpet/linear-cli` is a wrapper whose install script downloads the same asset without verifying it. The step selects the `x86_64` or `aarch64` glibc Linux asset, checks its pinned SHA-256 digest before extracting anything, and refuses any other platform. Upstream ships glibc builds only, while the Docker runtime image is Alpine (musl) with amd64-only glibc compatibility. The installed `linear` is therefore a small launcher that runs the binary through the Nix glibc loader and libgcc of the pinned devbox Node.js package, which works on every Linux runtime and architecture. It has been run on x86_64 (Ubuntu and Alpine); the `aarch64` asset has been checked by digest and loader name (`ld-linux-aarch64.so.1`) but not yet run on arm64 hardware. The step needs the devbox packages `nodejs@24.12.0` (hashing and the glibc runtime) and `xz@5.8.3` (the archive format). Readiness requires `linear --version` to print `linear 3.1.0`. Host sandboxes do not reconcile a managed toolchain, so they use whatever `linear` the operator installed.

**Credentials.** `linear` is wrapped like `gh` and `ntn` (see [Integration command execution](integration-execution.md)). Each command, including one started from a script, fetches the selected connection's `Authorization` value as `LINEAR_API_KEY` for that process only: the raw key for an API-key connection, `Bearer <access token>` for the agent app. For the app, the sandbox also gets `LINEAR_ORGANIZATION_URL_KEY`, the workspace's URL key, so agents can tell which workspace the CLI acts in; API-key connections have no such binding. Nothing is written to disk, and disabling or detaching the connection takes effect on the next command; the wrapper then fails instead of running the CLI with any other credential.

**Account selection.** The CLI resolves a key from the process environment first, then a `.env` file, then `api_key` in a project or global `.linear.toml`, then credentials stored by `linear auth login` (a credentials file or the system keyring). Ficus closes each other path:

- `LINEAR_API_KEY` is always set by the wrapper, so `.linear.toml` keys and stored credentials are never consulted.
- `LINEAR_IGNORE_ENV_FILE=1` stops `.env` loading. Without it, a repository `.env` could set `LINEAR_GRAPHQL_ENDPOINT` and receive the key. The endpoint is also pinned to `https://api.linear.app/graphql`.
- `--workspace` fails with a usage error while `LINEAR_API_KEY` is set, so it cannot switch to a stored account.
- A project `.linear.toml` can still set nonsecret defaults such as the team. The skill tells agents to pass `--team` explicitly.
- The skill forbids `linear auth login` and `logout`.

A person's own terminal has no agent identity, so the wrapper runs their own `linear` login unchanged.

**App tokens.** The CLI sends `LINEAR_API_KEY` verbatim as the `Authorization` header (checked against a local server for both a raw key and a `Bearer` value), so the agent app's `Bearer <token>` needs no CLI change. With an app connection, everything the CLI writes appears in Linear as the app, not as a person.

## Outputs

A verified `Issue` or `Comment` webhook normalizes into one of these typed outputs, the same way GitHub events do — consumable from workflow subscriptions, squad event rules, and predicate conditions, including [decision conditions](github-integrations.md#decision-conditions) (`GET /api/integrations/outputs`):

| Output             | Emitted when                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue.assigned`   | The issue's assignee changes and it now has one                                                                                                                                                                            |
| `issue.unassigned` | The issue's assignee changes and it now has none                                                                                                                                                                           |
| `issue.updated`    | State, title, or labels change. `action` is `state`, `title`, or `labels`, or `updated` for any other field change; `state` carries the Linear workflow state's _type_ (e.g. `started`, `completed`), not its display name |
| `issue.comment`    | A comment is created or edited                                                                                                                                                                                             |

Fields: `issue.id`, `issue.number`, `issue.identifier` (e.g. `ENG-123`), `issue.title`, `teamId`, `teamKey`, `assignee`, `action`, `actor`, `state`, plus the predicate-only `labels`, whose names compare case-insensitively in event rule conditions (`contains blocked` matches `Blocked`). Linear's `Issue` create and remove events produce no output. There is no polling fallback for Linear — every output depends on webhook delivery.

## Authority model

A verified signature proves the payload came from Linear; it does not by itself authorize any squad to see it. For every squad with an enabled, assigned Linear connection, Ficus queries that squad's own connection to confirm it can currently read the issue — and, for `issue.assigned`/`issue.unassigned`, that the connected account is the assignee being added or removed — before publishing the event under that squad's authority. A squad whose connection cannot read the issue never receives it, even when another squad's connection can. Linear has no repository-level webhook scoping to fall back on, so this per-squad access probe runs live for every event, every squad.

## Tracked issues

Work streams can track Linear issues the same way they track GitHub issues and pull requests — see [Work references: tracked issues and pull requests](work-streams.md#tracked-issues-and-pull-requests). Linear-specific notes:

- Identity: `{ integration: "linear", repository: <team key, lowercase>, kind: "issue", number, externalId: <Linear issue UUID> }`. `externalId` is what actually holds a subscription together: a comment delivery carries only the issue UUID, not the team key or number, so a tracked issue matches on `externalId` when it is known and falls back to team key + number only when it isn't.
- Reference forms: `KEY-123` (`ficus workstream track <ws> --issue KEY-123`) or a Linear issue URL (`https://linear.app/<workspace>/issue/KEY-123[/slug]`).
- Linking resolves the issue through the squad's own Linear connection (a live `describe` GraphQL lookup), which is also how `externalId` and `url` get recorded. No usable connection → `409 Linear connection needs revalidation before linking`; the issue is unreadable or doesn't exist → `404`; the squad has no Linear connection assigned → `403`.
- Pull requests are not supported for Linear: `ficus workstream track --pr` or `--delivery` against a Linear reference is rejected with `400`, and a Linear issue can never be a delivery change request.
- A tracked issue subscribes to `issue.assigned`, `issue.unassigned`, `issue.updated`, and `issue.comment`, with ids `tracked-<12 hex>-<event>` derived from the resource's identity.
- `ficus workstream create --from-event <id>` and `ficus workstream track --event <id>` work for every Linear notification, including comments. An assignment or update fact carries the team key and number, so its `Tracked resource:` line reads `issue KEY-123`; a comment fact carries only the issue UUID, so the line names that UUID and the issue is resolved through the squad's own Linear connection at link time (the same `describe` lookup, with the same `409`/`404`/`403` answers).
- Trigger-created streams (`start-workstream` squad rules) record the issue in `metadata.tracked[0]`, including rules on `issue.comment` — for those the entry is completed through the squad's connection when the stream is created, and is simply omitted if that connection cannot read the issue then. Streams created before this feature may still carry the legacy `metadata.linear.issueId` correlation instead; that path keeps working for those streams, but there is no backfill converting them to `tracked` entries.

## Activity

Linear issue and comment webhooks project into the squad's Activity feed (`squad_activity`, `linear-issue` family, lane 71, kind `issue`). Assignment, state, title, label, and generic-update facts come from `Issue` webhooks; new and edited comments come from `Comment` webhooks. One row is written per stream that tracks the issue — a stream matches through its `tracked[]` entry's `externalId`, or, for older streams, the legacy `metadata.linear.issueId` — so a squad with no stream tracking the issue gets no rows, however the receipt was owned. A squad with team routing configured (`metadata.linear[].teamId`) owns the receipt even when no stream names the issue yet, which is what lets a row appear later once a stream starts tracking it; a `Comment` delivery carries no `teamId` at all, so comments are only ever owned through a tracking stream. There is no polling path for Linear Activity — only the webhook.

Live memory search resolves the calling squad’s selected connection. Existing memory grants and team-key filters further restrict search. `ficus integration exec linear --squad <id> -- <command>` supplies the selected key (and the fixed CLI settings above) to any other command without exposing it in CLI output.

On upgrade, a legacy `LINEAR_API_KEY` is imported once as a disabled account. Validate, enable, and assign that account in Integrations. The old webhook secret is moved into encrypted integration settings. `LINEAR_USER_ID` and legacy secret editing are retired. Existing team routing metadata is preserved.
