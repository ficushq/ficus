import { eq, isNull, inArray } from 'drizzle-orm'
import type { WorkflowGateFallback } from '@ficus/shared'
import { db, users } from '../../db'
import { getUserIdsWithPermission, hasPermission, type Identity } from '../rbac'

export async function listWorkflowReviewers(squadId: string) {
  const people = await db
    .select({ id: users.id, name: users.displayName, email: users.email })
    .from(users)
    .where(isNull(users.disabledAt))
  const eligible = []
  for (const person of people) {
    if (await hasPermission({ type: 'user', userId: person.id }, 'workstreams:review', squadId))
      eligible.push({
        id: person.id,
        name: person.name?.trim() ? `${person.name.trim()} (${person.email})` : person.email,
      })
  }
  return eligible
}

export async function validateAssignedReviewers(ids: string[], squadId: string) {
  if (new Set(ids).size !== ids.length || ids.length > 64) throw new Error('Choose up to 64 distinct reviewers')
  if (!ids.length) return
  const people = await db.select().from(users).where(inArray(users.id, ids))
  for (const id of ids) {
    const person = people.find((user) => user.id === id)
    if (
      !person ||
      person.disabledAt ||
      !(await hasPermission({ type: 'user', userId: id }, 'workstreams:review', squadId))
    )
      throw new Error('Assigned reviewers must be active users with work-stream review permission in this squad')
  }
}

interface ReviewedStream {
  id: string
  squadId: string
  assignedReviewerIds: readonly string[] | null
  requestingUserId?: string | null
}

/**
 * The assigned reviewers of each stream who can no longer decide its gates, by stream id; streams
 * whose assigned reviewers are all active are left out. Active means what {@link isWorkflowReviewer}
 * checks: the account exists and is not disabled, and the person holds `workstreams:review` in the
 * stream's squad (losing the squad's role, or a role without the permission, makes them inactive).
 * One permission read per squad, however many streams.
 */
export async function loadInactiveAssignedReviewers(
  streams: readonly ReviewedStream[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const reviewed = streams.filter((stream) => stream.assignedReviewerIds?.length)
  const squads = [...new Set(reviewed.map((stream) => stream.squadId))]
  const activeBySquad = new Map(
    await Promise.all(
      squads.map(
        async (squadId) => [squadId, new Set(await getUserIdsWithPermission('workstreams:review', squadId))] as const
      )
    )
  )
  for (const stream of reviewed) {
    const active = activeBySquad.get(stream.squadId)!
    const inactive = stream.assignedReviewerIds!.filter((id) => !active.has(id))
    if (inactive.length) result.set(stream.id, inactive)
  }
  return result
}

/**
 * What Core reads to apply the shared gate fallback for this person on this stream: the stream's
 * inactive assigned reviewers, its requester, and whether the person is an admin (holds `*`). It
 * costs reads only for a user outside the stream's assigned reviewers (who decide without it).
 */
export async function workflowGateFallbackFor(
  identity: Identity,
  stream: ReviewedStream
): Promise<WorkflowGateFallback> {
  if (
    identity.type !== 'user' ||
    !stream.assignedReviewerIds?.length ||
    stream.assignedReviewerIds.includes(identity.userId)
  )
    return {}
  const [inactive, isAdmin] = await Promise.all([
    loadInactiveAssignedReviewers([stream]),
    hasPermission(identity, '*', stream.squadId),
  ])
  return {
    inactiveAssignedReviewerIds: inactive.get(stream.id) ?? [],
    requestingUserId: stream.requestingUserId ?? null,
    isAdmin,
  }
}

export async function isWorkflowReviewer(userId: string, squadId: string) {
  const [person] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  return (
    !!person && !person.disabledAt && (await hasPermission({ type: 'user', userId }, 'workstreams:review', squadId))
  )
}
