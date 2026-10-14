import type {
  GitHubPersonalIdentityStatus,
  IntegrationAuthorizationStart,
  IntegrationDeviceAuthorizationStatus,
} from '@ficus/shared'
import { apiFetch } from './client'

type ApiFetcher = typeof apiFetch

/**
 * The signed-in person's own verified GitHub account. Distinct from squad integration accounts:
 * it never creates a connection, grants repository access or exposes a token to the browser.
 */
export const getGitHubIdentity = (fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubPersonalIdentityStatus>('/github-identity')

export const startGitHubIdentityLink = (returnTo: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<IntegrationAuthorizationStart>('/github-identity/authorization/start', {
    method: 'POST',
    body: JSON.stringify({ returnTo }),
  })

export const pollGitHubIdentityDevice = (id: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<IntegrationDeviceAuthorizationStatus>(
    `/github-identity/authorization/device/${encodeURIComponent(id)}/poll`,
    {
      method: 'POST',
      body: '{}',
    }
  )

export const cancelGitHubIdentityDevice = (id: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ canceled: true }>(`/github-identity/authorization/device/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: '{}',
  })

export const confirmGitHubIdentity = (proofId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<unknown>(`/github-identity/${encodeURIComponent(proofId)}/confirm`, { method: 'POST', body: '{}' })

export const unlinkGitHubIdentity = (fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ unlinked: true }>('/github-identity', { method: 'DELETE', body: '{}' })
