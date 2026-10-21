/**
 * Setup status of the BigBrain integration on Ficus Cloud, derived from the shared vaults rather
 * than the generic connection pool. Pool rows are an implementation detail of managed vaults
 * (one read connection per vault, plus disabled rows of deleted vaults), so the generic "enable a
 * connected account" advice is meaningless here: the next step is always on a vault or a squad.
 *
 * Catalog text only: counts and fixed sentences, never vault names, IDs or provider messages.
 */
import type { IntegrationSetupStatus } from '../../plugin'
import { MANAGED_VAULT_READABLE_STATES } from './readable'

export interface ManagedVaultSetupInput {
  state: string
  readAccess: string
  /** Ficus's read connection: null before import, otherwise whether it is enabled. */
  connectionEnabled: boolean | null
  /** Squads the vault is attached to. */
  squadCount: number
  /** The last read-credential synchronization failed (Ficus retries with backoff). */
  syncFailed?: boolean
}

export const MANAGED_SETUP_ISSUES = {
  create: 'Create a shared vault.',
  provisioning: 'A shared vault is still being set up.',
  failed: 'A shared vault failed to set up. Retry it in its vault row.',
  readPending: 'Ficus read access to a shared vault is being set up.',
  readRevoked: 'Ficus read access to a shared vault is revoked. Reconnect it in its vault row so agents can read it.',
  readOff: 'Ficus cannot read a shared vault yet. Its vault row shows why.',
  attach: 'Attach a vault to a squad so its agents can read it.',
} as const

export function managedBigbrainSetupStatus(vaults: readonly ManagedVaultSetupInput[]): IntegrationSetupStatus {
  const live = vaults.filter((vault) => vault.state !== 'deleted' && vault.state !== 'deleting')
  if (!live.length) return { state: 'needs_setup', issues: [MANAGED_SETUP_ISSUES.create] }

  const attention = new Set<string>()
  const pending = new Set<string>()
  for (const vault of live) {
    if (vault.state === 'failed') attention.add(MANAGED_SETUP_ISSUES.failed)
    else if (!MANAGED_VAULT_READABLE_STATES.includes(vault.state)) pending.add(MANAGED_SETUP_ISSUES.provisioning)
    else if (vault.readAccess === 'revoked') attention.add(MANAGED_SETUP_ISSUES.readRevoked)
    else if (vault.readAccess === 'active' && vault.connectionEnabled !== true && vault.syncFailed)
      attention.add(MANAGED_SETUP_ISSUES.readOff)
    else if (vault.readAccess !== 'active' || vault.connectionEnabled === null)
      pending.add(MANAGED_SETUP_ISSUES.readPending)
    else if (!vault.connectionEnabled) attention.add(MANAGED_SETUP_ISSUES.readOff)
  }
  const readable = live.filter(
    (vault) =>
      MANAGED_VAULT_READABLE_STATES.includes(vault.state) &&
      vault.readAccess === 'active' &&
      vault.connectionEnabled === true
  )
  if (readable.length && !readable.some((vault) => vault.squadCount > 0)) attention.add(MANAGED_SETUP_ISSUES.attach)

  const issues = [...attention, ...pending]
  if (attention.size) return { state: 'needs_attention', issues }
  // Only work in progress and nothing readable yet: setup is not finished.
  if (!readable.length) return { state: 'needs_setup', issues }
  // A vault agents can read: another vault still being set up is not a setup problem.
  return { state: 'configured', issues: [] }
}
