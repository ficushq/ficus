import type { IntegrationSubscription } from '@ficus/shared'
import { githubTrackedResourceAdapter } from '../github/code-hosting'
import { linearTrackedResourceAdapter } from './linear'
import { TrackedResourceRegistry, type TrackedResourceIdentity } from './registry'

export {
  TrackedResourceRegistry,
  type DescribableResource,
  type TrackedResourceAdapter,
  type TrackedResourceIdentity,
} from './registry'

// Provider composition belongs here, not in the work-stream service or the event router.
export const trackedResourceRegistry = new TrackedResourceRegistry([
  githubTrackedResourceAdapter,
  linearTrackedResourceAdapter,
])

/** Whether `subscription`'s literal `match` values identify `resource`. See `targetsResource`. */
export function subscriptionTargetsResource(
  subscription: IntegrationSubscription,
  resource: TrackedResourceIdentity,
  registry: TrackedResourceRegistry = trackedResourceRegistry
): boolean {
  return registry.targetsResource(subscription, resource)
}
