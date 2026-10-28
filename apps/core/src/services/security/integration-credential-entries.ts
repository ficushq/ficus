import { parseOAuthCredential } from '../integrations/authorization/credential-bundle'

/** Short legacy material is not exact-matched; credential-pattern detection remains independent. */
export const MIN_INTEGRATION_CREDENTIAL_LENGTH = 8

export const INTEGRATION_CREDENTIAL_PREFIX = '__integration-credential:'

type Entry = { key: string; value: string }

/**
 * Connection material is either an opaque manual token or a serialized secret
 * bundle. Register its leaves, never the JSON envelope. OAuth's expiry, client
 * binding and revision are public metadata, not credential material.
 */
export function integrationCredentialEntries(key: string, raw: string): Entry[] {
  let material: unknown
  try {
    const oauth = parseOAuthCredential(raw)
    material = { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken }
  } catch {
    try {
      const parsed: unknown = JSON.parse(raw)
      material = parsed !== null && typeof parsed === 'object' ? parsed : raw
    } catch {
      material = raw
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
