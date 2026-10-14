import type { GitHubFeedbackContent, IntegrationOutputFact } from '@ficus/shared'
import type { IntegrationOutputAuthority } from '../outputs/types'
import type { VerifiedIngressEvent } from '../types'
import { githubApiGet } from '../../github/api-client'
import { githubContentIdentity, githubNativeId } from './feedback-envelope'

type Get = (path: string, squadId: string, connectionId: string) => Promise<unknown>
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const repositoryName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value)
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Missing provider IDs may only be enriched through the observing squad's assigned access. */
export async function resolveGitHubFeedbackRepository(
  event: VerifiedIngressEvent,
  authority: IntegrationOutputAuthority,
  get: Get = githubApiGet
): Promise<VerifiedIngressEvent> {
  const payload = record(event.payload),
    repository = record(payload.repository)
  if (authority.kind !== 'connection' || githubNativeId(repository.id) || !repositoryName(repository.full_name))
    return event
  try {
    const current = record(
      await get(`/repos/${repository.full_name.toLowerCase()}`, authority.squadId, authority.connectionId)
    )
    if (
      !githubNativeId(current.id) ||
      typeof current.full_name !== 'string' ||
      current.full_name.toLowerCase() !== repository.full_name.toLowerCase()
    )
      return event
    return { ...event, payload: { ...payload, repository: { ...repository, id: current.id } } }
  } catch {
    return event
  }
}

/**
 * Bounded authenticated verification of the supplied snapshot, never replacement text or editor proof.
 * Use only after capture's live exact-source authorization; githubApiGet independently checks assignment.
 * A transfer/rename mismatch or disappearance is uncertainty, not approval or inferred identity.
 */
export async function readCurrentGitHubFeedback(
  source: { authority: IntegrationOutputAuthority; fact: IntegrationOutputFact },
  content: GitHubFeedbackContent,
  get: Get = githubApiGet
): Promise<{ contentHash: string } | null> {
  if (
    source.authority.kind !== 'connection' ||
    !content.repositoryId ||
    !content.nativeId ||
    !content.delivery ||
    !/^[1-9][0-9]*$/.test(content.repositoryId) ||
    !/^[1-9][0-9]*$/.test(content.nativeId)
  )
    return null
  const { squadId, connectionId } = source.authority
  try {
    const repo = record(await get(`/repositories/${content.repositoryId}`, squadId, connectionId))
    if (
      githubNativeId(repo.id) !== content.repositoryId ||
      !repositoryName(repo.full_name) ||
      repo.full_name.toLowerCase() !== content.delivery.data.repository
    )
      return null
    const number = record(content.delivery.data.pullRequest ?? content.delivery.data.issue).number
    if (!Number.isSafeInteger(number) || number <= 0) return null
    const root = `/repos/${repo.full_name.toLowerCase()}`
    const path =
      content.objectKind === 'issue_comment'
        ? `${root}/issues/comments/${content.nativeId}`
        : content.objectKind === 'review_comment'
          ? `${root}/pulls/comments/${content.nativeId}`
          : content.objectKind === 'review'
            ? `${root}/pulls/${number}/reviews/${content.nativeId}`
            : `${root}/${content.objectKind === 'pull_request' ? 'pulls' : 'issues'}/${number}`
    const native = record(await get(path, squadId, connectionId))
    // Native ID is not enough: prove this content belongs to the intended parent resource.
    const parentUrl = new URL(text(native.html_url))
    const parentKind =
      content.objectKind === 'issue' || (content.objectKind === 'issue_comment' && !content.delivery.data.pullRequest)
        ? 'issues'
        : 'pull'
    if (
      parentUrl.origin !== 'https://github.com' ||
      parentUrl.username ||
      parentUrl.password ||
      parentUrl.search ||
      parentUrl.pathname.toLowerCase() !== `/${repo.full_name.toLowerCase()}/${parentKind}/${number}`
    )
      return null
    const expected = record(content.delivery.data.content)
    if (
      githubNativeId(native.id) !== content.nativeId ||
      !content.author ||
      githubContentIdentity(native.user)?.accountId !== content.author.accountId ||
      text(native.body) !== expected.body ||
      (['issue', 'pull_request'].includes(content.objectKind) && text(native.title) !== expected.title) ||
      (content.objectKind === 'review' && text(native.state).toLowerCase() !== content.delivery.data.state) ||
      (content.objectKind === 'review_comment' &&
        (text(native.path) !== expected.path || (native.line ?? native.original_line ?? null) !== expected.line))
    )
      return null
    if (
      content.providerVersion &&
      (typeof native.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(native.updated_at)) ||
        new Date(native.updated_at).toISOString() !== content.providerVersion)
    )
      return null
    return { contentHash: content.contentHash }
  } catch {
    return null
  }
}
