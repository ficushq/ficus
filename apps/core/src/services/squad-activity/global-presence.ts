import { workStreamNeedsHumanAttention, type GlobalActivityPresence } from '@ficus/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, workStreams } from '../../db/schema'
import type { Identity } from '../rbac'
import { EMPTY_USER_ATTENTION, loadUserAttention } from '../attention/resolver'
import { computeDerivedStates } from '../work-streams/derived-state'
import { resolveGlobalActivityAccess } from './access'

/**
 * Build the global activity presence strip from only the squads and resource
 * types the authenticated identity may read. Callers supply no squad ids: the
 * same per-squad resolver as the global activity feed is authoritative here.
 */
export async function projectGlobalActivityPresence(identity: Identity): Promise<GlobalActivityPresence> {
  const access = await resolveGlobalActivityAccess(identity)
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
            squadId: workStreams.squadId,
            status: workStreams.status,
            pause: workStreams.pause,
            assigneeAgentId: workStreams.assigneeAgentId,
            agentIds: workStreams.agentIds,
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
  const needsYouCount = activeStreams.filter((stream) => {
    if (attention.forWorkStream(stream.id, stream.squadId).decisions === 'mute') return false
    const presentation = derived.get(stream.id)
    return workStreamNeedsHumanAttention({
      status: stream.status,
      pause: stream.pause,
      delivery: presentation?.delivery,
      derivedState: presentation?.derivedState,
      openWaits: presentation?.openWaits,
    })
  }).length
  const streamCount = activeStreams.filter(
    (stream) => attention.forWorkStream(stream.id, stream.squadId).progress !== 'mute'
  ).length

  return {
    workingAgentIds,
    workingCount: workingAgentIds.length,
    needsYouCount,
    streamCount,
  }
}
