/**
 * Box-creation timing — the single, app-side (Core) clock authority for the
 * "Box ready" summary line VmSandboxManager logs at the end of every ensure
 * (see services/sandbox/vm/manager.ts and services/machines/box-manager.ts).
 *
 * ## Doctrine (measure, don't guess — see docs on the box-timing initiative)
 * A 30-60s cold box creation was operator-observed on a machine host and the
 * cause is UNKNOWN. This module exists to answer "where did the time go" from
 * a single grep-able log line, not to fix anything.
 *
 * ## Clock authority
 * Every duration here is produced by ONE clock: the calling process's own
 * `Date.now()` (injectable as `now()` for tests), taken immediately before and
 * after each step Core already awaits (an SSH `runner.run`, an HTTP call to the
 * box, a DB read, ...). Nothing here ever reads or trusts a REMOTE timestamp —
 * a box-side or SSH-remote clock could be skewed relative to Core's, which
 * would make cross-step comparisons meaningless. Where a remote process streams
 * output back to Core in real time (the box's `/bash` SSE stream), we may time
 * against WHEN CORE OBSERVES a chunk arrive — still Core's own clock, just
 * timestamped at a more granular moment — never a timestamp embedded in the
 * stream's text.
 */

/**
 * The canonical, fixed set of steps a box-creation summary line reports. Order
 * here is the order they render in — fixed and NOT re-sorted from recorded
 * data, so every summary line has the identical shape/field order regardless
 * of which ensure path ran (grep-able, diffable, stable across releases).
 *
 * Steps are populated by whichever layer actually performs them:
 *  - `placement`, `identity`, `tunnel`, `assets`, `devbox-resolve`,
 *    `devbox-realize`, `devbox-ready`, `bashrc` — recorded directly by
 *    VmSandboxManager._ensureSandbox (services/sandbox/vm/manager.ts).
 *  - `artifacts`, `provision`, `start`, `health` — recorded inside
 *    box-manager.ts's `ensureBox` and merged into the outer timer via its
 *    returned `timings` (see {@link BoxStepTimer.merge}).
 *
 * `provision`/`start` and `health` are NOT always mutually exclusive: a clean
 * fast path records only `health` (the existing box's /healthz probe
 * succeeds) and a clean full (re)provision records only
 * `artifacts`/`provision`/`start` (no existing-box probe was attempted at
 * all) — but when the fast path's probe FAILS and box-manager falls through
 * to a full (re)provision in the SAME ensure, that failed probe's `health`
 * time is real and stays recorded alongside the reprovision's own
 * `artifacts`/`provision`/`start`, so a single summary line can legitimately
 * show BOTH non-zero (see box-manager.ts's `ensureBox`, the healthy.ok
 * fall-through). Whichever steps a given ensure's path never ran simply
 * render as 0.0s, which honestly reports "no time spent here", not
 * "unmeasured".
 *
 * `provision` — NOTE: for docker-capable roles (squad, system-manager) this
 * bucket's single SSH call (`box-provision.sh`) ALSO runs the box's rootless
 * dockerd install/enable/restart (`dockerd-rootless-setuptool.sh` +
 * `systemctl --user restart docker.service` — see box-provision.sh's
 * `provision_docker`), because that's how the script already runs — ONE
 * blocking SSH round trip. It cannot be isolated into its own step without
 * EITHER a second SSH round trip (a NEW probe, which this initiative's
 * constraints forbid) or trusting box-provision.sh's own remote-clock
 * timestamps (which the clock-authority rule above forbids). Read `provision`
 * for a docker-capable `role` as "user/dir/unit provisioning + rootless
 * dockerd setup, combined" — the summary line's trailing `role=` field tells
 * you which boxes that applies to. Agent (light) boxes never provision docker
 * at all (`roleWantsDocker` is false, and the box's own server skips
 * `ensureDocker` for `FICUS_SANDBOX_ROLE=agent` — see packages/k8s-sandbox's
 * server.ts), so for `role=agent` this bucket is pure user/unit provisioning.
 */
export const BOX_STEP_ORDER = [
  'placement',
  'identity',
  'tunnel',
  'artifacts',
  'provision',
  'start',
  'health',
  'assets',
  'devbox-resolve',
  'devbox-realize',
  'devbox-ready',
  'bashrc',
] as const

export type BoxStep = (typeof BOX_STEP_ORDER)[number]

/** A sparse map of step name -> accumulated milliseconds. Absent key === 0ms (never run this ensure). */
export type BoxStepTimings = Partial<Record<BoxStep, number>>

/** Context appended after the timing breakdown — cheap, always/best-effort-known facts that help
 *  correlate a given line's numbers (see box-timing.ts's module doc + box-manager.ts's ensureBox). */
export interface BoxReadyContext {
  /** The box's role (agent/squad/system-manager) — determines whether `provision` includes dockerd setup. */
  role: string
  /**
   * How many OTHER box rows already existed on this box's machine before this
   * ensure — a proxy for `/nix/store` + devbox-comfort-set warmth (the store
   * is machine-wide, not per box-user, so a machine that already hosts boxes
   * likely has a warm store even though EVERY new box user still pays its own
   * per-user `devbox install` — see devbox-seed.ts's module doc). `undefined`
   * means it was not computed for this ensure (the fast healthy-box path skips
   * the query to keep that hot path's query count unchanged) and renders as
   * `n/a` rather than a misleading `0`.
   */
  priorBoxesOnMachine?: number
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Render the ONE structured "Box ready" summary line. Every canonical step
 * always appears (0.0s if never recorded this ensure) in the fixed
 * {@link BOX_STEP_ORDER}, followed by an `other` bucket — `totalMs` minus the
 * sum of every recorded step — so the line is self-accounting: a reader can
 * always see how much of the wall-clock total is NOT yet attributed to a named
 * step, rather than that time silently vanishing into an implicit gap.
 */
export function formatBoxReadyLine(
  sandboxId: string,
  machineId: string,
  totalMs: number,
  steps: BoxStepTimings,
  context: BoxReadyContext
): string {
  const accounted = BOX_STEP_ORDER.reduce((sum, step) => sum + (steps[step] ?? 0), 0)
  const other = Math.max(0, totalMs - accounted)
  const breakdown = [
    ...BOX_STEP_ORDER.map((step) => `${step} ${formatSeconds(steps[step] ?? 0)}`),
    `other ${formatSeconds(other)}`,
  ]
  const priorBoxes = context.priorBoxesOnMachine === undefined ? 'n/a' : String(context.priorBoxesOnMachine)
  return (
    `Box ready: ${sandboxId} on machine ${machineId} in ${formatSeconds(totalMs)} ` +
    `(${breakdown.join(', ')}) role=${context.role} priorBoxesOnMachine=${priorBoxes}`
  )
}

/** Accumulates per-step durations against ONE clock (see module doc). */
export interface BoxStepTimer {
  /** Time an async step, recording its duration (added to any prior duration for the same step) win or lose. */
  time<T>(step: BoxStep, fn: () => Promise<T>): Promise<T>
  /** Add a duration recorded elsewhere (e.g. a sub-layer's own timer) directly. */
  record(step: BoxStep, ms: number): void
  /** Fold another layer's returned {@link BoxStepTimings} into this timer (e.g. ensureBox's/seedBoxDevbox's). No-op on `undefined`. */
  merge(timings: BoxStepTimings | undefined): void
  /** The accumulated timings so far. */
  readonly steps: BoxStepTimings
}

export function createBoxStepTimer(now: () => number = Date.now): BoxStepTimer {
  const steps: BoxStepTimings = {}

  const record = (step: BoxStep, ms: number): void => {
    steps[step] = (steps[step] ?? 0) + ms
  }

  const time = async <T>(step: BoxStep, fn: () => Promise<T>): Promise<T> => {
    const t0 = now()
    try {
      return await fn()
    } finally {
      record(step, now() - t0)
    }
  }

  const merge = (timings: BoxStepTimings | undefined): void => {
    if (!timings) return
    for (const step of BOX_STEP_ORDER) {
      const ms = timings[step]
      if (ms !== undefined) record(step, ms)
    }
  }

  return { time, record, merge, steps }
}
