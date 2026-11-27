import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  buildWorkInterestSnapshot,
  type WorkInterestSnapshot,
  type WorkStream,
  type WorkStreamDerivedState,
  type WorkStreamStatus,
  type WorkStreamViewer,
  type WorkStreamWait,
  workStreamNeedsHumanAttention,
} from '@ficus/shared'
import { db } from '../../db'
import { users, workStreams } from '../../db/schema'
import { getAccessibleSquadIds, hasPermission } from '../rbac/permissions'
import { resolveWorkStreamViewer } from '../rbac/work-stream-viewer'
import { loadUserAttention, type UserAttention } from '../attention/resolver'
import { computeDerivedStates } from '../work-streams/derived-state'
import { loadInactiveAssignedReviewersForOpenGates } from '../workflows/reviewers'

export interface WorkInterestCandidate {
  pause?: WorkStream['pause']
  id: string
  squadId: string
  title: string
  status: WorkStreamStatus
  assigneeAgentId: string | null
  agentIds: string[] | null
  /** Who may decide an assigned-reviewers gate: read by the "waiting on you" viewer rule. */
  assignedReviewerIds?: string[]
  requestingUserId?: string | null
  updatedAt: Date
}

interface DerivedFacts {
  hasActiveSlotWait?: boolean
  hasActiveMonitor?: boolean
  delivery?: WorkStream['delivery']
  inactiveAssignedReviewerIds?: string[]
  derivedState: WorkStreamDerivedState
  openWaits: WorkStreamWait[]
}

export const WORK_INTEREST_AUTH_CONCURRENCY = 8

export interface WorkInterestLoaderDeps {
  isActiveUser(userId: string): Promise<boolean>
  loadAttention(userId: string): Promise<UserAttention>
  loadCandidates(userId: string): Promise<WorkInterestCandidate[]>
  canReadSquad(userId: string, squadId: string): Promise<boolean>
  /** The user as the shared viewer rule reads them in one squad (their permissions there). */
  loadViewer(userId: string, squadId: string): Promise<WorkStreamViewer>
  derive(streams: WorkInterestCandidate[]): Promise<Map<string, DerivedFacts>>
  now(): Date
}

async function filterAuthorizedSquads(
  squadIds: string[],
  canRead: (squadId: string) => Promise<boolean>
): Promise<Set<string>> {
  const authorized = new Set<string>()
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(WORK_INTEREST_AUTH_CONCURRENCY, squadIds.length) }, async () => {
      while (cursor < squadIds.length) {
        const squadId = squadIds[cursor++]!
        try {
          if (await canRead(squadId)) authorized.add(squadId)
        } catch {
          // Authorization failures are private-data failures: deny this squad rather than exposing it.
        }
      }
    })
  )
  return authorized
}

export function createWorkInterestLoader(deps: WorkInterestLoaderDeps) {
  return async (userId: string): Promise<WorkInterestSnapshot> => {
    if (!(await deps.isActiveUser(userId))) return buildWorkInterestSnapshot([], { now: deps.now() })

    // Show (including the default without a saved row) is passive visibility. Notify adds
    // alerts, but is not required for widgets or Live Activities.
    const attention = await deps.loadAttention(userId)
    const candidates = await deps.loadCandidates(userId)
    const deduped = [...new Map(candidates.map((stream) => [stream.id, stream])).values()]
    const interested = deduped.filter((stream) => {
      const levels = attention.forWorkStream(stream.id, stream.squadId)
      return levels.decisions !== 'mute' || levels.progress !== 'mute'
    })
    const candidateSquadIds = [...new Set(interested.map((stream) => stream.squadId))]
    const authorizedSquads = await filterAuthorizedSquads(candidateSquadIds, (squadId) =>
      deps.canReadSquad(userId, squadId)
    )
    const authorized = interested.filter((stream) => authorizedSquads.has(stream.squadId))
    const derived = await deps.derive(authorized)
    const streams = authorized.map((stream) => ({ ...stream, ...derived.get(stream.id) }))
    // "N waiting on you" is this user's count, by the same rule and mutes as Activity's: a stream
    // counts only when the user can act on it, and never while they muted its decisions. Only
    // squads holding such a stream resolve the user's permissions (cached: just read above).
    const decisionsShown = (stream: { id: string; squadId: string }) =>
      attention.forWorkStream(stream.id, stream.squadId).decisions !== 'mute'
    const viewerSquadIds = [
      ...new Set(
        streams
          .filter((stream) => decisionsShown(stream) && workStreamNeedsHumanAttention(stream))
          .map((s) => s.squadId)
      ),
    ]
    const viewers = new Map(
      await Promise.all(
        viewerSquadIds.map(async (squadId) => [squadId, await deps.loadViewer(userId, squadId)] as const)
      )
    )
    return buildWorkInterestSnapshot(streams, {
      now: deps.now(),
      viewerFor: (stream) => (decisionsShown(stream) ? viewers.get(stream.squadId) : undefined),
    })
  }
}

async function loadCandidates(userId: string): Promise<WorkInterestCandidate[]> {
  const squadIds = await getAccessibleSquadIds({ type: 'user', userId })
  if (squadIds !== 'all' && squadIds.length === 0) return []

  return db
    .select({
      id: workStreams.id,
      number: workStreams.number,
      squadId: workStreams.squadId,
      title: workStreams.title,
      status: workStreams.status,
      pause: workStreams.pause,
      assigneeAgentId: workStreams.assigneeAgentId,
      agentIds: workStreams.agentIds,
      assignedReviewerIds: workStreams.assignedReviewerIds,
      requestingUserId: workStreams.requestingUserId,
      updatedAt: workStreams.updatedAt,
    })
    .from(workStreams)
    .where(
      and(
        inArray(workStreams.status, ['queued', 'active']),
        squadIds === 'all' ? undefined : inArray(workStreams.squadId, squadIds)
      )
    )
}

const loadSnapshot = createWorkInterestLoader({
  isActiveUser: async (userId) => {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .limit(1)
    return Boolean(user)
  },
  loadAttention: loadUserAttention,
  loadCandidates,
  canReadSquad: (userId, squadId) => hasPermission({ type: 'user', userId }, 'workstreams:read', squadId),
  loadViewer: (userId, squadId) => resolveWorkStreamViewer({ type: 'user', userId }, squadId),
  derive: async (streams) => {
    const derived = await computeDerivedStates(streams)
    const inactiveReviewers = await loadInactiveAssignedReviewersForOpenGates(streams, derived)
    return new Map(
      [...derived].map(([id, facts]) => [id, { ...facts, inactiveAssignedReviewerIds: inactiveReviewers.get(id) }])
    )
  },
  now: () => new Date(),
})

/** Live Activity content is lock-screen data, even when seeded by the signed-in app. */
export async function loadWorkInterestSnapshot(userId: string): Promise<WorkInterestSnapshot> {
  const [snapshot, preferences] = await Promise.all([loadSnapshot(userId), UserNotificationPreferences.get(userId)])
  if (!preferences.showPreviews)
    snapshot.liveActivity = {
      ...snapshot.liveActivity,
      top: snapshot.liveActivity.top.map((work) => ({
        ...work,
        title: work.number ? `Work #${work.number}` : 'Work stream',
      })),
    }
  return snapshot
}
