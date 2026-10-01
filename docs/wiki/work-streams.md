# Work references

Each Ficus instance assigns an immutable, increasing number to every work stream, across all squads. Use `#42` in conversations and labels and `42` in CLI/API lookups and URLs (`/squads/<squad>/work?ws=42`). Moving work does not change its number. Numbers are never reused; gaps are normal. Existing work is numbered by creation time, with UUID order breaking ties.

UUIDs remain internal keys and are still returned as `id`; API objects additionally return `number`. UUIDs and unique UUID prefixes remain accepted for lookup. Digits-only references prefer a work number; use a longer UUID prefix or full UUID when a numeric prefix collides. `#42` explicitly requests a numeric lookup (quote it in the shell and URL-encode the hash as `%23` in API paths). Ambiguous UUID prefixes fail rather than picking a stream. References are local to the instance, not globally unique across servers.

Examples: `ficus workstream get 42`, `ficus workstream get '#42'`, and `GET /api/workstreams/42`. Existing UUID links remain valid. Agent chats can use `[#42](ficus:ws:42)`; bare work numbers in prose are also linked, while code and explicit PR/issue references are preserved.

## Metadata lookup

Use `ficus workstream find-by-meta --match github.pr.number=42 --match github.repo=org/repo`
to match all criteria, optionally with `--status active`. The API equivalent is
`GET /api/workstreams/by-metadata?match=github.pr.number:42&match=github.repo:org/repo`.
The route requires the existing unscoped `workstreams:read` permission and limits the
database lookup to the caller's accessible squads; it does not grant access to other squads.
Privileged global identities retain their existing visibility and action-scope checks.

Paths are dot-separated, non-empty JSON object keys, matched case-sensitively without
trimming. Quotes, backslashes, whitespace, Unicode and SQL-looking text are literal key
data, not SQL syntax. Empty paths, empty segments (such as `a..b`) and NUL in paths or
values are rejected. Values may be empty or contain colons and equals signs. Numeric
metadata values match their text representation; numeric path keys remain object keys,
not array indexes. Dot notation cannot address keys containing literal dots, and the API's
first-colon separator cannot address keys containing colons. Repeated criteria for the
same path retain the last value. These lookups use bound query parameters for every path
segment and value.

## Tracked issues and pull requests

A work stream can track any number of GitHub issues and pull requests, and any
number of Linear issues, alongside the one PR that gates its delivery, and can
designate additional pull requests that must also be merged before the stream
completes. Pull requests are a GitHub-only concept here: Linear supplies
issues only, and `delivery` can never be set on a Linear entry — see
[Linear integrations: Tracked issues](linear-integrations.md#tracked-issues)
for the Linear-specific identity, linking, and subscription details. The
canonical set is computed, not stored as one field — it is the union of:

1. **The delivery PR** — `metadata.codeHost.changeRequest` (or the legacy
   `metadata.github.repo`/`metadata.github.pr.number`/`.url` equivalent). This is
   the primary delivery resource and always has source `delivery`.
2. **`metadata.tracked[]`** — an array of explicit entries, the canonical way to
   attach additional resources. A tracked pull request may carry `delivery: true`
   to designate it as an additional delivery pull request (rejected on issues).

Resolution walks the list in that order and de-duplicates by
`integration:repository:kind:number` (case-insensitive on the repository), so the
same PR referenced as both the delivery binding and a `tracked[]` entry appears
once, tagged with its first (highest-priority) source. A stale
`metadata.github.repo` + `metadata.github.issue` pair is no longer part of this
set: `migrateDatabase` runs an idempotent backfill at every startup that
converts any row still carrying that pair into a `tracked` issue entry
(repository lowercased, `connectionId` carried over) and removes the
`github.issue` key. `github.issue` is never read after that; use `tracked` /
`ficus workstream track` going forward.

### Delivery pull requests

Every work stream has at most one **primary** delivery PR (`codeHost.changeRequest`)
plus zero or more **flagged** delivery PRs — tracked pull requests with
`delivery: true`. Together they are the pull requests whose merge state gates
completion:

**Binding the primary delivery PR when it is opened.** When a code-host event (webhook or
polling) reports a pull request whose head branch is an active `pr-merge`/`pr-auto-merge`
stream's `metadata.git.branch`, in the stream's `codeHost.repository` (or legacy `github.repo`),
with the base equal to `metadata.git.baseBranch`, and the stream has no
`codeHost.changeRequest`, the pull request is bound to `codeHost.changeRequest {number, url}`
right away — opened, synchronize, review, and review-comment events all carry the head
identity. The event that bound it is routed to the stream, and earlier events for the same pull
request that arrived before the binding (for example a comment delivered ahead of the opened
event) are routed then, so review feedback is not lost. The same policy as finish applies:
fork heads, wrong bases, other repositories, and closed-unmerged pull requests never bind; an
existing (including manual) binding is never overwritten; only streams the event's connection
is authorized for are considered, so one squad never binds another squad's stream; and when
more than one stream claims the branch nothing is bound and finish-time resolution decides.
Issue comments and CI runs do not carry the head branch, so they cannot bind on their own.

**Resolving the primary delivery PR at finish.** When `ficus workstream finish` runs for a
`pr-merge`/`pr-auto-merge` stream whose `codeHost.changeRequest` is not set, it asks the code
host which pull request the stream's branch (`metadata.git.branch`) carries — one
owner-namespace scoped lookup (`GET /repos/{repo}/pulls?head={owner}:{branch}&state=all`),
which by construction never matches fork pull requests. Exactly one usable pull request is
bound and persisted to `codeHost.changeRequest {number, url}` before merge verification
continues (a merged candidate wins over an open one; closed-unmerged candidates and candidates
with the wrong base are never chosen). When the branch carries nothing, the stream records no
branch, or the candidates do not identify one pull request, finish fails with the exact
shape-matching manual bind command — `ficus workstream set-meta <id> codeHost.changeRequest
'{"number":N,"url":"<pr url>"}'` for canonical streams, `github.pr` for legacy
`metadata.github` streams, and a full `codeHost` object for unconfigured ones. The manual bind
is therefore needed only when the delivery PR comes from a different branch (or to replace a
wrong binding), and finish does not depend on webhooks, event timing, or connection state for
the binding to exist.

- `POST /api/workstreams/:id/tracked` accepts `{ url, delivery: true }` or
  `{ resource, delivery: true }` (only valid when the resource is a pull
  request) to flag a tracked PR as delivery, alongside the identity fields
  described below; the response includes `changed`. The CLI equivalent is
  `ficus workstream track <id> --pr owner/repo#n --delivery` (or
  `--url <pr-url> --delivery`). `--delivery` combined with `--issue` or
  `--event` is rejected — an issue is never a delivery change request, and an
  event's resource kind isn't known until the server resolves it.
- For `pr-merge`/`pr-auto-merge` completion, `ficus workstream finish` still
  verifies the primary change request is merged first (branch identity and the
  recorded `deliveredHead` come only from the primary PR), then additionally
  requires every flagged delivery PR to be independently verified as merged.
  An unmerged one fails finish with
  `409 Delivery pull request <repo>#<n> must be merged before completion`.
  `direct-merge` ignores flagged delivery PRs entirely.
- What is observed about each delivery PR is recorded in
  `metadata.delivery.pullRequests[<key>]` as
  `{ state: "open" | "merged" | "closed", at, headSha?, eventId? }`. Merge,
  close, and reopen events (`pull_request.merged`, `pull_request.closed`,
  `pull_request.updated` with `action: "reopened"`) update this under the
  stream's row lock, keyed by the matching delivery PR's
  `integration:repository:kind:number` key; a newer `occurredAt` always wins
  over a stale one. `ficus workstream finish` re-verifies every delivery PR live
  against the code hosting adapter and records the result, independent of
  whatever was last observed from events. Unobserved is treated as open —
  delivery is only complete on positive evidence.
- `GET /api/workstreams/:id/tracked` (and the web tracked panel, which reads
  that endpoint) is the only surface that returns the summary
  `delivery: { pullRequests: [{ key, repository, number, url?, primary, state, at?, headSha? }], complete }`,
  where `complete` is true only when there is at least one delivery PR and
  every one of them is `merged`. `GET /api/workstreams/:id` exposes no summary;
  it returns the raw stored `metadata.delivery` along with the rest of the
  work stream's metadata.
- Delivery PR subscriptions (both the primary `code-host-*` ones and any
  flagged tracked PR's `tracked-*` ones) may pass the delivery-approval wait
  once the flow reaches `completion-ready`, so CI/merge/review feedback on a
  delivery PR still reaches the recipient during that wait. Subscriptions for
  non-delivery tracked resources never do, and neither does an explicit
  subscription written in the flow definition — only those two reserved id
  prefixes qualify, so a hand-written `match` on a delivery PR cannot buy a
  way past the wait.

### `metadata.tracked[]` entry shape

```json
{
  "integration": "github",
  "repository": "owner/repo",
  "kind": "issue",
  "number": 12,
  "connectionId": "0f1e2d3c-...",
  "url": "https://github.com/owner/repo/issues/12",
  "addedAt": "2026-01-01T00:00:00.000Z",
  "origin": {
    "eventId": "b2b7...",
    "resourceKey": "owner/repo#12",
    "output": "issue.assigned",
    "occurredAt": "2026-01-01T00:00:00.000Z"
  }
}
```

`integration`, `repository`, `kind` (`issue` or `pull_request`), and `number` are
required identity fields; `connectionId` and `url` are optional. `addedAt` is
stamped server-side when absent. An entry with `kind: "pull_request"` may also
carry `"delivery": true` to designate it as an additional delivery pull request
(see [Delivery pull requests](#delivery-pull-requests) above); setting it on an
issue is rejected. `origin` records the integration event that
produced the entry and is **server-managed**: `workstream create --from-event`
and `workstream track --event` stamp it for you, from the event they resolve.
A plain metadata write (`PATCH`/`set-meta`) has no event to resolve, so a
hand-written `origin` on a new entry is rejected with `400`; only
`create --from-event` may carry one on directly-written metadata, and only for
the event named in that same request.

A Linear issue entry additionally carries `externalId` (the Linear issue's own
UUID): `{ "integration": "linear", "repository": "<team key, lowercase>", "kind": "issue", "number": 12, "externalId": "1f2e3d4c-..." }`.
Its `repository` is the lowercased Linear team key (`eng`), not an `owner/repo`
path, and its `number` is the issue's team-scoped number. `externalId` is what
subscriptions actually match on — a Linear comment fact carries only the issue
UUID — so it takes priority over team key + number whenever it is known. The
human-readable label for a Linear entry is `KEY-123` (`trackedResourceLabel`),
not `owner/repo#12`.

Never hand-write `github.*`/`codeHost` metadata, or a raw `tracked[]` entry, to
attach a resource. Use the CLI/API paths below; they resolve identity, check
authorization, and stamp `origin` atomically.

### Adding and removing tracked resources

```bash
ficus workstream create "<title>" --squad <squad-id> --from-event <event-id>   # new stream, idempotent
ficus workstream track <ws-id> --event <event-id>                             # attach to an existing stream
ficus workstream track <ws-id> --issue owner/repo#12
ficus workstream track <ws-id> --issue KEY-123                                 # Linear issue
ficus workstream track <ws-id> --pr owner/repo#34
ficus workstream track <ws-id> --pr owner/repo#35 --delivery
ficus workstream track <ws-id> --url https://github.com/owner/repo/pull/34
ficus workstream track <ws-id> --url https://linear.app/workspace/issue/KEY-123/slug
ficus workstream untrack <ws-id> --issue owner/repo#12
ficus workstream tracked <ws-id>   # alias: links
```

API surface, each gated by its own permission on the work stream's squad:

- `POST /api/workstreams` accepts `integrationEventId` (a UUID). It resolves the
  event's issue/PR, stores the link with `origin`, and replays of the same event
  return `200 { ...stream, reusedFromEvent: true }` instead of creating a
  duplicate stream. Requires `workstreams:create`.
- `GET /api/workstreams/:id/tracked` returns
  `{ resources: [...{ integration, repository, kind, number, key, source, delivery, url?, subscriptionIds, subscribed, mergeState? }], subscriptions, delivery: { pullRequests: [...], complete } }`
  (plus `connectionId`, `addedAt` and `origin` when present). Requires `workstreams:read`.
- `POST /api/workstreams/:id/tracked` accepts exactly one of `{ "event": "<uuid>" }`,
  `{ "url": "<resource url>", "delivery"?: true }`, or
  `{ "resource": { integration, repository, kind, number, connectionId? }, "delivery"?: true }`.
  The response includes `changed`. Requires `workstreams:update`, or
  `workstreams:respond` for an agent bound to the stream.
- `DELETE /api/workstreams/:id/tracked` accepts `{ "url": ... }` or `{ "resource": ... }`.
  Untracking the delivery PR is rejected with `409 { code: "delivery_change_request" }`
  — edit `metadata.codeHost.changeRequest` instead. Same permission as the `POST` above.
- Writing `metadata.tracked` directly through `PATCH`/`set-meta` is schema-validated
  shape-for-shape, and any newly introduced entry is authorized exactly like an
  explicit track request. Same permission as the `POST`/`DELETE` above (the
  general work-stream `PATCH` gate: `workstreams:update`, or `workstreams:respond`
  for a bound agent).

### Authorization: identity is not access

A URL or an integration event only supplies **identity** — which issue/PR is
meant. **Access** always comes from the squad's own integration connection:

- An event is only usable if it was observed under a connection this squad
  owns; an event belonging to another squad, or one observed at instance-wide
  (non-squad) authority, is rejected with `403`. An unknown event ID is `404`.
- A URL or explicit `{ integration, repository, kind, number }` reference is
  checked against the squad's assigned, authorized connection for that
  integration; a squad with no authorized GitHub or Linear connection gets
  `403`.
- For Linear, this authorization also resolves identity: linking asks the
  squad's connection to `describe` the issue over GraphQL, which is where
  `externalId` and `url` come from. No usable connection → `409` (needs
  revalidation); the connection can't read the issue → `404`.

This means the same GitHub issue or Linear issue can be tracked by two
different squads, each authorized through its own connection, without either
granting the other access.

### Subscription IDs and completion semantics

Turning on **Code hosting** (`completion.followChanges: true`) derives a
subscription set for every resource in the canonical tracked set, each
targeting `delivery-owner` by default:

| Source                                                           | ID prefix (reserved)            |
| ---------------------------------------------------------------- | ------------------------------- |
| Primary delivery PR                                              | `code-host-<event>`             |
| `tracked[]` entry (issue or PR, including a flagged delivery PR) | `tracked-<12-hex-hash>-<event>` |

The hash in a `tracked-` ID is derived from the resource's identity
(`integration:repository:kind:number`), so adding or removing one tracked link
never renumbers another's subscriptions. Tracked issues subscribe to
`assigned`, `unassigned`, `updated`, and `comment`; tracked pull requests
(including flagged delivery PRs) subscribe to the same event set as the
primary PR. There is no separate `code-host-issue-` prefix — a legacy
`github.issue` binding is never read, so it never derives a subscription.

Only the primary delivery PR's merge/completion evidence sets the delivered
head and branch identity for `pr-merge`/`pr-auto-merge` completion, but every
flagged delivery PR must also be independently verified merged before
`ficus workstream finish` succeeds (see
[Delivery pull requests](#delivery-pull-requests)). Activity on any
non-delivery tracked resource — a tracked PR's reviews or CI, a tracked issue
closing, reopening, or being relabeled — is informational: it never finishes
the stream, clears an open manual/review wait, bypasses admission or a pause,
or discards acceptance requirements.

### Diagnosing "why isn't this delivering"

`GET /api/workstreams/:id/tracked` (and `ficus workstream tracked`) reports a
top-level `subscriptions` status alongside each resource:

| Status          | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `active`        | The stream has a running flow with Code hosting on; subscriptions are live |
| `no-flow`       | The stream has no attached workflow run — attach one                       |
| `not-following` | The attached flow does not have `completion.followChanges` set             |
| `ended`         | The stream is done/canceled; nothing is delivered anymore                  |

Even when `subscriptions` is `active`, an individual resource's `subscribed`
flag can still be `false` if nothing matches it yet. `GET /api/workflows/runs/:streamId`
→ `integrationDeliveries` reports the actual delivery outcome per subscription,
including a reason when one was skipped or superseded: `Work stream ended`,
`Subscription changed`, `Resource binding changed`, `Connection no longer
available`, `Work stream parked; owner notified`, `Recipient blocked by an
unrelated wait`, or `Waiting for consumer activation`.

### Known limits

- Activity records one row per `(event, work stream)`: when several of a squad's
  work streams track the same issue or PR, each one gets its own row, so the
  event shows up under every stream that is following it.
- Those rows are keyed positionally, so that existing rows never move: the oldest
  tracking stream carries the event's own row identity and the rest derive theirs
  from it. If that oldest stream is deleted or stops tracking the resource, the
  next stream becomes first, and a later repair adds a second row for it while
  its derived row remains — that stream then shows the event twice.
- Repository visibility for a URL-based link is enforced when events actually
  arrive for it, not at the moment it is linked.
- Poll/webhook de-duplication relies on GitHub's second-precision timestamps;
  two independent changes inside the same second can collapse.
