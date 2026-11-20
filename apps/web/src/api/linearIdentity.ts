import { apiFetch } from './client'

type ApiFetcher = typeof apiFetch

export interface LinearIdentityStatus {
  linked: Array<{ organizationId: string; linearUserId: string; linkedAt: string }>
}

/**
 * The signed-in person's own linked Linear accounts. Linking records who they are in a Linear
 * workspace so their exact answers in a Linear agent session count as their Ficus answers; Ficus
 * keeps no Linear token for it.
 */
export const getLinearIdentity = (fetcher: ApiFetcher = apiFetch) => fetcher<LinearIdentityStatus>('/linear-identity')

export const startLinearIdentityLink = (returnTo: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ authorizationUrl: string }>('/linear-identity/authorization/start', {
    method: 'POST',
    body: JSON.stringify({ returnTo }),
  })

export const unlinkLinearIdentity = (organizationId?: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ unlinked: boolean }>('/linear-identity', {
    method: 'DELETE',
    body: JSON.stringify(organizationId ? { organizationId } : {}),
  })
