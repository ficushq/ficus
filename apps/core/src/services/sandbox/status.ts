import type { SandboxToolchainConfig } from '@ficus/shared'
import type { Squad } from '../../entities/Squad'
import { fingerprintToolchain, isEmptyToolchain, type ManagedToolchainConfig } from './toolchain/config'
import { getProvisionState, loadDesiredToolchain, type ProvisionState } from './toolchain/state'

export type ToolchainStatusPayload = Pick<ProvisionState, 'status' | 'desiredFingerprint'> &
  Partial<Omit<ProvisionState, 'status' | 'desiredFingerprint'>>

/** Injectable seams for {@link resolveToolchainStatus}; production defaults read the database. */
export interface ResolveToolchainStatusDeps {
  loadDesiredToolchain(squadId: string, config: SandboxToolchainConfig | undefined): Promise<ManagedToolchainConfig>
  getProvisionState(sandboxId: string, desiredFingerprint: string): Promise<ProvisionState | undefined>
}

const defaultDeps: ResolveToolchainStatusDeps = { loadDesiredToolchain, getProvisionState }

/**
 * The managed-toolchain half of a sandbox status payload, or `undefined` when
 * nothing is declared for the squad — by the squad OR by its integrations.
 *
 * The desired fingerprint is computed from the same effective toolchain the
 * provisioner realizes (see {@link loadDesiredToolchain}), so `pending` here
 * means the provisioner has genuinely not caught up, not that two callers
 * hashed two different views of the declaration.
 */
export async function resolveToolchainStatus(
  sandboxId: string,
  squad: Squad | null | undefined,
  deps: ResolveToolchainStatusDeps = defaultDeps
): Promise<ToolchainStatusPayload | undefined> {
  if (!squad) return undefined
  const desired = await deps.loadDesiredToolchain(squad.id, squad.toolchainConfig)
  if (isEmptyToolchain(desired)) return undefined
  const desiredFingerprint = fingerprintToolchain(desired)
  return (
    (await deps.getProvisionState(sandboxId, desiredFingerprint)) ?? {
      status: 'pending',
      desiredFingerprint,
    }
  )
}

export function mergeSandboxStatus<T extends { devboxReady?: boolean }>(
  physical: T,
  toolchain?: ToolchainStatusPayload
): Omit<T, 'devboxReady'> & { toolchain?: ToolchainStatusPayload; devboxReady?: boolean } {
  if (!toolchain) return physical
  return {
    ...physical,
    toolchain,
    devboxReady: physical.devboxReady !== false && toolchain.status === 'ready',
  }
}
