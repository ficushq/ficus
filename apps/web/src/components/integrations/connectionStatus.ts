import type { IntegrationConnection } from '../../api/integrations'
import type { BadgeColor } from '../Badge'

export interface ConnectionStatus {
  label: string
  color: BadgeColor
}

/**
 * One status word for a connection, most urgent first. `finding` is a provider's own problem that
 * outranks health once the connection is enabled and signed in (Linear's missing permissions, say).
 */
export function connectionStatus(
  connection: Pick<IntegrationConnection, 'enabled' | 'authState' | 'healthState'>,
  finding?: ConnectionStatus | null
): ConnectionStatus {
  if (!connection.enabled) return { label: 'Disabled', color: 'neutral' }
  if (connection.authState === 'reauthorization_required') return { label: 'Reconnect required', color: 'attention' }
  if (connection.authState === 'invalid') return { label: 'Invalid credentials', color: 'danger' }
  if (connection.authState === 'pending') return { label: 'Pending', color: 'neutral' }
  if (finding) return finding
  if (connection.healthState === 'healthy') return { label: 'Healthy', color: 'success' }
  if (connection.healthState === 'degraded') return { label: 'Degraded', color: 'attention' }
  if (connection.healthState === 'unreachable') return { label: 'Unreachable', color: 'danger' }
  return { label: 'Not checked yet', color: 'neutral' }
}

/** The second sentence of a Disable or Remove confirmation: how many squads lose access, if any. */
function connectionImpact(squadCount: number, providerLabel: string): string {
  if (squadCount <= 0) return ''
  return ` ${squadCount} ${squadCount === 1 ? 'squad loses' : 'squads lose'} ${providerLabel} access.`
}

/** The question a Disable or Remove confirmation asks, naming the connection and the squads it affects. */
export function connectionConfirmQuestion(
  kind: 'disable' | 'remove',
  title: string,
  squadCount: number,
  providerLabel: string
): string {
  return `${kind === 'remove' ? 'Remove' : 'Disable'} the ${title} connection?${connectionImpact(squadCount, providerLabel)}`
}
