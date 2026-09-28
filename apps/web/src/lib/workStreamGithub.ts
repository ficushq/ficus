import { codeHostReferenceSchema, deliveryPullRequests, type ResolvedTrackedResource } from '@ficus/shared'

export interface GithubRepositoryInfo {
  repository: string
  repositoryUrl: string
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null
}

/**
 * All pull requests a work stream designates as delivery change requests, primary (codeHost-bound)
 * first, then tracked PRs flagged `delivery`. Canonical model only: PRs attach through an explicit
 * `codeHost.changeRequest` binding or `tracked` entries, and the legacy `metadata.github` shape is
 * intentionally not supported by web surfaces anymore.
 */
export function workStreamPullRequests(metadata: unknown): ResolvedTrackedResource[] {
  // deliveryPullRequests resolves the codeHost-bound PR through the shared resolver, which also
  // maps a legacy `github` shape onto the same 'delivery' source. Without an explicit `codeHost`
  // key those entries are legacy-only, so they are dropped here.
  const codeHostBound = metadataRecord(metadata)?.codeHost !== undefined
  return deliveryPullRequests(metadata).filter((pullRequest) => codeHostBound || pullRequest.source !== 'delivery')
}

/**
 * GitHub repository identity for detail surfaces: the explicit `codeHost` binding (which may be
 * repo-only), else the primary delivery pull request's repository. Non-github bindings carry no
 * GitHub identity, and legacy `metadata.github` is not read.
 */
export function workStreamGithubRepository(metadata: unknown): GithubRepositoryInfo | null {
  const record = metadataRecord(metadata)
  const binding = record && record.codeHost !== undefined ? codeHostReferenceSchema.safeParse(record.codeHost) : null
  if (binding?.success) {
    if (binding.data.integration !== 'github') return null
    return { repository: binding.data.repository, repositoryUrl: githubRepositoryUrl(binding.data.repository) }
  }
  const primary = workStreamPullRequests(metadata)[0]
  if (primary?.integration !== 'github') return null
  return { repository: primary.repository, repositoryUrl: githubRepositoryUrl(primary.repository) }
}

function githubRepositoryUrl(repository: string): string {
  return repository.startsWith('http') ? repository : `https://github.com/${repository}`
}
