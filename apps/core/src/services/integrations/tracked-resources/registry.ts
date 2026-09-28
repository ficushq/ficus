import {
  resolveTrackedResources,
  type IntegrationSubscription,
  type ResolvedTrackedResource,
  type TrackedResource,
  type TrackedResourceKind,
} from '@ficus/shared'

/**
 * A provider's answer to "what is this issue or pull request, and may this squad follow it?".
 * Identity only: an adapter never grants access, it reports the squad's own authorization.
 */
export interface TrackedResourceAdapter {
  integration: string
  validateRepository(repository: string): boolean
  /** Where this provider's facts carry the resource identity, by tracked-resource kind. */
  matchFields(kind: TrackedResourceKind): { repository: string; number: string; externalId?: string }
  /** Events for a resource tracked alongside the delivery binding. Identity only; never a grant. */
  trackedSubscriptions(resource: ResolvedTrackedResource): IntegrationSubscription[]
  authorizeSquad(squadId: string, connectionId?: string): Promise<boolean>
  /** Resolve the provider's own view of the resource: its native id, canonical URL and identity. */
  describe?(
    resource: DescribableResource,
    squadId: string
  ): Promise<Partial<Pick<TrackedResource, 'externalId' | 'url' | 'repository' | 'number'>> | null>
}

/**
 * What `describe` is asked about: as much identity as the caller holds. A written link names
 * `repository` and `number`; a fact that carries only a provider-native id (a Linear comment
 * names just the issue UUID) names `externalId` instead.
 */
export type DescribableResource = Omit<TrackedResource, 'repository' | 'number'> &
  Partial<Pick<TrackedResource, 'repository' | 'number'>>

/** Identity of a tracked link, as much of it as the caller knows. */
export type TrackedResourceIdentity = {
  integration: string
  repository: string
  kind: TrackedResourceKind
  number: number
  externalId?: string
}

function matchValue(subscription: IntegrationSubscription, path: string) {
  const match = subscription.match[path]
  return match && 'value' in match ? match.value : undefined
}

export class TrackedResourceRegistry {
  private readonly adapters = new Map<string, TrackedResourceAdapter>()
  constructor(adapters: readonly TrackedResourceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.integration)) throw new Error('Duplicate tracked resource adapter')
      this.adapters.set(adapter.integration, adapter)
    }
  }
  adapterFor(integration: string): TrackedResourceAdapter | undefined {
    return this.adapters.get(integration)
  }
  /**
   * Subscriptions for every extra link in `metadata`. The delivery change request is excluded:
   * it already owns the reserved code-host ids, so fanning it out again would duplicate them.
   */
  subscriptions(metadata: unknown): IntegrationSubscription[] {
    const out: IntegrationSubscription[] = []
    for (const resource of resolveTrackedResources(metadata)) {
      if (resource.source !== 'tracked') continue
      const adapter = this.adapters.get(resource.integration)
      if (!adapter?.validateRepository(resource.repository)) continue
      out.push(...adapter.trackedSubscriptions(resource))
    }
    return out
  }
  /**
   * Whether `subscription`'s literal `match` values identify `resource`: the provider's native id
   * when both sides carry one, otherwise the repository (trimmed, case-insensitive) and number on
   * the kind-appropriate paths the adapter names.
   *
   * `matchValue` only reads a literal `value`, so a `streamMetadata`-bound match — which carries no
   * fixed value of its own — never matches here, no matter what the stream currently binds it to.
   */
  targetsResource(subscription: IntegrationSubscription, resource: TrackedResourceIdentity): boolean {
    if (subscription.source.integration !== resource.integration) return false
    const fields = this.adapters.get(resource.integration)?.matchFields(resource.kind)
    if (!fields) return false
    if (fields.externalId && resource.externalId && matchValue(subscription, fields.externalId) === resource.externalId)
      return true
    return (
      String(matchValue(subscription, fields.repository) ?? '')
        .trim()
        .toLowerCase() === resource.repository.trim().toLowerCase() &&
      matchValue(subscription, fields.number) === resource.number
    )
  }
}
