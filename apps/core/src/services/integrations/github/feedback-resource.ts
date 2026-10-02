import { githubApiGet } from '../../github/api-client'
import type { IntegrationOutputFact } from '@ficus/shared'
import type { IntegrationOutputAuthority } from '../outputs/types'
import { githubNativeId } from './feedback-envelope'

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const number = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

/**
 * Assigned-access resource proof, NOT approval of provider text. At most three fixed-endpoint reads,
 * all outside transactions. No repository enumeration, sender inference, token override or raw URL fetch.
 * Historic allow-once snapshots need current access to the same object, not substitution of its new body.
 */
export async function verifyGitHubOutputResource(source: {
  authority: IntegrationOutputAuthority
  fact: IntegrationOutputFact
}): Promise<{ repositoryAuthorized: boolean; nativeAuthorized: boolean }> {
  let repositoryAuthorized = false
  const result = (nativeAuthorized = false) => ({ repositoryAuthorized, nativeAuthorized })
  if (source.authority.kind !== 'connection' || !source.authority.connectionRevision) return result()
  const { squadId, connectionId } = source.authority
  const content = source.fact.github?.content,
    status = source.fact.github?.status
  const repositoryId = content?.repositoryId ?? githubNativeId(status?.data.repositoryId)
  const repository = source.fact.data.repository
  if (
    (repositoryId !== null && !/^[1-9][0-9]*$/.test(repositoryId)) ||
    typeof repository !== 'string' ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)
  )
    return result()
  try {
    const repo = record(
      await githubApiGet(repositoryId ? `/repositories/${repositoryId}` : `/repos/${repository}`, squadId, connectionId)
    )
    if (
      !githubNativeId(repo.id) ||
      (repositoryId && githubNativeId(repo.id) !== repositoryId) ||
      typeof repo.full_name !== 'string' ||
      repo.full_name.toLowerCase() !== repository.toLowerCase()
    )
      return result()
    repositoryAuthorized = true
    // An assigned repository lookup can authorize a quarantine, never enrich/guess missing IDs
    // or confer native-resource authority on an unknown object.
    if (!repositoryId) return result()
    const root = `/repos/${repository.toLowerCase()}`
    if (source.fact.output === 'dependabot_alert.updated') {
      // Keep security authority independent of bot trust, and never infer webhook provenance from sender.
      if (source.fact.github?.observation?.kind !== 'webhook' || !status) return result()
      const alertNumber = record(status.data.alert).number
      if (!number(alertNumber) || record(status.data.alert).externalId !== `${repositoryId}:${alertNumber}`)
        return result()
      const alert = record(await githubApiGet(`${root}/dependabot/alerts/${alertNumber}`, squadId, connectionId))
      return result(alert.number === alertNumber)
    }
    const data = status?.data ?? content?.delivery?.data
    const parent = record(data?.pullRequest ?? data?.issue),
      parentNumber = parent.number
    if (!number(parentNumber)) return result()
    const isPR = !!data?.pullRequest
    const kind = content?.objectKind
    const nativeId = content?.nativeId
    if (!status && (!nativeId || !/^[1-9][0-9]*$/.test(nativeId))) return result()
    const path = status
      ? `${root}/${isPR ? 'pulls' : 'issues'}/${parentNumber}`
      : kind === 'issue_comment'
        ? `${root}/issues/comments/${nativeId}`
        : kind === 'review_comment'
          ? `${root}/pulls/comments/${nativeId}`
          : kind === 'review'
            ? `${root}/pulls/${parentNumber}/reviews/${nativeId}`
            : `${root}/${kind === 'pull_request' ? 'pulls' : 'issues'}/${parentNumber}`
    const native = record(await githubApiGet(path, squadId, connectionId))
    if (!githubNativeId(native.id) || (!status && githubNativeId(native.id) !== nativeId)) return result()
    if (!status && content?.author && githubNativeId(record(native.user).id) !== content.author.accountId)
      return result()
    const url = new URL(String(native.html_url))
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.pathname.toLowerCase() !== `/${repository.toLowerCase()}/${isPR ? 'pull' : 'issues'}/${parentNumber}`
    )
      return result()
    if (
      status &&
      content?.objectKind === 'pull_request' &&
      content.nativeId &&
      githubNativeId(native.id) !== content.nativeId
    )
      return result()
    if (source.fact.output === 'pull_request.ci_completed') {
      const ci = record(status?.data.ci)
      if (!/^[1-9][0-9]*$/.test(String(ci.runId))) return result()
      const run = record(await githubApiGet(`${root}/actions/runs/${ci.runId}`, squadId, connectionId))
      return result(
        githubNativeId(run.id) === ci.runId &&
          githubNativeId(run.workflow_id) === ci.workflowId &&
          run.pull_requests?.some(
            (pr: any) => pr.number === parentNumber && githubNativeId(pr.base?.repo?.id) === repositoryId
          ) === true
      )
    }
    return result(true)
  } catch {
    return result()
  }
}
