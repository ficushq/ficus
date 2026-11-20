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
  /**
   * Tell the squad that its declared toolchain failed to install. Called on
   * every failure; the implementation sends at most one notice per squad and
   * toolchain fingerprint. Optional so test doubles can leave it out.
   */
  notifyFailure?(input: StateKey & { errorCode: ToolchainErrorCode }): Promise<void>
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
  notifyFailure: async (input) => {
    const { notifyToolchainFailure } = await import('./failure-notice')
    await notifyToolchainFailure(input)
  },
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

/** Whether the box still serves a previously activated toolchain; unknown counts as no. */
async function servesPreviousToolchain(manager: ISandboxManager, sandboxId: string): Promise<boolean> {
  if (!manager.isManagedToolchainActive) return false
  try {
    return (await manager.isManagedToolchainActive(sandboxId)) === true
  } catch (error) {
    log.warn(`Could not tell whether ${sandboxId} still serves its previous toolchain; waiting for the install`, error)
    return false
  }
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
    if (configured) {
      // An install that fails in the background no longer fails anyone's turn,
      // so someone has to be told. Never let the notice mask the failure.
      await deps
        .notifyFailure?.({ ...stateKey, errorCode: classified.code })
        .catch((notifyError: unknown) => log.warn(`Toolchain failure notice for ${sandboxId} failed`, notifyError))
    }
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

/**
 * How a sandbox ensure left the managed toolchain:
 * - `settled`: the toolchain is reconciled (or nothing is declared).
 * - `installing`: a new toolchain is still installing in the background while
 *   the box keeps serving commands with its previously activated one.
 * - `failed`: reconciliation failed, but the box still serves its previously
 *   activated toolchain; the failure is recorded in the toolchain status.
 *
 * A box with no activated toolchain to fall back to never gets `installing` or
 * `failed`: its ensure waits for the install, and a failure throws.
 */
export type ToolchainSettleOutcome = 'settled' | 'installing' | 'failed'

export interface ToolchainSettleOptions {
  deps?: ToolchainProvisionDeps
  /** Upper bound on waiting for a reconcile that has not (yet) reported install work. */
  waitMs?: number
}

export interface ToolchainProvisionerHandle extends ToolchainProvisioner {
  /**
   * Start (or join) a reconcile, and wait for it only when the sandbox has
   * nothing to fall back to.
   *
   * The caller always waits while the reconcile is cheap: the already-applied
   * path (readiness checks and activating the cached environment), bounded by
   * `waitMs`. When the reconcile reports install work, another reconcile of
   * this sandbox is already installing, the wait budget runs out (for example
   * while another Core process holds the provisioning lease) or the reconcile
   * fails, the box is asked whether it still serves a previously activated
   * toolchain. If it does, this returns `installing` (or `failed`) and the
   * reconcile finishes in the background. If it does not (a new, recreated or
   * reset box, or a squad's first declaration), the caller waits for the
   * install as before and a failure throws {@link ToolchainProvisioningError}.
   */
  settle(
    manager: ISandboxManager,
    sandboxId: string,
    opts: SandboxOptions,
    squadId: string,
    options?: ToolchainSettleOptions
  ): Promise<ToolchainSettleOutcome>
  /** Whether a reconcile in this process is installing packages or running setup for the sandbox. */
  isInstalling(sandboxId: string): boolean
}

/** Default bound on how long a sandbox ensure waits for the managed toolchain before continuing. */
export const TOOLCHAIN_SETTLE_WAIT_MS = 30_000

const INSTALLING_STATUSES = new Set<SandboxToolchainStatus>(['installing', 'running_setup'])

export function createToolchainProvisioner(): ToolchainProvisionerHandle {
  const queues = new KeyedSerialQueue()
  // At most one queued, not-yet-started reconcile per sandbox. Every queued
  // reconcile reads the latest declaration when it starts, so later callers
  // can share it instead of piling up one reconcile per ensure behind a long
  // install.
  const queued = new Map<string, Promise<void>>()
  const installing = new Set<string>()
  const installListeners = new Map<string, Set<() => void>>()

  const noteInstalling = (sandboxId: string) => {
    installing.add(sandboxId)
    const listeners = installListeners.get(sandboxId)
    if (listeners) for (const listener of [...listeners]) listener()
  }

  const provision: ToolchainProvisioner = (manager, sandboxId, opts, squadId, deps = defaultDeps) => {
    const waiting = queued.get(sandboxId)
    if (waiting) return waiting
    const observed: ToolchainProvisionDeps = {
      ...deps,
      markStage: async (input) => {
        // Record first, so a caller released by this signal already sees the
        // install in the toolchain status.
        try {
          await deps.markStage(input)
        } finally {
          noteInstalling(sandboxId)
        }
      },
    }
    const run: Promise<void> = queues.run(sandboxId, async () => {
      if (queued.get(sandboxId) === run) queued.delete(sandboxId)
      try {
        const preflight = await deps.readSnapshot(squadId, sandboxId)
        if (isClean(preflight)) return
        // Another process may already be installing under the lease; callers
        // that only want to settle should not wait for it.
        if (preflight.provision && INSTALLING_STATUSES.has(preflight.provision.status)) noteInstalling(sandboxId)
        await deps.withLease(sandboxId, async () => {
          const locked = await deps.readSnapshot(squadId, sandboxId)
          await reconcileLocked(manager, sandboxId, opts, squadId, locked, observed)
        })
      } finally {
        installing.delete(sandboxId)
      }
    })
    queued.set(sandboxId, run)
    return run
  }

  /** Resolves `installing` once this sandbox reports install work or the budget runs out. */
  const releaseSignal = (sandboxId: string, waitMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let listener: (() => void) | undefined
    const signalled = new Promise<'installing'>((resolve) => {
      listener = () => resolve('installing')
      let listeners = installListeners.get(sandboxId)
      if (!listeners) installListeners.set(sandboxId, (listeners = new Set()))
      listeners.add(listener)
      timer = setTimeout(listener, waitMs)
    })
    const dispose = () => {
      clearTimeout(timer)
      const listeners = installListeners.get(sandboxId)
      if (listener) listeners?.delete(listener)
      if (listeners?.size === 0) installListeners.delete(sandboxId)
    }
    return { signalled, dispose }
  }

  const settle: ToolchainProvisionerHandle['settle'] = async (manager, sandboxId, opts, squadId, options = {}) => {
    let failure: unknown
    const outcome = provision(manager, sandboxId, opts, squadId, options.deps).then(
      () => 'settled' as const,
      (error: unknown) => {
        failure = error
        return 'failed' as const
      }
    )
    let released: ToolchainSettleOutcome
    if (installing.has(sandboxId)) released = 'installing'
    else {
      const signal = releaseSignal(sandboxId, options.waitMs ?? TOOLCHAIN_SETTLE_WAIT_MS)
      try {
        released = await Promise.race([outcome, signal.signalled])
      } finally {
        signal.dispose()
      }
    }
    if (released === 'settled') return 'settled'

    if (await servesPreviousToolchain(manager, sandboxId)) {
      if (released === 'failed') {
        log.warn(`Managed toolchain for ${sandboxId} failed; the box keeps its previous toolchain`, failure)
        return 'failed'
      }
      void outcome.then((final) => {
        if (final === 'failed')
          log.warn(
            `Background toolchain install for ${sandboxId} failed; the box keeps its previous toolchain`,
            failure
          )
      })
      return 'installing'
    }

    // Nothing to fall back to: commands would run without the squad's
    // declared packages, so wait for the install and fail like before.
    if ((await outcome) === 'failed') {
      throw failure instanceof ToolchainProvisioningError ? failure : new ToolchainProvisioningError('unknown')
    }
    return 'settled'
  }

  return Object.assign(provision, { settle, isInstalling: (sandboxId: string) => installing.has(sandboxId) })
}

export const ensureSandboxToolchain: ToolchainProvisionerHandle = createToolchainProvisioner()
