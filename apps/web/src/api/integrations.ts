import type {
  IntegrationAuthorizationStart,
  IntegrationDeviceAuthorizationStatus,
  GitHubCommitSigningStatus,
  GitHubSquadCommitSigning,
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
    version: 1 | 2
    bindingId?: string
    bindingFingerprint?: string
    vaultPath?: string
    executablePath?: string
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
  availability?: { available: boolean; reason?: string }
  setup?: { state: 'configured' | 'needs_setup' | 'needs_attention'; issues: string[] }
  connectionMode?: 'local' | 'managed' | 'credential' | 'oauth2' | 'channel' | 'deployment' | 'service'

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
  /** GitHub only: which attached accounts sign this squad's commits. */
  commitSigning?: GitHubSquadCommitSigning
  projection?: {
    status: 'pending' | 'installing' | 'ready' | 'degraded' | 'reconnect_required'
    lastErrorCode: string | null
  } | null
}

export const listIntegrationPool = (provider: string, fetcher: ApiFetcher = apiFetch) =>
  fetcher<IntegrationConnection[]>(`/integrations/connections?provider=${provider}`)

export interface BigbrainLocalBindings {
  state: 'available' | 'setup_required' | 'unsupported_host' | 'invalid_configuration' | 'binding_unavailable'
  bindings: { id: string; label: string; vaultPath: string; executablePath: string }[]
}
export const getBigbrainLocalBindings = (fetcher: ApiFetcher = apiFetch) =>
  fetcher<BigbrainLocalBindings>('/integrations/providers/bigbrain/local-bindings')
/** Management view of one managed shared BigBrain vault (never credentials or host paths). */
export interface ManagedBigbrainVault {
  vaultId: string
  displayName: string
  /** Null once the owner's Ficus account was deleted. */
  ownerUserId: string | null
  isOwner: boolean
  state: 'requested' | 'provisioning' | 'ready' | 'degraded' | 'failed' | 'deleting' | 'deleted'
  readAccess: 'pending' | 'active' | 'revoked'
  desiredGeneration: number
  appliedGeneration: number
  upstreamVaultId: string | null
  origin: string | null
  connectionId: string | null
  lastErrorCode: string | null
  retryable: boolean
  /** The host operation still to run, if any (Core records it; the server applies it shortly). */
  pendingAction: 'create' | 'rename' | 'read-revoke' | 'read-reconnect' | 'delete' | null
  /** Whether the most recent server backup included this vault. */
  backup: 'unknown' | 'included' | 'excluded'
  /** Squads that lose read access if this vault is deleted. */
  assignedSquads: { id: string; name: string }[]
  updatedAt: string
}
/** SECRET: a single-use owner device link. Keep in component state only; never cache or log. */
export interface ManagedBigbrainOwnerInvite {
  inviteUrl: string
  expiresAt: string
}
const MANAGED_VAULTS = '/integrations/providers/bigbrain/shared-vaults'
const vaultPath = (vaultId: string) => `${MANAGED_VAULTS}/${encodeURIComponent(vaultId)}`
export const listManagedBigbrainVaults = (fetcher: ApiFetcher = apiFetch) =>
  fetcher<{ vaults: ManagedBigbrainVault[] }>(MANAGED_VAULTS).then((value) => value.vaults)
export const createManagedBigbrainVault = (
  input: { requestId: string; displayName: string; ownerHandle: string },
  fetcher: ApiFetcher = apiFetch
) => fetcher<ManagedBigbrainVault>(MANAGED_VAULTS, { method: 'POST', body: JSON.stringify(input) })
export const renameManagedBigbrainVault = (
  vaultId: string,
  input: { requestId: string; expectedGeneration: number; displayName: string },
  fetcher: ApiFetcher = apiFetch
) => fetcher<ManagedBigbrainVault>(vaultPath(vaultId), { method: 'PATCH', body: JSON.stringify(input) })
export const retryManagedBigbrainVault = (
  vaultId: string,
  input: { requestId: string; expectedGeneration: number },
  fetcher: ApiFetcher = apiFetch
) => fetcher<ManagedBigbrainVault>(`${vaultPath(vaultId)}/retry`, { method: 'POST', body: JSON.stringify(input) })
export const setManagedBigbrainReadAccess = (
  vaultId: string,
  input: { requestId: string; expectedGeneration: number; action: 'revoke' | 'reconnect' },
  fetcher: ApiFetcher = apiFetch
) => fetcher<ManagedBigbrainVault>(`${vaultPath(vaultId)}/read-access`, { method: 'POST', body: JSON.stringify(input) })
export const deleteManagedBigbrainVault = (
  vaultId: string,
  input: { requestId: string; expectedGeneration: number; confirmedVaultId: string; confirmedName: string },
  fetcher: ApiFetcher = apiFetch
) => fetcher<ManagedBigbrainVault>(vaultPath(vaultId), { method: 'DELETE', body: JSON.stringify(input) })
export const createManagedBigbrainOwnerInvite = (
  vaultId: string,
  input: { requestId: string; expectedGeneration: number },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<ManagedBigbrainOwnerInvite>(`${vaultPath(vaultId)}/owner-invite`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

/** One-click local BigBrain setup: what Core detected on its own host (never client paths). */
export interface BigbrainSetupVault {
  id: string
  label: string
  vaultPath: string
  source: 'bigbrain_default' | 'bigbrain_fallback' | 'existing_binding' | 'chosen_folder'
}
export interface BigbrainLocalSetupState {
  state: 'ready' | 'unsupported_host' | 'executable_missing' | 'executable_untrusted'
  reason?: string
  hostPlatform: 'darwin' | 'linux' | 'other'
  executablePath?: string
  vaults: BigbrainSetupVault[]
  bindingsFile: 'none' | 'managed' | 'unmanaged' | 'invalid'
  connectionName: string
  access: readonly string[]
}
export interface BigbrainLocalSetupResult {
  connection: IntegrationConnection
  vault: BigbrainSetupVault
  bindingsFile: 'created' | 'updated' | 'unchanged'
  connectionOutcome: 'created' | 'updated' | 'reused'
  enabled: boolean
}
const LOCAL_SETUP = '/integrations/providers/bigbrain/local-setup'
export const getBigbrainLocalSetup = (fetcher: ApiFetcher = apiFetch) => fetcher<BigbrainLocalSetupState>(LOCAL_SETUP)
export const connectLocalBigbrain = (
  input: ({ vaultId: string } | { vaultPath: string }) & { replaceExisting?: boolean },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<BigbrainLocalSetupResult>(LOCAL_SETUP, {
    method: 'POST',
    body: JSON.stringify({ ...input, confirmVaultAccess: true }),
  })

export const createLocalBigbrainIntegration = (
  input: { bindingId: string; displayName: string },
  fetcher: ApiFetcher = apiFetch
) =>
  fetcher<IntegrationConnection>('/integrations/providers/bigbrain/local-connections', {
    method: 'POST',
    body: JSON.stringify(input),
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
