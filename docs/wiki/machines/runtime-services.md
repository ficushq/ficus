# VM runtime services

## Per-box rootless docker

A shared rootful `dockerd` is root-equivalent for every user in the `docker`
group (`docker run -v /:/host …` trivially reads every box's `~/.private`), which
is incompatible with the per-box privacy the runtime promises. So the vm runtime
**never runs a shared daemon** — `bootstrap.sh` installs the engine but disables
**and masks** `docker.service` + `docker.socket`. Each box that needs containers
runs its **own rootless dockerd** instead (spec §5):

- **Which boxes.** `box-provision.sh --with-docker` provisions the daemon;
  box-manager passes it for **squad** and **system-manager** roles (they run
  container workloads). **Agent** (light) boxes never run containers, so they get
  no daemon and no `DOCKER_HOST` — mirroring k8s, where the agent role skips the
  dockerd bring-up.
- **How it works.** `--with-docker` runs `dockerd-rootless-setuptool.sh install`
  as the box user and enables a `docker.service` **systemd `--user`** unit under
  the box user's linger. The daemon listens on `unix:///run/user/<uid>/docker.sock`;
  containers run inside the box user's own subuid/subgid namespace (auto-allocated
  by `useradd`, or allocated above all existing ranges if missing), so a container
  escape lands in the _box user_, not root, and other boxes' files stay unreadable.
- **Provisioning environment isolation.** Commands run as the box user pin
  `HOME`, XDG config/data/cache/runtime paths and `DOCKER_CONFIG` to that box,
  use its rootless socket, and discard inherited Docker context/TLS selectors.
  Resetting only `HOME` is insufficient: Docker's setuptool writes its unit under
  `XDG_CONFIG_HOME`, which may still point into the provisioning caller's home.
  The generated Docker service pins the same paths, runtime directory and bus
  address explicitly: the user manager launches the daemon separately and may
  itself retain another UID's environment. This is per-service configuration,
  not a global manager-environment change. The runtime fixture also poisons its
  own user manager before restart to verify this second boundary.
- **CPU/memory containment (cgroup v2).** The root-owned
  `user-<uid>.slice` is the box boundary, not `docker.service`: systemd's Docker
  driver creates container scopes outside the daemon's own service cgroup.
  Provisioning installs the root-owned slice limits **before enabling linger**,
  then verifies the kernel's `memory.high`, `memory.max` and `cpu.max` are finite,
  positive and no larger than the configured box caps. These checks also cover
  already-active slices. No separate runtime `system.control` overrides are left
  behind when the account is removed. The required hierarchy is:
  ```text
  user.slice/user-<uid>.slice/                 # root-owned CPU/memory boundary
    user@<uid>.service/                       # this box's delegated user manager
      ficus.slice/ficus-docker.slice/
        docker.service/                      # rootlesskit/dockerd/containerd/shims
        docker-<container-id>.scope/          # container payloads
  ```
  The Docker drop-in pins `Slice=ficus-docker.slice`,
  `--exec-opt native.cgroupdriver=systemd` and
  `--cgroup-parent=ficus-docker.slice`, retaining service delegation only inside
  the existing user-manager subtree. Even a workload choosing another container
  cgroup parent through that manager stays below the root-owned box boundary.
  Provisioning checks both managers' `ControlGroup` paths and requires Docker to
  report the `systemd` driver on cgroup v2. Failure refuses the success UID marker
  and attempts a bounded stop/disable of **only this user's** Docker service;
  cleanup failure cannot be interpreted as proof that an escaped daemon stopped.
  It never enables the rootful daemon, adds host privileges, changes global
  delegation, or removes security/port restrictions. CPU quota bounds scheduled
  CPU time, not host load averages or all sources of I/O pressure.
- **Database-capable squad memory sizing.** For `squad_*` boxes provisioned
  with `--with-docker`, `box-provision.sh` sets `MemoryHigh` to **45% of host
  MemTotal**, instead of the default 35%. This is 90% of the unchanged
  **50% MemoryMax**: test databases, their clients, builds and the box server
  share one working set, with 10% of the hard cap left for reclaim before a
  slice-local OOM. Docker capability is the stable provisioning predicate; the
  script does not inspect transient running containers or raise/lower limits
  every time a test database starts/stops. Agent boxes, system-manager boxes,
  non-Docker squads and unknown roles retain 35%. CPU remains half the host's
  cores (minimum one core), and `TasksMax` remains 8192.

  This chooses bounded soft-cap headroom rather than relocating test databases
  or increasing the hard cap. It does **not** reserve RAM, guarantee that all
  colocated boxes fit simultaneously, or fix CPU/I/O contention. Workload
  concurrency still needs admission control; raising the soft cap allows more
  resident memory before reclaim, while the hard host-share boundary remains
  unchanged. Small hosts receive the same proportional bound, not an absolute
  floor that could exceed their capacity. Values are floored to whole KiB in
  the provisioner; kernel readback can additionally round down to page size.

  The motivating measurement was a **5.97 GB** historical peak against a
  **5.87 GB** soft cap on a database-running squad. Lifetime `memory.events`
  counts are not evidence of current pressure: retain timestamped per-run
  deltas in the validation report rather than treating them as a current rate.
  Provisioning fixtures prove selection and convergence, not live-host
  enforcement or workload improvement.

  After the updated artifact reaches the target through authorized normal
  provisioning, read that **same parent slice**, not just the Docker service:
  `memory.high`, `memory.max`, `cpu.max`, `memory.current`, `memory.peak`,
  `memory.events`, `memory.pressure`, `cpu.pressure` and `cpu.stat`. Capture UTC
  and monotonic timestamps immediately before and after the same focused
  workload, plus host load and available memory. Compare counter/PSI **deltas**
  over elapsed time, retain the test completion summary, and tear down only
  the run's own test database. Verify the new soft-cap readback and unchanged
  hard/CPU caps first. A quiet run with zero new `high` events is not proof that
  the historical pressure has been solved; evaluate a representative busy
  window too, within the normal concurrency budget, without synthetic memory
  exhaustion. Missing target convergence or after-state data remains an open
  verification requirement, not something a dry-run fixture can satisfy.

- **Shared-host scheduling and bounded startup.** Squads and private agent boxes
  share host CPUs. Their kernel `CPUQuota=max(100%, nproc*50%)` values are
  **ceilings, not exclusive CPU reservations**; adding these ceilings together
  must not prevent another squad or agent from running. Existing per-box CPU,
  MemoryHigh, MemoryMax and task limits remain enforced by Linux cgroups.
  Configured squad work-stream limits and explicit resource pools still apply.

  The durable host ledger tracks distinct boxes across streams, executions and
  provisioning generations. Shared boxes are deduplicated, actual participants
  replace pending stream identities, and claims move with authoritative binds.
  Logical admission does not deny work based on this count or missing CPU facts.

  Physical setup is bounded separately to prevent a provisioning storm after an
  upgrade: a host allows **half its CPUs** in concurrent startup generations, at
  least **two** (also for unknown CPU facts) and at most **eight**. A
  **background** start, one with no execution of an agent using the box queued,
  waiting for a sandbox or running (warmups, spec reconciles, the devbox
  prewarm), never takes the **last** free slot, so a waiting turn is not
  outraced by background retries. Running boxes do not consume startup slots. Only admitted physical generations with live
  setup leases own slots, and same-box followers share the owner's generation.
  Different hosts progress independently. Normal box reconnects bypass setup
  admission. A spec recreation reserves its startup slot **before** stopping the
  old box, under the same setup lease and generation as the rebuild; a busy host
  leaves the old box and client available. Lifecycle generation fencing and
  verified-stop requirements still apply.

  Short transactional claims serialize startup admission. No transaction or
  extra DB session spans SSH. Lock contention uses bounded jittered retries.
  Capacity waits requeue without spending startup retries or increasing
  provisioning backoff. A durable first-wait timestamp caps the episode at
  30 minutes: polling slows from 5 seconds to 30 seconds after 2 minutes, then
  60 seconds after 10 minutes. Terminal notices include the machine ID and
  refusal reason; only allowlisted details are persisted, never remote output.
  Successful runner startup clears the wait window before model dispatch.
  Actual startup failures retain their separate bounded retry budget.

  Claims follow lifecycle records, not expiring permits. Abandoned/interrupted
  work with an unverified binding remains tracked conservatively, but a dead
  generation cannot hold a permanent startup lane. A running provision claim
  requires its actual granted PostgreSQL session advisory lock in this database;
  a crash that leaves a running row cannot preserve ownership after the session
  disappears. Unverified stop/ensuring bindings remain conservatively observed
  as remote demand, without acquiring a startup lane. Successful same-box recovery,
  a later confirmed stop, or normal box removal releases the uncertain claim.
  Normal removal deletes the binding after remote teardown; a capacity refusal
  or an unrelated failed retry alone is not evidence that remote work stopped.
  Same-box recovery does not double count its predecessor. Referenced generations
  are retained; settled claim rows are reclaimed on subsequent claims. Optional
  devbox prewarm uses the same full-generation gate, including its cleanup.
  Pre-existing running turns, provisioning and recent box activity are accounted
  conservatively (recent command/terminal touches have a 60-second cooldown).
  This does not schedule unmanaged host processes or guarantee memory/I/O capacity.

  The squad header shows **Host load** (one-minute load / host CPUs) and live
  **Starting boxes / startup limit** when setup is in progress. It no longer
  labels summed CPU ceilings as reserved host quota. Missing samples are not
  zeros. `SandboxStatus.hostCapacity` reports aggregate box counts and startup
  concurrency using database reads without probing or waking an idle box.
  Per-box pressure attribution remains separate. Representative burst verification
  still needs timestamped `cpu.stat`, `memory.events` and PSI deltas across the
  host's boxes; passing claim fixtures is not live proof.

- **Existing boxes / recreation.** The script is content-hashed into provisioning
  drift, so existing boxes receive this wiring on their next full provision or
  recreation, not by a live fleet migration. Installing/changing the drop-in
  restarts that box's Docker once; unchanged healthy provisions leave its
  containers alone, and a stopped daemon is started again. Conflicting
  `daemon.json` driver/parent settings fail startup rather than silently bypassing
  the chosen wiring. User-manager operations and Docker readiness checks are
  bounded; an unresponsive daemon is a provisioning failure, not deferred success.
- **`DOCKER_HOST`.** The box user's uid is `useradd`-assigned and NOT
  deterministic, so `box-provision.sh` prints it once on stdout (`FICUS_BOX_UID=<uid>`);
  box-manager reads it (`parseBoxUid`) and bakes
  `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` into the box's `server.env`
  (`derivedBoxEnv`). The sandbox-server's docker path is gated on `FICUS_BOX_HOME`
  (set only by vm boxes): it never spawns rootful `dockerd` or `chmod 666`s a
  system socket — it only **verifies** the box's own rootless socket answers
  (`docker info`). k8s pods (sysbox) and local docker leave `FICUS_BOX_HOME` unset
  and are byte-identical to before (`packages/sandbox-server/src/docker.ts`).
- **Known workload gaps** (spec §5): no `--privileged` in the rootful sense,
  ports <1024 need a sysctl, some exotic network modes fail. These are inherent to
  rootless docker; the escalation tiers below cover workloads that truly need more.

**Escalation tiers (FUTURE — designed in spec §5, not built this slice):**

- **Dedicated-machine rootful.** A box whose workload genuinely needs rootful
  docker (or heavy DinD nesting) is _placed on its own VM_, where a rootful daemon
  is harmless because it owns only that VM. This is a placement setting on the
  agent/squad config, not new architecture — but the setter is not wired yet.
- **Docker-host machine.** A machine whose only job is a rootful daemon, with
  boxes pointing `DOCKER_HOST=ssh://` at it (build-farm / CI style). **Caveat:**
  bind mounts don't cross machines (`-v $PWD:/app` breaks), so it suits image
  builds and self-contained compose stacks, not mounted-workspace dev loops. Not
  implemented this slice.

A shared rootful daemon on a multi-box machine is **never** offered.

## Egress model

Egress lockdown is **machine-level and opt-in**: it governs the whole machine
(every box on it), not per box. Set a machine's `egressPolicy` and `bootstrapMachine`
runs `bootstrap.sh --egress-lockdown --core-cidr <cidr>`, which loads a dedicated
`table inet tau_egress` output-hook ruleset (idempotent — flushed + recreated on
each apply) reproducing `k8s/network-policy.yaml`'s egress intent:

- **Allowed:** loopback (`oif lo`), `established,related` return traffic, DNS
  (udp/tcp dport 53), every `--core-cidr` allow-exception, and — by the default
  `policy accept` — the public internet.
- **Dropped (IPv4):** the `denied4` interval set — RFC1918, CGNAT, loopback,
  link-local, the cloud-metadata `169.254.0.0/16`, and the other special-use
  ranges, byte-identical to the `except:` block of `network-policy.yaml`.
- **Dropped (IPv6):** the `denied6` set — `fc00::/7` (ULA, which subsumes both
  `fd00::/8` and the AWS IPv6 IMDS `fd00:ec2::254`) and `fe80::/10` (link-local,
  which subsumes the `fe80::a9fe:a9fe` metadata mapping). Collapsing to these two
  non-overlapping supernets is deliberate: an nftables `flags interval` set
  rejects overlapping elements, so listing a subrange alongside its supernet would
  fail to load. This closes the slice-2 dual-stack leak.
- **Container path.** A box's containers egress via slirp4netns userspace NAT,
  which does the real outbound `socket()` in the **host** netns as the box user —
  so container traffic traverses this same output hook and is subject to the same
  deny-list. A container cannot reach RFC1918 that the host can't.

The `--core-cidr` value is **security-critical**: it is interpolated verbatim
into the root `nft -f` input, so `bootstrap.sh` validates it (strict IPv4-CIDR
shape _and_ numeric bounds, base-10 to reject octal leading-zero octets) and
exits non-zero before any `nft`/`apt` call on a bad value. The box→core **reverse
tunnel** keeps working under lockdown even when core sits in an otherwise-dropped
RFC1918 range: it rides the inbound SSH connection (`established`) over loopback,
both allowed ahead of the drop.

**Honest limits.** DNS is allowed **globally** (any resolver on :53), not pinned
to a specific server — a deliberate simplification. The rules are the machine
boundary between _tenants_; intra-tenant isolation between one tenant's boxes on a
shared machine is Unix users + rootless docker, not egress (which is machine-wide).
Per-tenant machines are the tenant boundary.

## Browser service

Like rootless docker, headless browsing is **shared per machine, isolated per
box** — one Chromium process serves every box on the host, the same trade
that keeps ~1.5 GB of browser-process overhead off a 9-box machine instead of
paying it per box (design: `docs/history/superpowers/specs/2026-08-21-browser-tools-in-sandbox-design.md`).

- **One `ficus-browser` service per machine.** `bootstrap.sh`'s `install_browser`
  creates an unprivileged `ficus-browser` system user + group, installs Playwright
  - a pinned Chromium under `/opt/ficus/browser`, and writes the `ficus-browser.service`
    systemd **system** unit (`User=ficus-browser`, `RuntimeDirectory=ficus-browser`).
    The service (`scripts/machine/browser/ficus-browser.js`, embedded byte-identical
    into both `bootstrap.sh` and `packages/machine-image/Dockerfile`) launches one
    headless Chromium and listens on a unix socket at `/run/ficus-browser/sock`,
    mode `0660` group `ficus-browser` — nothing outside that group can connect.
    Chromium's own sandbox stays on (a hard bootstrap gate, unrelated to the box
    sandbox); `Restart=on-failure` recovers a crashed browser, dropping every
    box's in-flight pages.
- **One `BrowserContext` per box, run-id-keyed pages inside it.** The service
  keys a `Map<boxUser, { context, pages: Map<runId, page> }>` on the
  _authenticated_ box user — no verb accepts or reads a context identifier, so
  one box cannot express reaching another box's context or pages even in
  principle. `open`/`click`/`type`/`scroll`/`screenshot`/`read`/`console`/`close`
  mirror the seven core browser tools' schemas verbatim (`apps/core/src/tools/browser.ts`).
- **Auth: per-box token digest files, not a pushed token list.** Box-manager
  writes `sha256(<box's EXECUTOR_AUTH_TOKEN>)` hex — never the raw token — to
  `/opt/ficus/browser-tokens/<boxUser>.token`, `0640` `root:ficus-browser`, at
  provision (right after the `server.env` push, over the same non-argv
  `install -m /dev/stdin` channel). The service compares `sha256(bearer)` from
  the request against the file contents with `crypto.timingSafeEqual` — a
  leaked digest file is unreplayable, so a chown mistake or an on-box `cat`
  can't hand out a working credential. The tokens directory is a **sibling**
  of `/opt/ficus/browser` (not nested in it), because `install_browser`
  recursively chown/chmods `/opt/ficus/browser` world-readable for the Chromium
  binaries and would otherwise expose every box's digest to every other box.
  Box removal `rm -f`s the token file (`removeBoxUserOnMachine`), which is the
  revocation mechanism — the service never gets an explicit "box removed"
  notification, so a stale context simply 401s on its next call and is reaped
  by the 15-minute context-idle sweep below. Both writes are **non-fatal**
  (self-cleaning on failure) so a pre-browser machine's provisioning is
  unaffected.
- **Box server pass-through.** `packages/sandbox-server/src/server.ts` proxies
  `/browser/open|click|type|scroll|screenshot|read|console|close` straight to
  the socket with the box's own token — no Playwright dependency in the box
  server, and the socket peer's status/body are forwarded verbatim. If the
  socket is absent or refuses the connection (pre-browser machine, service
  down), the box server returns `503 { error: 'browser unavailable on this
machine', code: 'BROWSER_UNAVAILABLE' }` rather than hanging or 500ing.
- **Core: thin `/browser/*` clients, no Playwright.** `apps/core/src/tools/browser.ts`'s
  seven `browser_*` tools no longer run their own Chromium — Playwright is
  deleted from core's `package.json`/build externals/postinstall entirely.
  Each tool resolves the calling agent's `SandboxClient` and calls one of
  `browserOpen`/`browserClick`/`browserType`/`browserScroll`/`browserScreenshot`/
  `browserRead`/`browserConsole`, which POST straight to the box server's
  `/browser/*` routes above (a `browserClose` client method exists but core
  never calls it — cleanup rests on the service's idle reaper, ruling R-C6). `browser_click`, `browser_type`
  and `browser_scroll` set `returnScreenshot: true` on every call, so the
  service performs the action and captures the post-action screenshot in one
  request — today's "act, then see the result" UX costs the same single
  round-trip it always did, just from the box instead of in-process. A call
  against an unopened session (no prior `browser_open`) gets `No page is
open in this browser session — use browser_open with a URL first.`
  instead of the old silent blank-page creation (spec §10, R-C3).
- **DEPLOY-WINDOW semantics — two machine/box generations can lag core.**
  Because the tools, the box-server routes and the `ficus-browser` service
  version independently (§ Fleet effect below), a rollout window exists
  where core's expectations outrun what a given machine or box is actually
  running:
  - A machine whose `ficus-browser` service predates `returnScreenshot`
    ignores the flag (unknown field, old code path) — `click`/`type`/`scroll`
    still succeed but come back with no `screenshotBase64`, so the tool
    degrades to a text-only result `(screenshot unavailable)` until that
    machine re-bootstraps onto the new service.
  - A box still running a pre-Phase-2 server bundle (before `/browser/*`
    existed) 404s every browser route — `browser_open` reports "Browser
    routes are unavailable on this box (stale sandbox server) — the box
    will gain browser support when it is next recreated." rather than a raw
    404, until the box is recreated (park + re-ensure) onto the current
    bundle. The other six tools instead read a 404 as R-C3's "no page open"
    case, since a stale-bundle 404 and a genuine unopened-session 404 are
    indistinguishable to them.
    Both are self-healing, not incidents: the machine reconciler and the box
    spec-hash drift check each carry the fleet forward on their own schedules:
    see § Fleet effect below for the box side.
- **Caps.** 3 pages per box (a 4th `open` evicts the box's own LRU page,
  concurrency-safe — an in-flight page reservation counts toward the cap so a
  concurrent burst can't sneak past it); a machine-wide ceiling of
  `floor(MemoryHigh / 256 MB)` total pages (`MemoryHigh` from the
  `ficus-browser.service` memory-cap drop-in, default 8 GB → 32 pages),
  returning `429` past either limit; pages idle-close after 10 minutes, whole
  contexts idle-close after 15 (cookies/storage are not preserved across
  that — browsing is ephemeral by design).
- **SSRF host filter.** Every navigation — the `open` verb's own check and a
  `context.route('**')` guard covering redirects/iframes/subresources — blocks
  loopback, `169.254.0.0/16` (including the `169.254.169.254` cloud-metadata
  IP), `*.internal`/`metadata`/`metadata.google.internal`, and the IPv6
  equivalents (`::1`, `fe80::/10`, `fc00::/7`, and IPv4-mapped/NAT64 forms of
  the above, normalized so bracket/trailing-dot tricks can't bypass it).
  **RFC1918 private ranges are deliberately allowed** — a box's `bash` already
  has the machine's network position and can reach them today, so blocking
  only the browser would be inconsistent security theater. The filter is a
  name-based table, not a DNS-rebinding defense (see
  `docs/backlog/machines/follow-ups.md`'s Phase 2 ledger); it stops an agent-supplied
  URL from directly reaching the metadata IP or another box's loopback
  service, which is the primary abuse case for a shared-host renderer.
- **Fleet effect of shipping this.** `server.ts` and `box-provision.sh` both
  changed, which bumps the sandbox-server bundle version and the
  box-provision script version that feed a box's spec hash (§ Troubleshooting
  → Drift / stale bundle). Every box on every machine picks up the change the
  same way any other drift does — not a forced fleet-wide restart, but each
  box recreates (park + re-ensure) the next time it goes through the idle
  reaper or is otherwise re-ensured, so the rollout is gradual and
  idle-gated rather than immediate.

[VM runtime overview](runtime.md)
