import {
  extractGitHubIssueDispatchFact,
  isGitHubIssueDispatchFact,
  type GitHubIssueDispatchFact,
} from '../../squad-activity/github-issue-fact'
import {
  extractGitHubPrDispatchFact,
  isGitHubPrDispatchFact,
  type GitHubPrDispatchFact,
} from '../../squad-activity/github-pr-fact'
import type { VerifiedIngressEvent } from '../types'

/**
 * Which polled GitHub event belongs to which watch.
 *
 * Extracted from the polling runtime so the decision is testable on its own:
 * it is pure, it decides what an `activity_squad_ids`-owned Activity receipt is
 * ever allowed to say, and a watch that quietly stops claiming its own events
 * is invisible in an integration test (it just projects nothing).
 */
export type GitHubDispatchWatch = { providerKey: string; connection: { configuration: unknown } }
export type GitHubDispatchFact = GitHubPrDispatchFact | GitHubIssueDispatchFact

const watchConfiguration = (watch: GitHubDispatchWatch): Record<string, unknown> | null =>
  watch.providerKey === 'github' && watch.connection.configuration && typeof watch.connection.configuration === 'object'
    ? (watch.connection.configuration as Record<string, unknown>)
    : null

/** `owner/repo`, lowercased — null unless the configuration names both. */
const watchRepository = (configuration: Record<string, unknown>) => {
  const owner = typeof configuration.owner === 'string' ? configuration.owner.trim().toLowerCase() : ''
  const repo = typeof configuration.repo === 'string' ? configuration.repo.trim().toLowerCase() : ''
  return owner && repo ? `${owner}/${repo}` : null
}

/**
 * An issue-events watch is scoped to a whole repository, not to one resource:
 * it discovers issues that have no Ficus stream yet, so the repository is the
 * only identity the watch can assert. A PR watch, by contrast, names its exact
 * change request, so its facts are matched on repository AND number.
 */
export const githubIssueWatchRepository = (watch: GitHubDispatchWatch): string | null => {
  const configuration = watchConfiguration(watch)
  return configuration?.kind === 'issue-events' ? watchRepository(configuration) : null
}

export function githubPrFactMatchesWatch(fact: GitHubPrDispatchFact, watch: GitHubDispatchWatch): boolean {
  const configuration = watchConfiguration(watch)
  if (!configuration || configuration.kind === 'issue-events') return false
  const repository = watchRepository(configuration)
  const number = configuration.number
  return Boolean(
    repository && Number.isSafeInteger(number) && fact.repository === repository && fact.prNumber === number
  )
}

/** The fact a polled event contributes to this watch, or null when it is not the watch's. */
export function extractGitHubDispatchFact(
  providerKey: string,
  event: VerifiedIngressEvent,
  watch: GitHubDispatchWatch
): GitHubDispatchFact | null {
  const issueRepository = githubIssueWatchRepository(watch)
  if (issueRepository) {
    const issue = extractGitHubIssueDispatchFact(providerKey, event)
    return issue && issue.repository === issueRepository ? issue : null
  }
  const pr = extractGitHubPrDispatchFact(providerKey, event)
  return pr && githubPrFactMatchesWatch(pr, watch) ? pr : null
}

/** Symmetric with `extractGitHubDispatchFact`: does this completed dispatch belong to this watch? */
export function validateGitHubDispatchFact(dispatch: { eventFact: unknown }, watch: GitHubDispatchWatch): boolean {
  const issueRepository = githubIssueWatchRepository(watch)
  if (issueRepository)
    return isGitHubIssueDispatchFact(dispatch.eventFact) && dispatch.eventFact.repository === issueRepository
  return isGitHubPrDispatchFact(dispatch.eventFact) && githubPrFactMatchesWatch(dispatch.eventFact, watch)
}
