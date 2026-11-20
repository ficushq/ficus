import { createLogger } from '../../../lib/infra/logger'
import type { IntegrationConnectionRepository } from '../connection-repository'
import { LinearInsufficientScopeError } from './scope-error'
import { LinearWriteError } from './write-api'

const log = createLogger('linear-scope-health')

/** The connection code an `Invalid scope` refusal records; the Linear card explains it. */
export const LINEAR_INSUFFICIENT_SCOPE_CODE = 'insufficient_scope'

type ScopeHealthRepository = Pick<IntegrationConnectionRepository, 'get' | 'markReauthorizationRequired'>

/** Whether an error from a Linear call is Linear's `Invalid scope` refusal. */
export function isLinearInsufficientScope(error: unknown): boolean {
  return (
    error instanceof LinearInsufficientScopeError ||
    (error instanceof LinearWriteError && error.code === LINEAR_INSUFFICIENT_SCOPE_CODE)
  )
}

/**
 * Linear refused a call because the app's token lacks a scope (`Invalid scope: \`write\` required`).
 * Retrying cannot help, and a session that is never acknowledged looks unresponsive in Linear, so
 * the app connection is marked **Reconnect required** with `insufficient_scope`: the Linear card
 * tells an admin to reconnect, which asks Linear to update the installation's scopes.
 *
 * Only app (`oauth2`) connections are marked; a personal API key's permissions are managed in Linear,
 * and reconnecting cannot change them. Returns whether the connection is an app connection that now
 * needs reconnect. Never throws.
 */
export async function markLinearScopeMissing(
  connectionId: string,
  dependencies: { repository?: ScopeHealthRepository } = {}
): Promise<boolean> {
  try {
    const repository = dependencies.repository ?? (await import('../runtime')).integrationConnectionRepository
    const connection = await repository.get(connectionId)
    if (!connection || connection.providerKey !== 'linear' || connection.authorizationKind !== 'oauth2') return false
    if (connection.authState === 'reauthorization_required') return true
    const marked = await repository.markReauthorizationRequired({
      id: connection.id,
      materialRevision: connection.materialRevision,
      code: LINEAR_INSUFFICIENT_SCOPE_CODE,
    })
    if (marked) log.warn(`Linear connection ${connection.id} lacks a required scope; it needs Reconnect`)
    return true
  } catch (error) {
    log.warn(`Marking a Linear connection for reconnect failed: ${error instanceof Error ? error.name : 'error'}`)
    return false
  }
}
