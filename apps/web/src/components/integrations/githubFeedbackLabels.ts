import type { GitHubAccountIdentity, GitHubFeedbackListItem, GitHubTrustOrigin } from '@ficus/shared'
import type { ModerateGitHubFeedback } from '@ficus/shared'

type Action = ModerateGitHubFeedback['action']

const KIND_LABELS: Record<NonNullable<GitHubFeedbackListItem['objectKind']>, string> = {
  issue: 'Issue',
  pull_request: 'Pull request',
  issue_comment: 'Comment',
  review: 'Review',
  review_comment: 'Review comment',
}

const REASON_LABELS: Record<string, string> = {
  untrusted_author: 'Author is not trusted in this squad',
  unknown_identity: 'Author or event could not be identified',
  previously_held: 'An earlier version of this event was held',
  stale_observation: 'Observed out of order; a newer version may exist',
  ambiguous_observation: 'Who made this change could not be verified',
  content_unavailable: 'Content could not be read from GitHub',
  trust_revoked: 'Author was trusted when sent, but trust was removed before delivery',
  filter_disabled: 'Released when the squad turned author filtering off',
  trusted_author: 'Author is trusted',
  recipient_waiting: 'Waiting for the recipient to be ready',
  no_current_recipient: 'No current recipient matches this event',
  work_stream_ended: 'The work stream it was routed to has ended',
  release_routing_failed: 'Routing failed; will retry',
  transient: 'Temporary delivery failure; will retry',
}

export const RELEASE_LABELS: Record<GitHubFeedbackListItem['releaseState'], string> = {
  held: 'Held',
  ready: 'Queued for release',
  retry: 'Retrying',
  retained: 'Waiting for recipient',
  delivered: 'Delivered',
  obsolete: 'No longer deliverable',
}

export const ACTION_DONE: Record<Action, string> = {
  allow_once: 'allowed once',
  deny: 'denied',
  allow_trust: 'allowed, and their authors are now trusted in this squad',
}

export const reasonLabel = (reason: string | null) => (reason ? (REASON_LABELS[reason] ?? reason) : null)
export const kindLabel = (row: Pick<GitHubFeedbackListItem, 'objectKind'>) =>
  row.objectKind ? KIND_LABELS[row.objectKind] : 'Event'
export const authorLabel = (author: GitHubAccountIdentity | null) =>
  author ? `@${author.login}${author.accountType === 'Bot' ? ' (bot)' : ''}` : 'Unknown author'
export const target = (row: Pick<GitHubFeedbackListItem, 'repository' | 'number' | 'isPullRequest'>) =>
  row.repository ? `${row.repository}${row.number ? ` ${row.isPullRequest ? 'PR' : 'issue'} #${row.number}` : ''}` : ''
export const formatTime = (value: string) => new Date(value).toLocaleString()
/** Only canonical GitHub links are ever rendered as links. */
export const safeGitHubUrl = (url: string | null) => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.href : null
  } catch {
    return null
  }
}

export function trustOriginLabel(origin: GitHubTrustOrigin) {
  return origin.kind === 'manual'
    ? 'Added to this squad’s trusted authors'
    : 'Linked Ficus user who can update this squad'
}
