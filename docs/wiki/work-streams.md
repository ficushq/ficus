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

## Creating work streams under load

`POST /api/workstreams` does all of its work before it answers. With `repository`, that
includes checking the squad box, about twenty commands in the box, a `git fetch` and a
`git worktree add`, then a transaction that locks the squad row, flow dispatch and the
owner notification. A create normally takes 8 to 15 seconds and can take minutes when the
squad is busy. Four things keep that safe:

- **Idempotency key.** A client may send an `Idempotency-Key` header (1 to 200 printable
  ASCII characters, no spaces). Before anything is provisioned, Core claims the key for
  the squad, the authenticated identity and the key (`work_stream_create_requests`). A
  repeat with the same key and the same JSON body (compared by a SHA-256 of the canonical
  body) returns `200 { ...stream, reusedFromIdempotencyKey: true }`, with the same workflow
  `warnings` as the original `201`, instead of creating a second stream or worktree.
  - The comparison ignores `metadata.sources[*].addedAt`. Clients stamp it with the current
    time (the CLI does for `--from-url`, `--from-slack`, `--from-memory` and
    `--source-link`), so a re-run of the same command with the same key still matches.
    Every other field, including the sources themselves, must be identical.
  - A repeat that arrives while the first request is still running waits for it, up to
    45 seconds, and then answers `409 { code: "create_in_progress" }`. Retrying later with
    the same key is safe.
  - The same key with a different body answers `409 { code: "idempotency_key_conflict" }`;
    a malformed key answers `400 { code: "invalid_idempotency_key" }`.
  - A create that fails before its transaction commits deletes its claim, so a retry
    starts fresh. The claim is bound to the stream inside the creation transaction.
  - Before it deletes the claim, a create that provisioned a worktree and then failed
    (its transaction failed, or it answered `create_claim_lost`) removes what it
    provisioned (`services/work-streams/create-rollback.ts`). Only a worktree at the
    stream's own default path (`worktrees/<id>`) named in its ownership receipt is
    removed, through the same runner as delivered-worktree cleanup: it keeps a worktree
    with uncommitted changes, and archives commits that only the worktree's reflog
    holds under `refs/ficus-archive/` before it removes the tree. A caller-chosen `--worktree` path is
    kept with its branch, because a repeat that took over the claim may have adopted it
    (a retry adopts it the same way), and nothing is removed while any stream in the squad
    references the worktree path or the repository and branch. The branch is
    deleted only when this create made it and it still points at the commit it was made
    from, in one box command that uses `git branch -D`, which refuses a branch any worktree
    has checked out (another create may have just checked it out); a branch that existed
    before the create is never deleted. A retry with the same explicit `--branch`
    therefore succeeds. The checks for a committed or referencing stream run under the
    squad row lock, so a create commit still in flight lands first, and the box commands
    run under a 60-second deadline. Anything that cannot be removed safely is left in
    place and logged under `work-stream-create`.
  - A pending claim holds a 60-second lease that its request renews every 20 seconds. If
    the Core process dies mid-create, a repeat takes the claim over once the lease
    expires. A request whose claim was taken over this way rolls its transaction back and
    answers `409 { code: "create_claim_lost" }`; the repeat that took over returns the
    stream. Claims are pruned after 30 days.
  - Without the header, creation behaves as before. `ficus workstream create` always
    sends one (see [CLI: workstream create](cli/workstream-commands.md#create)).
- **No idle cutoff.** Core's listener runs `Bun.serve({ idleTimeout: 30 })`. On Bun 1.4.2
  that timer closes requests without a body (as seen on slow `workstream get` and `list`
  reads, now answered first by the read deadline described under
  [Reading work streams under load](#reading-work-streams-under-load)) while their
  handlers keep running; it does not close a JSON `POST` such as a
  create. The create route still disables its own per-request timer after authorization
  (as workspace transfers do; see [Request limits](request-limits.md)), as a defence
  should Bun start applying the timer to such requests, and `restoreExtendedIdleTimeout`
  turns it back on when the handler returns, so the keep-alive connection is still
  closed once it sits idle. A connection dropped by anything
  else on the path (a proxy, the network) is covered by the idempotency key and the CLI's
  retry with the same key.
- **Lighter squad-box check.** Repository setup skips the full squad-box ensure (exposure
  cleanup, env-file regeneration, the runtime ensure behind the per-box gate, the
  toolchain settle and the watch setup) when the box is already healthy. On a vm or k8s
  runtime that means: this Core process tracks the box, its spec has not drifted, no
  toolchain install is running, the recorded toolchain is undeclared or `ready` with the
  current declaration applied and activated, maintenance admission is open, and one
  command in the box answers within 10 seconds (a command that does not is cancelled in
  the box through the exec `signal` option, not left running). Anything else, including an archived
  squad, a missing or untracked box, a docker or host runtime, or a failed check, runs
  the full ensure as before (`services/sandbox/squad-sandbox-fast-path.ts`). The same
  check runs when `PATCH`/`workstream update` sets up a repository on an existing stream.
- **Per-phase timing.** Every create logs one line under the `work-stream-create` logger:

  ```
  Work stream create timing: outcome=created total=12.4s slowest=repository-fetch authorize=0.1s validate=0.2s idempotency=0.0s sandbox-ensure=0.3s repository-exec=2.1s(18) repository-fetch=6.0s repository-worktree-add=2.9s squad-lock-wait=0.0s transaction=0.4s dispatch=0.3s notify=0.1s respond=0.1s sandbox=fast squad=<id> stream=<id>
  ```

  Phases are always listed in this order, and a phase the create never reached shows
  `0.0s`. `repository-exec` also shows how many box commands ran. `sandbox=` says
  whether the fast path ran (`fast`) or why the full ensure did (`full:<reason>`).
  `outcome` is `created`, `reused`, `rejected` (4xx) or `failed`. A create taking 20
  seconds or more logs at `warn`. Search Core logs for `Work stream create timing` and
  read `slowest=`.

## Reading work streams under load

A single stream read is cheap: `GET /api/workstreams/<id>` takes 0.2 to 0.3 seconds on the
server, its flow (`GET /api/workflows/runs/<id>`) 0.06 to 0.17 seconds and an agent's inbox
about 0.1 seconds (measured 2026-11-27 on an otherwise quiet instance, squad of 988
streams). The unpaginated list was the heavy read. `GET /api/workstreams?squadId=<id>`
with no status filter annotates every stream the squad ever had: 2.4 seconds and 7.7 MB for 940
done, 28 canceled and 20 open streams, against 0.23 seconds and 95 KB for
`statuses=queued,active`. Core's database pool is small (4 connections unless
`DATABASE_POOL_MAX` says otherwise), so reads queue behind each other. With three full
lists running at once, each took 6 seconds and an unrelated `GET /api/workstreams/<id>`
went from 0.17 to 6.7 seconds, while `/health` stayed at 0.03 seconds. A few agents
polling `ficus workstream list` that way are enough to push ordinary reads past 30
seconds.

Four things keep reads bounded, and a fifth keeps slow writes from losing their answer:

- **Open work by default.** `ficus workstream list` asks for `statuses=queued,active`
  unless it gets `--status` or `--all` (see
  [CLI: workstream list](cli/workstream-commands.md#list)).
- **Capped history.** `GET /api/workstreams` without `limit` still answers with a plain
  array, and still includes every open (queued or active) stream it matches, but done and
  canceled streams are capped at the newest 50 by completion (`UNPAGED_HISTORY_LIMIT` in
  `apps/core/src/routes/work-streams.ts`). When more history exists, the response carries
  a `Link: </api/workstreams?...&statuses=done,canceled&limit=50&cursor=...>; rel="next"`
  header. That target is an ordinary paginated request (the same squad filter, the
  requested terminal statuses and `omitDescription`). Its answer,
  `{ items, hasMore, nextCursor, totalCount }`, continues the history; repeat with each
  `nextCursor` until it is `null`. The link asks for `annotations=full`, which gives a
  terminal page the same row annotations (derived state, priority, step) as the unpaged
  list, so a list continued from the link has one row shape throughout. A request with `respectAttention` is capped the same way but gets no `Link`,
  because paginated requests refuse that filter. Requests that already send `limit` are
  unchanged. The CLI follows the link (`apiGetList`), so `--all` and `--status done` fetch
  the history page by page.
- **Read deadline.** Core's listener runs `Bun.serve({ idleTimeout: 30 })`, and Bun's
  idle timer closes a request without a body (a `GET`, or a `POST` without one) about 32
  seconds after it arrives if nothing has been sent, while the handler keeps running. The
  client only sees "The socket connection was closed unexpectedly". Core therefore
  answers any `GET` or `HEAD` under `/api` that has no response after 25 seconds itself,
  with a `503`, `Retry-After: 5` and
  `{ code: "read_deadline_exceeded", error: "Ficus is busy and did not finish this read within 25 seconds. ..." }`
  (`apps/core/src/middleware/read-deadline.ts`). 25 seconds leaves room for the idle
  timer's coarse granularity (on Bun 1.4.2 handlers answering at 28 and 31 seconds still
  got through; the close came at 32). Only the time until the response headers counts:
  the deadline never cuts a streamed body that has started. Its late result is discarded,
  and Core logs a `read-deadline` warning for the read and another when it finishes.
  Routes that set their own idle timeout through `extendIdleTimeout` (workspace
  transfers, work stream creation) and the local-app proxy are exempt.
- **Cancelled abandoned reads.** When the deadline answers for a read, or its client hangs
  up before it has an answer, Core cancels that read's own database work so its pool
  connections are free again (`apps/core/src/db/query-cancellation.ts`). The middleware
  runs the handler in a cancellation scope, and the main pool records the queries started
  in it (drizzle queries, raw tagged templates and queries inside a transaction). The
  rule keeps the cancellation inside the abandoned request:
  - A scope records queries only while its handler is pending. Once the handler has
    answered, or the scope was abandoned, nothing more is recorded, so a timer or loop a
    read happened to start never has a later query cancelled, and a read that has
    answered (a streamed body, say) is never cancelled.
  - Abandoning cancels only the recorded queries still in flight. One that has no
    connection yet (waiting in the pool's queue) is dropped at once; nothing was sent, so
    no cancel request is involved. One already sent on a connection, running or pipelined
    behind another query, is cancelled only after the server has run it for a second
    (`MIN_RUNNING_MS_BEFORE_CANCEL`) at the front of its connection, counted from no
    earlier than the abandonment. A Postgres cancel request targets the backend, not the
    query: sent for a short query, or for one still pipelined, it can arrive after that
    query finished and cancel the next query on the connection, which belongs to another
    request. So a query that finishes within that second is left to finish, and a long
    one is cancelled about a second late. A cancel can still race a query that finishes
    in the few milliseconds the cancel takes to arrive after a full second of running;
    that small window is accepted. A cancelled query fails with `57014` and its transaction
    rolls back; the error handler answers it with a quiet `503 read_abandoned` instead of
    logging an unhandled error.
  - Work shared beyond the request that started it runs in `shareAcrossRequests`, outside
    any scope: `InflightDeduper` and `KeyedSerialQueue`, the sandbox ensure entry points
    (`ensureSquadSandbox`, `ensureWorkspaceSandbox`, `ensureAgentSandbox`,
    `ensureSquadSandboxForCommands`, `getSquadClient`), the VM manager's attach and
    recovery, the machine tunnel manager's shared setups, the ssh-trust first use, the
    local-app WebSocket watcher, local-deployment readiness checks, restarts, observations
    and recoveries, flow decision passes, and the remaining process-wide promise caches.
    New code that keeps a promise for later callers, or starts a loop or timer lazily,
    should do the same.

  Dedicated connections (locks, migrations, `withDedicatedDbTransaction`) are never
  cancelled this way.

  Limits to keep in mind:
  - A queued query of an abandoned read is dropped with no grace period. Shared work
    that is not wrapped in `shareAcrossRequests` therefore fails with `57014` exactly
    when the pool is busy, which is when reads get abandoned. Wrap any new shared loader.
  - Synchronous fan-out a read triggers still runs in its scope: event-emitter listeners
    called from a `GET` (`eventEmitter.emit`) and the settings and secret stores'
    `notifyListeners`. Their queries are cancelled only if they are still in flight when
    the read is abandoned, and a listener that must always finish should start its work
    in `shareAcrossRequests`.

- **Body-less writes run to their answer.** Writes with a body (a JSON `POST`) are never
  cut by the idle timer, even after the handler has read the body. A write without one
  (`workstream pause`, `resume`, `cancel` and `reopen` send none, nor does a body-less
  `DELETE`) would be, and it cannot be answered early like a read because it may already
  have changed something. `holdIdleTimerForBodylessWrites` (same file) therefore turns
  the timer off for any non-`GET`/`HEAD` request without a body while its handler runs,
  so every client gets the real result, and turns it back on before the response is
  written. That second step matters: Bun's per-request `timeout(request, 0)` lasts for
  the whole keep-alive connection, so leaving it off would keep that idle socket open
  forever. A route that set its own idle timeout keeps it here; `restoreExtendedIdleTimeout`
  (same file) turns an `extendIdleTimeout` timer back on when that handler returns, or, for
  a workspace download whose body is already a stream (relayed from a box, or a directory
  archive; `holdIdleTimerUntilBodySent`), once that body has been sent. A local file
  download keeps its file body and `Content-Length`. Every restore is guarded: if
  Bun throws because the client has already gone, Core logs it instead of letting it
  replace the handler's own result or error. The fix is in Core rather than
  in the CLI (which could send `{}` instead) so that browsers, scripts and older CLIs are
  covered too, and no client depends on how Bun treats request bodies.

The CLI shows the 503's message as is. If a server without the deadline drops a read,
`apiGet` reports that Ficus closed the connection before answering, probably because it
was busy for more than 30 seconds, and that nothing was changed.

The web app never reads the unfiltered list either, because every work stream event
refetches whatever list is on screen:

- **Open work comes from `statuses=queued,active`.** The agent Chats rows, the agent's
  Work streams panel (still polled every 10 seconds) and the Assistant's command center
  all use it.
- **Finished work is paged.** The agent panel pages its history with
  `squadId=<id>&statuses=done,canceled&limit=25&agentId=<id>` and a "Show older work
  streams" button. `agentId` keeps the streams the agent is assigned to, owns, created
  or is attached to, and is accepted only on a paginated terminal-status query with a
  full `squadId` (anything else is a `400`). The predicate has no index of its own (it
  would need three btree indexes and a GIN on `agent_ids`, each a write cost on a hot
  table), so the squad bounds it to that squad's history instead of every finished
  stream the caller can read. History is not polled: when one of the agent's open
  streams leaves the polled open list without a live event, the panel refetches its
  loaded history pages, newest first, so the stream reappears as finished (it can be in
  neither list for as long as that takes). A first load that fails shows "Could not
  load work streams" with Retry, never "No work streams", and a first page that filters
  to nothing still offers "Show older work streams". The command center loads the 100
  most recent completions, reads a squad's "Recently completed" period with
  `completedAfter`, and asks `GET /api/search`
  (`kind=work_stream`) for older work matching what was typed. The voice `get_work`
  tool returns finished work 50 at a time when asked, with `finished.totalCount` and a
  `finished.nextCursor` that it passes back as `finishedCursor` for the next page.
- **A 503 waits for its Retry-After.** The web and Farm query clients use
  `shouldRetryQuery` and `queryRetryDelay` from `packages/client-core/src/retry.ts`. A
  `503` is retried no sooner than its `Retry-After` (5 seconds when the header is
  missing, never under 1 second), doubled per retry with up to 10% jitter, at most
  twice, and not at all if the wait would exceed 60 seconds. Every other failure keeps
  three retries with the usual 1, 2 and 4 second backoff.
- **A sandbox that is still being provisioned is waited for.** While Core cannot
  provision a squad sandbox yet, a read served from it (a workspace tree, file or
  search) answers `503` with `SANDBOX_PROVISION_BUSY`,
  `SANDBOX_PROVISION_COORDINATION_UNAVAILABLE` or `SANDBOX_PROVISION_UNAVAILABLE` and
  the provisioning cooldown as `Retry-After`, which can pass 60 seconds.
  `isSandboxProvisioningFailure` recognises those codes (an `ApiError` keeps the body as
  `payload`). Such a read follows the same doubling rule with a 5-minute bound on one
  wait and at most 4 retries: a 75-second `Retry-After` gives three retries (75, 150
  and 300 seconds), and one over 300 seconds gives none. The file tree, the file viewer
  and the work stream file card say "The workspace is starting" meanwhile. A
  provisioning that failed (`SANDBOX_PROVISION_FAILED`) is not waited for: it keeps the
  ordinary `503` rule and shows its error. The sandbox status endpoints answer `200`
  with provisioning in the body, so their screens never see these `503`s.
- **`@ficus/client-core` has no unfiltered list.** Its two unpaged helpers,
  `listSquadWorkStreams(squadId, statuses)` and `listAllWorkStreams(statuses)`, need a
  status list and throw at run time on an empty one or a finished status, so only open
  work (`queued`, `active`) is read unpaged.
  Finished work is read with `listDoneWorkStreamsPage`, and one stream with
  `getWorkStream`.

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
not `owner/repo#12`. When a Linear agent session is bound to the stream for that
issue, the entry also carries `agentSession: { "id": "...", "url": "..." }`, a
copy for `ficus workstream get`, the web view and agents (Core's session table
stays authoritative; the field is valid only on Linear entries). Ficus then
reports the stream's progress into that session; see
[Linear integrations: Progress write-back](linear-integrations.md#progress-write-back).

Never hand-write `github.*`/`codeHost` metadata, or a raw `tracked[]` entry, to
attach a resource. Use the CLI/API paths below; they resolve identity, check
authorization, and stamp `origin` atomically.

### Adding and removing tracked resources

```bash
ficus workstream create "<title>" --squad <squad-id> --from-event <event-id>   # new stream, idempotent
ficus workstream track <ws-id> --event <event-id>                             # attach to an existing stream
ficus workstream track <ws-id> --issue owner/repo#12
ficus workstream track <ws-id> --issue KEY-123                                 # Linear issue
ficus workstream track <ws-id> --issue KEY-123 --linear-session                # also open and bind a Linear agent session
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
  The `url`, `reference` and `resource` forms also accept `"linearSession": true` for a
  Linear issue: Ficus opens a Linear agent session on it with the squad's Linear app
  connection, binds it to the stream and returns `linearSession: { id, url }` (`400` for
  anything but a Linear issue or for an API-key connection; `409` when Linear refuses).
  The response includes `changed`. Requires `workstreams:update`, or
  `workstreams:respond` for an agent bound to the stream.
- `DELETE /api/workstreams/:id/tracked` accepts `{ "url": ... }` or `{ "resource": ... }`.
  Untracking the delivery PR is rejected with `409 { code: "delivery_change_request" }`
  — edit `metadata.codeHost.changeRequest` instead. Untracking a Linear issue also
  releases the Linear agent session on it bound to the stream and posts the final
  response "Ficus stopped tracking this work." to it. Same permission as the `POST` above.
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
targeting `delivery-owner` by default. Flows whose completion mode is
`pr-merge` or `pr-auto-merge` follow by default when `followChanges` is
absent; only an explicit `false` turns it off (see
[Workflows](workflows.md)):

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

| Status          | Meaning                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `active`        | The stream has a running flow with Code hosting on; subscriptions are live                                                               |
| `no-flow`       | The stream has no attached workflow run — attach one                                                                                     |
| `not-following` | The attached flow does not follow code-host changes: `completion.followChanges` is `false`, or absent outside `pr-merge`/`pr-auto-merge` |
| `ended`         | The stream is done/canceled; nothing is delivered anymore                                                                                |

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
