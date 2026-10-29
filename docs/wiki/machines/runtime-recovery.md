# VM runtime health and recovery

## Runtime degradation and Bash admission

The sandbox server reports nested Docker diagnostics separately from executor liveness:
`/healthz` keeps `healthy: true` while serving requests and adds
`runtimeHealth: { status: 'ready' | 'degraded', reason?: string }`. A Docker
probe that fails or exceeds **2 seconds**, or a box-owned **detached runc exec**
control process at least **5 minutes** old, degrades runtime health. The existing
Processes Docker failure (including `Docker did not answer within 15s`) feeds
that same state immediately. Reasons contain no command lines or credentials.

Only detached exec (`runc exec --detach` / `-d`) is age-limited: it should finish
starting the workload promptly. Non-detached exec waits for the workload and
can legitimately run for hours; containerd shims and ordinary foreground work
are not classified as stale by age. Detection never signals or restarts them.

Nested Docker failure, including stale detached runc, does **not** gate native
`POST /bash` admission or client attachment: ordinary Bash and diagnostic/recovery
commands remain usable without waiting for a Docker health check. Shell text is
not an authorization boundary. Native Bash still enforces stopped-session spawn
admission, invocation ownership/quarantine and execution deadlines; genuine
failures retain their existing errors. Docker probes and container operations
retain their own bounded timeouts. Read/write, Processes, cancellation and health
also remain usable for diagnosis.
Checks are demand-driven by health, single-flight and cached for 30 seconds;
no background polling keeps idle boxes awake. Health serves the latest snapshot
without waiting on Docker. A fresh successful Docker and stale-exec check clears
degradation automatically. An outstanding timed-out probe is retained until it
settles so retries cannot accumulate stuck clients.

VM squad/agent status APIs forward `runtimeHealth` and the degraded `reason`,
projecting `readiness: 'ready_degraded'` for an otherwise ready box. This does
not change durable asset setup state or executor liveness, trigger setup repair,
or authorize killing active work. Older servers may omit `runtimeHealth`, and
idle status checks still do not wake boxes just to probe execution health.

## Host versus sandbox pressure and protected processes

The Processes panel retains the host load/memory line. `/healthz`, squad/agent
`sandbox-status`, the squad header warning and `sandbox-ps` carry the same additive
`pressure.box` fields:

- `cpuPercent`: delta of the box slice's `cpu.stat` **usage_usec** (user + system
  CPU time), divided by the actual monotonic sampling window. **100% = one CPU**.
  The slice includes short-lived tasks and containers missed by the process list.
  Processes samples this alongside its per-PID ticks.
- `cpuQuotaCpus`: quota / period from `cpu.max`; `cpuQuotaPercent` expresses sampled
  usage as a share of that quota. An unlimited/missing/malformed quota, or a quota
  changed during sampling, leaves the share unknown.
- `cpuThrottledPeriods` / `cpuThrottledUsec`: deltas of `nr_throttled` and
  `throttled_usec` in `cpu.stat`, not lifetime totals.
- `memoryHighEvents` / `memoryMaxEvents`: `memory.events` high/max counter deltas.
- `sampleMs`: actual counter window duration (normally about one second).
- `cpuPressureSome` and `memoryPressureSome`: `{ avg10, avg60, avg300 }` from the
  slice's `cpu.pressure` / `memory.pressure` **some** line. These percentages are
  wall time with at least one task stalled, not CPU utilization or memory use.

The aggregate is discovered from `/proc/self/cgroup`, walking up to the owning
`user-<uid>.slice` (user-manager layout) or `ficus-box-<user>.slice` (system-unit
agent layout), then read under `/sys/fs/cgroup`. There is no fallback to host PSI,
a guessed slice, or another user's slice. Missing/malformed
metrics, counter resets and sampling windows over 30 seconds report `null`, not
zero. Older executors omit `box`. Off Linux the existing pressure result is null.
Health sampling is demand-driven and single-flight: health never waits on it,
reuses completed samples for five seconds, and stops exposing sampled CPU after
30 seconds. Until the first sample finishes it can report PSI but CPU is unknown.
No loop wakes an idle box. Runtime-health degradation, admission, containment,
restart behavior, quotas and fleet-alert hysteresis are unchanged.

CPU PSI is a **stall** metric, not a cause: other slices can starve a runnable
box. The UI/CLI says **This sandbox overloaded** for local reclaim (memory PSI
`some.avg10` at least 10%, or new memory high/max events). On an overloaded host,
usage of at least 90% of the box quota plus positive throttled-period and
throttled-time deltas also identifies a quota-bound sandbox. Normal parallel
work hitting quota on an otherwise quiet host does not create a header warning.
Host load of at least twice the CPU count without those local signals is labeled
**Host overloaded**. A box with CPU PSI `some.avg10` at least 10%, below 50% of its
own quota, no throttling, and known low memory pressure/no reclaim events gets
the explanation that the host is busy with other boxes. Missing metrics never
support that inference. Host load can also include host services and
uninterruptible I/O; these are diagnostic thresholds, not proof of a particular
offending process. Quota saturation and throttling remain visible as details
regardless of whether an overload warning is warranted.

Process rows and every signal request use the same fresh `/proc/<pid>/cgroup`
classification. Docker infrastructure roles (`dockerd`, `containerd` and shims,
`rootlesskit`, `slirp4netns`, `docker-proxy`, `vpnkit`) in `docker.service` are
protected as **Docker runtime**; membership alone does not protect payloads.
Shells and build steps under that unit remain stoppable, including BuildKit RUN
steps that cannot be stopped through `docker ps`. `dbus.service` processes are
**Session bus**; box socket/proxy units are **Box listener**. Server
identity/ancestors and the proven user manager remain protected. Helpers outside
the Docker unit require both an executable role and same-owner ancestry reaching
a proven Docker runtime process in that unit. Names alone do not protect a
process; arbitrary helper children are not protected by ancestry alone.

Membership in the server **service** cgroup does not protect agent command
shells, tests or builds: they inherit that cgroup and must remain stoppable.
Protected rows have a short role label instead of controls. Direct signal calls,
including CLI `sandbox-kill`, receive HTTP 403 with the role and `cannot be
signalled`; enforcement does not depend on a prior listing. New listings expose
`startTicks` (the kernel stat starttime), and UI signal requests echo it. CLI
`sandbox-ps` shows it as START; `sandbox-kill --start-ticks <START>` supplies it.
A stale row/PID identity mismatch returns HTTP 409 without signalling. Legacy
clients omitting it retain their previous behavior. Ownership and PID start time
are also rechecked during the request. This is not an atomic kernel pidfd
operation, and does not claim to eliminate the final kernel scheduling race.
Container workloads remain stoppable via `sandbox-stop-container` / the existing
container Stop action, without killing the daemon, its shims or networking.

## VM sandbox setup readiness and transport recovery

VM box liveness and best-effort setup readiness are independent. A usable box remains
physically `running`, while its durable readiness is either `ready` or
`ready_degraded`. Degraded reasons are bounded safe codes for Devbox comfort tools,
shell activation, Git credentials, callback transport, transport recovery, or ambiguous
command cleanup; raw stderr, commands, endpoints, tokens, and invocation IDs are never
returned by status APIs or fleet alerts.

Failed setup reconciliation backs off from 30 seconds exponentially to a 15-minute base
cap, with deterministic bounded jitter. The 60-second VM lifecycle scans due rows and
repairs tracked boxes; ordinary warmups skip degraded rows until they are due. The third
consecutive degraded result establishes the `sandbox_degraded` alert clock. Devbox and
shell-activation failures notify the current squad manager first and make human escalation
due 15 minutes after that third observation (not after manager delivery). Git credentials,
transport recovery, callback transport, ambiguous outcomes, mixed reason sets, empty sets,
and unknown reason sets notify both audiences immediately. If no valid current manager
exists at initial eligibility, manager delivery is terminally skipped for that episode and
the human alert is immediate; assigning a manager later does not revive it. A new episode
routes using its then-current attribution.

`sandbox_overloaded` incidents come from the fleet-alert tick. On the `vm` runtime it
reads `/healthz` load from ready boxes that have a running execution (an agent's own
box and, for a squad member, its squad box). It reads at most 48 boxes, 8 at a time,
with a 5-second budget each, and skips any that fail. Boxes with no running agent are
never read, since a read would wake a socket-activated box or reset its idle-exit
clock. The load is machine-wide, so every busy box on an overloaded machine has its
own incident. An episode opens when the one-minute load reaches twice the CPU count
and alerts when a reading 10 minutes later is still that high. The squad manager is
told first, and people 15 minutes later; if there is no valid manager, people are told
immediately. The episode resolves when the load falls below the CPU count, or when no
reading has arrived for 10 minutes.

Fleet alerts use one durable delivery row per incident phase and audience. Human messages
retain the trusted `fleet-alert` system-inbox source and best-effort push/external fan-out.
Manager messages use a separate agent-only source and pin their resolved recipient across
retries. Recovery is audience-paired: only an audience whose alert was durably delivered
receives recovery, so resolution before delayed human escalation produces neither a human
alert nor a human recovery. Dead-fleet episodes recover when demand becomes quiet or a
non-manager worker records `run_started_at`; the current manager's wake execution does not
recover or reset the episode, while a worker execution started by that manager counts
normally.

Dead-fleet demand is executable backlog, not residual lifecycle history. Dormant queued
turns count only when wake-eligible; pending-dormancy agents, stale workflow/integration
mail, and informational observer mail do not seed demand. Ordinary standalone and
consultant inbox work still counts, including a genuinely waking dormant batch.
Attempt-local waits do not hide runnable parallel siblings; paused streams and external
PR/human delivery gates remain quiet. Due inbox schedules require live scopes and targets.

A squad stall names a provider only when its known demand routes are currently blocked
by the same provider/account failure. Routing uses the effective agent override or
workflow/type/tier chain and the actual model selector, including configured accounts
and available fallbacks. Elapsed cooldowns permit retry without resolving historical
provider health. Unknown routes (such as not-yet-dispatched streams or work-creating
schedules), mixed causes, and healthy fallbacks leave the demand unattributed. Provider
attribution uses the same-tick health snapshot, not the newest global incident, so
provider-incident persistence order cannot create a false explanation. Legacy stall
notices without routing proof also avoid provider blame and provider-specific fixes.

Manager-audience rows are written unconditionally. This is safe only between
audience-aware Core builds, so the audience-aware image must already be deployed
fleet-wide before this build ships: a pre-audience worker that claimed a manager row
would deliver it to the human system inbox under `source: fleet-alert`, fanning
manager work-injection text out to human push and external channels. Once every API
and worker replica is audience-aware, ordinary rolling/selective tenant upgrades are
safe. Episodes a pre-audience Core already alerted stay human-only — a human-only
alert row suppresses late manager injection — while newly eligible episodes use the
manager-first policy.

Bun socket-close, connection reset, refused, timeout, and network failures are classified
as secret-safe typed transport errors. Core first probes the authenticated executor, then
atomically refreshes only the affected SSH local forward and callback reverse path before
publishing a replacement client. Diagnostics distinguish transport kind, stale forward or
master loss, callback degradation, and executor uptime regression without logging secrets.

A streamed Bash EOF or read failure without a terminal `exitCode` has an unknown outcome.
Core never transparently replays the command: it keeps the stable invocation identity,
reconnects only for future work, and repeats only `/bash/cancel` until the server proves no
owned process remains. Cancellation proves that no predecessor is still running, not that
it produced no side effects. This is especially important for long `devbox install`
commands, which run at most once per reconciliation cycle. Monitor polling retains its
existing five-consecutive-failure tolerance.

### Setup blocked by unproven invocation cleanup

`VM setup invocation cleanup remains unproven` means the setup row retains a
pending Bash invocation and `/bash/cancel` cannot prove its cleanup. A healthy
machine or newly freed disk space does not by itself clear that record. Consultant
chats share a sandbox per squad, so creating another chat in the same squad does
not bypass the blocker.

The executor runs registry maintenance before reserving an invocation. It keeps
known completion proof in memory until terminal records are durably published,
prevents idle exit while that proof is pending, and retries persistence on
cancellation after storage recovers. Terminal records are published atomically so
a partial disk-full write cannot become an immutable, corrupt completion record.

A record left by an older executor or a crash may have no process identity and no
completion proof. Such a record must still fail closed; absence of a PID in JSON
is not evidence that no command ran. Operator recovery requires holding the
sandbox setup lease, ruling out active executions, stopping its server/socket/proxy
units, and verifying no command processes survive before recording termination.
Preserve the original invocation record for diagnosis. Do not simply delete the
setup row or replay an ambiguous command; stopping a process does not undo any
side effects it already produced.

### Reprovision every registered box during offline maintenance

The artifact includes `apps/core/dist/box-reprovision.js`. It rewrites box units
in place using the existing provisioning code and the box's saved `server.env`,
recorded machine/port/user and unchanged executor token. It never removes a box
or relocates its data. `FICUS_BR_BOX=<sandboxId>` selects one registered box;
`FICUS_BR_BOX=all` preflights the whole inventory before the first mutation and
refuses any row that is not settled (`ready` or `stopped`). Resolve exceptions
before claiming the inventory is complete; do not delete orphan rows as a shortcut.

Run it as root, through the operator wrapper (`scripts/setup/run-core-operator.sh`),
on the Linux/systemd tenant Core host, after successful release
activation and explicit machine bootstrap. The API and worker must remain stopped
behind the following temporary start guards throughout the operation. Runtime
masks alone do not work when the installed unit is a regular `/etc` file. The
operator checks the actual D-Bus condition, guard ownership/content, absence of
the allow-start path, inactive units and absence of active executions. A global
advisory lease serializes operator invocations. It rechecks maintenance and the
fixed inventory before each box.

The wrapper loads the same EnvironmentFiles as the installed Core units
(`<dest>/.env`, then `/etc/ficus/managed.env`), parsing them and never
shell-sourcing them (valid values can contain shell metacharacters), sets
`FICUS_ROOT` to the active release as the units' `Environment=` does, and runs
the entrypoint from that release's Core working directory as the units' `User=`.
For the standard hosted artifact paths:

```bash
(
set -eu
# Require the allow-start path to be absent, including a dangling symlink.
test ! -e /run/ficus-box-reprovision.allow-start
test ! -L /run/ficus-box-reprovision.allow-start
for service in ficus-api ficus-worker; do
  install -d -m 0755 "/run/systemd/system/$service.service.d"
  printf '[Unit]\nConditionPathExists=/run/ficus-box-reprovision.allow-start\n' \
    > "/run/systemd/system/$service.service.d/90-ficus-box-reprovision.conf"
done
# Resume automatically only after the entire operation succeeds.
completed=0
cleanup() {
  if [ "$completed" != 1 ]; then
    echo "Maintenance guards retained: inspect the failure and pending journals, then retry." >&2
    return
  fi
  rm -f /run/systemd/system/ficus-api.service.d/90-ficus-box-reprovision.conf \
    /run/systemd/system/ficus-worker.service.d/90-ficus-box-reprovision.conf
  systemctl daemon-reload
  systemctl start ficus-api.service ficus-worker.service
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
systemctl daemon-reload
systemctl stop ficus-api.service ficus-worker.service
FICUS_BR_BOX=all bash run-core-operator.sh box-reprovision
completed=1
)
```

Inspect the installed units' EnvironmentFile paths first if this host uses a
nonstandard configuration. Do not print the env files or tokens. Each result is
`BOX_REPROVISION <id> ok state=<original-status>` or a fixed, secret-free failure
reason; nonzero exit means the run is incomplete. Failure retains the start guards
and leaves the API/worker stopped. Inspect pending journals and retry before
resuming. A preflight-only refusal with no pending recovery may be explicitly
ended by removing only these two guard files, reloading systemd and starting the
API/worker; do not resume automatically after an unverified restoration.

The operator records original runtime intent in owner-only, atomically written
journals under `<HOME_DIR>/box-reprovision` (owned by the account Core runs as;
releases before the service-user switch used `/var/backups/ficus-box-reprovision`,
which the setup toolkit still checks) before it changes artifacts or units. If the process dies, retain those journals and rerun with maintenance guards
in place: pending journals restore the original intent rather than treating a
socket started by an interrupted provision as its original state. The script
may temporarily start rootless Docker during maintenance; final server, socket,
proxy, Docker daemon, enabled-unit and linger/manager states are restored.
Previously idle boxes remain idle, and stopped rows remain stopped. Docker
container process continuity is not guaranteed: the existing provisioning code
restarts its daemon, and containers without restart policies may need an operator
restart. Box home/workspace/private data and credentials are preserved.

Every installation verifies canonical unit/env files and browser-token digest,
ownership, permissions and browser-user readability without waking an idle box.
Only previously running servers receive authenticated health checks, through
their Unix sockets so the TCP proxy stays idle. The operator invalidates the
provisioning stamp after success; it does not invent a canonical spec hash or
change the lifecycle generation. The next canonical ensure can refresh that stamp.
Verify each expected system/user unit and the absence of legacy **regular** unit
files; deliberate alias symlinks remain. Count boxes by identity and unit mode,
not by comparing wildcard system-unit counts to all ready rows.

[VM runtime overview](runtime.md)
