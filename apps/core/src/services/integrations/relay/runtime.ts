import { isPlatformManaged } from '../../secrets/managed'
import { platformRequest, PlatformRequestError } from '../../platform/instance-client'
import { relayPullResponse } from '@ficus/shared/integration-relay'
import {
  resolveGitHubConnection,
  resolveGitHubRelayAssignment,
  resolveInstanceGitHubConnection,
} from '../github/resolve-connection'
import { listGitHubPrWorkStreamCandidates, listGitHubTriggerSquads } from '../github/database-watch-source'
import { expandGitHubRepositories } from '../github/repository-enumeration-runtime'
import { publishIntegrationOutputs } from '../outputs/runtime'
import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import { extractGitHubPrDispatchFact } from '../../squad-activity/github-pr-fact'
import { materializeGitHubDispatch } from '../../squad-activity/materialize'
import { createLogger } from '../../../lib/infra/logger'
import { discoverGitHubRelayInterests } from './github-interests'
import { HostedIntegrationRelayRunner, type HostedRelayProvider } from './runner'
import type { RelayDelivery } from '@ficus/shared/integration-relay'
import type { RepositoryInterest } from './github-interests'

const log = createLogger('hosted-integration-relay')
const receipts = new DbEventPollingDispatchStore()

export const githubRelayProvider: HostedRelayProvider<RepositoryInterest, RelayDelivery> = {
  key: 'github',
  runnerName: 'hosted-integration-relay',
  intervalMs: 5_000,
  pullResponseSchema: relayPullResponse,
  subscribeExtra: (interests) => {
    const repositories = [...new Set(interests.map((interest) => interest.repository))].sort()
    // Fail closed instead of silently watching an arbitrary subset.
    if (repositories.length > 100) throw new PlatformRequestError('repository_limit', false)
    return { repositories }
  },
  matchesDelivery: (interest, delivery) => interest.repository === delivery.resourceKey,
}

export const hostedIntegrationRelayRuntime = new HostedIntegrationRelayRunner(githubRelayProvider, {
  managed: isPlatformManaged,
  interests: () =>
    discoverGitHubRelayInterests({
      listWorkStreams: listGitHubPrWorkStreamCandidates,
      listSquads: listGitHubTriggerSquads,
      resolveConnection: resolveGitHubRelayAssignment,
      expandRepositories: expandGitHubRepositories,
    }),
  resolve: async (id) => {
    const resolved = await resolveInstanceGitHubConnection(id)
    return (
      resolved && { id, revision: resolved.connection.materialRevision, accessToken: resolved.credential.accessToken }
    )
  },
  request: platformRequest,
  dispatch: dispatchHostedGitHubDelivery,
  onError: (code) => log.warn(`Hosted GitHub delivery deferred: ${code}`),
})

export async function dispatchHostedGitHubDelivery(delivery: RelayDelivery, interests: RepositoryInterest[]) {
  const event = {
    type: delivery.eventType,
    payload: delivery.payload,
    metadata: { providerDeliveryId: delivery.deliveryId },
  }
  // Connection-scoped output facts own agent routing. Instance-wide legacy shell rules
  // are deliberately not an authority path for a shared App's tenant-scoped events.
  for (const squadId of new Set(interests.map((interest) => interest.squadId))) {
    const live = await resolveGitHubConnection(squadId, delivery.connectionId)
    // Expiry may race a successful pull. Leave the lease unacknowledged so fresh authorization can retry.
    if (!live) throw new Error('relay_authorization_unavailable')
    if (live.connection.materialRevision !== delivery.connectionRevision) continue
    await publishIntegrationOutputs('github', event, {
      kind: 'connection',
      connectionId: delivery.connectionId,
      connectionRevision: delivery.connectionRevision,
      squadId,
    })
    const fact = extractGitHubPrDispatchFact('github', event)
    if (!fact || fact.repository !== delivery.resourceKey) continue
    const key = `relay:${delivery.connectionId}:${squadId}:${fact.logicalRowId}`
    const claim = await receipts.claim('github', key, 120_000)
    if (claim.status === 'busy') throw new Error('relay_receipt_busy')
    const completed =
      claim.status === 'completed'
        ? claim.dispatch
        : await receipts.complete('github', key, claim.leaseToken, {
            eventFact: fact,
            eventOccurredAt: new Date(fact.occurredAt),
            activitySquadId: squadId,
          })
    if (completed) await materializeGitHubDispatch(completed.activityId, squadId)
  }
}
