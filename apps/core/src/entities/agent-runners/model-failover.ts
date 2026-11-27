import type { AgentSession } from '../AgentSession'
import type { StreamBuffer } from '../../services/streaming/buffer'
import type { StreamEventCollector } from '../../services/streaming/events'
import {
  classifyCaughtProviderError,
  classifyProviderTransportError,
  isInternalExecutionError,
  providerErrorText,
  type CaughtProviderErrorClassification,
} from '../../lib/error'
import { routeDecision } from '@ficus/shared/provider-health'
import { parseModelSpec, resolveAgentModelSpec } from '../../lib/utils/model-spec'
import { providerHealth, type ProviderHealthAttempt } from '../../services/provider-health/registry'
import {
  resolveModelCandidatesForCurrentEnv,
  selectModelSpecForCurrentEnv,
  selectModelSpecForCurrentEnvWithSwitchBack,
  selectResolvedModelCandidatesForCurrentEnv,
} from '../../services/model-selection'
import { selectAccount } from '../../services/agent/account-selection'
import * as accountStore from '../../services/agent/account-store'
import { setAgentSelectedModel } from '../Agent'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('model-failover')

export interface ModelFailoverDeps {
  agentId: string
  executionId: string
  getSession: () => AgentSession
  getBuffer: () => StreamBuffer
  getCollector: () => StreamEventCollector
  /** Re-dispatch the same turn after a successful switch (the runner's sendPrompt). */
  resendPrompt: () => Promise<void>
  /** Whether the runner has observed no assistant or tool output for this turn. */
  isTransportReplaySafe: () => boolean
  /** Test seam; the site-local internal guard always runs before this classifier. */
  classifyError?: (error: unknown) => CaughtProviderErrorClassification | null
}

/**
 * Stamp lastUsedAt on an account through the serialized mutate queue.
 * A snapshot write here would race (and clobber) concurrent credential
 * merge-backs from the auth storage.
 */
const REAUTHORIZE_HINT = 'Re-authorize it in Settings → AI Providers.'

/** A credential the user must fix (revoked sign-in, bad key): no cooldown will bring it back. */
function isCredentialFailure(classification: CaughtProviderErrorClassification): boolean {
  return classification.kind === 'expired-oauth' || classification.kind === 'invalid-credential'
}

function stampAccountLastUsed(provider: string, accountId: string): void {
  accountStore
    .mutateAccountStore((store) => {
      const account = accountStore.getAccount(store, provider, accountId)
      if (!account) return false
      account.lastUsedAt = Date.now()
    }, 'system')
    .catch(() => {})
}

/**
 * Runtime model/account failover for a live agent session.
 *
 * Owns the model priority list captured at turn start, the currently-active
 * spec, and the per-turn failover caps. `beginTurn` makes the once-implicit
 * per-turn counter reset explicit; `attempt` is the failover ladder (account
 * rotation within the provider first, then provider/model switch), verbatim
 * from AgentRunner.attemptFailover.
 */
export class ModelFailoverCoordinator {
  /**
   * The full model priority list currently in effect for this agent (e.g.
   * 'anthropic:claude-sonnet-4-5,zai:glm-5-turbo'). Captured in beginTurn so
   * runtime failover can re-select without re-reading the DB. Public and
   * mutable: the runner exposes it to subclasses/tests via accessors.
   */
  priorityList: string | undefined
  /** The currently-active single model spec (candidate selected from priorityList). */
  currentSelectedSpec: string | undefined
  /** Per-turn provider/model failover counter; reset by beginTurn (not per sendPrompt). */
  private failoverCountThisTurn = 0
  /** Per-turn account failover counter; reset by beginTurn (not per sendPrompt). */
  private accountFailoverCountThisTurn = 0
  /** In-flight attempts reserve cap budget before their first asynchronous boundary. */
  private failoversReservedThisTurn = 0
  /** Stable resolved candidate budget captured at the turn boundary. */
  private maxFailoversThisTurn = 1
  /** Turn-local candidate routes that failed without implicating the provider account. */
  private failedCandidateSpecs = new Set<string>()
  /**
   * Serializes everything that changes the live session's model or account: provider failover and
   * a configured-model "Switch now" must never interleave their account projection, selected spec
   * or concurrency slot move. Resending the turn stays outside it, because a resent prompt can fail
   * over again.
   */
  private switching: Promise<unknown> = Promise.resolve()

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.switching.then(fn, fn)
    this.switching = run.catch(() => {})
    return run
  }

  constructor(private readonly deps: ModelFailoverDeps) {}

  /** Capture the turn's model selection and reset the per-turn caps. */
  async beginTurn(priorityList: string, selectedSpec: string): Promise<void> {
    this.priorityList = priorityList
    this.currentSelectedSpec = selectedSpec
    this.failoverCountThisTurn = 0
    this.accountFailoverCountThisTurn = 0
    this.failoversReservedThisTurn = 0
    this.maxFailoversThisTurn = Math.max(1, resolveModelCandidatesForCurrentEnv(priorityList).length)
    this.failedCandidateSpecs.clear()
    await this.reassignConcurrencySlot(selectedSpec)
  }

  /** Capture immutable health identity immediately before an outbound request. */
  captureActiveAttempt(): ProviderHealthAttempt | undefined {
    const provider = this.activeProvider()
    if (!provider) return undefined
    return providerHealth.captureAttempt(provider, this.deps.getSession().accountId)
  }

  /** Resolve the active provider from currentSelectedSpec. */
  private activeProvider(): string | undefined {
    if (!this.currentSelectedSpec) return undefined
    try {
      return parseModelSpec(this.currentSelectedSpec).provider
    } catch {
      return undefined
    }
  }

  /**
   * Switch the live session to `next` with its context preserved: project credentials for the new
   * provider, set the model and thinking level, then record the selection and move the concurrency
   * slot. Pi reads the session model on every request and checks the compaction threshold against it
   * before each turn, so a running turn uses `next` from its next model call.
   */
  private async switchSessionModel(next: string): Promise<void> {
    const session = this.deps.getSession()
    // Ensure the live session projects credentials for the provider we are
    // switching to before Pi validates auth in setModel().
    const previousAccountId = session.accountId
    if (session.authBackend) {
      const nextProvider = parseModelSpec(next).provider
      const store = accountStore.readAccountStore()
      const nextAccount = selectAccount(nextProvider, store, {
        isAccountHealthy: (p, accountId) =>
          routeDecision({ provider: p, accountId }, providerHealth.snapshotRecords(), Date.now()).state === 'ready',
      })
      if (nextAccount) {
        session.authBackend.selectAccount(nextProvider, nextAccount.id)
        session.accountId = nextAccount.id
        stampAccountLastUsed(nextProvider, nextAccount.id)
      } else {
        session.accountId = undefined
      }
    }

    // Switch model on the live session (context preserved).
    const { model, thinkingLevel } = resolveAgentModelSpec(next)
    try {
      await session.pi.setModel(model)
    } catch (error) {
      // The session keeps its current model; only the account projection moved.
      session.accountId = previousAccountId
      throw error
    }
    if (thinkingLevel) session.pi.setThinkingLevel(thinkingLevel)

    this.currentSelectedSpec = next
    session.selectedSpec = next
    await setAgentSelectedModel(this.deps.agentId, next).catch(() => {})
    await this.reassignConcurrencySlot(next)
  }

  /**
   * Apply a newly configured model chain to the live session now, as the next turn would: keep the
   * current model when the new chain still selects it, otherwise switch in place (see
   * {@link switchSessionModel}). Later failover in this turn follows the new chain.
   */
  async applyConfiguredChain(
    priorityList: string
  ): Promise<{ switched: boolean; selected: string; previous?: string }> {
    return this.exclusive(async () => {
      const previous = this.currentSelectedSpec
      const { selected } = selectModelSpecForCurrentEnvWithSwitchBack(priorityList, previous)
      // Switch first: if the session refuses the model, it stays on its old model and keeps failing
      // over along its old chain.
      if (selected !== previous) await this.switchSessionModel(selected)
      this.priorityList = priorityList
      this.maxFailoversThisTurn = Math.max(1, resolveModelCandidatesForCurrentEnv(priorityList).length)
      this.failedCandidateSpecs.clear()
      if (selected === previous) return { switched: false, selected, previous }
      this.deps.getBuffer().push({
        type: 'system_message',
        text: previous ? `Model switched to ${selected} (from ${previous}).` : `Model switched to ${selected}.`,
      })
      log.info('Agent model switched to its configured chain', {
        strategy: 'configured-model-apply',
        executionId: this.deps.executionId,
      })
      return { switched: true, selected, previous }
    })
  }

  private async reassignConcurrencySlot(modelSpec: string): Promise<void> {
    try {
      const parsed = parseModelSpec(modelSpec)
      const { concurrencyLimiter } = await import('../../services/execution/concurrency-limiter-instance')
      concurrencyLimiter.reassign(this.deps.executionId, parsed.provider, parsed.modelId)
    } catch {
      // Best-effort: provider concurrency accounting must not break an active runner.
    }
  }

  /**
   * Attempt to fail over to the next healthy candidate after an exhaustion
   * error. Marks the active provider exhausted, re-selects from the priority
   * list (which now skips the exhausted provider via the health predicate),
   * switches the session model (context preserved via `setModel`), persists
   * the new selectedModel, emits a visible system_message, and re-dispatches
   * the same turn. Returns `true` if failover succeeded.
   *
   * Loop/flap guards:
   *  - Per-turn cap: never fail over more times than there are candidates
   *    in the priority list (reset by {@link ModelFailoverCoordinator.beginTurn}, not per sendPrompt, so
   *    re-dispatched sends don't reset the cap).
   *  - Cooldown in the provider health registry prevents re-selecting the
   *    dead provider until `retryAt`.
   */
  async attempt(error: unknown): Promise<boolean> {
    const errorText = providerErrorText(error)
    if (errorText && isInternalExecutionError(errorText)) return false
    const classification = this.deps.classifyError
      ? this.deps.classifyError(error)
      : (classifyCaughtProviderError(error) ?? classifyProviderTransportError(error))
    if (!classification) return false
    if (classification.kind === 'network' && !this.deps.isTransportReplaySafe()) {
      log.info('Provider retry deferred to durable continuation', {
        strategy: 'durable-transport-continuation',
        executionId: this.deps.executionId,
      })
      return false
    }
    if (!this.currentSelectedSpec || !this.priorityList) return false

    const provider = this.activeProvider()
    if (!provider) return false

    // Per-turn cap: never fail over more times than there are candidates.
    if (this.failoverCountThisTurn + this.failoversReservedThisTurn >= this.maxFailoversThisTurn) return false
    this.failoversReservedThisTurn += 1

    const failedSpec = this.currentSelectedSpec
    const priorityList = this.priorityList
    try {
      const resend = await this.exclusive(async () => {
        // A configured-model switch landed while this failure waited: the session already runs the
        // model the person chose, so resend on it instead of failing over from the old one. Drop
        // the failed attempt's partial output first, as the failover resends below do.
        if (this.currentSelectedSpec !== failedSpec) {
          this.deps.getCollector().reset()
          return true
        }
        return this.attemptReserved(classification, provider, priorityList)
      })
      if (!resend) return false
      await this.deps.resendPrompt()
      return true
    } finally {
      this.failoversReservedThisTurn -= 1
    }
  }

  private async attemptReserved(
    classification: CaughtProviderErrorClassification,
    provider: string,
    priorityList: string
  ): Promise<boolean> {
    const session = this.deps.getSession()
    const failedSpec = this.currentSelectedSpec!
    // A hard-pinned OpenRouter model/endpoint capacity failure says nothing
    // about the credential or other pinned model routes. Exclude only this
    // candidate for the rest of the turn. Rate limits remain account-scoped.
    const candidateScopedFailure = provider === 'openrouter' && classification.kind === 'capacity'
    if (candidateScopedFailure) this.failedCandidateSpecs.add(failedSpec)

    // Tier 1: rotate accounts within the same provider while preserving the live
    // Pi session/context. Only when all accounts for this provider are exhausted
    // do we fall through to provider/model failover below.
    const currentAccountId = session.accountId
    if (!candidateScopedFailure && currentAccountId && session.authBackend) {
      providerHealth.recordFailure(providerHealth.captureAttempt(provider, currentAccountId), classification)

      const store = accountStore.readAccountStore()
      const accountCount = accountStore.listAccounts(store, provider).length
      if (this.accountFailoverCountThisTurn < Math.max(1, accountCount)) {
        const nextAccount = selectAccount(provider, store, {
          isAccountHealthy: (p, accountId) =>
            routeDecision({ provider: p, accountId }, providerHealth.snapshotRecords(), Date.now()).state === 'ready',
        })

        if (nextAccount && nextAccount.id !== currentAccountId) {
          session.authBackend.selectAccount(provider, nextAccount.id)
          session.accountId = nextAccount.id
          stampAccountLastUsed(provider, nextAccount.id)
          this.accountFailoverCountThisTurn += 1

          this.deps.getBuffer().push({
            type: 'system_message',
            text:
              classification.kind === 'network'
                ? `Provider connection failed for ${provider} — rotated to ${nextAccount.label ?? 'next account'}.`
                : isCredentialFailure(classification)
                  ? `${provider} sign-in expired or was revoked — rotated to ${nextAccount.label ?? 'next account'}. ${REAUTHORIZE_HINT}`
                  : `Account exhausted for ${provider} — rotated to ${nextAccount.label ?? 'next account'}.`,
          })
          log.info('Provider request switched accounts', {
            strategy: 'account-failover',
            executionId: this.deps.executionId,
            failureKind: classification.kind,
          })
          this.deps.getCollector().reset()
          return true
        }
      }
    }

    // Known-account failures stay exact-account scoped. Provider-level auth is
    // the only case that may create a provider-wide observation.
    if (!candidateScopedFailure && !currentAccountId) {
      providerHealth.recordFailure(providerHealth.captureAttempt(provider), classification)
    }

    // Re-select — the exhausted provider is now skipped. Prefer a candidate
    // whose context window fits the live context so failover doesn't land on
    // a smaller-window model mid-turn (preference only — see #625).
    let next: string
    try {
      const selectionCandidates = this.failedCandidateSpecs.size
        ? resolveModelCandidatesForCurrentEnv(priorityList).filter((spec) => !this.failedCandidateSpecs.has(spec))
        : [priorityList]
      const sel = this.failedCandidateSpecs.size
        ? selectResolvedModelCandidatesForCurrentEnv(selectionCandidates, {
            preferContextTokens: session.pi.getContextUsage()?.tokens ?? undefined,
          })
        : selectModelSpecForCurrentEnv(priorityList, {
            preferContextTokens: session.pi.getContextUsage()?.tokens ?? undefined,
          })
      next = sel.selected
    } catch {
      return false // no usable candidate left
    }

    // No switch needed if it re-selected the same spec (shouldn't happen, but guard).
    if (next === this.currentSelectedSpec) return false

    await this.switchSessionModel(next)
    this.failoverCountThisTurn += 1

    if (candidateScopedFailure) {
      this.deps.getBuffer().push({
        type: 'system_message',
        text: `OpenRouter route ${failedSpec} unavailable — failed over to ${next}.`,
      })
    } else {
      // Read the cooldown from the record the failure was actually written to.
      // Account-scoped failures (every OAuth provider) leave the provider-level
      // record empty, so reading only `getHealth(provider)` here fell back to
      // `Date.now()` and announced "~1m" for every cooldown length.
      const accountRetryAt = currentAccountId
        ? providerHealth.getAccountHealth(provider, currentAccountId).retryAt
        : undefined
      const retryAt = accountRetryAt ?? providerHealth.getHealth(provider).retryAt ?? Date.now()
      const mins = Math.max(1, Math.round((retryAt - Date.now()) / 60000))
      this.deps.getBuffer().push({
        type: 'system_message',
        text:
          classification.kind === 'network'
            ? `Provider connection failed for ${provider} — failed over to ${next}. (retry in ~${mins}m)`
            : isCredentialFailure(classification)
              ? `${provider} sign-in expired or was revoked — failed over to ${next}. ${REAUTHORIZE_HINT}`
              : `Provider ${provider} exhausted — failed over to ${next}. (retry in ~${mins}m)`,
      })
    }
    log.info('Provider request switched models', {
      strategy: 'model-failover',
      executionId: this.deps.executionId,
      failureKind: classification.kind,
    })
    this.deps.getCollector().reset()

    // The caller re-dispatches the same turn. The Pi SDK persists the user message
    // to the session file before the API call, so the failed prompt is already in
    // context. sendPrompt lets that delivery be acknowledged before releasing its
    // claim, and then sends a short continuation instead of the original text
    // (AgentRunner.unclaimedPromptText), so the model never sees the task twice.
    // A prompt that failed before it reached the session is released and re-sent.
    return true
  }
}
