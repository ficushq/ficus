import { isPlatformManaged } from '../../secrets/managed'
import type { OAuthAuthority } from './authority'
import type { OAuthClientBinding } from '@ficus/shared/oauth-providers/types'
import { configureGitHubApp, resolveGitHubAppCredentials } from './github-app'

export const SELF_HOSTED_OAUTH_APP_KEY = {
  notion: '__integration-oauth-app:notion',
} as const

const REQUIRED_CAPABILITIES = ['read_content', 'insert_content', 'update_content'] as const

interface OAuthAppSecretStore {
  get(key: string): string | undefined
  set(key: string, value: string, actor?: string): Promise<void>
}

interface HistoricalOAuthAppSecretStore {
  get(key: string): string | undefined
  refreshKey(key: string): Promise<void>
}

interface SelfHostedOAuthAppV1 {
  version: 1
  clientId: string
  clientSecret: string
  capabilitiesAcknowledged: true
}

export interface ResolvedOAuthClientCredentials {
  clientId: string
  clientSecret: string
  clientBinding?: OAuthClientBinding
}

export interface SafeOAuthAppSettings {
  authority: OAuthAuthority
  configured: boolean
  clientId: string | null
  callbackUrl: string
  requiredCapabilities: readonly string[]
  authorizationMode?: 'device' | 'browser'
}

export function resolveOAuthClientCredentials(
  providerKey: string,
  store: OAuthAppSecretStore,
  binding?: OAuthClientBinding
): ResolvedOAuthClientCredentials | undefined {
  if (providerKey === 'github') return isPlatformManaged() ? undefined : resolveGitHubAppCredentials(store, binding)
  requireNotion(providerKey)
  if (isPlatformManaged()) return undefined
  const configured = parseSelfHostedOAuthApp(store.get(SELF_HOSTED_OAUTH_APP_KEY.notion))
  return configured ? { clientId: configured.clientId, clientSecret: configured.clientSecret } : undefined
}

/** Job-gated resolver for historical local revocation only. */
export async function resolveHistoricalLocalOAuthClientCredentials(
  providerKey: string,
  store: HistoricalOAuthAppSecretStore,
  binding?: OAuthClientBinding
): Promise<ResolvedOAuthClientCredentials | undefined> {
  if (providerKey === 'github') {
    if (!binding) return undefined
    if (binding.credentialRef) await store.refreshKey(binding.credentialRef)
    return resolveGitHubAppCredentials(store, binding)
  }
  requireNotion(providerKey)
  await store.refreshKey(SELF_HOSTED_OAUTH_APP_KEY.notion)
  const configured = parseSelfHostedOAuthApp(store.get(SELF_HOSTED_OAUTH_APP_KEY.notion))
  return configured ? { clientId: configured.clientId, clientSecret: configured.clientSecret } : undefined
}

export function getOAuthAppSettings(
  providerKey: string,
  store: OAuthAppSecretStore,
  callbackUrl: string
): SafeOAuthAppSettings {
  if (providerKey === 'github') {
    const credentials = isPlatformManaged() ? undefined : resolveGitHubAppCredentials(store)
    return {
      authority: isPlatformManaged() ? 'platform_broker' : 'local',
      configured: isPlatformManaged() || credentials !== undefined,
      clientId: credentials?.clientId ?? null,
      callbackUrl,
      authorizationMode: isPlatformManaged() || credentials?.clientSecret ? 'browser' : 'device',
      requiredCapabilities: [
        'Contents: write',
        'Pull requests: write',
        'Issues: write',
        'Actions: write',
        'Workflows: write',
        'Checks: read',
        'Commit statuses: read',
        'SSH signing keys: write (account permission, for commit signing)',
      ],
    }
  }
  requireNotion(providerKey)
  if (isPlatformManaged()) {
    return {
      authority: 'platform_broker',
      configured: true,
      clientId: null,
      callbackUrl,
      requiredCapabilities: [...REQUIRED_CAPABILITIES],
    }
  }
  const credentials = resolveOAuthClientCredentials(providerKey, store)
  return {
    authority: 'local',
    configured: credentials !== undefined,
    clientId: credentials?.clientId ?? null,
    callbackUrl,
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
  }
}

export async function configureOAuthApp(
  providerKey: string,
  input: unknown,
  store: OAuthAppSecretStore,
  actor: string,
  callbackUrl: string
): Promise<SafeOAuthAppSettings> {
  if (providerKey === 'github') {
    if (isPlatformManaged()) throw new Error('OAuth application credentials are platform-managed')
    await configureGitHubApp(input, store, actor)
    return getOAuthAppSettings(providerKey, store, callbackUrl)
  }
  requireNotion(providerKey)
  if (isPlatformManaged()) throw new Error('OAuth application credentials are platform-managed')
  const bundle = parseSelfHostedOAuthAppInput(input)
  await store.set(SELF_HOSTED_OAUTH_APP_KEY.notion, JSON.stringify(bundle), actor)
  return getOAuthAppSettings(providerKey, store, callbackUrl)
}

function parseSelfHostedOAuthApp(raw: string | undefined): SelfHostedOAuthAppV1 | undefined {
  if (raw === undefined) return undefined
  try {
    return parseSelfHostedOAuthAppValue(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function parseSelfHostedOAuthAppInput(value: unknown): SelfHostedOAuthAppV1 {
  if (!isRecord(value)) throw invalidSettings()
  const keys = Object.keys(value).sort()
  if (keys.join() !== ['capabilitiesAcknowledged', 'clientId', 'clientSecret'].join()) throw invalidSettings()
  return parseSelfHostedOAuthAppValue({ version: 1, ...value })
}

function parseSelfHostedOAuthAppValue(value: unknown): SelfHostedOAuthAppV1 {
  if (!isRecord(value)) throw invalidSettings()
  const keys = Object.keys(value).sort()
  if (keys.join() !== ['capabilitiesAcknowledged', 'clientId', 'clientSecret', 'version'].join()) {
    throw invalidSettings()
  }
  if (
    value.version !== 1 ||
    !isClientId(value.clientId) ||
    !isClientSecret(value.clientSecret) ||
    value.capabilitiesAcknowledged !== true
  ) {
    throw invalidSettings()
  }
  return {
    version: 1,
    clientId: value.clientId.trim(),
    clientSecret: value.clientSecret,
    capabilitiesAcknowledged: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isClientId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length >= 1 && normalized.length <= 512
}

function isClientSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 16_384
}

function requireNotion(providerKey: string): void {
  if (providerKey !== 'notion') throw new Error('Unsupported OAuth application provider')
}

function invalidSettings(): Error {
  return new Error('Invalid OAuth application settings')
}
