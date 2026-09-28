import { createHash } from 'node:crypto'
import type { SquadActivityItem, SquadActivityLane, SquadActivityRef } from '@ficus/shared'

export type SquadActivitySourceFamily =
  | 'chat'
  | 'inbox'
  | 'execution'
  | 'workstream'
  | 'wait'
  | 'github-pr'
  | 'github-issue'
  | 'linear-issue'
export type SquadActivityAccessScope = 'agents' | 'workstreams' | 'inbox' | 'workstreams_inbox'

export interface ExtractedSquadActivity extends SquadActivityItem {
  squadId: string
  lane: SquadActivityLane
  rowId: string
  sourceFamily: SquadActivitySourceFamily
  sourceGroupId: string
  workStreamId: string | null
  quietEligible: boolean
  accessScope: SquadActivityAccessScope
  inboxRecipientId: string | null
  agentTypeRequiresAgentsRead: boolean
}

export interface StoredSquadActivityPayload {
  squadId: string
  lane: SquadActivityLane
  rowId: string
  sourceFamily: SquadActivitySourceFamily
  sourceGroupId: string
  at: string
  agentId: string | null
  workStreamId: string | null
  agentTypeId: string | null
  agentTypeRequiresAgentsRead: boolean
  kind: SquadActivityItem['kind']
  summary: string
  preview: SquadActivityItem['preview']
  ref: SquadActivityRef
  quietEligible: boolean
  accessScope: SquadActivityAccessScope
  inboxRecipientId: string | null
}

export function activityPersistencePayload(item: ExtractedSquadActivity): StoredSquadActivityPayload {
  return {
    squadId: item.squadId,
    lane: item.lane,
    rowId: item.rowId,
    sourceFamily: item.sourceFamily,
    sourceGroupId: item.sourceGroupId,
    at: new Date(item.at).toISOString(),
    agentId: item.agentId,
    workStreamId: item.workStreamId,
    agentTypeId: item.agentTypeId,
    agentTypeRequiresAgentsRead: item.agentTypeRequiresAgentsRead,
    kind: item.kind,
    summary: item.summary,
    preview: item.preview,
    ref: item.ref,
    quietEligible: item.quietEligible,
    accessScope: item.accessScope,
    inboxRecipientId: item.inboxRecipientId,
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)])
  )
}

export function activityPayloadHash(item: ExtractedSquadActivity): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(activityPersistencePayload(item))))
    .digest('hex')
}

export function materializedItem(item: ExtractedSquadActivity): SquadActivityItem {
  return {
    id: `${item.lane}:${item.rowId}`,
    at: new Date(item.at).toISOString(),
    agentId: item.agentId,
    agentTypeId: item.agentTypeId,
    kind: item.kind,
    summary: item.summary,
    preview: item.preview,
    ref: item.ref,
  }
}
