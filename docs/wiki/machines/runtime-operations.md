# VM runtime operations

## Events: `machine.*` / `box.status` (admin-global)

The fleet is observable over the same WS EventMap/topic mechanism the rest of
ficus uses (`packages/shared/src/events.ts`, `ws-topics.ts`):

```
'machine.created': { machineId: string }
'machine.updated': { machineId: string }
'machine.status':  { machineId: string; status: string }
'machine.deleted': { machineId: string }
'box.status':      { sandboxId: string; machineId: string; status: string }
```

All five bridge to topic `'machines'` / instance topic `` `machines:${machineId}` ``
(`services/ws/bridge.ts`) and are emitted after the corresponding DB write:

- `routes/machines.ts` — `machine.created` after register-insert; on
  bootstrap/check, a real status transition emits `machine.status`, a
  non-transition update emits `machine.updated` (mutually exclusive, via the
  route's `emitMachineChange` helper); `machine.deleted` after the row is
  deleted.
- `services/machines/machine-health.ts` — `machine.status` on a `probeMachineHealth`
  ready↔unreachable flip (transition only, same as the route's bootstrap/check
  path).
- `services/machines/box-manager.ts` — `box.status` with `status: 'ready'` on
  a successful `ensureBox`, `status: 'stopped'` on `stopBox`, and
  `status: 'gone'` on `removeBox` (both the normal-teardown and
  machine-already-gone cases).

**Admin-global, not squad-scoped.** Machine/box events carry no `squadId`, and
`services/ws/topic-scope.ts`'s `'machines'` case returns `{ kind: 'unresolved'
}` for the `machines:<id>` instance topic — the WS layer has no cheap way to
check a subscriber's `machines:read` permission per-message, so it fails
closed. In practice this means only WS clients whose accessible-squad set
resolves to `'all'` (i.e., an admin) ever receive `machine.*`/`box.status`
messages; a non-admin client can subscribe to the bare `machines` collection
topic but never gets delivery on the instance topic. The web Machines admin
section relies on exactly this — it's gated `machines:read` in the UI, and the
underlying WS delivery independently enforces admin-only.

## Web admin: Machines settings section

`apps/web/src/components/settings/MachinesSection.tsx` (SettingsPage → Admin
group → 🗄️ Machines, gated `machines:read` to view / `machines:write` to
mutate — `SECTION_PERMISSIONS.machines` in `SettingsPage.tsx`) is the
operator-facing fleet UI:

- **Fleet list** — name, provider, status badge, purpose/squad, box count,
  last-seen, kept live via the Task-3 `QueryInvalidator` subscription to the
  `'machines'` topic (§ Events above) rather than polling; a light
  `refetchInterval` still runs while any machine is `bootstrapping`/
  `unreachable`, mirroring `ProviderAuthSection`'s conditional poll.
- **Register** — BYO-SSH (name/host/port/user) shows the generated public key
  once, with the instruction to add it to the target host's
  `~/.ssh/authorized_keys`; or `exe` (name/scope), which requires the
  `exe-provider-token` secret to be set first (see below).
- **Per-row actions** — Bootstrap, Check, Delete (confirm-gated; a machine
  still hosting boxes 409s on delete).
- **Assigning a machine to an agent/squad** (the pin) drives the
  `POST .../machine` endpoints above via `apps/web/src/api/machines.ts`
  (`setAgentMachine`/`setSquadMachine`).

**exe-token secret.** The exe.dev API token is registered like any other
credential, in `apps/web/src/components/settings/SecretsSection.tsx`, key
`exe-provider-token`, category `Machines` — on-demand (no restart required);
setting it is what makes the `exe` provider option (and squad-per-VM/commons/
dedicated placement) available.

**Mobile: deferred.** No mobile Machines UI shipped this slice — the
`liveUpdates.ts` seam that already carries other admin-ish live state makes
adding a mobile read surface (or a minimal pin-setter) a cheap follow-up when
prioritized; nothing in the backend design blocks it.

## Troubleshooting

- **`MachineUnusableError: AllowTcpForwarding=no`.** The machine's sshd forbids
  forwarding. Set `AllowTcpForwarding yes` in `sshd_config`, restart sshd, and
  re-bootstrap so the capability re-probes to `yes`. If the caps show
  `forwarding: "unknown"`, `sshd -T` was unavailable during bootstrap (sshd
  absent, bad config, or sudo denied) — fix that and re-bootstrap.
- **`control socket path too long (… > 90 bytes)`.** SSH's `sockaddr_un.sun_path`
  is ~104 bytes; the tunnel manager rejects derived control-socket paths over 90
  bytes rather than let ssh silently truncate and fail cryptically. Shorten
  `HOME_DIR` (the control dir defaults to `<HOME_DIR>/machines/ctl`). Note:
  on macOS the default `TMPDIR` is a long `/var/folders/...` path — if you point
  the control dir at a temp dir, use a short one.
- **Drift / stale bundle.** The box's spec hash folds in the sandbox-server
  bundle version and the box-provision script version. When either changes, the
  box is `recreate`d (park + re-ensure; state persists). The server bundle is
  content-hashed and re-pushed only when the machine's recorded version differs.
  The **file-synced** artifacts (`~/bin/ficus`, skills, squad `.env`,
  `identity.pem`, memory) are re-pushed over `/write` on **every** ensure (step 6
  runs after `ensureBox` returns). `server.env`, however, is pushed only on a full
  (re-)provision — the healthy **fast path** (step 4) returns BEFORE the
  `server.env` push, so a re-ensure of an already-healthy box does NOT re-push it.
  None of these re-pushes trigger a recreate. File-synced assets also persist a
  bounded manifest of paths they own. When a grant, secret, identity, or tree
  entry is revoked, reconciliation writes the new manifest, removes only stale
  previously managed files (never unmanaged user files), and stamps completion
  only after deletion succeeds. An explicitly empty SSH source therefore
  revokes the last delivered host key instead of leaving it usable.
- **Stale baked `FICUS_API_URL` after a Core restart.** When Core reaches a box
  over a reverse tunnel, the box's `server.env` bakes `FICUS_API_URL=http://127.0.0.1:<remotePort>`.
  A Core restart allocates a NEW reverse-tunnel port, but the healthy fast path
  does not re-push `server.env` (above), so the box keeps the stale baked URL. The
  interactive/session surfaces are unaffected — `exec`/`spawnShell` and the bash
  tool re-inject the LIVE callback URL per command (`resolveToolApiUrl` /
  `spawnShell` env) — but a box-side process that reads the baked `server.env`
  value directly (e.g. a long-lived watcher) can point at a dead port until the
  box is next fully (re-)provisioned. Force a re-provision (`recreate`, or park +
  ensure) if a box must pick up a new reverse-tunnel port.
- **`starting` vs `failed`.** `getSandboxStatus` distinguishes non-terminal
  from terminal states, and the difference matters — routes keep a
  `starting`/`running` session alive but tear down a `failed` one, and the outage
  watch treats `failed` as a crash:
  - `starting` — the box is mid-(re-)provision, or its machine is `ready` but the
    tunnel/`/healthz` hasn't converged yet. Transient; leave it alone.
  - `failed` — the box's machine is gone or no longer `ready`. Terminal: the box
    is unrecoverable where it lives and will be re-placed / reclaimed.
- **Diagnosing a box that never goes healthy.** The systemd unit tolerates a
  missing bundle/env and stays failed-and-retrying until they arrive; check the
  unit with `systemctl status ficus-box-<user>.service` (system mode) or
  `systemctl --machine=<user>@.host --user status ficus-sandbox-server.service`
  (user mode) and its journal on the machine. Under socket activation an
  `inactive (dead)` server unit is NOT a fault — check the `.socket` unit
  first: if it is `active (listening)`, the box is idle and healthy, and
  `curl 127.0.0.1:<boxPort>/healthz` on the machine will wake it.

## Known limitations

- **The full systemd path is validated only on real VMs.** `box-provision.sh`'s
  linger + `--user` unit + `--machine=<user>@.host` restart — and, by extension,
  per-box **rootless docker** and **devbox** seeding — require systemd as PID 1,
  which a plain container does not have. The tenant-zero VM smoke test covers
  those paths end-to-end. The gated container integration test
  (`integration-vm.test.ts`) covers everything AROUND them — bootstrap, the same
  ssh runner, tunnel manager, real server bundle, `SandboxClient`, and the
  file/exec/reverse contracts — via a UNIT-FREE box (the server started
  directly), and asserts box-provision fails loudly at the systemd step. Its
  slice-3 blocks are additionally gated: `FICUS_TEST_EGRESS` (NET_ADMIN — the live
  RFC1918-drop proof) and `FICUS_TEST_SYSTEMD` (a real systemd host — the rootless
  docker + docker-path egress blocks). Devbox seeding is folded into the MAIN
  flow, but although `bootstrap.sh` puts `devbox` on PATH, `devbox install`
  realizes packages through the nix DAEMON, which runs only on a systemd VM (and
  the nix install itself dies under qemu on an amd64-emulated host). So the seed
  step self-gates on the nix daemon socket (`/nix/var/nix/daemon-socket/socket`)
  or `FICUS_TEST_SYSTEMD` and skips otherwise; running the full main flow (seed +
  cached-shellenv + a comfort tool resolving in a PLAIN `/bash`) therefore needs a
  **native-amd64 systemd host**, aligned with those gated blocks.
- **Containment validation requires a real systemd VM.**
  `scripts/machine/box-provision.test.sh` runs the real provisioning code against
  a temporary host tree with mocked account managers, systemd, Docker and kernel
  cgroup files. It verifies generated flags/units, first provision, legacy
  convergence, idempotence, stopped-daemon recreation, and rejection of escaped
  ancestry, missing controllers, unbounded limits and failed startup. It does
  **not** prove real kernel accounting or enforcement. The normal PR CI job
  `Rootless box cgroup containment` runs `scripts/machine/box-cgroup.integration.sh`
  on its own disposable Ubuntu 24.04 systemd VM. It verifies host-visible
  dockerd/containerd/shim/payload cgroups, ancestor CPU/memory caps and accounting,
  inability to raise ancestor limits, unchanged reprovision, daemon restart, a
  caller-selected container parent, and reprovision after stopping the user
  manager. Commands, job runtime and the single sleeping container's lifetime are
  bounded. The fixture refuses non-disposable hosts and missing prerequisites;
  it never skips to green or disables security restrictions. All five runtime
  phases and cleanup passed for commit
  [751f4949](https://github.com/ficushq/ficus/commit/751f4949681385ea3d8d4d81120401f3e385bf7b)
  in the [real containment CI job](https://github.com/ficushq/ficus/actions/runs/40632730516/job/122632864143).
  **Each subsequent PR head must pass its own runtime CI**; historical results,
  authoring the fixture or passing local static guards do not replace that proof.
- **Sync-on-every-ensure re-push traffic.** File sync (CLI, skills, `.env`,
  identity, memory) re-pushes on every ensure rather than diffing, so a busy
  ensure/park cycle re-transfers unchanged artifacts. Acceptable at current
  scale; a content-hash skip is a future optimization.
- **Egress lockdown is opt-in and coarse on DNS.** The nftables rules (§ Egress
  model) apply only when a machine's `egressPolicy` is set; they now cover both
  IPv4 special-use ranges AND an IPv6 metadata/ULA/link-local drop (the slice-2
  v4-only gap is closed). Remaining coarseness: DNS is allowed globally (any
  resolver on :53, not pinned), and the lockdown is machine-wide, not per box.
- **The lifecycle loop's 60s cadence and real systemd unit stop are not
  container-modelable.** `integration-vm.test.ts` exercises the slice-4
  primitives directly against the real container and a real database row
  rather than waiting out the 60s tick: `box-manager.stopBox` parks a
  real box (asserting the `machine_boxes` row flips to `stopped` and the
  tunnel forward is genuinely torn down — a post-park request through the old
  forward fails) and re-adding a forward proves the resume side (row back to
  `ready`, `/healthz` answering) in seconds; a separate machine row pointed at
  a closed port proves `probeMachineHealth` flips a real unreachable target to
  `unreachable`. What it does NOT prove: that `stopBox`'s
  `systemctl --user stop` actually stops a real systemd unit — the plain
  container has no systemd (§ above), so that command is a harmless no-op
  there and the box's unit-free server process never actually stops. That half
  of park (and the full-provision side of resume, which needs
  `box-provision.sh`'s systemd path) is VM-smoke-deferred, same as the rest of
  the systemd surface.
- **The exe.dev provider path is UNVERIFIED-pending-credentials.** exe.dev's
  entire wire format (lobby command grammar, JSON field names, the token's
  auth role, and — the biggest open question — the pubkey-injection mechanism
  that lets ficus SSH into a VM it just created) is an assumption from a
  provider survey, never confirmed against a live account. Every assumption
  is isolated in `providers/exe-api.ts`, and the gated
  `integration-exe.test.ts` (separate `FICUS_TEST_EXE_TOKEN` gate from the SSH
  integration test) is the ONLY thing that exercises the real API — it has
  never actually run in this environment (no exe.dev token available). Until
  a credentialed human runs it, treat the exe provider as **authored but
  unverified**: BYO-SSH placement is fully verified and safe to depend on
  today; exe-based placement (squad-per-VM, commons, dedicated) is
  code-complete and unit-tested against a fake `ExeApi`, but its correctness
  against the real service is an open question. See
  `docs/wiki/machines/exe-provider.md` for the complete UNVERIFIED-API inventory
  and the exact run command.

## Backlog (not done in slice 6)

Slice 6 shipped the events surface, the pin setter + migrate-with-teardown
fix, and the web Machines admin section (above). These remain open follow-ups,
none blocking the above:

- **Persist the GitHub public profile on the connection.** The author name and
  email are cached per Core process. A process that has not loaded the profile
  yet resolves the login-only identity while the token is unusable (mid-refresh
  or GitHub unreachable), and an idle box is then reprovisioned when the profile
  loads. Storing the profile at validation time needs a new column and writes in
  every validation path.
- **Concurrent same-key provision dedupe** (from slice 5). Two placement calls
  racing to provision the _same_ target machine name (e.g. two boxes for the
  same new squad) both reach `provider.provision(...)` — the existing
  `InflightDeduper` in `services/sandbox/vm/manager.ts` keys only on
  `sandboxId`, not on the computed squad/commons/dedicated machine name.
  Backstopped today by the DB's unique `machines.name` constraint plus
  cleanup-on-conflict, but a keyed in-flight dedupe by machine name (see the
  doc comment on `placement.ts`'s `resolvePlacement`) would remove the wasted
  provision attempt.
- **Dedicated-placement reuse/teardown** (from slice 5). Placement's
  `dedicated` path (§ Placement, rule 3) always provisions a fresh VM — there
  is no reuse-by-(`purpose='dedicated'`, `name`) lookup and no teardown path,
  unlike squad/commons which reuse by their deterministic name. A retry after
  a mid-`ensureBox` failure would re-provision `exe-ded-<sandboxId>` and
  collide forever on the `machines.name` unique constraint, since nothing
  currently reclaims a failed dedicated attempt's row. (Note: this is
  independent of the machine pin shipped this slice — the pin targets an
  _existing_ machine; `dedicated` placement is about auto-provisioning a new
  one per box.)
- **Squad-warmup vs. keepalive predicate alignment** (from slice 4).
  `squad-warmup.ts` warms a squad on `squad.isSandboxAlwaysOn ||
hasRecentAgentActivity(...)`, but the idle reaper's keepalive predicate
  (§ Lifecycle, step 1) checks `hasActiveLocalDeployments ||
hasRecentWorkStreamActivityForSandbox` — and `work-stream-activity.ts`
  explicitly returns `false` for squad/system-manager sandboxes. A squad
  warmed by recent agent activity currently has no corresponding keepalive
  signal protecting it from being idle-reaped shortly after. The two
  predicates should be reconciled.
- **Drop the hardcoded `VmLifecycleState.status` field** (from slice 4).
  `services/sandbox/vm/manager.ts`'s `getLifecycleState()` returns a literal
  `status: 'ready'` justified only by a comment ("a tracked box completed
  ensure, so its status is 'ready'") rather than deriving it from the box's
  actual live state.
- **Machine-health serial-SSH concurrency at fleet scale** (from slice 4).
  `sweepMachineHealth` (§ Lifecycle, step 2) probes machines one at a time in
  a plain `for` loop with no concurrency limiter; fine at current fleet sizes,
  but a large BYO-SSH fleet would serialize on SSH round-trip latency per
  60s tick.
- **Machine-side remnant sweep.** After a skip-teardown or failed-teardown
  pin migrate (§ Pin + migrate, old-machine-ready gate) — or the null-pin
  dead-machine re-placement in `box-manager.ensureBox` — the OLD machine's
  `box_<hash>` unix user, its `systemd --user` unit, and its home dir are left
  behind: the rebind repointed the `machine_boxes` row, and the
  orphan-reconcile pass is **row-based** (`reconcileOrphanedBoxes` in
  `machine-health.ts` scans `machine_boxes` ROWS), so it can no longer see
  those remnants. A machine that later recovers keeps the leaked box user /
  unit / home forever. Follow-up: a machine-side sweep that enumerates
  `box_<hash>` unix users / `systemd --user` units on ready machines and
  reclaims those with no matching `machine_boxes` row (the reconciler can't see
  them today).
- **Mobile machines UI.** Deferred this slice (§ Web admin above) — no
  backend blocker, just not built yet.


[VM runtime overview](runtime.md)
