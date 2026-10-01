import {
  effectiveSquadEventRules,
  eventRepositoryMatches,
  matchesGitHubRouting,
  resolveTrackedResources,
  trackedResourceMatches,
  integrationValueAt,
  type IntegrationOutputFact,
  type IntegrationSubscription,
} from '@ficus/shared'

/** Visibility of an installation is not a squad's interest in private vulnerability details. */
export function dependabotRepositoryInterest(
  metadata: unknown,
  streams: readonly { metadata: unknown; subscriptions?: readonly IntegrationSubscription[] }[],
  fact: IntegrationOutputFact,
  connectionId: string
): boolean {
  const repository = String(fact.data.repository ?? '')
  const externalId = integrationValueAt(fact.data, 'alert.externalId') as string
  if (
    effectiveSquadEventRules(metadata, 'github').some((rule) => {
      if (
        !rule.enabled ||
        rule.action.type === 'ignore' ||
        rule.source.output !== fact.output ||
        (rule.source.connectionId && rule.source.connectionId !== connectionId)
      )
        return false
      const pattern = rule.filters.repository || rule.match?.repository?.value
      if (typeof pattern === 'string' && !eventRepositoryMatches(pattern, repository)) return false
      if (rule.filters.squadRouting && !matchesGitHubRouting(metadata, repository)) return false
      // Unscoped rules can match delivered facts, but must not subscribe to every installation repository.
      return typeof pattern === 'string' || rule.filters.squadRouting
    })
  )
    return true
  return streams.some(
    (stream) =>
      resolveTrackedResources(stream.metadata).some(
        (resource) =>
          resource.kind === 'dependabot_alert' &&
          trackedResourceMatches(resource, {
            integration: 'github',
            kind: 'dependabot_alert',
            repository,
            number: Number(integrationValueAt(fact.data, 'alert.number')),
            externalId,
            connectionId,
          })
      ) ||
      stream.subscriptions?.some((subscription) => {
        if (
          subscription.source.integration !== 'github' ||
          subscription.source.output !== fact.output ||
          (subscription.source.connectionId && subscription.source.connectionId !== connectionId)
        )
          return false
        const value = (field: string) => {
          const binding = subscription.match[field]
          return (
            binding &&
            ('value' in binding ? binding.value : integrationValueAt(stream.metadata, binding.streamMetadata))
          )
        }
        return (
          value('alert.externalId') === externalId ||
          (typeof value('repository') === 'string' && eventRepositoryMatches(String(value('repository')), repository))
        )
      })
  )
}
