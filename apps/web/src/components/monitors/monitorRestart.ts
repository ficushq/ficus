import type { Monitor } from '@ficus/shared'

/**
 * Compact restart summary for monitor tables: the policy, how many times the
 * command was relaunched after a sandbox loss, and whether a relaunch is
 * pending right now.
 */
export function monitorRestartLabel(monitor: Monitor): string {
  if (monitor.restartPolicy !== 'on-loss') return 'never'
  const parts = ['on-loss']
  const restarts = monitor.restartCount ?? 0
  if (restarts > 0) parts.push(`${restarts} restart${restarts === 1 ? '' : 's'}`)
  if (monitor.nextRestartAt) parts.push('relaunch pending')
  return parts.join(' · ')
}
