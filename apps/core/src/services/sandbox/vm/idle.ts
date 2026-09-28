/**
 * Pure idle-park decision for a vm sandbox "box".
 *
 * This is the vm-runtime mirror of the k8s pod manager's `checkIdlePods`
 * idle-decision (pod-manager.ts): a box is parked when it is ready, not
 * always-on, has been idle past its timeout, and no keepalive signal wants it
 * kept warm. It is deliberately a PURE, unit-testable function — all I/O
 * (`now`, the keepalive predicate) is injected, so the periodic reaper (slice 4
 * Task 3) owns the side effects and this stays a decision rule.
 *
 * Missing-data caveat: `lastActivityAt` is `undefined` when NO activity signal
 * exists at all — neither a process-local touch nor the row's persisted
 * cross-process heartbeat (the reaper feeds in max(local, row.last_activity_at);
 * see lifecycle.ts). With no signal we cannot know the box's real idle time, so
 * parking on missing data would wrongly reap a box some process is actively
 * using. Such a box is skipped here and left for reconcile/re-ensure, mirroring
 * the k8s manager's care to only reap pods it tracks.
 */
export interface IdleCandidate {
  sandboxId: string
  /** Last known activity (epoch ms): max of the process-local touch and the
   *  row's cross-process heartbeat. `undefined` when no signal exists at all. */
  lastActivityAt?: number
  /** Idle timeout in ms after which an inactive box is parked. */
  idleTimeoutMs: number
  /** When true, the box is never parked for inactivity. */
  alwaysOn: boolean
  /** The box's current status; only `'ready'` boxes are eligible for parking. */
  boxStatus: string
}

/**
 * VM boxes are lightweight and do nothing while idle (measured: agent boxes
 * 75MB/19MB RSS, a squad box 257MB only because it runs rootless dockerd —
 * cheap next to a k8s pod's cluster-resource cost), so the vm runtime
 * defaults every box to `alwaysOn`: the periodic idle reaper (lifecycle.ts)
 * never parks them, and a user session never pays the ~15s park/resume
 * round-trip. This is a single VM-RUNTIME-WIDE policy switch — it does NOT
 * branch on box role (agent/squad/system-manager all default the same way,
 * even though ensure.ts still hardcodes `alwaysOn:false` for agents and
 * squads default their OWN config to false) or on the machine a box happens
 * to sit on (BYO SSH / exe-provisioned / dedicated are all just `machines`
 * rows to this runtime; it has no provider/origin concept to branch on). Idle
 * parking is the k8s/docker-only behavior; nothing here touches those
 * runtimes.
 *
 * The mechanism itself (`shouldParkBox` below, the lifecycle reaper's
 * `stopBox` call) is NOT removed — it stays fully alive and re-enablable, in
 * case a future capacity concern calls for it, via ONE global override:
 * `FICUS_VM_BOX_PARK_ON_IDLE=true`. With the override set, a box's actual
 * requested `alwaysOn` (from `opts.k8s.alwaysOn` — e.g. a squad's own
 * always-on config, sourced by whichever caller — manager.ts or
 * lifecycle.ts — resolves the box's tracked/untracked `alwaysOn`) is honored
 * again, exactly as before this policy existed.
 *
 * Deliberately a leaf-module export: BOTH `vm/manager.ts` (a box THIS process
 * tracks — `_ensureSandbox` seeds `VmSandboxState.alwaysOn` from it) AND
 * `vm/lifecycle.ts` (a box the sweep's `getLifecycleState` returns nothing
 * for — ensured by the OTHER process, or by this process before a worker
 * restart wiped its in-memory map) must apply the SAME default, or the policy
 * only half-applies: a box the reaper doesn't happen to have in memory would
 * still be parkable at the old 15-minute timeout regardless of this policy.
 */
export function vmBoxAlwaysOnDefault(): boolean {
  return process.env.FICUS_VM_BOX_PARK_ON_IDLE !== 'true'
}

/**
 * Whether an idle box should be parked. Parks iff the box is `ready`, not
 * `alwaysOn`, some activity signal exists (`lastActivityAt !== undefined`),
 * the injected keepalive predicate does not want it kept warm, and it has been
 * idle strictly longer than its timeout. Cheaper branches short-circuit before
 * the (async, potentially DB-hitting) keepalive check.
 */
export async function shouldParkBox(
  candidate: IdleCandidate,
  now: number,
  keepAlive: (sandboxId: string) => Promise<boolean>
): Promise<boolean> {
  if (candidate.boxStatus !== 'ready') return false
  if (candidate.alwaysOn) return false
  // No activity signal from ANY process → never reap on a guess.
  if (candidate.lastActivityAt === undefined) return false
  if (await keepAlive(candidate.sandboxId)) return false
  return now - candidate.lastActivityAt > candidate.idleTimeoutMs
}
