import { missingLinearAppScopes } from './client'

/**
 * The non-secret configuration of a Linear agent app connection. Version 1 is
 * the API-key shape (`{ version: 1 }`); version 2 is the app installed in one
 * workspace. Tokens live only in the credential bundle.
 */
export interface LinearAppConfiguration {
  version: 2
  mode: 'app'
  organizationId: string
  organizationName: string
  organizationUrlKey: string
  appUserId: string
  appUserName: string
  /**
   * Scopes Linear reported in the token response when the app was installed or reconnected. A
   * connection installed before Ficus read them (or through a broker that does not pass them on)
   * holds the scopes Ficus requested instead.
   */
  scopes: string[]
}

/**
 * What the Linear adapter returns as a grant's configuration: the scopes Linear granted, carried
 * through the OAuth broker unchanged (the broker treats configuration as opaque). Core reads the app
 * identity afterwards and stores these scopes in {@link LinearAppConfiguration}.
 */
export interface LinearGrantScopes {
  version: 'linear-grant'
  scopes: string[]
}

/** The granted scopes from a grant's configuration, or `null` when it carries none or is malformed. */
export function parseLinearGrantScopes(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).sort().join() !== 'scopes,version' ||
    row.version !== 'linear-grant' ||
    !Array.isArray(row.scopes) ||
    row.scopes.length > 32 ||
    !row.scopes.every((scope) => typeof scope === 'string' && /^[a-z:_-]{1,64}$/i.test(scope))
  )
    return null
  return [...(row.scopes as string[])]
}

const KEYS = [
  'appUserId',
  'appUserName',
  'mode',
  'organizationId',
  'organizationName',
  'organizationUrlKey',
  'scopes',
  'version',
].join()

export function parseLinearAppConfiguration(value: unknown): LinearAppConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).sort().join() !== KEYS ||
    row.version !== 2 ||
    row.mode !== 'app' ||
    !isId(row.organizationId) ||
    !isText(row.organizationName, 512) ||
    !isUrlKey(row.organizationUrlKey) ||
    !isId(row.appUserId) ||
    !isText(row.appUserName, 512) ||
    !Array.isArray(row.scopes) ||
    row.scopes.length > 32 ||
    !row.scopes.every((scope) => typeof scope === 'string' && /^[a-z:_-]{1,64}$/i.test(scope))
  )
    throw invalid()
  return {
    version: 2,
    mode: 'app',
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationUrlKey: row.organizationUrlKey,
    appUserId: row.appUserId,
    appUserName: row.appUserName,
    scopes: [...(row.scopes as string[])],
  }
}

/**
 * The catalog and settings view: everything but the scope list, plus the app scopes the connection
 * lacks (`missingScopes`), so the settings card can ask an admin to reconnect and grant them.
 */
export function safeLinearAppConfiguration(
  configuration: LinearAppConfiguration
): Omit<LinearAppConfiguration, 'scopes'> & { missingScopes: string[] } {
  const { scopes, ...safe } = configuration
  return { ...safe, missingScopes: missingLinearAppScopes(scopes) }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value)
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.length <= max && !/[\r\n\0]/.test(value)
}

function isUrlKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function invalid(): Error {
  return new Error('Invalid Linear app configuration')
}
