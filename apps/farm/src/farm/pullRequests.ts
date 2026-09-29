import { deliveryPullRequests, type ResolvedTrackedResource } from '@ficus/shared'

/**
 * A work stream's delivery pull requests, primary first, the way the web app
 * lists them (apps/web/src/lib/workStreamGithub.ts): legacy `metadata.github`
 * entries count only when the stream has an explicit `codeHost` binding.
 */
export function workStreamPullRequests(metadata: unknown): ResolvedTrackedResource[] {
  const record =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null
  const codeHostBound = record?.codeHost !== undefined
  return deliveryPullRequests(metadata).filter((pr) => codeHostBound || pr.source !== 'delivery')
}
