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
  /** Scopes Ficus requested when the app was installed. */
  scopes: string[]
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

/** The catalog and settings view: everything but the scope list. */
export function safeLinearAppConfiguration(
  configuration: LinearAppConfiguration
): Omit<LinearAppConfiguration, 'scopes'> {
  const { scopes: _scopes, ...safe } = configuration
  return safe
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
