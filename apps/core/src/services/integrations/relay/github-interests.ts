import {
  effectiveSquadEventRules,
  resolveCodeHostReference,
  resolveTrackedResources,
  integrationValueAt,
  type WorkflowEventTrigger,
} from '@ficus/shared'
import { githubRepositoryKey } from '@ficus/shared/integration-relay'
import { isRepositoryPattern } from '../github/repository-enumeration'
import { findGitHubPrUrl, type WorkStreamCandidate } from '../github/watch-policy'

export interface RepositoryInterest {
  squadId: string
  connectionId: string
  repository: string
}
export interface GitHubInterestSource {
  listWorkStreams(): Promise<readonly WorkStreamCandidate[]>
  listSquads(): Promise<readonly { id: string; metadata: unknown }[]>
  resolveConnection(squadId: string, connectionId?: string): Promise<{ id: string } | undefined>
  /**
   * Resolves wildcard selectors (`owner/*`) to the exact repositories the
   * connection can see — see GitHubRepositoryExpander. Without it, wildcard
   * selectors declare no relay interest.
   */
  expandRepositories?(connectionId: string, selectors: readonly string[]): Promise<string[]>
}

/**
 * Declared interests only: exact selectors as written, wildcard selectors
 * expanded against the connection's own visible repositories (never an
 * account-wide guess). Webhook presence never suppresses its own subscription.
 */
export async function discoverGitHubRelayInterests(source: GitHubInterestSource): Promise<RepositoryInterest[]> {
  const [streams, squads] = await Promise.all([source.listWorkStreams(), source.listSquads()])
  const result = new Map<string, RepositoryInterest>()
  const connections = new Map<string, Promise<{ id: string } | undefined>>()
  const resolve = (squadId: string, requested?: string) => {
    const cacheKey = JSON.stringify([squadId, requested])
    if (!connections.has(cacheKey)) connections.set(cacheKey, source.resolveConnection(squadId, requested))
    return connections.get(cacheKey)!
  }
  const addInterest = (squadId: string, connectionId: string, repository: string) => {
    const interest = { squadId, connectionId, repository }
    result.set(JSON.stringify(interest), interest)
  }
  const add = async (squadId: string, repository: unknown, requested?: string) => {
    if (typeof repository === 'string' && isRepositoryPattern(repository)) {
      if (!source.expandRepositories) return
      const connection = await resolve(squadId, requested)
      if (!connection) return
      for (const expanded of await source.expandRepositories(connection.id, [repository]))
        addInterest(squadId, connection.id, expanded)
      return
    }
    const key = githubRepositoryKey.safeParse(repository)
    if (!key.success) return
    const connection = await resolve(squadId, requested)
    if (!connection) return
    addInterest(squadId, connection.id, key.data)
  }
  for (const stream of streams) {
    if (['done', 'canceled'].includes(stream.status)) continue
    const binding = resolveCodeHostReference(stream.metadata)
    const metadata = stream.metadata as {
      codeHost?: unknown
      github?: { repo?: unknown; connectionId?: string }
    } | null
    const github =
      metadata?.codeHost !== undefined
        ? binding?.integration === 'github'
          ? binding
          : null
        : { repository: metadata?.github?.repo, connectionId: metadata?.github?.connectionId }
    await add(stream.squadId, github?.repository, github?.connectionId)
    const pr = findGitHubPrUrl(stream.metadata)
    if (pr) await add(stream.squadId, `${pr.owner}/${pr.repo}`, github?.connectionId)
    for (const resource of resolveTrackedResources(stream.metadata)) {
      if (resource.integration === 'github') await add(stream.squadId, resource.repository, resource.connectionId)
    }
    for (const subscription of stream.subscriptions ?? []) {
      if (subscription.source.integration !== 'github') continue
      const match = subscription.match.repository
      if (match)
        await add(
          stream.squadId,
          'value' in match ? match.value : integrationValueAt(stream.metadata, match.streamMetadata),
          subscription.source.connectionId
        )
    }
  }
  for (const squad of squads) {
    const metadata = squad.metadata as {
      integrationTriggers?: WorkflowEventTrigger[]
      github?: { repo?: unknown }[]
    } | null
    if (Array.isArray(metadata?.github)) for (const repo of metadata.github) await add(squad.id, repo.repo)
    for (const rule of effectiveSquadEventRules(metadata, 'github')) {
      if (!rule.enabled || rule.action.type === 'ignore') continue
      const repository = rule.filters.repository || rule.match?.repository?.value
      if (repository) await add(squad.id, repository, rule.source.connectionId)
      else if (rule.filters.squadRouting && Array.isArray(metadata?.github))
        for (const repo of metadata.github) await add(squad.id, repo.repo, rule.source.connectionId)
    }
  }
  return [...result.values()]
}
