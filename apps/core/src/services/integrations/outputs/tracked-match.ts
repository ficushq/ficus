import {
  integrationValueAt,
  resolveTrackedResources,
  trackedResourceMatches,
  type IntegrationOutputFact,
  type TrackedResourceKind,
} from '@ficus/shared'
import { integrationOutputRegistry } from './registry'
import type { integrationOutputEvents, agents, workStreams } from '../../../db'

type Event = typeof integrationOutputEvents.$inferSelect
export interface TrackedTarget {
  integration: string
  repository: string
  kind: TrackedResourceKind
  number: number
  url?: string
  /** Provider-native identity, when the fact carries one alongside repository/number. */
  externalId?: string
}

export function eventTrackedResource(event: {
  integration: string
  fact: IntegrationOutputFact
}): TrackedTarget | null {
  return integrationOutputRegistry.adapter(event.integration)?.trackedResource?.(event.fact) ?? null
}

/**
 * Correlation only: a match never grants the connection any access.
 *
 * Facts that name no repository or number — a Linear comment carries just the issue UUID — still
 * identify their resource through the adapter's provider-native identity, which only matches a
 * link that already recorded the same `externalId`.
 */
export function streamTracksEvent(metadata: unknown, event: Event): boolean {
  const adapter = integrationOutputRegistry.adapter(event.integration)
  const target = adapter?.trackedResource?.(event.fact) ?? adapter?.trackedIdentity?.(event.fact)
  if (!target) return false
  const connectionId = event.authority.kind === 'connection' ? event.authority.connectionId : undefined
  return resolveTrackedResources(metadata).some((resource) =>
    trackedResourceMatches(resource, { ...target, connectionId })
  )
}

/** Existing pre-flow matching, shared by query-only planning and delivery. */
export function defaultStreamMatches(metadata: unknown, event: Event): boolean {
  const value = integrationValueAt(metadata, 'integrationSource')
  const origin = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return (
    (origin.integration === event.integration &&
      origin.resourceKey === event.fact.resourceKey &&
      event.authority.kind === 'connection' &&
      origin.connectionId === event.authority.connectionId) ||
    (event.integration === 'linear' &&
      !origin.integration &&
      typeof integrationValueAt(event.fact.data, 'issue.id') === 'string' &&
      integrationValueAt(metadata, 'linear.issueId') === integrationValueAt(event.fact.data, 'issue.id')) ||
    streamTracksEvent(metadata, event)
  )
}

/** Preserve the existing pre-flow recipient preference in both planning and delivery. */
export function preFlowRecipient(
  stream: typeof workStreams.$inferSelect,
  available: Array<typeof agents.$inferSelect>,
  managerId: string | null
) {
  const preferred = integrationValueAt(stream.metadata, 'github.pr.recipientAgentId')
  return (
    available.find((agent) => agent.id === preferred) ??
    available.find((agent) => stream.agentIds?.includes(agent.id) && agent.agentTypeId === 'reviewer') ??
    available.find((agent) => agent.id === stream.assigneeAgentId) ??
    available.find((agent) => agent.id === managerId)
  )
}
