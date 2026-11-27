import {
  ACTIVITY_WORK_STREAM_CARD_LIMIT,
  DELIVERY_STATUS_LABELS,
  codeHostDeliveryLabel,
  resolveCodeHostReference,
  viewerCanActOnWait,
  workStreamNeedsHumanAttention,
  workStreamWaitDisplayType,
  workStreamWaitNeedsHuman,
  workStreamWaitsOnViewer,
  type ActivityWorkStreamCard,
  type GlobalActivityPresence,
  type WorkStreamDeliveryPresentation,
  type WorkStreamViewer,
  workStreamDeliveryCiState,
} from '@ficus/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, workStreams } from '../../db/schema'
import { permissionMatches, resolvePermissions, type Identity } from '../rbac'
import { EMPTY_USER_ATTENTION, loadUserAttention } from '../attention/resolver'
import { computeDerivedStates } from '../work-streams/derived-state'
import { resolveGlobalActivityAccess, resolveSquadActivityAccess } from './access'
import type { GlobalActivitySquadAccess } from './global-activity'
import { loadWorkStreamSteps } from './row-context'
import { presentWorkStreamSummary, streamSummariesEnabled } from '../stream-summaries/visibility'
import { activityRetentionFloor } from '../squad/activity-cursor'

/**
 * Build the global activity presence strip from only the squads and resource
 * types the authenticated identity may read. Callers supply no squad ids: the
 * same per-squad resolver as the global activity feed is authoritative here.
 */
export async function projectGlobalActivityPresence(identity: Identity): Promise<GlobalActivityPresence> {
  return projectActivityPresence(identity, await resolveGlobalActivityAccess(identity))
}

/** One squad's presence (the squad Activity tab); null when the identity cannot read its activity. */
export async function projectSquadActivityPresence(
  identity: Identity,
  squadId: string
): Promise<GlobalActivityPresence | null> {
  const access = await resolveSquadActivityAccess(identity, squadId)
  return access ? projectActivityPresence(identity, [{ squadId, access }]) : null
}

/** Aggregate CI from delivery tracking only (shared with clients as `workStreamDeliveryCiState`). */
export const deliveryCiState = workStreamDeliveryCiState

function deliveryLabel(delivery: WorkStreamDeliveryPresentation | undefined): string | null {
  if (!delivery) return null
  return (
    codeHostDeliveryLabel(delivery) ??
    DELIVERY_STATUS_LABELS[`delivery_${delivery.kind}` as keyof typeof DELIVERY_STATUS_LABELS] ??
    null
  )
}

function primaryPullRequest(
  metadata: unknown,
  delivery: WorkStreamDeliveryPresentation | undefined
): ActivityWorkStreamCard['pullRequest'] {
  const reference = resolveCodeHostReference(metadata)
  const number = reference?.changeRequest?.number
  if (!reference || !number) return null
  const url =
    reference.changeRequest?.url ??
    (reference.integration === 'github' ? `https://github.com/${reference.repository}/pull/${number}` : undefined)
  const observed = delivery?.explanation?.pullRequests?.find((pr) => pr.number === number)?.state
  return { number, repository: reference.repository, ...(url ? { url } : {}), state: observed ?? 'open' }
}

/**
 * The identity as the shared viewer rules read it in one squad: its permissions there and who it is.
 * Workflow gates are decided only by users (`mayDecideWorkflowGate`), so other identities never
 * pass on a userId.
 */
async function squadViewer(identity: Identity, squadId: string): Promise<WorkStreamViewer> {
  const permissions = await resolvePermissions(identity, squadId)
  return {
    can: (permission) => permissions.some((held) => permissionMatches(held, permission)),
    identity: identity.type === 'user' ? { type: 'user', userId: identity.userId } : { type: identity.type },
  }
}

/**
 * The viewer in each of `squadIds`, by squad ID. Only squads with a stream to label resolve
 * permissions, and a user's resolution is cached (the access check just read it).
 */
async function loadSquadViewers(identity: Identity, squadIds: Iterable<string>) {
  const ids = [...new Set(squadIds)]
  const viewers = await Promise.all(ids.map((squadId) => squadViewer(identity, squadId)))
  return new Map(ids.map((squadId, index) => [squadId, viewers[index]]))
}

export async function projectActivityPresence(
  identity: Identity,
  access: GlobalActivitySquadAccess[]
): Promise<GlobalActivityPresence> {
  const agentSquadIds = access.filter((entry) => entry.access.agentsRead).map((entry) => entry.squadId)
  const workStreamSquadIds = access.filter((entry) => entry.access.workstreamsRead).map((entry) => entry.squadId)

  const [workingAgents, activeStreams, attention] = await Promise.all([
    agentSquadIds.length === 0
      ? []
      : db
          .select({ id: agents.id })
          .from(agents)
          .where(and(inArray(agents.squadId, agentSquadIds), eq(agents.status, 'active'))),
    workStreamSquadIds.length === 0
      ? []
      : db
          .select({
            id: workStreams.id,
            number: workStreams.number,
            title: workStreams.title,
            squadId: workStreams.squadId,
            status: workStreams.status,
            pause: workStreams.pause,
            metadata: workStreams.metadata,
            updatedAt: workStreams.updatedAt,
            assigneeAgentId: workStreams.assigneeAgentId,
            agentIds: workStreams.agentIds,
            assignedReviewerIds: workStreams.assignedReviewerIds,
          })
          .from(workStreams)
          .where(
            and(inArray(workStreams.squadId, workStreamSquadIds), inArray(workStreams.status, ['queued', 'active']))
          ),
    identity.type === 'user' ? loadUserAttention(identity.userId) : EMPTY_USER_ATTENTION,
  ])

  const derived = await computeDerivedStates(activeStreams)
  const workingAgentIds = workingAgents.map((agent) => agent.id).sort()
  // The strip is a personal summary: muting a kind removes that squad's work from ITS count and
  // from nobody else's. Agents are not attention-scoped — the working count is about the instance.
  // "Waiting on you" is about this viewer, applied here per request: a stream needing a person
  // counts only when the viewer may act on one of its waits, by the shared rule every client shows.
  const facts = new Map(
    activeStreams.map((stream) => {
      const presentation = derived.get(stream.id)
      return [
        stream.id,
        {
          status: stream.status,
          pause: stream.pause,
          delivery: presentation?.delivery,
          derivedState: presentation?.derivedState,
          openWaits: presentation?.openWaits,
          assignedReviewerIds: stream.assignedReviewerIds,
        },
      ]
    })
  )
  const needingPerson = activeStreams.filter((stream) => workStreamNeedsHumanAttention(facts.get(stream.id)!))
  // Cards label every open wait for the viewer too, so squads with any open wait need one.
  const viewers = await loadSquadViewers(identity, [
    ...needingPerson.map((stream) => stream.squadId),
    ...activeStreams.filter((stream) => facts.get(stream.id)!.openWaits?.length).map((stream) => stream.squadId),
  ])
  const needsYou = new Set(
    needingPerson
      .filter((stream) => {
        if (attention.forWorkStream(stream.id, stream.squadId).decisions === 'mute') return false
        return workStreamWaitsOnViewer(facts.get(stream.id)!, viewers.get(stream.squadId))
      })
      .map((stream) => stream.id)
  )
  const shownStreams = activeStreams.filter(
    (stream) => attention.forWorkStream(stream.id, stream.squadId).progress !== 'mute'
  )

  return {
    workingAgentIds,
    workingCount: workingAgentIds.length,
    needsYouCount: needsYou.size,
    streamCount: shownStreams.length,
    streams: await buildWorkStreamCards(shownStreams, derived, needsYou, new Set(agentSquadIds), viewers),
  }
}

async function buildWorkStreamCards(
  streams: Array<{
    id: string
    number: number
    title: string
    squadId: string
    status: 'queued' | 'active' | 'done' | 'canceled'
    metadata: unknown
    updatedAt: Date
    assignedReviewerIds: string[]
  }>,
  derived: Awaited<ReturnType<typeof computeDerivedStates>>,
  needsYou: Set<string>,
  agentReadableSquads: Set<string>,
  viewers: Map<string, WorkStreamViewer>
): Promise<ActivityWorkStreamCard[]> {
  if (!streams.length) return []
  const agentStreamIds = streams.filter((stream) => agentReadableSquads.has(stream.squadId)).map((stream) => stream.id)
  const [working, lastEvents] = await Promise.all([
    agentStreamIds.length
      ? db.execute<{ work_stream_id: string; agent_id: string }>(sql`
          SELECT b.work_stream_id,a.id agent_id FROM workflow_bindings b JOIN agents a ON a.id=b.agent_id
          WHERE b.work_stream_id IN (${uuidList(agentStreamIds)}) AND a.status='active' ORDER BY a.id`)
      : [],
    agentStreamIds.length
      ? db.execute(workStreamLastEventsSql(agentStreamIds, activityRetentionFloor(new Date())))
      : [],
  ])
  const workingByStream = new Map<string, string[]>()
  for (const row of working as Array<{ work_stream_id: string; agent_id: string }>)
    workingByStream.set(row.work_stream_id, [...(workingByStream.get(row.work_stream_id) ?? []), row.agent_id])
  const lastEventByStream = new Map(
    (lastEvents as Array<{ work_stream_id: string; last_at: Date | string }>).map((row) => [
      row.work_stream_id,
      new Date(row.last_at).toISOString(),
    ])
  )
  const lastEventAt = (stream: (typeof streams)[number]) => {
    const updatedAt = new Date(stream.updatedAt).toISOString()
    const event = lastEventByStream.get(stream.id)
    return event && event > updatedAt ? event : updatedAt
  }

  // Order and cap first: only the returned cards pay for reading their flow step.
  const shown = [...streams]
    .sort(
      (a, b) =>
        Number(needsYou.has(b.id)) - Number(needsYou.has(a.id)) ||
        lastEventAt(b).localeCompare(lastEventAt(a)) ||
        b.number - a.number
    )
    .slice(0, ACTIVITY_WORK_STREAM_CARD_LIMIT)
  const steps = await loadWorkStreamSteps(shown)
  const summariesEnabled = streamSummariesEnabled()

  return shown.map((stream): ActivityWorkStreamCard => {
    const presentation = derived.get(stream.id)
    const openWaits = presentation?.openWaits ?? []
    const delivery = presentation?.delivery
    const step = steps.get(stream.id) ?? null
    // The summary paraphrases participants' chat, so it needs agents:read like their Activity rows.
    const summary = agentReadableSquads.has(stream.squadId)
      ? presentWorkStreamSummary(stream.metadata, { status: stream.status, step }, summariesEnabled)
      : undefined
    return {
      id: stream.id,
      number: stream.number,
      squadId: stream.squadId,
      title: stream.title,
      status: stream.status,
      step,
      waits: openWaits.map((wait) => {
        const needsPerson = workStreamWaitNeedsHuman(wait, { openWaits, delivery })
        const facts = { openWaits, delivery, assignedReviewerIds: stream.assignedReviewerIds }
        return {
          type: workStreamWaitDisplayType(wait),
          needsYou: needsPerson,
          // Whether this viewer is that person (the shared rule): "Waiting on you: review" only then.
          you: needsPerson && viewerCanActOnWait(wait, facts, viewers.get(stream.squadId)),
        }
      }),
      needsYou: needsYou.has(stream.id),
      pullRequest: primaryPullRequest(stream.metadata, delivery),
      ci: deliveryCiState(delivery),
      deliveryLabel: deliveryLabel(delivery),
      workingAgentIds: workingByStream.get(stream.id) ?? [],
      lastEventAt: lastEventAt(stream),
      // Already computed for needsYou above: no extra read.
      ...(presentation?.derivedState ? { derivedState: presentation.derivedState } : {}),
      ...(presentation?.slotWait ? { slotWait: presentation.slotWait } : {}),
      ...(summary ? { summary: summary.text, summaryGeneratedAt: summary.generatedAt } : {}),
    }
  })
}

const uuidList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`,`
  )

/**
 * Newest retained Activity row of each stream's bound participants: one `LIMIT 1` probe of
 * `idx_squad_activity_agent` (squad, agent, at DESC NULLS LAST; the ORDER BY must match it or
 * Postgres sorts the participant's whole history) per participant, never a scan of their
 * history. A stream's own rows (creation, waits, handoffs, PR events) have no index ordered by
 * time, so they are not read; the stream's `updatedAt` stands in for them, and the events that
 * matter to a participant (PR and CI notices, handoffs) reach its inbox and so its rows anyway.
 */
export function workStreamLastEventsSql(streamIds: string[], retentionFloor: Date) {
  // MATERIALIZED pins the join order: participants are resolved first, then probed once each.
  // Inlined, the planner can run the probe for every binding x stream pair before filtering.
  return sql`
    WITH participants AS MATERIALIZED (
      SELECT b.work_stream_id,b.agent_id,ws.squad_id FROM workflow_bindings b
      JOIN work_streams ws ON ws.id=b.work_stream_id
      WHERE b.work_stream_id IN (${uuidList(streamIds)})
    )
    SELECT p.work_stream_id,max(latest.at) AS last_at
    FROM participants p
    CROSS JOIN LATERAL (
      SELECT sa.at FROM squad_activity sa
      WHERE sa.squad_id=p.squad_id AND sa.agent_id=p.agent_id AND sa.at>=${retentionFloor.toISOString()}::timestamptz
      ORDER BY sa.at DESC NULLS LAST LIMIT 1
    ) latest
    GROUP BY p.work_stream_id`
}
