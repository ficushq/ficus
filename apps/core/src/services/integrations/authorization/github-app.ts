import { FICUS_GITHUB_APP_CLIENT_ID } from '@ficus/shared/oauth-providers/github/app'
import type { OAuthClientBinding } from '@ficus/shared/oauth-providers/types'
import { parseOAuthClientBinding } from './credential-bundle'

const SETTINGS_KEY = '__integration-oauth-app:github'
interface AppStore {
  get(key: string): string | undefined
  set(key: string, value: string, actor?: string): Promise<void>
}

export interface GitHubAppCredentials {
  clientId: string
  clientSecret: string
  clientBinding: OAuthClientBinding
}

export function resolveGitHubAppCredentials(
  store: Pick<AppStore, 'get'>,
  binding?: OAuthClientBinding
): GitHubAppCredentials | undefined {
  let selected: OAuthClientBinding
  try {
    selected = binding
      ? parseOAuthClientBinding(binding)
      : store.get(SETTINGS_KEY)
        ? parseOAuthClientBinding(JSON.parse(store.get(SETTINGS_KEY)!))
        : { clientId: FICUS_GITHUB_APP_CLIENT_ID }
    if (!selected.credentialRef) return { clientId: selected.clientId, clientSecret: '', clientBinding: selected }
    const raw = store.get(selected.credentialRef)
    if (!raw) return undefined
    const record = JSON.parse(raw)
    if (record.clientId !== selected.clientId || typeof record.clientSecret !== 'string' || !record.clientSecret)
      return undefined
    return { clientId: selected.clientId, clientSecret: record.clientSecret, clientBinding: selected }
  } catch {
    return undefined
  }
}

export async function configureGitHubApp(input: unknown, store: AppStore, actor: string): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  const row = input as Record<string, unknown>
  if (
    Object.keys(row).some(
      (key) => !['clientId', 'clientSecret', 'capabilitiesAcknowledged', 'useDefault'].includes(key)
    )
  )
    throw invalid()
  if (row.useDefault === true) {
    if (Object.keys(row).length !== 1) throw invalid()
    await store.set(SETTINGS_KEY, JSON.stringify({ clientId: FICUS_GITHUB_APP_CLIENT_ID }), actor)
    return
  }
  if (
    row.useDefault !== undefined ||
    row.capabilitiesAcknowledged !== true ||
    typeof row.clientId !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,512}$/.test(row.clientId) ||
    (row.clientSecret !== undefined && (typeof row.clientSecret !== 'string' || row.clientSecret.length > 16_384))
  )
    throw invalid()
  const binding: OAuthClientBinding = { clientId: row.clientId }
  if (row.clientSecret) {
    binding.credentialRef = `__integration-oauth-app:github:client:${crypto.randomUUID()}`
    // Write immutable material before publishing the pointer. Existing tokens
    // keep their issuing app reference through future settings changes.
    await store.set(
      binding.credentialRef,
      JSON.stringify({ clientId: row.clientId, clientSecret: row.clientSecret }),
      actor
    )
  }
  await store.set(SETTINGS_KEY, JSON.stringify(binding), actor)
}

function invalid(): Error {
  return new Error('Invalid OAuth application settings')
}
