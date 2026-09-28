import { createHash } from 'node:crypto'
import {
  trackedResourceKey,
  type BranchChangeRequestCandidate,
  type IntegrationSubscription,
  type ResolvedTrackedResource,
} from '@ficus/shared'
import { resolveGitHubRelayAssignment } from './resolve-connection'
import type { CodeHostingAdapter } from '../code-hosting/registry'
import type { TrackedResourceAdapter } from '../tracked-resources/registry'
import { githubApiGet } from '../../github/api-client'

const ISSUE_EVENTS = ['assigned', 'unassigned', 'updated', 'comment']
const PULL_REQUEST_EVENTS = [
  'updated',
  'merged',
  'closed',
  'review_requested',
  'reviewed',
  'comment',
  'review_comment',
  'ci_completed',
]

const validateRepository = (repository: string) => /^[\w.-]+\/[\w.-]+$/.test(repository)

/** Ids hash the resource identity, so adding or removing a link never renumbers the others. */
function trackedSubscriptions(resource: ResolvedTrackedResource): IntegrationSubscription[] {
  const hash = createHash('sha256').update(trackedResourceKey(resource)).digest('hex').slice(0, 12)
  const repository = resource.repository.trim().toLowerCase()
  const issue = resource.kind === 'issue'
  return (issue ? ISSUE_EVENTS : PULL_REQUEST_EVENTS).map((event) => ({
    id: `tracked-${hash}-${event.replaceAll('_', '-')}`,
    source: {
      integration: 'github',
      output: `${issue ? 'issue' : 'pull_request'}.${event}`,
      version: 1,
      ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
    },
    match: {
      repository: { value: repository },
      [issue ? 'issue.number' : 'pullRequest.number']: { value: resource.number },
    },
    deliver: { to: 'delivery-owner' as const, whenInactive: 'retain' as const },
  }))
}

/** Identity and authorization for links this squad follows; the delivery binding is separate. */
export const githubTrackedResourceAdapter: TrackedResourceAdapter = {
  integration: 'github',
  validateRepository,
  matchFields: (kind) => ({
    repository: 'repository',
    number: kind === 'issue' ? 'issue.number' : 'pullRequest.number',
  }),
  trackedSubscriptions,
  async authorizeSquad(squadId, connectionId) {
    return !!(await resolveGitHubRelayAssignment(squadId, connectionId))
  },
}

/** The pull requests a head branch carries, in provider-neutral form. `head=owner:branch` only matches the owner's namespace, never forks. */
function branchChangeRequests(pulls: Array<Record<string, any>>): BranchChangeRequestCandidate[] {
  return pulls.flatMap((pull) => {
    const number = pull?.number
    const headBranch = pull?.head?.ref
    const baseBranch = pull?.base?.ref
    if (!Number.isSafeInteger(number) || number <= 0 || typeof headBranch !== 'string' || !headBranch) return []
    if (typeof baseBranch !== 'string' || !baseBranch) return []
    const url =
      typeof pull?.html_url === 'string' && pull.html_url.startsWith('https://github.com/') ? pull.html_url : undefined
    const headRepository =
      typeof pull?.head?.repo?.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pull.head.repo.full_name)
        ? pull.head.repo.full_name.toLowerCase()
        : undefined
    return [
      {
        number,
        // The list endpoint returns the simple shape: no `merged` field, but `merged_at` is set
        // for merged pull requests. Reading only `merged` would classify every merged delivery
        // pull request as closed-unmerged and drop it.
        merged: pull?.merged === true || (typeof pull?.merged_at === 'string' && pull.merged_at !== ''),
        state: String(pull?.state ?? ''),
        headBranch,
        baseBranch,
        ...(url ? { url } : {}),
        ...(headRepository ? { headRepository } : {}),
        ...(typeof pull?.head?.sha === 'string' && pull.head.sha ? { headSha: pull.head.sha } : {}),
      },
    ]
  })
}

export const githubCodeHostingAdapter: CodeHostingAdapter = {
  integration: 'github',
  validateRepository,
  async changeRequest(reference, squadId) {
    if (!reference.changeRequest) return null
    const pr = await githubApiGet<{ merged: boolean; base: { ref: string }; head: { ref: string; sha?: string } }>(
      `/repos/${reference.repository}/pulls/${reference.changeRequest.number}`,
      squadId,
      reference.connectionId
    )
    return pr
      ? {
          merged: pr.merged,
          headBranch: pr.head.ref,
          baseBranch: pr.base.ref,
          ...(pr.head.sha ? { headSha: pr.head.sha } : {}),
        }
      : null
  },
  async changeRequestsByHead(reference, squadId, headBranch) {
    const [owner] = reference.repository.split('/')
    if (!owner || !headBranch) return []
    const pulls = await githubApiGet<Array<Record<string, any>>>(
      `/repos/${reference.repository}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&state=all`,
      squadId,
      reference.connectionId
    )
    return pulls === null ? null : branchChangeRequests(pulls)
  },
  async containsCommit(reference, squadId, base, commit) {
    const comparison = await githubApiGet<{ status: string }>(
      `/repos/${reference.repository}/compare/${encodeURIComponent(base)}...${commit}`,
      squadId,
      reference.connectionId
    )
    return !!comparison && ['identical', 'behind'].includes(comparison.status)
  },
  subscriptions(reference) {
    return PULL_REQUEST_EVENTS.map((event) => ({
      id: `code-host-${event.replaceAll('_', '-')}`,
      source: {
        integration: 'github',
        output: `pull_request.${event}`,
        version: 1,
        ...(reference.connectionId ? { connectionId: reference.connectionId } : {}),
      },
      match: {
        repository: { value: reference.repository },
        'pullRequest.number': { value: reference.changeRequest!.number },
      },
      deliver: { to: 'delivery-owner' as const, whenInactive: 'retain' as const },
    }))
  },
}
