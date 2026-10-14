# Linear integration

Manage Linear in **Settings → Integrations → Linear**. Enable the integration, create a named account with a personal API key, validate it, and enable the account. Keys can be limited to specific teams in Linear; read access is sufficient for issue search and assignment routing. See [Linear’s API documentation](https://linear.app/docs/api-and-webhooks).

In a squad’s **Integrations** tab, enable Linear and choose an account. Add team IDs to route assigned issues to its manager. Disabling the squad integration preserves the account choice; re-enabling restores it. Global disable preserves all account and squad settings while stopping use.

For webhook delivery, configure an Issue webhook in Linear with the URL shown in the global card and the same signing secret in both applications. Save a signing secret to enable delivery; disabling clears it. Stored secrets are never returned to the browser. Rotate by entering a new value in both places.

The connected account supplies the assignee identity. Ficus verifies current issue access, team, and assignee before delivering an event. Workflow subscriptions and squad triggers can consume the typed outputs below. When a flow handles the event, the same squad’s legacy team-based manager notification is suppressed.

## Outputs

A verified `Issue` or `Comment` webhook normalizes into one of these typed outputs, the same way GitHub events do — consumable from workflow subscriptions, squad event rules, and predicate conditions, including [decision conditions](github-integrations.md#decision-conditions) (`GET /api/integrations/outputs`):

| Output             | Emitted when                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue.assigned`   | The issue's assignee changes and it now has one                                                                                                                                                                            |
| `issue.unassigned` | The issue's assignee changes and it now has none                                                                                                                                                                           |
| `issue.updated`    | State, title, or labels change. `action` is `state`, `title`, or `labels`, or `updated` for any other field change; `state` carries the Linear workflow state's _type_ (e.g. `started`, `completed`), not its display name |
| `issue.comment`    | A comment is created or edited                                                                                                                                                                                             |

Fields: `issue.id`, `issue.number`, `issue.identifier` (e.g. `ENG-123`), `issue.title`, `teamId`, `teamKey`, `assignee`, `action`, `actor`, `state`, plus the predicate-only `labels`. Linear's `Issue` create and remove events produce no output. There is no polling fallback for Linear — every output depends on webhook delivery.

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

Live memory search resolves the calling squad’s selected connection. Existing memory grants and team-key filters further restrict search. `ficus integration exec linear --squad <id> -- <command>` supplies the selected key to a command without exposing it in CLI output.

On upgrade, a legacy `LINEAR_API_KEY` is imported once as a disabled account. Validate, enable, and assign that account in Integrations. The old webhook secret is moved into encrypted integration settings. `LINEAR_USER_ID` and legacy secret editing are retired. Existing team routing metadata is preserved.
