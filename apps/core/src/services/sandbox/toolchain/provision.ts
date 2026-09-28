import type { SandboxToolchainStatus } from '@ficus/shared'
import { KeyedSerialQueue } from '../../../lib/infra/inflight'
import { createLogger } from '../../../lib/infra/logger'
import type { ISandboxManager, SandboxOptions } from '../types'
import { fingerprintToolchain, isEmptyToolchain, normalizeToolchain, renderManagedDevbox } from './config'
import {
  clearCurrentToolchainState,
  markActivationRequired,
  markDesired,
  markFailed,
  markReady,
  markStage,
  readToolchainReconcileSnapshot,
  withProvisionLease,
  type ToolchainErrorCode,
  type ToolchainReconcileSnapshot,
} from './state'

const log = createLogger('toolchain')

const SAFE_MESSAGES: Record<ToolchainErrorCode, string> = {
  devbox_unavailable: 'Devbox is unavailable in this sandbox',
  install_failed: 'Package installation failed',
  setup_failed: 'Toolchain setup failed',
  activation_failed: 'Toolchain activation failed',
  readiness_failed: 'Toolchain readiness check failed',
  timeout: 'Toolchain provisioning timed out; the sandbox may be overloaded',
  unknown: 'Toolchain provisioning failed',
}

export class ToolchainAdapterError extends Error {
  constructor(
    readonly code: ToolchainErrorCode,
    readonly exitCode?: number,
    cause?: unknown
  ) {
    super(SAFE_MESSAGES[code], cause === undefined ? undefined : { cause })
  }
}

export class ToolchainProvisioningError extends Error {
  constructor(readonly code: ToolchainErrorCode) {
    super(SAFE_MESSAGES[code])
  }
}

interface StateKey {
  sandboxId: string
  squadId: string
  desiredFingerprint: string
}

export interface ToolchainProvisionDeps {
  readSnapshot(squadId: string, sandboxId: string): Promise<ToolchainReconcileSnapshot>
  markDesired(input: StateKey): Promise<void>
  markActivationRequired(input: StateKey): Promise<void>
  markStage(input: StateKey & { status: 'installing' | 'running_setup' }): Promise<void>
  markReady(input: StateKey): Promise<void>
  markFailed(input: StateKey & { errorCode: ToolchainErrorCode; exitCode?: number }): Promise<void>
  clearState(sandboxId: string, squadId: string): Promise<void>
  withLease<T>(sandboxId: string, reconcile: () => Promise<T>): Promise<T>
}

const defaultDeps: ToolchainProvisionDeps = {
  readSnapshot: readToolchainReconcileSnapshot,
  markDesired,
  markActivationRequired,
  markStage,
  markReady,
  markFailed,
  clearState: clearCurrentToolchainState,
  withLease: withProvisionLease,
}

function isClean(snapshot: ToolchainReconcileSnapshot): boolean {
  return isEmptyToolchain(snapshot.config) && !snapshot.provision && !snapshot.activation
}

async function reconcileLocked(
  manager: ISandboxManager,
  sandboxId: string,
  opts: SandboxOptions,
  squadId: string,
  snapshot: ToolchainReconcileSnapshot,
  deps: ToolchainProvisionDeps
): Promise<void> {
  if (isClean(snapshot)) return
  const normalized = snapshot.config ? normalizeToolchain(snapshot.config) : undefined
  const configured = normalized && !isEmptyToolchain(normalized)
  const fingerprint = configured ? fingerprintToolchain(normalized) : undefined
  const stateKey = { sandboxId, squadId, desiredFingerprint: fingerprint ?? '' }

  if (!manager.reconcileToolchain) {
    if (!configured) return
    await deps.markDesired(stateKey)
    await deps.markFailed({ ...stateKey, errorCode: 'devbox_unavailable' })
    throw new ToolchainProvisioningError('devbox_unavailable')
  }

  if (configured) {
    await deps.markDesired(stateKey)
    await deps.markActivationRequired(stateKey)
  }

  try {
    await manager.reconcileToolchain(sandboxId, opts, {
      config: configured ? normalized : undefined,
      fingerprint,
      devboxJson: configured ? renderManagedDevbox(normalized) : undefined,
      initHooks: normalized?.initHooks,
      readiness: normalized?.readiness,
      reportStage: (status: Extract<SandboxToolchainStatus, 'installing' | 'running_setup'>) =>
        deps.markStage({ ...stateKey, status }),
    })
    if (configured) await deps.markReady(stateKey)
    else await deps.clearState(sandboxId, squadId)
  } catch (error) {
    const classified =
      error instanceof ToolchainAdapterError ? error : new ToolchainAdapterError('unknown', undefined, error)
    // The recorded state keeps only a safe code; the cause is what an operator
    // needs to tell an overloaded box from a broken toolchain.
    log.warn(`Toolchain provisioning failed for ${sandboxId} (${classified.code})`, classified.cause ?? error)
    await deps.markFailed({ ...stateKey, errorCode: classified.code, exitCode: classified.exitCode })
    throw new ToolchainProvisioningError(classified.code)
  }
}

export type ToolchainProvisioner = (
  manager: ISandboxManager,
  sandboxId: string,
  opts: SandboxOptions,
  squadId: string,
  deps?: ToolchainProvisionDeps
) => Promise<void>

export function createToolchainProvisioner(): ToolchainProvisioner {
  const queues = new KeyedSerialQueue()
  return (manager, sandboxId, opts, squadId, deps = defaultDeps) =>
    queues.run(sandboxId, async () => {
      const preflight = await deps.readSnapshot(squadId, sandboxId)
      if (isClean(preflight)) return
      await deps.withLease(sandboxId, async () => {
        const locked = await deps.readSnapshot(squadId, sandboxId)
        await reconcileLocked(manager, sandboxId, opts, squadId, locked, deps)
      })
    })
}

export const ensureSandboxToolchain: ToolchainProvisioner = createToolchainProvisioner()
