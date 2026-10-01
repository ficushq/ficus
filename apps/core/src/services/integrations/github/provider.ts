import { GitHubDependabotPoller, type GitHubDependabotPollingConfig } from './dependabot-poller'
import { GitHubIssueEventPoller, type GitHubIssueEventPollingConfig } from './issue-event-poller'
import { githubOutputAdapter } from '../outputs/github'
import type { IntegrationProvider, RuntimeConnection } from '../types'
import { GitHubPrEventPoller, type GitHubPollingFetch, type GitHubPrPollingConfig } from './event-poller'

export type GitHubPollingConfig = GitHubPrPollingConfig | GitHubIssueEventPollingConfig | GitHubDependabotPollingConfig

export type GitHubPollingCredentialResolver = (
  connection: RuntimeConnection<GitHubPollingConfig>
) => Promise<string | undefined>

export class GitHubPollingProvider implements IntegrationProvider<GitHubPollingConfig> {
  readonly key = 'github'
  readonly outputs = githubOutputAdapter
  readonly adapterVersion = 1
  readonly capabilities: IntegrationProvider<GitHubPollingConfig>['capabilities']

  constructor(resolveCredential: GitHubPollingCredentialResolver, fetchImpl?: GitHubPollingFetch) {
    const pr = new GitHubPrEventPoller({ resolveCredential, fetch: fetchImpl })
    const issues = new GitHubIssueEventPoller(resolveCredential, fetchImpl)
    const dependabot = new GitHubDependabotPoller(resolveCredential, fetchImpl)
    this.capabilities = {
      event_polling: {
        poll: (connection, cursor, signal) =>
          'kind' in connection.configuration && connection.configuration.kind === 'dependabot-alerts'
            ? dependabot.poll(connection as RuntimeConnection<GitHubDependabotPollingConfig>, cursor, signal)
            : 'kind' in connection.configuration && connection.configuration.kind === 'issue-events'
              ? issues.poll(connection as RuntimeConnection<GitHubIssueEventPollingConfig>, cursor, signal)
              : pr.poll(connection as RuntimeConnection<GitHubPrPollingConfig>, cursor, signal),
      },
    }
  }

  parseConfig(value: unknown): GitHubPollingConfig {
    const issueConfig = value as Partial<GitHubIssueEventPollingConfig | GitHubDependabotPollingConfig> | null
    if (issueConfig?.kind === 'issue-events' || issueConfig?.kind === 'dependabot-alerts') {
      if (
        typeof issueConfig.owner !== 'string' ||
        !/^[a-zA-Z0-9_.-]+$/.test(issueConfig.owner) ||
        typeof issueConfig.repo !== 'string' ||
        !/^[a-zA-Z0-9_.-]+$/.test(issueConfig.repo)
      )
        throw new Error('Invalid GitHub polling configuration')
      return { kind: issueConfig.kind, owner: issueConfig.owner, repo: issueConfig.repo }
    }
    const config = value as Partial<GitHubPrPollingConfig> | null
    if (
      !config ||
      typeof config.owner !== 'string' ||
      !config.owner.trim() ||
      typeof config.repo !== 'string' ||
      !config.repo.trim() ||
      !Number.isInteger(config.number) ||
      Number(config.number) <= 0
    ) {
      throw new Error('Invalid GitHub polling configuration')
    }
    return {
      owner: config.owner.trim(),
      repo: config.repo.trim(),
      number: Number(config.number),
      // Synthetic delivery watches pass through this parser at the plugin boundary.
      // Preserve explicit false; ignore malformed optional values rather than coercing them.
      ...(typeof config.deliveryPresentation === 'boolean'
        ? { deliveryPresentation: config.deliveryPresentation }
        : {}),
      ...(typeof config.lastVerifiedWebhookDeliveryAt === 'string'
        ? { lastVerifiedWebhookDeliveryAt: config.lastVerifiedWebhookDeliveryAt }
        : {}),
    }
  }

  async validate(context: { credential: string }) {
    return context.credential ? { ok: true as const, grantedScopes: [] } : { ok: false as const, code: 'invalid_auth' }
  }
}
