import type { StreamEventCollector } from '../streaming/events'
import type { StreamBuffer } from '../streaming/buffer'
import { streamManager } from '../streaming/buffer'
import { AgentSession } from '../../entities/AgentSession'
import {
  formatPrecompactionLogLine,
  formatPrecompactionSystemMessage,
  type PrecompactionLifecycleEvent,
} from '../agent/precompaction/debug'
import { disposeAllPrecompactionControllers } from '../agent/precompaction/registry'
import { createLogger } from '../../lib/infra/logger'

const precompactionLog = createLogger('precompaction')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveSession {
  session: AgentSession
  collector: StreamEventCollector
  buffer: StreamBuffer
  agentId: string
  executionId: string
  isCompacting?: boolean
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activeSessions: Map<string, ActiveSession> = new Map() // keyed by agentId
const sessionReservations: Map<string, string> = new Map() // agentId -> executionId
// agentId -> executionId of an execution whose session has been torn down but
// whose row has not yet left 'running' (see markExecutionSettling).
const settlingExecutions: Map<string, string> = new Map()

type TransitionalKind = 'compact' | 'reset'

interface TransitionalOperation {
  kind: TransitionalKind
  startedAt: number
}

const transitionalOperations: Map<string, TransitionalOperation> = new Map()

let onCreateStreamBuffer: ((id: string) => StreamBuffer) | null = null
let isShuttingDown = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setStreamBufferFactory(cb: (id: string) => StreamBuffer): void {
  onCreateStreamBuffer = cb
}

export function getActiveSessionCount(): number {
  return activeSessions.size + [...sessionReservations.keys()].filter((agentId) => !activeSessions.has(agentId)).length
}

export function isSessionActive(agentId: string): boolean {
  return activeSessions.has(agentId)
}

export function getSession(agentId: string): ActiveSession | undefined {
  return activeSessions.get(agentId)
}

/**
 * True when THIS process is running or about to run `executionId` for `agentId`.
 *
 * Covers both maps deliberately. `reserveSession` writes `sessionReservations`
 * and only a started session appears in `activeSessions`, so a check against
 * either one alone misses the window between pickup and session start — which is
 * exactly when a recovery sweep would wrongly reclaim live work and start a
 * second copy that then fails its own reservation.
 */
export function isSessionHeldFor(agentId: string, executionId: string): boolean {
  return (
    activeSessions.get(agentId)?.executionId === executionId ||
    sessionReservations.get(agentId) === executionId ||
    settlingExecutions.get(agentId) === executionId
  )
}

/**
 * Hold `executionId` as this process's work from the moment its session is torn
 * down until its row leaves `running` (the terminal CAS). completeNormally and
 * onError drop the session FIRST and only then run turn hooks, save the message
 * and transition the row — 4-20s in practice — while the admission lease (which
 * is renewed only inside durable effects) has long expired. Without this hold
 * that window reads as "running, unheld, lease expired" to the abandoned-lease
 * sweep, which re-queued live, finishing executions and posted a spurious
 * "[System] Agent recovered after a process restart." Per-execution, so it can
 * never shield a different execution of the same agent. Cleared by
 * clearExecutionSettling; removeSession deliberately leaves it in place.
 */
export function markExecutionSettling(agentId: string, executionId: string): void {
  settlingExecutions.set(agentId, executionId)
}

export function clearExecutionSettling(agentId: string, executionId: string): void {
  if (settlingExecutions.get(agentId) === executionId) settlingExecutions.delete(agentId)
}

export function reserveSession(agentId: string, executionId: string): boolean {
  const existingReservation = sessionReservations.get(agentId)
  if (activeSessions.has(agentId)) return false
  if (existingReservation && existingReservation !== executionId) return false

  sessionReservations.set(agentId, executionId)
  return true
}

export function releaseSessionReservation(agentId: string, executionId: string): void {
  if (sessionReservations.get(agentId) === executionId) {
    sessionReservations.delete(agentId)
  }
}

export function isSessionReserved(agentId: string, executionId?: string): boolean {
  const reservedExecutionId = sessionReservations.get(agentId)
  if (!reservedExecutionId) return false
  return executionId ? reservedExecutionId === executionId : true
}

export function listActiveSessions(): Array<[string, ActiveSession]> {
  return [...activeSessions.entries()]
}

export function registerSession(agentId: string, session: ActiveSession): void {
  sessionReservations.delete(agentId)
  activeSessions.set(agentId, session)
}

export function removeSession(agentId: string): void {
  const active = activeSessions.get(agentId)
  active?.session.dispose?.()
  activeSessions.delete(agentId)
  sessionReservations.delete(agentId)
}

export function setSessionCompacting(agentId: string, isCompacting: boolean): void {
  const session = activeSessions.get(agentId)
  if (session) {
    session.isCompacting = isCompacting
  }
}

export function isSessionCompacting(agentId: string): boolean {
  return activeSessions.get(agentId)?.isCompacting ?? false
}

export function createBuffer(executionId: string): StreamBuffer {
  return onCreateStreamBuffer?.(executionId) ?? streamManager.create(executionId)
}

export function beginTransitionalOperation(agentId: string, kind: TransitionalKind): void {
  transitionalOperations.set(agentId, { kind, startedAt: Date.now() })
}

export function endTransitionalOperation(agentId: string): void {
  transitionalOperations.delete(agentId)
}

export function isTransitionalOperationInProgress(agentId: string): boolean {
  return transitionalOperations.has(agentId)
}

export function listTransitionalOperations(): Array<[string, TransitionalOperation]> {
  return [...transitionalOperations.entries()]
}

export function markShuttingDown(): void {
  isShuttingDown = true
}

export function isWorkerShuttingDown(): boolean {
  return isShuttingDown
}

export function resetWorkerShuttingDownForTests(): void {
  isShuttingDown = false
}

/** Process-wide pre-compaction lifecycle sink. Logs every event and, for
 * user-facing kinds, pushes a system_message to whatever execution is currently
 * live for the agent. Best-effort: log-only when the agent is idle, the buffer
 * is closed (push no-ops on non-streaming buffers), or the kind is log-only. */
export function precompactionLifecycleSink(agentId: string, event: PrecompactionLifecycleEvent): void {
  precompactionLog.info(formatPrecompactionLogLine(event))
  const text = formatPrecompactionSystemMessage(event)
  if (!text) return
  activeSessions.get(agentId)?.buffer.push({ type: 'system_message', text })
}

/**
 * Gracefully shut down all active sessions.
 * Aborts each session; any assistant message the Pi SDK persists before
 * shutdown completes is mirrored to Ficus's DB by the runner's persistence event
 * handler. Returns execution IDs so the caller can re-queue them.
 */
export async function shutdownActiveSessions(
  options: { settleDelayMs?: number; agentIds?: string[] } = {}
): Promise<string[]> {
  const { settleDelayMs = 1000, agentIds } = options
  const agentIdFilter = agentIds ? new Set(agentIds) : undefined
  const entries = [...activeSessions.entries()].filter(([agentId]) => !agentIdFilter || agentIdFilter.has(agentId))
  if (entries.length === 0) return []

  markShuttingDown()
  const executionIds = entries.map(([, active]) => active.executionId)

  // Abort all sessions. If abort produces a persisted Pi session message, the
  // runner will mirror it to the DB before we delete sessions below.
  await Promise.all(
    entries.map(async ([, active]) => {
      await active.session.pi.abort()
    })
  )

  // Wait briefly for abort-related persistence/settlement handlers to complete.
  if (settleDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleDelayMs))
  }

  // Now dispose and delete sessions. The caller will re-queue interrupted executions.
  for (const [agentId] of entries) {
    removeSession(agentId)
  }

  disposeAllPrecompactionControllers()

  return executionIds
}
