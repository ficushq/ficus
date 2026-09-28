import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  buildWorkInterestSnapshot,
  hasNotify,
  type WorkInterestSnapshot,
  type WorkStream,
  type WorkStreamDerivedState,
  type WorkStreamStatus,
  type WorkStreamWait,
} from '@ficus/shared'
import { db } from '../../db'
import { users, workStreams } from '../../db/schema'
import { hasPermission } from '../rbac/permissions'
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
  delivery?: WorkStream['delivery']
  derivedState: WorkStreamDerivedState
  openWaits: WorkStreamWait[]
}

export const WORK_INTEREST_AUTH_CONCURRENCY = 8

export interface WorkInterestLoaderDeps {
  isActiveUser(userId: string): Promise<boolean>
  loadAttention(userId: string): Promise<UserAttention>
  loadCandidates(squadIds: string[], streamIds: string[]): Promise<WorkInterestCandidate[]>
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

    // Live Activity and the widget carry work the user asked to be interrupted about, so interest
    // is `notify` on either kind. DEFAULT_ATTENTION never notifies, which is why rows alone bound
    // the candidate query.
    const attention = await deps.loadAttention(userId)
    const squadIds = Array.from(attention.squads.entries())
      .filter(([, levels]) => hasNotify(levels))
      .map(([squadId]) => squadId)
    const streamIds = Array.from(attention.workStreams.entries())
      .filter(([, levels]) => hasNotify(levels))
      .map(([workStreamId]) => workStreamId)
    if (squadIds.length === 0 && streamIds.length === 0) return buildWorkInterestSnapshot([], deps.now())

    const candidates = await deps.loadCandidates(squadIds, streamIds)
    const deduped = [...new Map(candidates.map((stream) => [stream.id, stream])).values()]
    // A stream row can quiet one stream inside a notify squad; re-check each candidate.
    const interested = deduped.filter((stream) => hasNotify(attention.forWorkStream(stream.id, stream.squadId)))
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

async function loadCandidates(squadIds: string[], streamIds: string[]): Promise<WorkInterestCandidate[]> {
  const interest =
    squadIds.length > 0 && streamIds.length > 0
      ? or(inArray(workStreams.squadId, squadIds), inArray(workStreams.id, streamIds))
      : squadIds.length > 0
        ? inArray(workStreams.squadId, squadIds)
        : inArray(workStreams.id, streamIds)

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
    .where(and(inArray(workStreams.status, ['queued', 'active']), interest))
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
