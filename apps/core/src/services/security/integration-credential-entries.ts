import { parseOAuthCredential } from '../integrations/authorization/credential-bundle'

/** Short legacy material is not exact-matched; credential-pattern detection remains independent. */
export const MIN_INTEGRATION_CREDENTIAL_LENGTH = 8

export const INTEGRATION_CREDENTIAL_PREFIX = '__integration-credential:'

// Keep existing immutable GitHub app bindings and the Notion settings key at
// rest. Only matcher labels are namespaced; no credential migration is needed.
function isOAuthAppCredentialKey(key: string): boolean {
  return key === '__integration-oauth-app:notion' || /^__integration-oauth-app:github:client:[a-f0-9-]{36}$/.test(key)
}

export function isIntegrationCredentialKey(key: string): boolean {
  return key.startsWith(INTEGRATION_CREDENTIAL_PREFIX) || isOAuthAppCredentialKey(key)
}

type Entry = { key: string; value: string }

/**
 * Connection material is either an opaque manual token or a serialized secret
 * bundle. Register its leaves, never the JSON envelope. OAuth's expiry, client
 * binding and revision are public metadata, not credential material.
 */
export function integrationCredentialEntries(key: string, raw: string): Entry[] {
  if (isOAuthAppCredentialKey(key)) {
    try {
      const app: unknown = JSON.parse(raw)
      if (
        app &&
        typeof app === 'object' &&
        'clientSecret' in app &&
        typeof app.clientSecret === 'string' &&
        app.clientSecret.length >= MIN_INTEGRATION_CREDENTIAL_LENGTH
      ) {
        return [{ key: `${INTEGRATION_CREDENTIAL_PREFIX}${key.slice(2)}.clientSecret`, value: app.clientSecret }]
      }
    } catch {
      // Invalid legacy envelopes grant no authority and are never matched whole.
    }
    return []
  }
  // Opaque manual providers execute trimmed tokens. Normalize legacy padding
  // too, but preserve exact OAuth/channel leaf semantics inside bundles.
  let material: unknown
  try {
    const oauth = parseOAuthCredential(raw)
    material = { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken }
  } catch {
    try {
      const parsed: unknown = JSON.parse(raw)
      material = parsed !== null && typeof parsed === 'object' ? parsed : raw.trim()
    } catch {
      material = raw.trim()
    }
  }
  const entries: Entry[] = []
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string' && value.length >= MIN_INTEGRATION_CREDENTIAL_LENGTH)
      entries.push({ key: path, value })
    else if (value !== null && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) visit(child, `${path}.${name}`)
    }
  }
  visit(material, key)
  return entries
}
