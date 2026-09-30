import {
  BashOutcomeUnknownError,
  SandboxTransportError,
  classifySandboxTransportError,
  type SandboxClient,
} from '../client/http-client'
import { createLogger } from '../../../lib/infra/logger'
import { runIdempotentSandboxOperation } from './retry'
import type { VmSetupReasonCode, VmSetupState } from './setup-state'

const defaultLog = createLogger('vm-setup')

/**
 * One bounded, secret-free line per failed setup component. The durable row
 * only keeps the reason CODE (`devbox_unavailable`, …) — without this the
 * actual cause of a box sitting in `ready_degraded` for days is visible nowhere.
 */
function describeSetupFailure(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return `${name}: ${oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine}`
}

export interface VmSetupReconcilerDeps {
  withLease<T>(sandboxId: string, fn: () => Promise<T>): Promise<T>
  ensureFingerprint(sandboxId: string, fingerprint: string): Promise<VmSetupState>
  markReconciling(sandboxId: string, fingerprint: string, now: Date): Promise<boolean>
  setPendingInvocation(sandboxId: string, fingerprint: string, invocationId: string, kind: string): Promise<boolean>
  clearPendingInvocation(sandboxId: string, fingerprint: string, invocationId: string): Promise<boolean>
  mergeObservedReasons?: (
    sandboxId: string,
    fingerprint: string,
    reasons: VmSetupReasonCode[],
    now: Date
  ) => Promise<VmSetupState | null>
  markDegraded(input: {
    sandboxId: string
    fingerprint: string
    reasons: VmSetupReasonCode[]
    lastFailureClass?: string
    squadId?: string
    now?: Date
  }): Promise<VmSetupState | null>
  markReady(sandboxId: string, fingerprint: string, now: Date): Promise<boolean>
  getClient(): SandboxClient
  recoverClient(failedClient: SandboxClient, cause: Error): Promise<SandboxClient>
  seedDevbox(client: SandboxClient, invocationId: string): Promise<void>
  signalDevboxReady(client: SandboxClient): Promise<void>
  writeBashrc(client: SandboxClient): Promise<void>
  configureGit(client: SandboxClient, invocationId: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): Date
  /** Failure log sink; defaults to the `vm-setup` logger. */
  log?: { warn(message: string): void }
}

export interface ReconcileVmSetupInput {
  sandboxId: string
  fingerprint: string
  configureGit: boolean
  devboxInvocationId: string
  gitInvocationId?: string
  initialReasons?: VmSetupReasonCode[]
  squadId?: string
  now?: Date
  leaseAlreadyHeld?: boolean
}

function transportFailure(error: unknown): SandboxTransportError | null {
  return error instanceof SandboxTransportError ? error : classifySandboxTransportError(error)
}

async function refreshAfterFailure(
  client: SandboxClient,
  error: unknown,
  deps: VmSetupReconcilerDeps
): Promise<{ client: SandboxClient; cleanupProven: boolean }> {
  if (error instanceof BashOutcomeUnknownError) {
    try {
      await client.cancelBashInvocation(error.invocationId, 'transport-loss')
      return { client, cleanupProven: true }
    } catch {
      const recovered = await deps.recoverClient(client, error)
      await recovered.cancelBashInvocation(error.invocationId, 'transport-loss')
      return { client: recovered, cleanupProven: true }
    }
  }
  const transport = transportFailure(error)
  if (transport) return { client: await deps.recoverClient(client, transport), cleanupProven: true }
  return { client, cleanupProven: true }
}

export async function reconcileVmSetup(
  input: ReconcileVmSetupInput,
  deps: VmSetupReconcilerDeps
): Promise<VmSetupState> {
  const reconcile = async (): Promise<VmSetupState> => {
    const attemptStartedAt = input.now ?? deps.now()
    const initial = await deps.ensureFingerprint(input.sandboxId, input.fingerprint)
    const observedReasons = [...new Set(input.initialReasons ?? [])]
    if (
      initial.readiness === 'ready_degraded' &&
      initial.nextAttemptAt &&
      initial.nextAttemptAt.getTime() > attemptStartedAt.getTime()
    ) {
      const newReasons = observedReasons.filter((reason) => !initial.reasons.includes(reason))
      if (newReasons.length === 0) return initial
      return (
        (await deps.mergeObservedReasons?.(input.sandboxId, input.fingerprint, newReasons, attemptStartedAt)) ?? initial
      )
    }
    if (initial.readiness === 'ready') {
      if (observedReasons.length === 0) return initial
      return (
        (await deps.markDegraded({
          sandboxId: input.sandboxId,
          fingerprint: input.fingerprint,
          reasons: observedReasons,
          lastFailureClass: 'callback_transport_degraded',
          squadId: input.squadId,
          now: attemptStartedAt,
        })) ?? initial
      )
    }

    if (!(await deps.markReconciling(input.sandboxId, input.fingerprint, attemptStartedAt))) {
      throw new Error(`VM setup fingerprint changed before reconciling ${input.sandboxId}`)
    }
    const reasons: VmSetupReasonCode[] = [...(input.initialReasons ?? [])]
    const log = deps.log ?? defaultLog
    let client = deps.getClient()
    if (initial.pendingInvocationId) {
      try {
        try {
          await client.cancelBashInvocation(initial.pendingInvocationId, 'transport-loss')
        } catch (error) {
          client = await deps.recoverClient(client, error as Error)
          await client.cancelBashInvocation(initial.pendingInvocationId, 'transport-loss')
        }
        if (!(await deps.clearPendingInvocation(input.sandboxId, input.fingerprint, initial.pendingInvocationId))) {
          throw new Error(`VM setup fingerprint changed while clearing invocation ${input.sandboxId}`)
        }
      } catch (error) {
        const degraded = await deps.markDegraded({
          sandboxId: input.sandboxId,
          fingerprint: input.fingerprint,
          squadId: input.squadId,
          reasons: ['command_outcome_ambiguous'],
          lastFailureClass: transportFailure(error)?.kind ?? 'command_outcome_ambiguous',
          now: deps.now(),
        })
        if (!degraded) throw new Error(`VM setup fingerprint changed while settling ${input.sandboxId}`)
        return degraded
      }
    }
    let cleanupProven = true
    let lastFailureClass: string | undefined

    try {
      // Publish the stable invocation fence before starting long streamed work.
      if (
        !(await deps.setPendingInvocation(
          input.sandboxId,
          input.fingerprint,
          input.devboxInvocationId,
          'devbox_install'
        ))
      ) {
        throw new Error(`VM setup already has an unproven invocation for ${input.sandboxId}`)
      }
      await deps.seedDevbox(client, input.devboxInvocationId)
      if (!(await deps.clearPendingInvocation(input.sandboxId, input.fingerprint, input.devboxInvocationId))) {
        throw new Error(`VM setup fingerprint changed while clearing devbox ${input.sandboxId}`)
      }
      await runIdempotentSandboxOperation({
        sandboxId: input.sandboxId,
        operationClass: 'health',
        getClient: () => client,
        recoverClient: async (failed, cause) => (client = await deps.recoverClient(failed, cause)),
        operation: (current) => deps.signalDevboxReady(current),
        sleep: deps.sleep,
      })
    } catch (error) {
      reasons.push('devbox_unavailable')
      log.warn(`VM setup devbox step failed for ${input.sandboxId}: ${describeSetupFailure(error)}`)
      if (!(error instanceof BashOutcomeUnknownError)) {
        await deps.clearPendingInvocation(input.sandboxId, input.fingerprint, input.devboxInvocationId)
      }
      try {
        const refreshed = await refreshAfterFailure(client, error, deps)
        client = refreshed.client
        cleanupProven = refreshed.cleanupProven
        if (error instanceof BashOutcomeUnknownError) {
          await deps.clearPendingInvocation(input.sandboxId, input.fingerprint, error.invocationId)
        }
      } catch (recoveryError) {
        cleanupProven = false
        if (error instanceof BashOutcomeUnknownError) {
          if (
            !(await deps.setPendingInvocation(input.sandboxId, input.fingerprint, error.invocationId, 'devbox_install'))
          ) {
            throw new Error(`VM setup fingerprint changed while fencing ${input.sandboxId}`)
          }
        }
        lastFailureClass = transportFailure(recoveryError)?.kind ?? 'command_outcome_ambiguous'
        reasons.push(
          error instanceof BashOutcomeUnknownError ? 'command_outcome_ambiguous' : 'transport_recovery_failed'
        )
      }
    }

    try {
      await runIdempotentSandboxOperation({
        sandboxId: input.sandboxId,
        operationClass: 'deterministic_overwrite',
        getClient: () => client,
        recoverClient: async (failed, cause) => (client = await deps.recoverClient(failed, cause)),
        operation: (current) => deps.writeBashrc(current),
        sleep: deps.sleep,
      })
    } catch (error) {
      reasons.push('bashrc_unavailable')
      log.warn(`VM setup bashrc step failed for ${input.sandboxId}: ${describeSetupFailure(error)}`)
      lastFailureClass ??= transportFailure(error)?.kind
    }

    if (input.configureGit) {
      if (!cleanupProven) {
        reasons.push('git_credentials_unavailable')
      } else {
        const invocationId = input.gitInvocationId ?? `git-${input.sandboxId}`
        if (!(await deps.setPendingInvocation(input.sandboxId, input.fingerprint, invocationId, 'git_config'))) {
          throw new Error(`VM setup already has an unproven invocation for ${input.sandboxId}`)
        }
        try {
          const configure = () => deps.configureGit(client, invocationId)
          try {
            await configure()
          } catch (error) {
            if (!(error instanceof BashOutcomeUnknownError)) throw error
            const refreshed = await refreshAfterFailure(client, error, deps)
            client = refreshed.client
            await configure()
          }
          if (!(await deps.clearPendingInvocation(input.sandboxId, input.fingerprint, invocationId))) {
            throw new Error(`VM setup fingerprint changed while clearing Git ${input.sandboxId}`)
          }
        } catch (error) {
          reasons.push('git_credentials_unavailable')
          log.warn(`VM setup git step failed for ${input.sandboxId}: ${describeSetupFailure(error)}`)
          if (error instanceof BashOutcomeUnknownError) {
            try {
              const refreshed = await refreshAfterFailure(client, error, deps)
              client = refreshed.client
            } catch (cleanupError) {
              reasons.push('command_outcome_ambiguous')
              lastFailureClass ??= transportFailure(cleanupError)?.kind ?? 'command_outcome_ambiguous'
            }
          } else {
            await deps.clearPendingInvocation(input.sandboxId, input.fingerprint, invocationId)
            lastFailureClass ??= transportFailure(error)?.kind
          }
        }
      }
    }

    const boundedReasons = [...new Set(reasons)].slice(0, 5)
    const completedAt = deps.now()
    if (boundedReasons.length === 0) {
      if (!(await deps.markReady(input.sandboxId, input.fingerprint, completedAt))) {
        throw new Error(`VM setup fingerprint changed while marking ready ${input.sandboxId}`)
      }
      return {
        ...initial,
        readiness: 'ready',
        reasons: [],
        attemptCount: 0,
        nextAttemptAt: null,
        pendingInvocationId: null,
        pendingInvocationKind: null,
        lastFailureClass: null,
        lastAttemptAt: attemptStartedAt,
        updatedAt: completedAt,
      }
    }
    const degraded = await deps.markDegraded({
      sandboxId: input.sandboxId,
      fingerprint: input.fingerprint,
      squadId: input.squadId,
      reasons: boundedReasons,
      lastFailureClass,
      now: completedAt,
    })
    if (!degraded) throw new Error(`VM setup fingerprint changed while reconciling ${input.sandboxId}`)
    return degraded
  }
  return input.leaseAlreadyHeld ? reconcile() : deps.withLease(input.sandboxId, reconcile)
}
