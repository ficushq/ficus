import { useQuery } from '../../reactQueryHooks'
import { queries } from '../../queryOptions'
import { usePermissions } from '../../hooks/usePermissions'
import { StreamSummariesSetting } from './StreamSummariesSetting'

/**
 * Settings → Work features: instance-wide switches for features of work itself, kept apart from the
 * model tiers they happen to run on. Work stream summaries is the first.
 */
export function WorkFeaturesSection() {
  const { can } = usePermissions()
  // Only to warn when no Lite model is signed in; the switch works without it.
  const tiers = useQuery({ ...queries.modelTiers.list(), enabled: can('agent-types:read') })
  const lite = tiers.data?.find((tier) => tier.slug === 'lite')
  return (
    <div className="ficus-section py-5">
      <h2 className="text-sm font-medium text-secondary">Work features</h2>
      <div data-setting-target="stream-summaries">
        <StreamSummariesSetting usableCandidates={lite?.usableCandidates} />
      </div>
    </div>
  )
}
