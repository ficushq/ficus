import type { AgentStatus, SessionUsage, MessageMetadata, QuestionData } from '@ficus/shared'

/**
 * Context passed to turn completion hooks.
 */
export interface TurnContext {
  agentId: string
  executionId: string
  response: string
  metadata: MessageMetadata | undefined
  sessionUsage: SessionUsage
}

/**
 * Agent updates that can be applied by a halt result.
 */
export interface HaltUpdates {
  questionData?: QuestionData | null
}

/**
 * Result returned by a turn hook.
 * - `continue`: Proceed with normal completion (agent → idle)
 * - `halt`: Stop completion, set agent to specified status with optional updates
 * - `restart`: Complete current execution and immediately queue a new one with the given message
 */
export type TurnHookResult =
  | { action: 'continue' }
  | { action: 'halt'; status: AgentStatus; updates?: HaltUpdates }
  | { action: 'restart'; message: string }

/**
 * A turn completion hook function.
 * Called after agent finishes a turn, before normal completion.
 */
export type TurnHook = (ctx: TurnContext) => Promise<TurnHookResult>

/**
 * Hook registration with priority (lower = runs first).
 */
export interface RegisteredHook {
  name: string
  priority: number
  hook: TurnHook
}
