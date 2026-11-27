import {
  isWorkflowHumanGateWait,
  mayDecideWorkflowGate,
  workflowGateOfWait,
  workStreamNeedsHumanAttention,
  workStreamWaitDisplayType,
  workStreamWaitNeedsHuman,
  type WorkStream,
  type WorkStreamWait,
} from '@ficus/shared'

/** Core's stale bound for time worked (`RUNTIME_STALE_AFTER_MS` in the WorkStream entity). */
const RUNTIME_STALE_AFTER_MS = 90 * 60_000

/**
 * Running executions still accruing time. Older servers send only
 * `activeCount`, which also counts sandbox waits.
 */
function workingCount(ws: WorkStream): number {
  return ws.runtime?.workingCount ?? ws.runtime?.activeCount ?? 0
}

/**
 * Time worked on a work stream, in ms: the summed duration of the executions
 * that did its work, as computed by Core (`workStreamRuntimesSql`). Nothing
 * accrues while no agent is executing, so a stream parked on a review or a
 * question stops counting, and an execution left open stops at its last sign
 * of activity.
 *
 * While executions are working, extrapolates from the backend-computed total
 * using the supplied `now` timestamp.
 */
export function computeWorkStreamElapsedMs(ws: WorkStream, now: number): number {
  const rt = ws.runtime
  if (!rt) return 0
  const working = workingCount(ws)
  if (working <= 0) return rt.totalMs
  const computedAt = new Date(rt.computedAt).getTime()
  // Core stops counting an execution after this long without a message, so local ticking never
  // runs past it before the next refetch would.
  const delta = Math.min(Math.max(0, now - computedAt), RUNTIME_STALE_AFTER_MS)
  return rt.totalMs + working * delta
}

/** Tooltip/definition shared by every surface that shows time worked. */
export const TIME_WORKED_DEFINITION = 'Time worked: total time agents spent executing on this work stream'

/** "45s", "12m", "3h 5m", "7d 2h": the two largest units, for time worked. */
export function formatWorkStreamDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

/** "<1m", "12m", "3h", "7d": one coarse unit, for how long a person has been waited on. */
export function formatWaitedDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Who is looking: the permissions they hold in the stream's squad, and who they are. Undefined
 * while permissions load, which never claims "you".
 */
export interface WorkStreamViewer {
  can: (permission: string) => boolean
  identity?: { type: string; userId?: string }
}

/** What a person is being waited on for. */
export type PersonWaitKind = 'answer' | 'review' | 'approval' | 'blocker'

const PERSON_WAIT_NOUN: Record<PersonWaitKind, string> = {
  answer: 'an answer',
  review: 'review',
  approval: 'approval',
  blocker: 'a person',
}

function personWaitKind(wait: WorkStreamWait, ws: WorkStream): PersonWaitKind | null {
  // The delivery approval is a wait on a person too; the shared rule leaves it to delivery.
  if (ws.delivery?.kind === 'approval' && wait.id === ws.delivery.approvalWaitId) return 'approval'
  if (!workStreamWaitNeedsHuman(wait, ws)) return null
  if (wait.type === 'question') return 'answer'
  return workStreamWaitDisplayType(wait) === 'review' ? 'review' : 'blocker'
}

/**
 * Whether this viewer can clear the wait, mirroring the server's checks: answering a question
 * takes agents:run, a workflow gate is the shared {@link mayDecideWorkflowGate} rule for the
 * approver Core puts on the wait, anything else workstreams:respond or workstreams:update.
 */
function viewerCanAct(kind: PersonWaitKind, wait: WorkStreamWait, ws: WorkStream, viewer: WorkStreamViewer) {
  if (kind === 'answer') return viewer.can('agents:run')
  if (isWorkflowHumanGateWait(wait))
    return mayDecideWorkflowGate(
      viewer.identity,
      viewer.can('workstreams:review'),
      ws.assignedReviewerIds,
      workflowGateOfWait(wait)
    )
  return viewer.can('workstreams:respond') || viewer.can('workstreams:update')
}

/**
 * Whether this viewer can act on one open wait: it asks a person (including the delivery approval)
 * and the viewer is someone who may clear it. False while the viewer is unknown.
 */
export function viewerCanActOnWait(wait: WorkStreamWait, ws: WorkStream, viewer?: WorkStreamViewer): boolean {
  const kind = personWaitKind(wait, ws)
  return !!kind && !!viewer && viewerCanAct(kind, wait, ws, viewer)
}

export interface WorkStreamPersonWait {
  /** When the oldest wait shown started. */
  since: Date
  /** True when the viewer can act on it: "Waiting on you". */
  you: boolean
  kind: PersonWaitKind
  /** "Waiting on you", or for someone else's wait "Waiting on review". */
  label: string
}

/**
 * How long the stream has waited on a person: the oldest open wait that asks a person to act (a
 * question, an actionable review, a blocker only a person can clear, or the delivery approval).
 * It says "you" only for a wait this viewer can act on; for anyone else it names the wait.
 * Null when nobody is being waited on, including paused or finished streams and delivery states
 * that carry no open wait to date them from (a human merge at the code host).
 */
export function workStreamPersonWait(ws: WorkStream, viewer?: WorkStreamViewer): WorkStreamPersonWait | null {
  if (!workStreamNeedsHumanAttention(ws)) return null
  let oldest: { at: number; kind: PersonWaitKind } | null = null
  let mine: { at: number; kind: PersonWaitKind } | null = null
  for (const wait of ws.openWaits ?? []) {
    const kind = personWaitKind(wait, ws)
    if (!kind) continue
    const at = new Date(wait.openedAt).getTime()
    if (!Number.isFinite(at)) continue
    if (!oldest || at < oldest.at) oldest = { at, kind }
    if (viewer && viewerCanAct(kind, wait, ws, viewer) && (!mine || at < mine.at)) mine = { at, kind }
  }
  const shown = mine ?? oldest
  if (!shown) return null
  return {
    since: new Date(shown.at),
    you: !!mine,
    kind: shown.kind,
    label: mine ? 'Waiting on you' : `Waiting on ${PERSON_WAIT_NOUN[shown.kind]}`,
  }
}

export type WorkStreamTimeDisplay =
  | { kind: 'waiting'; text: string; title: string; waitingMs: number; workedMs: number }
  | { kind: 'worked'; text: string; title: string; workedMs: number }

/**
 * The one time a work stream row shows. While a person is being waited on, how long
 * ("Waiting on you 7d", or "Waiting on review 7d" to someone who cannot act on it) replaces time
 * worked, which stays in the tooltip; otherwise time worked, once it passes a second.
 */
export function workStreamTimeDisplay(
  ws: WorkStream,
  now: number,
  viewer?: WorkStreamViewer
): WorkStreamTimeDisplay | null {
  const workedMs = computeWorkStreamElapsedMs(ws, now)
  const waiting = workStreamPersonWait(ws, viewer)
  if (waiting) {
    const waitingMs = Math.max(0, now - waiting.since.getTime())
    const since = waiting.since.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    return {
      kind: 'waiting',
      text: `${waiting.label} ${formatWaitedDuration(waitingMs)}`,
      title: `${waiting.label} since ${since}. Time worked: ${formatWorkStreamDuration(workedMs)}`,
      waitingMs,
      workedMs,
    }
  }
  if (workedMs <= 1000) return null
  return { kind: 'worked', text: formatWorkStreamDuration(workedMs), title: TIME_WORKED_DEFINITION, workedMs }
}

/**
 * How often a row's time needs re-rendering: every second while an execution
 * runs, every minute while a person is waited on, otherwise never.
 */
export function workStreamTimeTickMs(ws: WorkStream): number | null {
  if (workingCount(ws) > 0) return 1000
  if (workStreamPersonWait(ws)) return 60_000
  return null
}
