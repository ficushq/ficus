import {
  effectiveSquadEventRules,
  deliveryPullRequests,
  resolveCodeHostReference,
  resolveTrackedResources,
  integrationValueAt,
  type IntegrationSubscription,
} from '@ficus/shared'
import type { EventPollingWatch } from '../event-polling-runner'
import type { GitHubPrPollingConfig } from './event-poller'
import { isRepositoryPattern } from './repository-enumeration'

export interface GitHubPrReference {
  owner: string
  repo: string
  number: number
}

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)\/?$/i

export function findGitHubPrUrl(value: unknown): GitHubPrReference | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const metadata = value as Record<string, unknown>
    if (metadata.codeHost !== undefined) {
      const reference = resolveCodeHostReference(metadata)
      if (
        reference?.integration !== 'github' ||
        !reference.changeRequest ||
        !/^[\w.-]+\/[\w.-]+$/.test(reference.repository)
      )
        return null
      const [owner, repo] = reference.repository.split('/')
      return { owner, repo, number: reference.changeRequest.number }
    }
    const github =
      metadata.github && typeof metadata.github === 'object' ? (metadata.github as Record<string, unknown>) : null
    const pr = github?.pr && typeof github.pr === 'object' ? (github.pr as Record<string, unknown>) : null
    if (
      typeof github?.repo === 'string' &&
      typeof pr?.number === 'number' &&
      Number.isSafeInteger(pr.number) &&
      pr.number > 0
    ) {
      const [owner, repo, extra] = github.repo.trim().split('/')
      if (owner && repo && !extra) return { owner, repo, number: pr.number }
    }
  }

  // Watch discovery retains the pre-existing recursive URL contract for legacy
  // work streams. Activity attribution deliberately does not use this fallback.
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  for (let visited = 0; pending.length > 0 && visited < 1_000; visited++) {
    const candidate = pending.shift()
    if (typeof candidate === 'string') {
      const match = PR_URL.exec(candidate.trim())
      if (match) return { owner: match[1], repo: match[2], number: Number(match[3]) }
      continue
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue
    seen.add(candidate)
    pending.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate as Record<string, unknown>)))
  }
  return null
}

export interface WorkStreamCandidate {
  deliveryPresentation?: boolean
  squadId: string
  status: 'active' | 'queued' | 'done' | 'canceled' | string
  metadata: unknown
  subscriptions?: readonly IntegrationSubscription[]
}

export interface GitHubPrWatchPolicyOptions {
  resolveConnection: (squadId: string, connectionId?: string) => Promise<{ id: string } | undefined>
  listWorkStreams: () => Promise<readonly WorkStreamCandidate[]>
  listSquads?: () => Promise<readonly { id: string; metadata: unknown }[]>
  lastRealDeliveries: (provider: string, repos: readonly string[]) => Promise<Map<string, Date>>
  /**
   * Resolves wildcard repository selectors (`owner/*`) to the exact repositories
   * the connection can see — see GitHubRepositoryExpander. Without it, wildcard
   * selectors establish no watches (they still match events that arrive).
   */
  expandRepositories?: (connectionId: string, selectors: readonly string[]) => Promise<string[]>
  realDeliveryLookbackDays?: number
  now?: () => Date
}

/** Runner policy: discover PR-linked work streams and suppress repos with live webhooks. */
export class GitHubPrWatchPolicy {
  readonly #options: GitHubPrWatchPolicyOptions
  constructor(options: GitHubPrWatchPolicyOptions) {
    this.#options = options
  }

  async listWatches(): Promise<EventPollingWatch[]> {
    const candidates = await this.#options.listWorkStreams()
    const now = this.#options.now?.() ?? new Date()
    const cutoff = new Date(now.getTime() - (this.#options.realDeliveryLookbackDays ?? 7) * 86_400_000)
    const drafts = new Map<string, EventPollingWatch>()

    const connections = new Map<string, Promise<{ id: string } | undefined>>()
    const resolve = (squadId: string, connectionId?: string) => {
      const key = JSON.stringify([squadId, connectionId ?? null])
      let pending = connections.get(key)
      if (!pending) {
        pending = this.#options.resolveConnection(squadId, connectionId)
        connections.set(key, pending)
      }
      return pending
    }
    const issueWatches = new Map<string, EventPollingWatch>()
    const watchIssueRepository = (squadId: string, connectionId: string, repository: string) => {
      const [owner, repo] = repository.toLowerCase().split('/')
      const key = `${squadId}:${connectionId}:${owner}/${repo}:issue-events`
      issueWatches.set(key, {
        providerKey: 'github',
        resourceKey: key,
        active: true,
        connection: {
          id: connectionId,
          squadId,
          providerKey: 'github',
          adapterVersion: 1,
          configuration: { kind: 'issue-events', owner, repo },
        },
      })
    }
    const watchIssues = async (squadId: string, repository: unknown, connectionId?: string) => {
      if (typeof repository !== 'string') return
      if (isRepositoryPattern(repository)) {
        // A pattern is only as wide as the connection's own visibility, and the
        // expander fails closed (see GitHubRepositoryExpander) — so this never
        // guesses a scope the credential cannot see.
        if (!this.#options.expandRepositories) return
        const connection = await resolve(squadId, connectionId)
        if (!connection) return
        for (const expanded of await this.#options.expandRepositories(connection.id, [repository]))
          watchIssueRepository(squadId, connection.id, expanded)
        return
      }
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) return
      const connection = await resolve(squadId, connectionId)
      if (!connection) return
      watchIssueRepository(squadId, connection.id, repository)
    }

    for (const stream of candidates) {
      if (stream.status === 'done' || stream.status === 'canceled') continue
      const refs: (GitHubPrReference & { connectionId?: string })[] = []
      const legacy = findGitHubPrUrl(stream.metadata)
      if (legacy) {
        const metadata = stream.metadata as { codeHost?: unknown; github?: { connectionId?: unknown } } | null
        const github = metadata?.codeHost !== undefined ? resolveCodeHostReference(metadata) : metadata?.github
        refs.push({
          ...legacy,
          connectionId: typeof github?.connectionId === 'string' ? github.connectionId : undefined,
        })
      }
      for (const resource of resolveTrackedResources(stream.metadata)) {
        if (resource.integration !== 'github' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(resource.repository))
          continue
        if (resource.kind === 'pull_request') {
          const [owner, repo] = resource.repository.split('/')
          refs.push({ owner: owner!, repo: repo!, number: resource.number, connectionId: resource.connectionId })
        } else await watchIssues(stream.squadId, resource.repository, resource.connectionId)
      }
      for (const subscription of stream.subscriptions ?? []) {
        if (subscription.source.integration !== 'github') continue
        const binding = (field: string) => {
          const match = subscription.match[field]
          return match && ('value' in match ? match.value : integrationValueAt(stream.metadata, match.streamMetadata))
        }
        const repository = binding('repository')
        if (['issue.assigned', 'issue.unassigned', 'issue.updated'].includes(subscription.source.output)) {
          await watchIssues(stream.squadId, repository, subscription.source.connectionId)
          continue
        }
        const number = binding('pullRequest.number')
        if (
          typeof repository !== 'string' ||
          !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
          typeof number !== 'number' ||
          !Number.isSafeInteger(number) ||
          number <= 0
        )
          continue
        const [owner, repo] = repository.split('/')
        refs.push({ owner, repo, number, connectionId: subscription.source.connectionId })
      }
      for (const pr of refs) {
        const connection = await resolve(stream.squadId, pr.connectionId)
        if (!connection) continue
        const repoFullName = `${pr.owner}/${pr.repo}`.toLowerCase()
        const key = `${stream.squadId}:${connection.id}:${repoFullName}#${pr.number}`
        const presentation =
          stream.deliveryPresentation === true &&
          deliveryPullRequests(stream.metadata).some(
            (resource) =>
              resource.integration === 'github' &&
              resource.repository.toLowerCase() === repoFullName &&
              resource.number === pr.number
          )
        const existing = drafts.get(key)
        if (existing) {
          if (stream.status === 'active' || presentation) existing.active = true
          if (presentation) (existing.connection.configuration as GitHubPrPollingConfig).deliveryPresentation = true
          continue
        }
        const [owner, repo] = repoFullName.split('/')
        const configuration: GitHubPrPollingConfig = {
          owner,
          repo,
          number: pr.number,
          ...(presentation ? { deliveryPresentation: true } : {}),
        }
        drafts.set(key, {
          providerKey: 'github',
          resourceKey: `${stream.squadId}:${connection.id}:${repoFullName}#${pr.number}`,
          active: stream.status === 'active' || presentation,
          connection: {
            id: connection.id,
            squadId: stream.squadId,
            providerKey: 'github',
            adapterVersion: 1,
            configuration,
          },
        })
      }
    }

    // Trigger bindings declare repository interest before any stream exists.
    // Exact bindings need no lookup; wildcard bindings are expanded against the
    // selected connection's own visible repositories, never guessed.
    for (const squad of (await this.#options.listSquads?.()) ?? []) {
      const metadata = squad.metadata as {
        integrationTriggers?: IntegrationSubscription[]
        github?: { repo?: unknown }[]
      } | null
      if (Array.isArray(metadata?.github))
        for (const binding of metadata.github) await watchIssues(squad.id, binding?.repo)
      for (const rule of effectiveSquadEventRules(metadata, 'github')) {
        if (
          !rule.enabled ||
          rule.action.type === 'ignore' ||
          !['issue.assigned', 'issue.unassigned', 'issue.updated'].includes(rule.source.output)
        )
          continue
        const repository = rule.filters.repository || rule.match?.repository?.value
        if (repository) await watchIssues(squad.id, repository, rule.source.connectionId)
        else if (rule.filters.squadRouting && Array.isArray(metadata?.github))
          for (const binding of metadata.github) await watchIssues(squad.id, binding?.repo, rule.source.connectionId)
      }
    }

    const repositories = [
      ...new Set(
        [...drafts.values()].map((watch) => {
          const config = watch.connection.configuration as GitHubPrPollingConfig
          return `${config.owner}/${config.repo}`
        })
      ),
    ]
    if (repositories.length === 0) return [...issueWatches.values()]
    const deliveries = await this.#options.lastRealDeliveries('github', repositories)
    return [
      ...issueWatches.values(),
      ...[...drafts.values()].filter((watch) => {
        const config = watch.connection.configuration as GitHubPrPollingConfig
        const deliveredAt = deliveries.get(`${config.owner}/${config.repo}`)
        if (deliveredAt) config.lastVerifiedWebhookDeliveryAt = deliveredAt.toISOString()
        return config.deliveryPresentation === true || !deliveredAt || deliveredAt < cutoff
      }),
    ]
  }
}
