# Machine host memory model

How the boxes on one machine host share its memory: what a box may burst to,
what is protected, what gets killed when memory runs out, and how the agent
hears about it. The policy lives in `scripts/machine/box-provision.sh` (per box,
on every provision) and `scripts/machine/bootstrap.sh` (per host, on every
bootstrap). Both target Ubuntu 24.04 (systemd 255, cgroup v2).

## Why

On 2026-11-16 one box on a 16 GB host with no swap and 57 boxes ran two copies
of a Next.js dev server. They grew to 6.7 GB between them and the box's slice
reached 7.7 GB, just under its 45% soft cap. With no swap, the kernel could only
reclaim the file cache every box shares: memory pressure (PSI `full avg10`)
reached 95% and the load average 69. Nothing was OOM-killed, but systemd itself
stalled, so provisioning other boxes failed (a 20 second `daemon-reload` timed
out and was reported as a Docker containment failure) and Docker health checks
timed out for about 12 minutes.

The policy that follows: a single box should be able to burst to a sizable share
of a host whose other boxes are idle, and its neighbors are protected by memory
pressure protection (floors, swap, systemd-oomd), not only by a lower cap.

## What a box may burst to (caps)

Each box's slice (`user-<uid>.slice` in user mode, `ficus-box-<user>.slice` in
system mode) gets a root-owned drop-in, `50-ficus-box.conf`, with caps that scale
with host size: a percentage on large hosts, most of the host on small ones.

| Quantity | Formula | Constant(s) |
| --- | --- | --- |
| Host reserve R | max(512 MiB, 10% of MemTotal) | `SLICE_HOST_RESERVE_FLOOR_KB`, `SLICE_HOST_RESERVE_PCT` |
| `MemoryMax` (hard cap; the kernel OOM-kills inside the box above it) | min(MemTotal - R, max(40% of MemTotal, 3 GiB)) | `SLICE_MEMORY_MAX_PCT`, `SLICE_MEMORY_MAX_FLOOR_KB` |
| `MemoryHigh` (soft cap; the box is throttled and reclaimed above it) | min(`MemoryMax` - 256 MiB, max(30% of MemTotal, 2.5 GiB)) | `SLICE_MEMORY_HIGH_PCT`, `SLICE_MEMORY_HIGH_FLOOR_KB`, `SLICE_MEMORY_HIGH_HEADROOM_KB` |

| Host | `MemoryMax` | `MemoryHigh` |
| --- | --- | --- |
| 2 GiB | 1.5 GiB | 1.25 GiB |
| 4 GiB | 3 GiB | 2.5 GiB |
| 8 GiB | 3.2 GiB | 2.5 GiB |
| 16 GiB | 6.4 GiB | 4.8 GiB |
| 32 GiB | 12.8 GiB | 9.6 GiB |

Every box role gets the same caps. (Before this model, caps were a flat 35% /
50%, and 45% / 50% for Docker-capable squads.) On small hosts the cap is not
what protects the neighbors; the floors, swap and oomd below are.

`box-provision.sh --print-slice-limits --memtotal-kb <kB> [--swaptotal-kb <kB>]
[--box-count <n>]` prints the drop-in for any host size without touching the host.

## What is protected (floors)

`MemoryLow` is memory the kernel reclaims from a cgroup only after every
unprotected page on the host is gone, so under pressure a greedy box reclaims
from itself before it can take the working set of a quiet neighbor.

- **Each box:** min(256 MiB, its share of the floor pool), where the pool is 40%
  of the box budget (MemTotal - R) divided by the number of box accounts on the
  host (`SLICE_MEMORY_LOW_MAX_KB`, `SLICE_MEMORY_LOW_POOL_PCT`). On the 16 GB
  incident host, 57 boxes get about 101 MiB each instead of 256 MiB (57 x 256 MiB
  would have been 14.6 GB). A floor only protects memory the box actually uses,
  so idle boxes claim nothing.
- **Host-critical services:** `system.slice` (systemd, journald, sshd, every
  box's socket proxy, the browser service) gets 50% of R, and `user-0.slice` plus
  the provisioning SSH user's own `user-<uid>.slice` (Core's SSH commands and
  tunnels) get 25% of R each (`HOST_SYSTEM_MEMORY_LOW_PCT`,
  `HOST_ADMIN_MEMORY_LOW_PCT`). This keeps the control path answering under
  pressure.
- **The pool as a hard bound:** `user.slice` carries the user-mode boxes' floors
  plus the admin floors, and `ficus.slice` / `ficus-box.slice` carry the
  system-mode boxes' floors. A child's protection is only effective up to its
  parent's, so the total stays bounded even while a box provisioned earlier,
  with fewer neighbors, still carries a larger share.

These host drop-ins (`/etc/systemd/system/<slice>.d/50-ficus-memory-floor.conf`)
are recomputed on every provision and rewritten only when a value changes.
`--print-host-floors` prints them.

## Swap

`bootstrap.sh` creates a swapfile at `/swapfile` of 25% of RAM, at least 1 GiB
and at most 4 GiB (`MACHINE_SWAP_*`), only when the disk keeps 5 GiB free after
it. It follows the same state machine as `ensure_swapfile` in
`scripts/setup/lib.sh`: an active managed swapfile is kept, another active swap
device is left alone, an existing file is re-activated, and a new file is
allocated through a temporary file. Each box may use at most 25% of the host's
swap (`MemorySwapMax`, `SLICE_SWAP_MAX_PCT`), so one box cannot fill it.

A swapfile rather than zram: zram needs a kernel module that some provider
kernels lack, and its compressed pages still live in RAM and cost CPU exactly
when the host has neither to spare. With swap, cold pages (idle sandbox
servers, the unused heap of a dev server) can leave RAM, so reclaim is no longer
limited to the shared file cache.

## What gets killed (systemd-oomd)

`bootstrap.sh` installs and starts `systemd-oomd` and sets
`DefaultMemoryPressureDurationSec=20s` (oomd's default is 30s). The box units
set `ManagedOOMMemoryPressure=kill` with `ManagedOOMMemoryPressureLimit=50%`:
when the monitored cgroup's tasks are all stalled on memory for more than half
of the time for 20 seconds, it is thrashing rather than busy, and oomd SIGKILLs
the leaf cgroup below it that is reclaiming the most.

What can be killed, and what never is:

- **The box's commands.** The sandbox server unit is delegated (`Delegate=yes`)
  and systemd starts the server in the `supervisor` subgroup
  (`DelegateSubgroup=supervisor`). The server moves every bash invocation into
  its own `workload/inv-<invocation id>` leaf while it is still stopped in
  admission, so a dev server, build or test run is a separate kill candidate,
  together with everything it started.
- **A user-mode box's rootless Docker:** `ficus-docker.slice` (dockerd and
  every container scope) is monitored the same way through
  `/etc/systemd/user/ficus-docker.slice.d/50-ficus-oomd.conf`.
- **Never the sandbox server.** The server marks `supervisor` with the
  `user.oomd_omit` xattr, which oomd honors because the candidate and the
  monitored unit are owned by the same (box) user. The server keeps answering,
  so the agent hears what happened.

Ubuntu's `systemd-oomd` package also ships two default policies, and
`bootstrap.sh` replaces both with same-named files in `/etc/systemd/system`
before the package is installed: `ManagedOOMSwap=kill` on `-.slice` (kill
whichever cgroup on the host swaps the most once swap is 90% full) and
`ManagedOOMMemoryPressure=kill` on every `user@.service` (which could pick a
box's own user manager or an admin session). Neither can be steered away from a
sandbox server, because oomd honors `user.oomd_omit` only below a cgroup the
box user owns. Swap is bounded per box by `MemorySwapMax` instead.

The kernel OOM killer still acts inside a box that reaches its `MemoryMax`.

Units provisioned before this model, servers that are not delegated, and the
k8s and Docker runtimes run commands in the server's own cgroup exactly as
before (the server logs `Workload cgroups: off`).

## How the agent hears about it

- **A command that was running:** its result is the error `Killed by
  systemd-oomd: this box was under sustained memory pressure ...` (or `Killed by
  the kernel OOM killer: this box reached its memory limit ...`) with exit status
  137, instead of a bare signal. The server reads the kill counters on the
  command's own leaf: oomd's `user.oomd_ooms` xattr and the kernel's `oom_kill`
  count in `memory.events`
  (`packages/sandbox-server/src/services/workload-cgroup.ts`).
- **A background process started by an earlier command** (a dev server, a test
  database started with `&`): the next command run in that box starts its output
  with a `[ficus] systemd-oomd killed the processes started by an earlier command
  in this box (...)` notice naming the command that started it.

## Starting a dev server twice

Before spawning, the server checks a command that starts a known dev server on
an explicit port (`next dev --port 3000`, `vite --port`, `PORT=3000 npm run dev`,
`python -m http.server 8000`, and similar). If a process of the same box already
listens on that port, the command fails at once with exit status 98 and a
message naming that process, its command line and its working directory,
instead of starting a second copy (`dev-server-guard.ts`). A command that also
stops processes (`kill`, `pkill`, `fuser`, `lsof`) is replacing the server and is
not checked.

## Provisioning under host memory pressure

When the `daemon-reload` that installs a box's limits times out and
`/proc/pressure/memory` shows `full avg10` of at least 10%, `box-provision.sh`
exits 69 with `FICUS_HOST_MEMORY_PRESSURE` and the PSI reading. Core turns that
into `BoxHostMemoryPressureError`, a startup retry (`box_host_memory_pressure`,
30 seconds doubling to 8 minutes) whose stream notice names the host's memory
pressure. It is not reported as a Docker containment failure, and Docker is left
as it was: the limits loaded by the last successful provision still apply. The
same timeout on a calm host, and any reload that fails rather than times out,
remain terminal containment failures.

## Failed-unit hygiene

A per-user manager that is SIGKILLed stays loaded as a failed
`user@<uid>.service` until reset, and every loaded unit slows `daemon-reload`
(one host carried 1,107). Box removal now stops the box's manager through
systemd before killing what is left, and resets its `user@<uid>.service` and
`user-runtime-dir@<uid>.service`. Every provision and every bootstrap also runs
`systemctl reset-failed 'user@*.service' 'user-runtime-dir@*.service'`, which
clears a failed state and never stops anything.

## Rollout: how existing hosts converge

No manual host step is needed for hosts that re-bootstrap automatically.

1. **Host level (swap, systemd-oomd, oomd duration, failed-unit sweep).** These
   live in `bootstrap.sh`, and the bootstrap version hashes both machine
   scripts. After a Core upgrade that contains this change, the worker's
   boot-time bootstrap-drift reconcile re-runs `bootstrap.sh` on every ready
   machine whose version differs. A host deferred for an explicit layout
   migration converges at its explicit bootstrap. On a prebaked image,
   `systemd-oomd` is installed by `ensure_oomd` if the image predates it.
2. **Box level (caps, floors, swap share, unit delegation and oomd policy, the
   Docker oomd drop-in, host floors).** `box-provision.sh` reaches every host as
   a machine artifact. Each box's spec hash includes the box-provision version
   and the server bundle version, so each box is re-provisioned on its next
   ensure after the upgrade: new slice drop-ins, the delegated unit and the new
   server arrive together. To converge every box at once, use the offline
   reprovision tool (see [runtime recovery](runtime-recovery.md)).
3. **Until a box is re-provisioned** it keeps its old caps and unit, so oomd
   does not watch its commands. The host floors appear with the first provision
   on that host after the upgrade, whichever box it is.

Note that the oomd policy only acts once both halves have landed: oomd running
on the host (bootstrap) and the box's delegated unit (provision).
