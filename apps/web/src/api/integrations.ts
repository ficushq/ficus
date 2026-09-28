import type {
  IntegrationAuthorizationStart,
  IntegrationDeviceAuthorizationStatus,
  GitHubCommitSigningStatus,
  GitHubRepositoryAccess,
} from '@ficus/shared'
import { apiFetch } from './client'

type ApiFetcher = <T>(path: string, init?: RequestInit) => Promise<T>

export const getGitHubRepositoryAccess = (connectionId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubRepositoryAccess>(`/integrations/connections/${connectionId}/github-repository-access`)

export const getGitHubCommitSigning = (connectionId: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubCommitSigningStatus>(`/integrations/connections/${connectionId}/github-commit-signing`)

/** Turn commit signing on (registers a key on the GitHub account) or off (removes it). */
export const setGitHubCommitSigning = (connectionId: string, enabled: boolean, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubCommitSigningStatus>(`/integrations/connections/${connectionId}/github-commit-signing`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })

export type IntegrationConnectionHealthState = 'unknown' | 'healthy' | 'degraded' | 'unreachable'

export interface IntegrationConnectionSummary {
  id: string
  providerKey: string
  displayName: string
  enabled: boolean
  healthState: IntegrationConnectionHealthState
}

export interface IntegrationConnection extends IntegrationConnectionSummary {
  isGlobalDefault?: boolean
  adapterVersion: number
  configuration: {
    version: 1
    apiBase?: string
    workspaceId?: string
    workspaceName?: string | null
    workspaceIcon?: string | null
    login?: string
    userId?: number
    botId?: string
  }
  credentialConfigured: boolean
  refreshAvailable?: boolean
  authState: 'pending' | 'authenticated' | 'invalid' | 'reauthorization_required'
  grantedScopes: string[]
  validatedAt: string | null
  validationExpiresAt: string | null
  lastErrorCode: string | null
  usage: {
    squadCount: number
    squads: { id: string; name: string }[]
  }
}

export interface IntegrationCatalogItem {
  setup?: { state: 'configured' | 'needs_setup' | 'needs_attention'; issues: string[] }
  connectionMode?: 'credential' | 'oauth2' | 'channel' | 'deployment' | 'service'

  enabled?: boolean
  key: string
  label: string
  description: string
  capabilities: string[]
  assignable: boolean
  authorization: { kind: string }
}

export const listIntegrationCatalog = (fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ integrations: IntegrationCatalogItem[] }>('/integrations/catalog')

export const setIntegrationEnabled = (provider: string, enabled: boolean, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ enabled: boolean }>(`/integrations/providers/${provider}/enabled`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })

export interface OAuthAppSettings {
  authorizationMode?: 'browser' | 'device'
  authority: 'local' | 'platform_broker'
  configured: boolean
  clientId: string | null
  callbackUrl: string
  requiredCapabilities: string[]
}

export const getIntegrationOAuthApp = (provider: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<OAuthAppSettings>(`/integrations/providers/${provider}/oauth-app`)

export const configureIntegrationOAuthApp = (
  provider: string,
  input: { clientId: string; clientSecret?: string; capabilitiesAcknowledged: true } | { useDefault: true },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<OAuthAppSettings>(`/integrations/providers/${provider}/oauth-app`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })

export const startIntegrationAuthorization = (
  provider: string,
  body: { returnTo: string; connectionId?: string },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<IntegrationAuthorizationStart>(`/integrations/providers/${provider}/authorization/start`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const pollIntegrationDeviceAuthorization = (id: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<IntegrationDeviceAuthorizationStatus>(`/integrations/providers/github/authorization/device/${id}/poll`, {
    method: 'POST',
  })

export const cancelIntegrationDeviceAuthorization = (id: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<void>(`/integrations/providers/github/authorization/device/${id}/cancel`, { method: 'POST' })

export const callbackIntegrationAuthorization = (
  provider: string,
  body: { state: string; code?: string; denied?: true },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<{ returnTo: string }>(`/integrations/providers/${provider}/authorization/callback`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const completeIntegrationAuthorization = (
  provider: string,
  body: { localFlowId: string; handle: string },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<{ returnTo: string }>(`/integrations/providers/${provider}/authorization/complete`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export interface SquadIntegrationSelection {
  scope?: { enabled: boolean; inheritDefault: boolean; globalDefaultId: string | null }
  providerKey: string
  assignment: IntegrationConnectionSummary | null
  connections: IntegrationConnectionSummary[]
  attached?: (IntegrationConnectionSummary & { isDefault: boolean })[]
  projection?: {
    status: 'pending' | 'installing' | 'ready' | 'degraded' | 'reconnect_required'
    lastErrorCode: string | null
  } | null
}

export const listIntegrationPool = (provider: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<IntegrationConnection[]>(`/integrations/connections?provider=${provider}`)

export const createIntegration = (
  body: { displayName: string; apiBase: string; credential: string },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<IntegrationConnection>('/integrations/connections', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'bigbrain',
      displayName: body.displayName,
      configuration: { version: 1, apiBase: body.apiBase },
      credential: body.credential,
    }),
  })

export const integrationAction = (
  id: string,
  action: 'validate' | 'enable' | 'disable',
  confirmAssigned = false,
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<IntegrationConnection | { enabled: false }>(`/integrations/connections/${id}/${action}`, {
    method: 'POST',
    body: JSON.stringify(action === 'disable' && confirmAssigned ? { confirmAssigned: true } : {}),
  })

export const refreshIntegration = (id: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ status: 'refreshed' | 'unchanged' | 'reauthorization_required' | 'degraded' }>(
    `/integrations/connections/${id}/refresh`,
    { method: 'POST' }
  )

export const removeIntegration = (id: string, confirmAssigned = false, fetcher: ApiFetcher = apiFetch) =>
  fetcher<void>(`/integrations/connections/${id}${confirmAssigned ? '?confirmAssigned=true' : ''}`, {
    method: 'DELETE',
  })

export const replaceIntegrationCredential = (
  id: string,
  credential: string,
  confirmAssigned = false,
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<IntegrationConnection>(`/integrations/connections/${id}/credential`, {
    method: 'PUT',
    body: JSON.stringify({ credential, ...(confirmAssigned ? { confirmAssigned: true } : {}) }),
  })

export const getSquadIntegrationSelection = (squadId: string, provider: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<SquadIntegrationSelection>(`/squads/${squadId}/integrations/${provider}`)

export const assignIntegration = (
  squadId: string,
  provider: string,
  connectionId: string,
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<IntegrationConnectionSummary>(`/squads/${squadId}/integrations/${provider}/assignment`, {
    method: 'PUT',
    body: JSON.stringify({ connectionId }),
  })

export const attachIntegration = (squadId: string, provider: string, connectionId: string, makeDefault = false) =>
  apiFetch<IntegrationConnectionSummary>(`/squads/${squadId}/integrations/${provider}/assignment`, {
    method: 'PUT',
    body: JSON.stringify({ connectionId, makeDefault }),
  })
export const detachIntegration = (squadId: string, provider: string, connectionId: string) =>
  apiFetch<void>(
    `/squads/${squadId}/integrations/${provider}/assignment?connectionId=${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' }
  )

export const retryIntegrationProjection = (squadId: string, provider: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ projection: { status: 'pending'; lastErrorCode: null } }>(
    `/squads/${squadId}/integrations/${provider}/projection/retry`,
    { method: 'POST' }
  )

export const unassignIntegration = (squadId: string, provider: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<void>(`/squads/${squadId}/integrations/${provider}/assignment`, { method: 'DELETE' })

export type ExternalExportStatus =
  | { state: 'disabled' }
  | { state: 'enabled'; connectionId: string; consentedAt: string; revokedAt: null; lastDeliveredAt?: string }
export const getExternalExport = (agentId: string) =>
  apiFetch<ExternalExportStatus>(`/agents/${agentId}/external-export`)
export const enableExternalExport = (agentId: string, connectionId: string) =>
  apiFetch<ExternalExportStatus>(`/agents/${agentId}/external-export`, {
    method: 'POST',
    body: JSON.stringify({ connectionId, consent: true, policyVersion: 1, projectionVersion: 1 }),
  })
export const disableExternalExport = (agentId: string) =>
  apiFetch<void>(`/agents/${agentId}/external-export`, { method: 'DELETE' })

export interface GitHubWebhookSettings {
  configured: boolean
  webhookUrl: string
}

export const getGitHubWebhookSettings = (fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubWebhookSettings>('/integrations/providers/github/webhook')

export const configureGitHubWebhook = (secret: string | null, fetcher: ApiFetcher = apiFetch) =>
  fetcher<GitHubWebhookSettings>('/integrations/providers/github/webhook', {
    method: 'PUT',
    body: JSON.stringify({ secret }),
  })

export const setIntegrationDefault = (provider: string, connectionId: string) =>
  apiFetch(`/integrations/providers/${provider}/default`, { method: 'PUT', body: JSON.stringify({ connectionId }) })
export const configureSquadIntegration = (
  squadId: string,
  provider: string,
  input: { enabled?: boolean; inheritDefault?: boolean }
) => apiFetch(`/squads/${squadId}/integrations/${provider}/scope`, { method: 'PUT', body: JSON.stringify(input) })

export const createLinearIntegration = (body: { displayName: string; credential: string }) =>
  apiFetch<IntegrationConnection>('/integrations/connections', {
    method: 'POST',
    body: JSON.stringify({ provider: 'linear', configuration: { version: 1 }, ...body }),
  })
export interface LinearWebhookSettings {
  configured: boolean
  webhookUrl: string
}
export const getLinearWebhookSettings = () => apiFetch<LinearWebhookSettings>('/integrations/providers/linear/webhook')
export const configureLinearWebhook = (secret: string | null) =>
  apiFetch<LinearWebhookSettings>('/integrations/providers/linear/webhook', {
    method: 'PUT',
    body: JSON.stringify({ secret }),
  })

export interface ChannelIntegrationSettings {
  fields: {
    key: string
    label: string
    secret: boolean
    multiline?: boolean
    placeholder: string
    configured: boolean
    required?: boolean
    managed?: boolean
    value?: string
  }[]
  /** Channel providers only: what the provider said the saved credential is. */
  identity?: Record<string, string> | null
  connection?: {
    id: string
    source: 'connection' | 'legacy'
    authState: string
    healthState: string
    lastErrorCode: string | null
  } | null
  enabled?: boolean
  setup?: { state: 'configured' | 'needs_setup' | 'needs_attention'; issues: string[] }
  webhook?: { url: string; secretConfigured: boolean; delivery?: 'direct' | 'relay' }
  routing?: { instanceId: string; defaultSquadId: string | null } | null
  routable?: boolean
  guilds?: { id: string; name: string }[]
  /** Slack only: the "Add to Slack" managed-app connection, offered alongside manual entry on hosted instances. */
  managedApp?: {
    available: boolean
    connection: {
      id: string
      authState: string
      healthState: string
      lastErrorCode: string | null
      teamId: string | null
      teamName: string | null
    } | null
    active: boolean
  }
}
export const slackAppManifestUrl = '/api/integrations/providers/slack/channel-settings/manifest'
export const getChannelIntegrationSettings = (provider: string) =>
  apiFetch<ChannelIntegrationSettings>(`/integrations/providers/${provider}/channel-settings`)
export const configureChannelIntegration = (provider: string, fields: Record<string, string | null>) =>
  apiFetch<ChannelIntegrationSettings>(`/integrations/providers/${provider}/channel-settings`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  })

export const getDeploymentIntegrationSettings = (provider: string) =>
  apiFetch<ChannelIntegrationSettings>(`/integrations/providers/${provider}/deployment-settings`)
export const configureDeploymentIntegration = (provider: string, fields: Record<string, string | null>) =>
  apiFetch<ChannelIntegrationSettings>(`/integrations/providers/${provider}/deployment-settings`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  })

export const getServiceIntegrationSettings = (provider: string) =>
  apiFetch<ChannelIntegrationSettings>(`/integrations/providers/${provider}/service-settings`)
export const configureServiceIntegration = (provider: string, fields: Record<string, string | null>) =>
  apiFetch<ChannelIntegrationSettings>(`/integrations/providers/${provider}/service-settings`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  })

export function getSquadGitAuthorDefaults(squadId: string): Promise<{
  github: { gitUserName: string; gitUserEmail: string; login: string } | null
  defaults: { gitUserName?: string; gitUserEmail?: string }
}> {
  return apiFetch(`/squads/${squadId}/integrations/github/author-defaults`)
}

export const listIntegrationOutputs = () =>
  apiFetch<import('@ficus/shared').IntegrationOutputDescriptor[]>('/integrations/outputs')
