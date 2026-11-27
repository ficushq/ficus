/**
 * Per-phase timing for work stream creation.
 *
 * A create runs authorization, validation, the squad-box check, a dozen or
 * more box commands, a GitHub fetch, a `git worktree add`, a transaction on the
 * squad row, flow dispatch and the owner notification inside one request.
 * Under load any of them can stall, so every create logs one summary line with
 * the time spent in each phase, in a fixed order, plus the slowest phase:
 *
 *   Work stream create timing: outcome=created total=12.4s slowest=repository-fetch ...
 *
 * A create at or above {@link SLOW_CREATE_MS} logs at `warn`, so slow creates
 * can be found by level as well as by text. Phases a create never ran render as
 * `0.0s`. Durations come from Core's own clock only.
 */
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('work-stream-create')

export const CREATE_PHASE_ORDER = [
  /** Permission checks, squad lookup and workflow access in the route. */
  'authorize',
  /** Input validation and resolution before anything is provisioned. */
  'validate',
  /** Claiming (or waiting on) an idempotency key. */
  'idempotency',
  /** The squad-box check before repository setup (fast path or full ensure). */
  'sandbox-ensure',
  /** Every Git and shell command repository setup runs in the box, except the two below. */
  'repository-exec',
  /** The `git fetch` of the base branch. */
  'repository-fetch',
  /** The `git worktree add`. */
  'repository-worktree-add',
  /** Waiting for the squad row lock (`SELECT ... FOR UPDATE`). */
  'squad-lock-wait',
  /** The rest of the creation transaction after the lock was granted. */
  'transaction',
  /** Dependency stacking and `ensureFlowDispatch`. */
  'dispatch',
  /** The owner notification. */
  'notify',
  /** Route work after creation: session binding, subscription and serialization. */
  'respond',
] as const

export type CreatePhase = (typeof CREATE_PHASE_ORDER)[number]

/** A create at or above this total logs at `warn`. */
export const SLOW_CREATE_MS = 20_000

export interface WorkStreamCreateTimer {
  /** Run `operation` and add its duration to `phase`, whether it resolves or throws. */
  time<T>(phase: CreatePhase, operation: () => Promise<T>): Promise<T>
  /** Add a measured duration to `phase`. */
  add(phase: CreatePhase, ms: number): void
  /** Attach a short label (for example the squad-box path taken). */
  note(key: string, value: string | number): void
  readonly phases: Readonly<Record<CreatePhase, { ms: number; count: number }>>
  readonly notes: Readonly<Record<string, string | number>>
  elapsed(): number
  now(): number
}

export function createWorkStreamCreateTimer(now: () => number = () => performance.now()): WorkStreamCreateTimer {
  const startedAt = now()
  const phases = Object.fromEntries(CREATE_PHASE_ORDER.map((phase) => [phase, { ms: 0, count: 0 }])) as Record<
    CreatePhase,
    { ms: number; count: number }
  >
  const notes: Record<string, string | number> = {}
  const add = (phase: CreatePhase, ms: number) => {
    phases[phase].ms += Math.max(0, ms)
    phases[phase].count += 1
  }
  return {
    phases,
    notes,
    now,
    add,
    note(key, value) {
      notes[key] = value
    },
    elapsed: () => now() - startedAt,
    async time(phase, operation) {
      const started = now()
      try {
        return await operation()
      } finally {
        add(phase, now() - started)
      }
    },
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** The single grep-able summary line, in {@link CREATE_PHASE_ORDER}. */
export function formatWorkStreamCreateTiming(
  timer: WorkStreamCreateTimer,
  context: { outcome: string; squadId?: string; workStreamId?: string }
): string {
  const total = timer.elapsed()
  let slowest: CreatePhase | undefined
  for (const phase of CREATE_PHASE_ORDER)
    if (timer.phases[phase].ms > 0 && (!slowest || timer.phases[phase].ms > timer.phases[slowest].ms)) slowest = phase
  const fields = [
    `outcome=${context.outcome}`,
    `total=${seconds(total)}`,
    `slowest=${slowest ?? 'none'}`,
    ...CREATE_PHASE_ORDER.map((phase) => {
      const { ms, count } = timer.phases[phase]
      return `${phase}=${seconds(ms)}${phase === 'repository-exec' ? `(${count})` : ''}`
    }),
    ...Object.entries(timer.notes).map(([key, value]) => `${key}=${value}`),
    ...(context.squadId ? [`squad=${context.squadId}`] : []),
    ...(context.workStreamId ? [`stream=${context.workStreamId}`] : []),
  ]
  return `Work stream create timing: ${fields.join(' ')}`
}

export function logWorkStreamCreateTiming(
  timer: WorkStreamCreateTimer,
  context: { outcome: string; squadId?: string; workStreamId?: string },
  logger: Pick<typeof log, 'info' | 'warn'> = log
): void {
  const line = formatWorkStreamCreateTiming(timer, context)
  if (timer.elapsed() >= SLOW_CREATE_MS) logger.warn(line)
  else logger.info(line)
}
