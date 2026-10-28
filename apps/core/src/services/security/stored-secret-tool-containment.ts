import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import { createLogger } from '../../lib/infra/logger'
import type { ContentSafetyPort } from './content-safety'
import {
  recordStoredSecretToolAudit,
  type StoredSecretToolAuditInput,
  type StoredSecretToolAuditOutcome,
} from './stored-secret-tool-audit'

const log = createLogger('stored-secret-containment')

/**
 * The agent-visible refusal for a denied stored-value tool call. Constant,
 * content-free: it never names the key or echoes any payload bytes.
 */
export const STORED_SECRET_TOOL_REFUSAL =
  'A protected credential value appeared in this tool payload. The call was refused before execution; you must not retry using that value.'

export type StoredSecretToolAuditSink = (input: StoredSecretToolAuditInput) => Promise<void>

export interface StoredSecretToolContainmentOptions {
  agentId: string
  executionId: string
  /** Defaults to the durable audit writer; tests inject an in-memory sink. */
  sink?: StoredSecretToolAuditSink
}

/** Structural slice of the Pi agent: only the hook this coordinator wraps. */
export interface StoredSecretToolHookTarget {
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>
}

/**
 * Runner-owned containment coordinator for one agent execution.
 *
 * Denies exactly one validated tool call at a time — the pre-call wrapper
 * around Pi's `beforeToolCall` — and records post-execution result matches the
 * inbound output boundary reports. It cannot abort the Pi session, abort bash,
 * fail the execution, or change the terminal outcome; sink failures are logged
 * with content-free identity only. Containing one call is not containment of
 * the secret: the session may still hold the value and try another route.
 */
export class StoredSecretToolContainment {
  readonly #agentId: string
  readonly #executionId: string
  readonly #sink: StoredSecretToolAuditSink
  readonly #recorded = new Set<string>()
  readonly #pending: Promise<void>[] = []

  constructor(options: StoredSecretToolContainmentOptions) {
    this.#agentId = options.agentId
    this.#executionId = options.executionId
    this.#sink = options.sink ?? recordStoredSecretToolAudit
  }

  /**
   * Wrap the agent's existing `beforeToolCall` with stored-value denial.
   *
   * Scans validated args before delegating (a match never reaches the previous
   * hook), and again afterwards because extension `tool_call` handlers may
   * mutate the input. A previous-hook failure carrying a stored value is
   * replaced by the actionable refusal; any other failure is rethrown
   * unchanged. Returns a disposer that restores the previous hook only while
   * this wrapper is still the installed one.
   */
  attachBeforeToolCall(agent: StoredSecretToolHookTarget, safety: ContentSafetyPort): () => void {
    const previous = agent.beforeToolCall

    const wrapper = async (
      context: BeforeToolCallContext,
      signal?: AbortSignal
    ): Promise<BeforeToolCallResult | undefined> => {
      const matched = (): readonly string[] => safety.redactWithStoredKeys(context.args).storedKeys
      const deny = async (storedKeys: readonly string[]): Promise<BeforeToolCallResult> => {
        await this.#write(context.toolCall.id, storedKeys, 'denied')
        // No `terminate`: the refusal is the actionable message and the agent
        // run continues to a normal terminal state.
        return { block: true, reason: STORED_SECRET_TOOL_REFUSAL }
      }

      const before = matched()
      if (before.length > 0) return deny(before)

      let decision: BeforeToolCallResult | undefined
      if (previous) {
        try {
          decision = await previous(context, signal)
        } catch (error) {
          const keys = new Set<string>([...matched(), ...safety.redactWithStoredKeys(error).storedKeys])
          if (keys.size > 0) return deny([...keys])
          throw error
        }
      }

      const after = matched()
      if (after.length > 0) return deny(after)
      return decision
    }

    agent.beforeToolCall = wrapper
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      if (agent.beforeToolCall === wrapper) agent.beforeToolCall = previous
    }
  }

  /**
   * Record a stored-value match in content the original tool already returned.
   * Truthful outcome only: the side effect happened; never call this denied.
   */
  async recordAlreadyExecuted(toolCallId: string, storedKeys: readonly string[]): Promise<void> {
    await this.#write(toolCallId, storedKeys, 'already_executed')
  }

  /** Resolve once every queued audit write has settled. */
  async waitForAuditWrites(): Promise<void> {
    await Promise.allSettled(this.#pending)
  }

  async #write(
    toolCallId: string,
    storedKeys: readonly string[],
    outcome: StoredSecretToolAuditOutcome
  ): Promise<void> {
    const writes: Promise<void>[] = []
    for (const secretKey of storedKeys) {
      const dedup = JSON.stringify([toolCallId, secretKey])
      if (this.#recorded.has(dedup)) continue
      this.#recorded.add(dedup)
      writes.push(
        this.#sink({ agentId: this.#agentId, executionId: this.#executionId, secretKey, outcome }).catch((error) => {
          log.error(
            `Stored-secret tool audit write failed agent=${this.#agentId} execution=${this.#executionId} key=${secretKey} outcome=${outcome}:`,
            error
          )
        })
      )
    }
    if (writes.length > 0) this.#pending.push(...writes)
  }
}
