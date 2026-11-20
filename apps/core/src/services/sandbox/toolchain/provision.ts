import type { SandboxToolchainStatus } from '@ficus/shared'
import { KeyedSerialQueue } from '../../../lib/infra/inflight'
import { createLogger } from '../../../lib/infra/logger'
import type { ISandboxManager, SandboxOptions } from '../types'
import { ManagedToolchainLockPin } from '../../../entities/ManagedToolchainLockPin'
import { fingerprintToolchain, isEmptyToolchain, normalizeToolchain, renderManagedDevbox } from './config'
import { TOOLCHAIN_STDENV_LOCK_KEY } from './lock-pin'
import { buildVerifiedPin, checkStoredPin } from './lock-verify'
import { DevboxLockCache } from '../../../entities/DevboxLockCache'
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
  /** The squad's pinned devbox.lock for a fingerprint (see lock-pin.ts). */
  readLockPin(squadId: string, fingerprint: string): Promise<string | null>
  /** First write wins; `replacing` swaps only a pin still equal to that value. */
  storeLockPin(squadId: string, fingerprint: string, lockContent: string, replacing?: string): Promise<void>
  /**
   * Turn a lock captured on a box into the pin Core stores, verified against
   * upstream nixpkgs and the official binary cache (see lock-verify.ts).
   */
  verifyLock(captured: string, packages: readonly string[]): ReturnType<typeof buildVerifiedPin>
}

/**
 * The stdenv `resolved` value from Core's comfort-set lock cache (squad set,
 * then agent set): the nixpkgs every box's comfort shell already uses.
 */
async function readTrustedStdenv(): Promise<string | undefined> {
  // Loaded lazily: devbox-seed pulls in the VM box manager, which the Docker
  // and Kubernetes runtimes that import this module never need.
  const { computeDevboxSeedHash } = await import('../../machines/devbox-seed')
  for (const role of ['squad', 'agent'] as const) {
    const lock = await DevboxLockCache.get(computeDevboxSeedHash(role))
    if (!lock) continue
    try {
      const resolved = (JSON.parse(lock) as { packages?: Record<string, { resolved?: unknown }> }).packages?.[
        TOOLCHAIN_STDENV_LOCK_KEY
      ]?.resolved
      if (typeof resolved === 'string') return resolved
    } catch {
      // An unreadable seed lock just means no trusted stdenv.
    }
  }
  return undefined
}

async function verifyLockWithTrustedStdenv(captured: string, packages: readonly string[]) {
  let stdenv: string | undefined
  try {
    stdenv = await readTrustedStdenv()
  } catch (error) {
    log.warn('Reading the comfort-set stdenv failed; pinning without a stdenv entry', error)
  }
  return buildVerifiedPin(captured, packages, stdenv)
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
  readLockPin: ManagedToolchainLockPin.get,
  storeLockPin: ManagedToolchainLockPin.store,
  verifyLock: verifyLockWithTrustedStdenv,
}

/**
 * Load the squad's pin for this fingerprint. Never fails the reconcile: an
 * unreadable or invalid pin is treated as missing, and `stale` names an
 * invalid stored value so a fresh resolution may replace it.
 */
async function loadLockPin(
  squadId: string,
  fingerprint: string,
  packages: readonly string[],
  deps: ToolchainProvisionDeps
): Promise<{ pinned?: string; stale?: string }> {
  let stored: string | null
  try {
    stored = await deps.readLockPin(squadId, fingerprint)
  } catch (error) {
    log.warn(`Reading the toolchain lock pin failed for squad ${squadId}; resolving afresh`, error)
    return {}
  }
  if (stored === null) return {}
  const check = checkStoredPin(stored, packages)
  if (check.ok) return { pinned: stored }
  log.warn(`Ignoring invalid toolchain lock pin for squad ${squadId} (${check.reason})`)
  return { stale: stored }
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

  const packages = normalized?.packages ?? []
  // Loaded only when the runtime is about to install, never for an unchanged box.
  let pin: { pinned?: string; stale?: string } = {}
  const loadPinnedLock = async () => {
    if (!fingerprint) return undefined
    pin = await loadLockPin(squadId, fingerprint, packages, deps)
    return pin.pinned
  }
  const recordResolvedLock = async (lockContent: string, outcome: { unrealizable: boolean }) => {
    if (!fingerprint) return
    // A box can make any install fail, so a failed pinned install never moves
    // a verified pin: that box resolved afresh and the pin stays. An operator
    // refreshes a pin that is genuinely unrealizable by deleting its row.
    if (outcome.unrealizable) {
      log.warn(`Pinned toolchain lock for squad ${squadId} did not install in ${sandboxId}; keeping the pin`)
      return
    }
    const verified = await deps.verifyLock(lockContent, packages)
    if (!verified.ok) {
      log.warn(`Not pinning the toolchain lock from ${sandboxId} (${verified.reason})`)
      return
    }
    // First write wins; only a stored value that failed the reuse check may be replaced.
    await deps.storeLockPin(squadId, fingerprint, verified.lock, pin.stale)
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
      loadPinnedLock,
      recordResolvedLock,
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
