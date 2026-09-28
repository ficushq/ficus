import { eq } from 'drizzle-orm'
import type { EventMap } from '@ficus/shared'
import { db } from '../../db'
import { agents, schedules, workStreams } from '../../db/schema'

export type TopicScope =
  | { kind: 'squad'; squadId: string }
  | { kind: 'owner'; ownerUserId: string }
  | { kind: 'permission'; permission: 'agents:read' }
  | { kind: 'unavailable' }
  | { kind: 'recipient'; recipientId: string }
  | { kind: 'collection' }
  | { kind: 'unresolved' }

export async function topicScope(topic: string): Promise<TopicScope> {
  // Split on the first separator only: saved Assistant mailboxes are `inbox:assistant:<uuid>`.
  const separator = topic.indexOf(':')
  const collection = separator === -1 ? topic : topic.slice(0, separator)
  const id = separator === -1 ? '' : topic.slice(separator + 1)
  if (!id) return { kind: 'collection' }

  switch (collection) {
    case 'squads':
    case 'squadActivity':
      return { kind: 'squad', squadId: id }
    case 'inbox':
      return { kind: 'recipient', recipientId: id }
    case 'agents':
      return agentTopicScope(id)
    case 'workstreams': {
      if (!isUuid(id)) return { kind: 'unresolved' }
      const [workStream] = await db
        .select({ squadId: workStreams.squadId })
        .from(workStreams)
        .where(eq(workStreams.id, id))
        .limit(1)
      return workStream?.squadId ? { kind: 'squad', squadId: workStream.squadId } : { kind: 'unresolved' }
    }
    case 'machines':
      // Machines are an ADMIN-GLOBAL surface, not squad-scoped. The WS layer
      // only knows squad-access ('all' vs a squad-id list) + inbox recipients —
      // it cannot gate on the `machines:read` permission directly (that's
      // enforced on the REST routes). Returning `unresolved` fail-closes the
      // instance topic to full-access ('all') clients only: canSubscribe rejects
      // a non-'all' client, and canReceive (machine.* carry no squadId, so
      // eventSquadId → null) only delivers to 'all'-access clients. The bare
      // `machines` collection topic short-circuits to `{ kind: 'collection' }`
      // above, so it is filtered the same way at receive time.
      return { kind: 'unresolved' }
    case 'schedules': {
      if (!isUuid(id)) return { kind: 'unresolved' }
      const [schedule] = await db
        .select({ scopeType: schedules.scopeType, scopeId: schedules.scopeId })
        .from(schedules)
        .where(eq(schedules.id, id))
        .limit(1)
      return schedule?.scopeType === 'squad' ? { kind: 'squad', squadId: schedule.scopeId } : { kind: 'unresolved' }
    }
    default:
      return { kind: 'unresolved' }
  }
}

export async function agentTopicScope(agentId: string): Promise<TopicScope> {
  if (!isUuid(agentId)) return { kind: 'unavailable' }

  const [agent] = await db
    .select({ squadId: agents.squadId, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  if (!agent) return { kind: 'unavailable' }
  if (agent.squadId) return { kind: 'squad', squadId: agent.squadId }
  if (agent.ownerUserId) return { kind: 'owner', ownerUserId: agent.ownerUserId }
  return { kind: 'permission', permission: 'agents:read' }
}

type Scope = string | 'global' | null

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function eventSquadId(event: keyof EventMap | string, data: any): Scope {
  if (event === 'worker.status') return 'global'
  if (data && typeof data.squadId === 'string') return data.squadId
  if (event === 'squadRelationship.created' && data && typeof data.sourceSquadId === 'string') return data.sourceSquadId
  return null
}
