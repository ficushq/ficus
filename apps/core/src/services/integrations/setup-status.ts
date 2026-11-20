import type { IntegrationSetupStatus } from './plugin'
import type { IntegrationConnectionRecord } from './connection-repository'

/** Safe descriptions only: never put credential values or provider error bodies in the catalog. */
export function credentialSetupStatus(
  fields: readonly { label: string; required?: boolean; configured: boolean }[]
): IntegrationSetupStatus {
  const issues = fields
    .filter((field) => field.required && !field.configured)
    .map((field) => `${field.label} is required.`)
  return { state: issues.length ? 'needs_setup' : 'configured', issues }
}

export function connectionSetupStatus(
  connections: readonly (Pick<
    IntegrationConnectionRecord,
    'enabled' | 'authState' | 'healthState' | 'materialRevision' | 'validatedRevision'
  > & { credentialConfigured: boolean })[]
): IntegrationSetupStatus {
  if (!connections.length) return { state: 'needs_setup', issues: ['Connect an account to finish setup.'] }
  const enabled = connections.filter((connection) => connection.enabled)
  if (!enabled.length) return { state: 'needs_attention', issues: ['Enable at least one connected account.'] }
  const authenticated = enabled.filter(
    (connection) =>
      connection.credentialConfigured &&
      connection.authState === 'authenticated' &&
      connection.materialRevision === connection.validatedRevision
  )
  if (!authenticated.length)
    return { state: 'needs_attention', issues: ['Reconnect or validate an account to restore access.'] }
  if (!authenticated.some((connection) => connection.healthState === 'healthy'))
    return { state: 'needs_attention', issues: ['No connected account is healthy. Check account settings.'] }
  return { state: 'configured', issues: [] }
}

/**
 * Routing problems the connection status alone cannot show (Linear: a squad routes a team its agent
 * app cannot access). A configured integration with such problems needs attention; the issues name them.
 */
export function withRoutingIssues(status: IntegrationSetupStatus, issues: readonly string[]): IntegrationSetupStatus {
  if (!issues.length) return status
  return {
    state: status.state === 'configured' ? 'needs_attention' : status.state,
    issues: [...status.issues, ...issues],
  }
}
