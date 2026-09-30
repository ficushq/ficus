import { queryKeys } from '@ficus/client-core'
import type { QueryKey } from '@tanstack/react-query'

/** The collection topics the farm subscribes to (see @ficus/shared ws-topics). */
export const FARM_TOPICS = ['actions', 'agents', 'squads', 'workstreams', 'inbox'] as const

/** A squad's field log (cards/FieldLogCard): its topic, watched only while the card is open, and its query key. */
export const fieldLogTopic = (squadId: string) => `squadActivity:${squadId}`
export const fieldLogKey = (squadId: string) => ['farm', 'fieldLog', squadId] as const

export interface LiveEvent {
  type: 'event'
  topic: string
  event: string
  data?: unknown
}

export function isLiveEvent(value: unknown): value is LiveEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.type === 'event' && typeof v.topic === 'string' && typeof v.event === 'string'
}

function agentIdOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const id = d.agentId ?? (d.agent as Record<string, unknown> | undefined)?.id ?? d.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Which cached queries a live event makes stale. Mirrors the web app's
 * QueryInvalidator for the topics the farm draws from, without its per-screen
 * extras: the farm only needs squads, work streams, agents and the mailbox.
 */
export function keysForEvent(event: LiveEvent): QueryKey[] {
  switch (event.topic.split(':')[0]) {
    case 'actions':
      return [queryKeys.actions.all, queryKeys.agentQuestions.all]
    case 'workstreams':
      return [queryKeys.squads.all, queryKeys.workflows.all, queryKeys.actions.all]
    case 'squads':
      return [queryKeys.squads.all]
    case 'agents': {
      const keys: QueryKey[] = [queryKeys.agents.listPrefix(), [...queryKeys.squads.all, 'agents']]
      const id = agentIdOf(event.data)
      if (id) keys.push(queryKeys.agents.detail(id))
      if (event.event.startsWith('agent-question.') || event.event === 'agent.waiting-input') {
        keys.push(queryKeys.actions.all, queryKeys.agentQuestions.all)
      }
      if (event.event === 'agent.created' || event.event === 'agent.terminated' || event.event === 'agent.deleted') {
        keys.push([...queryKeys.squads.all, 'agentsWithRecent'])
      }
      return keys
    }
    case 'inbox':
      return event.event === 'assistant.activityChanged' ? [['farm', 'assistant']] : []
    case 'squadActivity': {
      // A new or changed entry (or access withdrawn): that squad's field log refetches.
      const squadId = event.topic.slice('squadActivity:'.length)
      return squadId ? [fieldLogKey(squadId)] : []
    }
    default:
      return []
  }
}

/** Collapse keys that a broader key in the same batch already covers. */
export function dedupeKeys(keys: QueryKey[]): QueryKey[] {
  const out: QueryKey[] = []
  const serialized = keys.map((k) => JSON.stringify(k))
  keys.forEach((key, i) => {
    const covered = keys.some((other, j) => {
      if (j === i || other.length > key.length) return false
      if (other.length === key.length) return j < i && serialized[j] === serialized[i]
      return other.every((part, n) => JSON.stringify(part) === JSON.stringify(key[n]))
    })
    if (!covered) out.push(key)
  })
  return out
}
