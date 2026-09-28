import type { WorkStreamDeliveryExplanation } from '@ficus/shared'

function pullRequestNumbers(numbers: number[]): string {
  const head = numbers.slice(0, 3).map((n) => `#${n}`)
  const rest = numbers.length - head.length
  return `${head.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
}

/**
 * A one-line delivery note from server-owned facts only, or null when they
 * don't say anything definite. Mirrors the web app's externalDeliveryLabel
 * (apps/web/src/lib/workStreamStatusPresentation.ts), which the farm can't
 * import; a candidate for the shared client packages.
 */
export function deliveryNote(explanation?: WorkStreamDeliveryExplanation): string | null {
  if (!explanation) return null
  const pullRequests = explanation.pullRequests ?? []
  if (pullRequests.length && pullRequests.every((pr) => pr.state === 'merged'))
    return pullRequests.length === 1 ? 'PR merged — finalizing delivery' : 'PRs merged — finalizing delivery'
  const { gates } = explanation
  if (gates?.draft === true) return null
  if (gates?.checksState === 'pending') return 'Awaiting CI'
  if (gates?.reviewDecision === 'required' || gates?.pendingHumanReview === true) return 'Awaiting review'
  if (gates?.mergeState === 'blocked') return 'Blocked by branch protection'
  const open = pullRequests.filter((pr) => pr.state === 'open').map((pr) => pr.number)
  if (open.length) return `Awaiting merge of ${pullRequestNumbers(open)}`
  return null
}
