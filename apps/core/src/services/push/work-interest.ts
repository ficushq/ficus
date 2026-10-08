import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  buildWorkInterestSnapshot,
  type WorkInterestSnapshot,
  type WorkStream,
  type WorkStreamDerivedState,
  type WorkStreamStatus,
  type WorkStreamWait,
} from '@ficus/shared'
import { db } from '../../db'
import { users, workStreams } from '../../db/schema'
import { getAccessibleSquadIds, hasPermission } from '../rbac/permissions'
import { loadUserAttention, type UserAttention } from '../attention/resolver'
import { computeDerivedStates } from '../work-streams/derived-state'

export interface WorkInterestCandidate {
  pause?: WorkStream['pause']
  id: string
  squadId: string
  title: string
  status: WorkStreamStatus
  assigneeAgentId: string | null
  agentIds: string[] | null
  updatedAt: Date
}

interface DerivedFacts {
  hasActiveSlotWait?: boolean
  delivery?: WorkStream['delivery']
  derivedState: WorkStreamDerivedState
  openWaits: WorkStreamWait[]
}

export const WORK_INTEREST_AUTH_CONCURRENCY = 8

export interface WorkInterestLoaderDeps {
  isActiveUser(userId: string): Promise<boolean>
  loadAttention(userId: string): Promise<UserAttention>
  loadCandidates(userId: string): Promise<WorkInterestCandidate[]>
  canReadSquad(userId: string, squadId: string): Promise<boolean>
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
    if (!(await deps.isActiveUser(userId))) return buildWorkInterestSnapshot([], deps.now())

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
    return buildWorkInterestSnapshot(
      authorized.map((stream) => ({ ...stream, ...derived.get(stream.id) })),
      deps.now()
    )
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
  derive: computeDerivedStates,
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
