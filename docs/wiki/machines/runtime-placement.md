# VM runtime placement and migration

## Placement

`box-manager.ensureBox` resolves a box's machine via
`resolveMachineForBox` → `placement.ts`'s `resolvePlacement`
(`services/machines/placement.ts`), in precedence order:

1. **Pin.** An explicit `machineId` on the agent/squad row → that machine (must
   be `ready`, else `MachineUnavailableError`). Set it via `PATCH /api/agents/:id`
   / `PATCH /api/squads/:id` (`machineId: string | null` in the body — `null`
   unpins) or via the dedicated `POST /api/agents/:id/machine` /
   `POST /api/squads/:id/machine` endpoints; see § Pin + migrate below for how
   the write paths differ and how a live box moves.
2. **Sticky.** A box that already has a recorded machine sticks to it while that
   machine is `ready` — re-running placement could otherwise repoint the row and
   orphan the old machine's user + unit + forward.
3. **`dedicated`.** A box requesting `dedicated: true` gets a freshly
   provisioned VM of its own — **requires the exe provider** (BYO-SSH machines
   are registered by an operator, never auto-provisioned by ficus); no exe
   provider configured → `DedicatedPlacementUnavailableError`.
4. **No cloud provider (BYO-only).** When the exe provider isn't registered
   (no `exe-provider-token` configured — see `docs/wiki/machines/exe-provider.md`),
   every box — regardless of role — falls to the **least-loaded ready shared
   machine**: the `ready` `scope:'shared'` machine with the fewest boxes
   (`COUNT(machine_boxes)`), ties broken deterministically by `createdAt` then
   `id`. Zero ready shared machines → `MachineUnavailableError`. This is
   byte-identical to the pre-exe (slices 1-4) behavior.
5. **Squad-per-VM.** With the exe provider available, a `squad` box — or an
   `agent` box carrying a `squadId` (an agent collaborating within a squad) —
   shares ONE exe VM per squad: `findReadySquadMachine(squadId)` reuses an
   existing one; a miss provisions a fresh exe VM tagged `purpose:'squad'`,
   `squadId` set, subject to the provisioning cap (below).
6. **Commons singleton.** A solo `agent` (no `squadId`) or a
   `system-manager` box, with the exe provider available, lands on the
   tenant's ONE singleton commons VM (`purpose:'commons'`) —
   `findReadyCommonsMachine()` reuses it if it exists, otherwise provisions it
   once, subject to the cap.

Steps 3/5/6 provision through the shared `provisionCapped` helper: mint a
keypair, `provider.provision(...)` (injecting ficus's public key —
UNVERIFIED for exe, see `docs/wiki/machines/exe-provider.md`), insert the row,
`bootstrapMachine` it so it comes back `ready` (a box can only land on a
bootstrapped machine). Reusing an existing squad/commons machine (the "else"
half of steps 5/6) is never cap-blocked — only a genuinely NEW provision
counts against the cap.

**Provisioning cap (`FICUS_MAX_MACHINES`).** Placement never silently
over-provisions: before any new machine is created, the live fleet size
(`countMachines()` — every row, since a terminated machine's row is deleted
rather than retained) is checked against `FICUS_MAX_MACHINES` (default **20**,
`DEFAULT_MAX_MACHINES`). At or over the cap, provisioning is refused with a
structured `MachineProvisioningCapError` rather than silently queuing or
degrading placement — raise the env var or free a machine.

**Purpose + squad_id columns.** `machines.purpose` (`'shared' | 'squad' |
'commons' | 'dedicated'`, default `'shared'`) records WHY a machine exists —
distinct from `machines.scope` (`'shared' | 'dedicated'`), which records
placement _eligibility_ for the least-loaded query. Every pre-slice-5 machine
backfills to `purpose:'shared'`, preserving old placement behavior exactly.
`machines.squad_id` (nullable, not an FK — a machine can outlive or pre-date a
squad row, and placement only ever equality-matches it) is the squad-per-VM
reuse key, set only on `purpose:'squad'` rows.

**Provider selection.** A machine's `provider` column (`'ssh' | 'exe'`)
determines who provisions/terminates/parks/resumes it (`getMachineProvider`
registry). `'ssh'` (BYO) is always registered; `'exe'` is registered only when
`exe-provider-token` is configured — see
[`docs/wiki/machines/exe-provider.md`](exe-provider.md) for credential setup,
the pubkey-injection mechanism, cost model, and — because exe.dev's real API
was never confirmed against a live account — the complete UNVERIFIED-API
inventory a credentialed human must validate before relying on the exe path
in production. Placement is fully autonomous and tested without exe (steps
5/6 simply never trigger; every box takes the BYO least-loaded path), so the
absence of exe credentials degrades gracefully rather than breaking anything.

**Single-worker provisioning race-safety.** Provisioning is a check-then-act
(count the fleet, look for an existing squad/commons machine, provision on the
miss). Like the rest of the VM runtime, ficus runs one worker, so two placement
calls for the same tenant never run concurrently — a future multi-worker
deployment would need an advisory lock around the provision step; the cap and
the `(purpose, squad_id)` reuse key bound the blast radius until then.

## Pin + migrate: moving a box to a specific machine

An operator (or the web Machines admin section) can pin an agent or squad to a
specific machine, overriding placement (§ Placement, rule 1). Every write path
validates the target through `assertMachinePinReady`
(`services/machines/pin.ts`) BEFORE the row is touched: `null` unpins with no
DB read; a non-null id must resolve to an existing `ready` machine or the
request is rejected with `MachinePinError` — a pin can never be set to a
missing or not-ready machine.

- **`PATCH /api/agents/:id` / `PATCH /api/squads/:id`** write the `machineId`
  column only. They do **not** move a live box — the box migrates lazily, the
  next time `ensureBox` runs for it.
- **`POST /api/agents/:id/machine` / `POST /api/squads/:id/machine`**
  (`machines:write`-gated) write the pin AND migrate a live box **now**:
  agents call `ensureAgentSandbox` once, which drives `ensureBox`'s own
  migrate-with-teardown branch (below); squads stop-then-start
  (`removeSandbox` then `ensureSquadSandbox`) to force the box off the old
  machine before re-ensuring on the new one. Both are best-effort — a
  migration failure does not roll back the already-written pin, so the row and
  the error are both visible even if the move didn't complete; retry via the
  same endpoint.

**Migrate-with-teardown (`box-manager.ensureBox`).** When an explicit pin
moves a box to a machine different from where its row currently lives
(`existing && opts.machineId && existing.machineId !== machine.id`), the OLD
box is torn down BEFORE the new one is bound — the same teardown `removeBox`
uses for a normal remove (cancel the tunnel, best-effort pull the
`~/.private` archive for agent/system-manager roles, `box-provision.sh
--remove`, delete the row) — so a pin change never leaves an orphaned Unix
user, systemd unit, or tunnel forward behind on the old machine (the
correctness gap flagged in the slice-5 review). Two guards keep this safe:

- **Old-machine-ready gate.** Teardown only runs when the OLD machine is still
  `ready`. If it's missing or not `ready` (the outage-recovery case — the box
  is being re-placed because its old machine died), teardown is **skipped**
  entirely and the box just rebinds on the new machine; SSHing a dead machine
  would throw and fail the whole ensure. **What this leaks:** the rebind
  repoints the `machine_boxes` row to the new machine and drops the stale
  tunnel forward, but the OLD machine's box-side remnants — the `box_<hash>`
  unix user, its `systemd --user` unit, and its home dir — are currently
  **NOT** reclaimed. The orphan-reconcile pass (§ Lifecycle, step 3) is
  **row-based**: it scans `machine_boxes` ROWS, and the rebind already moved
  the only row that pointed at those remnants, so the reconciler can no longer
  see them. If the old machine later comes back it keeps that leaked box user /
  unit / home indefinitely. Only the DB row and the tunnel forward are cleaned
  up here; a machine-side remnant sweep is a follow-up (§ Backlog). The same
  leak applies on a **failed teardown** (a `ready` machine that goes
  unreachable mid-teardown) and on the null-pin dead-machine re-placement path
  in `box-manager.ensureBox`.
- **Best-effort, never blocking.** The teardown call is wrapped so a
  mid-teardown failure (network blip, the old machine going away mid-call) is
  logged and swallowed, not rethrown — the code always falls through to bind
  on the new machine regardless of whether the old teardown succeeded.

Neither guard changes the null-pin, sticky (same-machine), or dead-machine
placement paths — migrate-with-teardown only engages on an explicit,
different-machine pin.

## Manual rebalance: re-packing live boxes

Placement (§ Placement) only ever decides where a **new** box goes, so a
`FICUS_UNIT_WEIGHT_*` / `FICUS_MACHINE_UNIT_CAPACITY` change can leave live boxes
co-located in ways the packer would now refuse. Manual rebalance
(`services/machines/rebalance.ts` on top of the `migrateBox` primitive in
`services/machines/box-migrate.ts`) re-packs the **existing** shared fleet so
its two placement invariants hold again:

1. **Unit budget** — the summed `unitWeightForSandboxId` of a VM's boxes stays
   within the machine unit capacity (with the packer's tolerated exception: a
   single non-squad box heavier than the capacity keeps its own VM — evacuating
   it would reproduce the violation forever).
2. **Squad exclusivity** — a `squad_` box shares its VM with nothing else.

**Squad boxes migrate by default; rebalance still never moves them.** A direct
`migrateBox` — `ficus machines migrate-box <sandboxId> --to <machineId>`, and the
primitive the platform's machine-host resize uses to evacuate EVERY box off a
host before destroying it — moves a squad box like any other. Pass
`migrateBox(..., { allowSquad: false })`, or `--skip-squad` on the CLI, to
refuse one instead.

Plain `rebalance` is unaffected: it only ever moves a squad's non-squad
co-tenants **off** its VM, never the squad itself. That is not this flag — its
PLANNER excludes squad boxes structurally (they are VM-exclusive anchors, and
only non-squad boxes are ever selected as movable), so rebalance behaviour is
identical whatever the default is.

Squad migration was originally opt-in because the archive path buffered a box's
whole state in core's memory as base64 — fine for an agent box's `~/.private`,
hopeless for a multi-GB `~/workspace`. Streaming removed that ceiling, and with
it the reason for the gate. (A squad workspace is "practically identical to an
agent's private workspace, just potentially a lot more files," which is why the
old immobility was a policy choice, not a hard constraint.)

A migrating squad box behaves like an agent box with two additions:

- **Durable state set.** The transfer leg carries both `~/workspace` and
  `~/.private` for every box role. This durability contract is independent of
  the role-specific `WORKSPACE_PATH`; consequently idle and never-run agent
  workspaces survive migration even though agents actively work in `~/.private`.
- **Deployment quiesce/restart.** Before the transfer, the squad box's local
  deployments are **actually terminated** (their managed processes killed, not
  just marked) so nothing is writing to `~/workspace` while it is tar'd — a
  failed stop aborts the move pre-archive (`quiesce-failed`, old box intact).
  After the move proves out (repoint + old teardown), the managed/restartable
  deployments are restarted on the target; a restart failure is logged, never a
  migration failure (the user can restart them). `~/memory` and
  `~/workspace/.ficus/.env` are re-materialized from core, so they are not
  archived. The quiesce marks a managed-always deployment `crashed` (not
  `stopped`) so it _stays_ restartable — but `crashed` is also the health
  poller's and `ensureSquadSandbox`'s restart trigger, so both consult the
  SAME `machine_boxes.migrating` fence before restarting (never a second flag)
  and skip while it's up; only `migrateBox`'s own post-move restart is exempt
  (`skipIfMigrating: false` — it already knows the row is repointed). If a
  migration aborts AFTER the quiesce (e.g. `quiesce-failed`, `archive-failed`),
  the deployment sits down on the (still-authoritative) old box for one poller
  tick — up to `LOCAL_APP_HEALTH_POLL_INTERVAL_MS` (10s) plus its
  `LOCAL_APP_RESTART_COOLDOWN_MS` (30s) — before the fence is clear and the
  poller self-heals it there. Benign, by design: a short user-visible restart
  window, not data loss.
- **Exact manifest verification.** Before transfer, core inventories both durable
  roots with canonical path/type/mode/size/content digests. It scans the stopped
  source again after transfer and independently scans the target; any source
  change or target mismatch retains the source. Whole-host recreation additionally
  freezes the database roster and persists an operation receipt bound to both
  machine IDs, hosted generations, roster digest, and aggregate manifest digest.
  Core machine deletion and provider droplet deletion require that exact receipt;
  a same-size retry without pending evidence performs no historical deletion.
- **Streamed transfer (no materialization anywhere).** The state is NOT pulled
  back to core. The source's `sudo tar c` is piped straight over SSH into the
  destination's `box-provision.sh --restore-stream`, which extracts from stdin
  and re-owns/locks the members with the same helper `--restore` uses
  (`~/workspace` 0755, private trees 0700). Core's memory stays flat regardless
  of workspace size, and nothing is staged on core's disk or on either machine's
  (staging would need transient headroom equal to the workspace on both, and
  disk pressure is frequently _why_ a migration is running). The codec is agreed
  across BOTH hosts first — `zstd` when each proves a `--zstd` tar round-trips,
  else `gzip` (`FICUS_BOX_ARCHIVE_CODEC` pins a candidate, still verified) — so
  the codec that writes is always the codec that reads. This restore-only mode
  intentionally omits `--port`: it does not start or configure the sandbox
  server. A supplied port is still required to use the separate `--port VALUE`
  form and pass the normal 1024–65535 validation; a bare `--port` fails without
  consuming the following option, and `--port=VALUE` is not supported.
- **Fail-closed transfer.** A truncated stream must never look complete, so
  three independent signals must all agree: the SOURCE tar's exit status
  (primary — a `tar` fed a prefix ending on a member boundary extracts it and
  exits 0, so the destination alone cannot detect truncation), the DESTINATION
  restore's exit status (a compressed stream truncated anywhere fails its
  decompressor, and the script runs under `set -euo pipefail`), and a non-zero
  streamed byte count. A timeout or connection death is a failure too. Which
  END failed picks the reason, preserving the `archive-failed` (old machine
  unreadable) vs `restore-failed` (target write failed) distinction — but that
  attribution is a **best-effort guess, not a fact**, and the error says so.
  When the destination fails, core's pipe pump cancels the source's stdout and
  the source ssh dies of EPIPE, so BOTH ends exit non-zero, a shape
  indistinguishable from a truncated source (which also fails the destination's
  decompressor). Every failure therefore carries BOTH ends' exit codes and
  stderr tails, so whichever end is blamed the real cause is still legible. An
  **ambiguous** attribution is reported as `restore-failed`, never
  `archive-failed`: the two behave identically, and `archive-failed` renders to
  an operator as "old machine unreadable" — a guess must not name a machine.
- **Destination verification (replaces the old at-rest archive check).**
  Streaming removes the pulled file the old `tar tzf` floor check inspected. In
  its place the state dirs are measured FOUR times — both ends, on both sides of
  the transfer. _Before_ anything is provisioned, on the SOURCE (presence +
  owner/mode + top-level entry count; a squad with no `~/workspace` aborts as
  `archive-failed` with nothing provisioned). _After provisioning but before the
  stream_, on the DESTINATION, which must be present and EMPTY — `ensure_dirs`
  creates every state dir empty and nothing has written into them yet, so a
  non-empty one is a leftover tree from an earlier attempt whose best-effort
  teardown failed, and streaming onto it is refused. _After the stream_, on the
  SOURCE again and then on the DESTINATION: every state dir must exist, hold a
  top-level entry count within `[min, max]` of the TWO source readings, and be
  owned by the box user with the mode the restore promises (a root-owned
  `~/workspace` is a dead squad box). An unverifiable end — either one — is
  treated exactly like a failed one. Failure aborts as `restore-failed` with the
  old box untouched; this verifies the OUTCOME rather than the transport, which
  the old check could not do.

  Two details are load-bearing. The empty baseline holds NOT because assets
  avoid the state dirs — two of the five vm assets land inside them (the squad
  `.env` at `~/workspace/.ficus/.env`, the identity key at
  `~/.private/identity.pem`) — but because asset delivery goes through the box
  SERVER's HTTP API, `box-provision.sh` only `enable`s the unit and never starts
  it, and migrate never calls `syncBoxFiles` at all. Move asset delivery ahead
  of the stream and this invariant dies with it. And the source is measured
  TWICE because it stays LIVE across the move: minutes of artifact delivery
  (up to 2 min per file) and box install sit between the first reading and the
  tar, so a background build adding one top-level entry would otherwise abort
  the migration AFTER the whole multi-GB stream was paid for. The band between
  the readings absorbs that drift; the upper bound survives it, as the backstop
  for the stale-superset shape the empty baseline is the primary guard against.

- **Size budget (transfer AND teardowns).** Role-scaled: 30 minutes for a
  squad's potentially-huge `~/workspace`
  (`FICUS_BOX_MIGRATE_ARCHIVE_TIMEOUT_MS`), 5 minutes for an agent /
  system-manager box's `~/.private` (which holds its git trees;
  `FICUS_BOX_MIGRATE_AGENT_ARCHIVE_TIMEOUT_MS`). Neither is the SSH runner's 30s
  default — that bound exists for a HUNG box, not a fat one — but the agent
  budget stays an order of magnitude under the squad's, because rebalance moves
  boxes sequentially and one unreachable box must not stall the whole run for
  half an hour. The SAME budget covers both of a migrate's teardowns, because
  `box-provision.sh --remove` gzips the entire home before `userdel`: on the 30s
  default the teardown of a just-streamed multi-GB home times out, its tree
  survives on the target, and the empty-baseline check then refuses every LATER
  migration of that box to that machine — a permanent block rather than the one
  retry the baseline's rationale promises. The state-dir probes keep the runner
  default on every role (they are O(top-level entries)), so an unreachable
  machine still fails those fast.

**Idle boxes only; squad execution activity is included.** A non-squad box is
only moved when every owning agent is provably idle: the fence's activity probe
covers the agent **and its subagent descendants** (they share the parent's
sandbox), and for a `system_manager_<userId>` box **all** of that user's
system-manager agents. For `squad_<id>`, running and stopping executions block
migration even if their agent or subagent has since terminated. Queued rows do
not independently block: once migration owns the squad row lock, pickup cannot
claim them. Squad managers, workers, consultants, and squad subagents qualify;
top-level system-manager and artifact-builder executions remain personal-only.

Execution pickup locks every accessible box row (the private or inherited box
and, for capable squad runners, the shared squad box) in sorted order inside the
queued-to-running transaction. Thus pickup and migration cannot pass each other:
the winner's commit makes the loser defer or refuse. An `active-turn` refusal
may include only `activeExecutionCount`; it exposes no agent IDs or execution
content. Local deployments are quiesced separately before archive.

The activity probe is deliberately DB-only. An **in-flight `squad_bash`
command** is covered while its execution remains running or stopping, but an
untracked background process or build writing to `~/workspace` remains outside
the execution fence. That is the accepted residual: move a squad host when
non-execution background work is quiescent. A violation no legal move can fix
(two squads on one VM; a lone over-capacity squad) is surfaced as
`unresolvable`, not silently skipped.

**Progress + timeouts.** Because a squad `~/workspace` can be tens of GB, the
streamed transfer's SSH budget is raised well past the 30s default
(`FICUS_BOX_MIGRATE_ARCHIVE_TIMEOUT_MS`, 30 min default) — **squad moves only**:
rebalance moves boxes sequentially, so widening every box's budget would let
one hung agent box stall a whole rebalance for up to 30 minutes instead of
failing fast at 30s; the agent/system-manager path gets its own, much smaller
minutes-scale budget (`FICUS_BOX_MIGRATE_AGENT_ARCHIVE_TIMEOUT_MS`, 5 min
default). The state-dir probes on either side are
O(top-level entries) and deliberately keep the runner default on every role, so
an unreachable machine fails them fast instead of hanging for half an hour.
`migrateBox` reports
per-phase progress (`fence → stop-deployments → archive → provision → restore →
health → repoint → teardown → restart-deployments`) that the `migrate-box` route
streams as SSE and the CLI tails — as NDJSON under `--json` (one record per
phase, then the final result record) so a resize orchestrator driving the CLI
over SSH can tell which phase is running without waiting for the end. The phase
NAMES are unchanged by the switch to streaming (external orchestrators key off
them), but their content moved: `archive` is now the source-side measurement +
codec agreement (fast), and `restore` carries the whole streamed transfer plus
the destination verification (where the minutes are spent).

**The migrating fence.** `migrateBox` claims the box by setting `migrating` on
its `machine_boxes` row inside a transaction that re-checks activity under the
row lock — a turn that slips in first wins and the move is refused
(`active-turn`; rebalance reports these as `skippedActive`). While the fence is
up, execution pickup **defers** any queued turn for the box's owners instead of
starting it mid-move, and every exit path — success, structured failure, or
throw — lifts the fence, so a box is never left fenced. API startup clears stale
durable fences before migration/rebalance routes proceed; this recovery barrier
assumes the current single-API-process deployment. Multiple API replicas would
require leased fence ownership rather than unconditional recovery. Note the
idle/fence definition is **execution-based**: non-execution writes into
`~/.private` (e.g. a precompaction bake or file-sync) are not fenced, and a
write landing after the source is read is simply not migrated — rebalance when
the agent is quiescent.

**Forcing past the fence.** `ficus machines migrate-box --force <reason>`
requires an explicit bounded reason. The API additionally
requires `machines:force-migrate` and derives an attributable user/agent actor
from authentication; legacy and anonymous system-token identities fail closed.
Under the locked fence decision, core records actor, reason, request ID,
box/squad, source and target machines, and the exact running/stopping count on
the fence transaction's connection. The fence and started audit commit together
_before_ destructive work. Audit failure aborts the move. Terminal settlement is
first-writer-wins and row-count checked: an exact retry is idempotent, while a
missing or conflicting audit fails closed — except after a fence that threw,
which rolled its own started audit back, so a missing record there is expected
and the fence's error surfaces unwrapped. A successful audit settlement and box
repoint commit in the same transaction. API boot marks interrupted records
canceled with `api-restart` and a replayable failed result; if recovery races a
success, the loser observes the winner rather than overwriting it. Cancellation
is recognized from typed abort signals (including causal aborts), never error
message text. The single-API caveat above still applies to unconditional fence
recovery; audit race hardening does not add leased fence ownership.

Force exists only to evacuate a machine that is failing regardless. It bypasses
the active-execution refusal, not missing/unready boxes or a concurrent fence.
It is genuinely destructive: the source box is torn down after transfer, so
whatever live turns write after the archive is read is gone. There is no web-UI
equivalent by design — a second button beside a one-click Migrate is the wrong
affordance for an override that destroys live work.

**The transfer step (old box survives until the move is proven).** A move runs:
fence → (squad only: stop the box's local deployments) → measure the old box's
state dirs (`~/.private`, plus `~/workspace` for a squad box — the role-driven
set) → provision the new box on the target → **stream that state
source→destination before the new unit's first start** → verify the
destination's actual restored state → start + health-verify (including a
token-authenticated probe, since `/healthz` is auth-exempt) → repoint the
`machine_boxes` row → tear down the old box → (squad only: restart the managed
deployments on the target).
Any failure before the old teardown leaves the old box fully authoritative (the
freshly provisioned box is torn down best-effort); a teardown failure after the
healthy repoint is logged remnants — the move still succeeded.

**Dry-run is exact.** The planner (`planRebalance`) is pure — it reads the
fleet and returns `{ moves, skippedActive, unplaceable, unresolvable }` with no
effects — and the executing run (`rebalanceFleet`) executes exactly that plan,
so `dryRun: true` shows precisely what a real run would attempt. Evacuees are
chosen lightest-first from each violating VM and targeted best-fit against the
fleet's virtual state; when nothing fits, the plan groups evacuees onto the
fewest freshly provisioned shared machines (subject to `FICUS_MAX_MACHINES` —
past the cap they're `unplaceable`). The executing loop runs moves sequentially
in outbound-before-inbound order; one move's failure never aborts the rest, and
a fleet with no violations plans zero moves (idempotent).

**Long runs and connection loss.** A non-dry-run rebalance is one synchronous
HTTP request, and each move is a measure → provision → stream → verify SSH cycle
that takes minutes — a large plan can easily outlive the client or proxy
connection. That only loses the caller's per-move results: the server keeps
executing regardless. Re-running afterwards is safe — the loop is idempotent
and the per-box migrating fence prevents double-moves — and `--dry-run` shows
what (if anything) remains. Executes are single-flight per process: a second
non-dry-run request while one is running is refused with 409 (dry runs are
never blocked), since overlapping executes would each provision their own
fresh machines for their provision groups (duplicate billed VMs).

**Surface.** Both entry points are admin (`machines:write`) HTTP routes served
by `routes/machines.ts`, with `ficus machines` CLI wrappers:

- `POST /api/machines/rebalance` body `{ dryRun?: boolean }` → the plan (plus
  per-move `results` when executing, each stamped with the resolved
  `targetMachineId` — the machine actually provisioned for a `provision:<n>`
  planned target) — `ficus machines rebalance [--dry-run]`. 409 while another
  execute is running.
- `POST /api/machines/:id/migrate-box` body
  `{ sandboxId, allowSquad?, force?: { reason, requestId } }` moves one box
  onto machine `:id` and
  returns `migrateBox`'s structured result
  (`{ moved, reason?, activeExecutionCount? }`). CLI:
  `ficus machines migrate-box <sandboxId> --to <machineId>`, plus
  `--skip-squad` / `--force <reason>`.

VM runtime only (`isVmRuntime()`); on other runtimes the routes return an
error.


[VM runtime overview](runtime.md)
