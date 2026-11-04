import { Permissions, permissionMatches } from '@ficus/shared'

/**
 * Monitor tokens: the credential a background monitor's command runs with.
 *
 * Each monitor launch mints an agent token bound to the monitor
 * (`agent_tokens.monitor_id`), expiring at the monitor's deadline and revoked
 * when it ends, so `gh` and other integration CLIs inside a monitor work
 * exactly as they do in the agent's foreground shell. The token is READ-ONLY:
 *
 * - its permissions are the creating agent's read permissions plus
 *   `integrations:use` ({@link narrowToMonitorPermissions});
 * - over HTTP it may only read, and fetch integration credentials
 *   ({@link isMonitorTokenRequestAllowed}), because many write routes
 *   authorize by the agent identity itself rather than by a permission;
 * - it never opens a WebSocket, terminal or log stream (resolveTokenContext
 *   rejects it unless the HTTP identity middleware asks for it).
 */

/** The one write a monitor needs: exchanging its token for integration credentials. */
export const MONITOR_INTEGRATION_PERMISSION = Permissions.INTEGRATIONS_USE

/** A permission whose action only reads: `res:read`, `res:read-x`, `res:sub:read`. */
export function isReadPermission(permission: string): boolean {
  const action = permission.split(':').at(-1) ?? ''
  return permission.includes(':') && (action === 'read' || action.startsWith('read-'))
}

function isMonitorPermission(permission: string): boolean {
  return isReadPermission(permission) || permission === MONITOR_INTEGRATION_PERMISSION
}

const CATALOG: readonly string[] = Object.values(Permissions).filter(
  (permission) => permission !== Permissions.WILDCARD && isMonitorPermission(permission)
)

/**
 * What a monitor token holds, given what its agent holds: only read
 * permissions and `integrations:use`. Wildcards (`*`, `res:*`) are expanded
 * into the concrete catalog permissions they cover, since keeping a wildcard
 * would also grant every write it matches.
 */
export function narrowToMonitorPermissions(held: readonly string[]): string[] {
  const narrowed = new Set<string>()
  for (const permission of held) {
    if (permission === Permissions.WILDCARD || permission.endsWith(':*')) {
      for (const candidate of CATALOG) if (permissionMatches(permission, candidate)) narrowed.add(candidate)
    } else if (isMonitorPermission(permission)) {
      narrowed.add(permission)
    }
  }
  return [...narrowed]
}

const INTEGRATION_ENVIRONMENT_PATH = /^\/api\/squads\/[^/]+\/integrations\/[^/]+\/execute-environment\/?$/

/** HTTP requests a monitor token may make: reads, and the integration credential exchange. */
export function isMonitorTokenRequestAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (verb === 'GET' || verb === 'HEAD') return true
  return verb === 'POST' && INTEGRATION_ENVIRONMENT_PATH.test(path)
}
