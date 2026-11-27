/**
 * Time worked on a work stream, and how long a person has been waited on: the rules every client
 * shows. Time worked is the agent execution time Core attributes to the stream
 * (`workStreamRuntimesSql`); clients only extrapolate it between fetches. A person is waited on
 * while an open wait asks a person to act, and the viewer is "you" only for a wait they may clear,
 * with workflow gates following the shared {@link mayDecideWorkflowGate} rule.
 */
import {
  type WorkStreamPresentationFacts,
  workStreamNeedsHumanAttention,
  workStreamWaitDisplayType,
  workStreamWaitNeedsHuman,
} from './status-presentation'
import type { WorkStream, WorkStreamWait } from './types'
import { mayDecideWorkflowGate, workflowGateOfWait } from './workflow-gate-deciders'
import { isWorkflowHumanGateWait } from './workflow-review-waits'

/**
 * How long an execution may go without a new assistant message before it stops counting as work.
 * Longer than the longest single tool call an agent may run in the foreground (one hour), so a
 * long test run still counts in full. Core's runtime query stops counting there, and clients never
 * extrapolate past it before their next refetch.
 */
export const RUNTIME_STALE_AFTER_MS = 90 * 60_000

/** Tooltip/definition shared by every surface that shows time worked. */
export const TIME_WORKED_DEFINITION = 'Time worked: total time agents spent executing on this work stream'

/**
 * Running executions still accruing time. Older servers send only `activeCount`, which also counts
 * sandbox waits.
 */
export function workStreamWorkingCount(ws: Pick<WorkStream, 'runtime'>): number {
  return ws.runtime?.workingCount ?? ws.runtime?.activeCount ?? 0
}

/**
 * Time worked on a work stream, in ms: the summed duration of the executions that did its work, as
 * computed by Core. Nothing accrues while no agent is executing, so a stream parked on a review or
 * a question stops counting, and an execution left open stops at its last sign of activity.
 *
 * While executions are working, extrapolates from the server's total using the supplied `now`,
 * never past {@link RUNTIME_STALE_AFTER_MS}.
 */
export function computeWorkStreamElapsedMs(ws: Pick<WorkStream, 'runtime'>, now: number): number {
  const rt = ws.runtime
  if (!rt) return 0
  const working = workStreamWorkingCount(ws)
  if (working <= 0) return rt.totalMs
  const computedAt = new Date(rt.computedAt).getTime()
  if (!Number.isFinite(computedAt)) return rt.totalMs
  const delta = Math.min(Math.max(0, now - computedAt), RUNTIME_STALE_AFTER_MS)
  return rt.totalMs + working * delta
}

/** "45s", "12m", "3h 5m", "7d 2h": the two largest units, for time worked. */
export function formatWorkStreamDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
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

/** The parts of a stream the viewer rules read: its open waits, delivery and assigned reviewers. */
export type WorkStreamViewerFacts = Pick<WorkStream, 'openWaits' | 'delivery' | 'assignedReviewerIds'>

/** What a person is being waited on for. */
export type PersonWaitKind = 'answer' | 'review' | 'approval' | 'blocker'

const PERSON_WAIT_NOUN: Record<PersonWaitKind, string> = {
  answer: 'an answer',
  review: 'review',
  approval: 'approval',
  blocker: 'a person',
}

/** What this open wait waits on a person for; null when it does not wait on a person. */
function personWaitKind(wait: WorkStreamWait, ws: WorkStreamViewerFacts): PersonWaitKind | null {
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
function viewerCanAct(kind: PersonWaitKind, wait: WorkStreamWait, ws: WorkStreamViewerFacts, viewer: WorkStreamViewer) {
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
export function viewerCanActOnWait(
  wait: WorkStreamWait,
  ws: WorkStreamViewerFacts,
  viewer?: WorkStreamViewer
): boolean {
  const kind = personWaitKind(wait, ws)
  return !!kind && !!viewer && viewerCanAct(kind, wait, ws, viewer)
}

/**
 * Whether the stream waits on this viewer, for "N waiting on you" counts and "Waiting on you"
 * badges: it needs a person ({@link workStreamNeedsHumanAttention}) and one of its open waits on a
 * person is one this viewer can act on ({@link viewerCanActOnWait}). A stream that needs a person
 * with no such wait open (its delivery pull request awaiting review or merge at the code host,
 * which Ficus cannot attribute to anyone) waits on every viewer. False while the viewer is unknown.
 */
export function workStreamWaitsOnViewer(
  ws: WorkStreamViewerFacts & WorkStreamPresentationFacts,
  viewer?: WorkStreamViewer
): boolean {
  if (!viewer || !workStreamNeedsHumanAttention(ws)) return false
  const personWaits = (ws.openWaits ?? []).filter((wait) => personWaitKind(wait, ws))
  return personWaits.length === 0 || personWaits.some((wait) => viewerCanActOnWait(wait, ws, viewer))
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
 * that carry no open wait to date them from (a human merge at the code host). Dependencies and
 * owner holds are not waits on a person.
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

/**
 * How often a stream's time needs re-rendering: every second while an execution runs, every
 * minute while a person is waited on, otherwise never.
 */
export function workStreamTimeTickMs(ws: WorkStream): number | null {
  if (workStreamWorkingCount(ws) > 0) return 1000
  if (workStreamPersonWait(ws)) return 60_000
  return null
}
