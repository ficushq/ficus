import {
  resolveTrackedResources,
  trackedResourceMatches,
  type IntegrationOutputFact,
  type TrackedResourceKind,
} from '@ficus/shared'
import { integrationOutputRegistry } from './registry'
import type { integrationOutputEvents } from '../../../db'

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
