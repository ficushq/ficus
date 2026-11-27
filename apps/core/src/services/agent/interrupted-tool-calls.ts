/**
 * Results for tool calls that a hard Core interruption cut off.
 *
 * When Core dies mid tool call (OOM, SIGKILL, node loss), the pi session file holds the assistant
 * message with the call but no result. Startup recovery or the lease sweep requeues the execution,
 * and on the next model request pi-ai fills the gap with a generic "No result provided" error.
 *
 * On the resumed pickup, the runner records the calls that were cut off as a session custom entry
 * (one entry per recovery notice), and the `context` hook below answers each recorded call that
 * still has no result with a result that names the interruption and says, from the tool's replay
 * class, whether running it again is safe. The model sees that result instead of pi-ai's.
 *
 * Only calls this records are rewritten. A call counts as cut off when all of these hold:
 *  - the execution's latest recovery notice comes from startup recovery or the lease sweep (a
 *    graceful restart drains its commands and resumes with its own brief instead);
 *  - the call is in the session's last assistant message and has no result after it;
 *  - that message was written while the execution ran, before the recovery notice.
 * Any other missing result keeps pi-ai's behavior.
 *
 * The hook works on pi's copy of the context, so the Claude Code bridge, which renders that context
 * into a seeded transcript, shows the same result.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import {
  createSyntheticSourceInfo,
  type ContextEvent,
  type Extension,
  type ExtensionContext,
  type SessionEntry,
  type SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { InterruptionCause } from '@ficus/shared/restart-context'
import { toolReplay, type ToolReplay } from '../../tools/metadata'

/** The session custom-entry type the cut-off calls are recorded under. */
export const INTERRUPTED_TOOL_CALLS_TYPE = 'ficus:interrupted-tool-calls'
const EXTENSION_PATH = 'ficus:interrupted-tool-calls'

/** A hard interruption of one execution, read from its recovery notice. */
export interface HardInterruption {
  /** The recovery notice's message ID; one record per notice. */
  noticeId: string
  executionId: string
  cause: InterruptionCause
  /** When recovery requeued the execution (the notice's time), ISO 8601. */
  recoveredAt: string
  /** When the execution was created, ISO 8601: calls before it belong to an earlier execution. */
  executionStartedAt: string
}

export interface InterruptedToolCall {
  toolCallId: string
  toolName: string
  /** The class when the call was recorded, so a later reclassification does not change history. */
  replay: ToolReplay
}

export interface InterruptedToolCallsRecord {
  noticeId: string
  executionId: string
  cause: InterruptionCause
  recoveredAt: string
  calls: InterruptedToolCall[]
}

type RecordSession = Pick<SessionManager, 'getBranch' | 'appendCustomEntry'>

function isRecord(entry: SessionEntry): entry is Extract<SessionEntry, { type: 'custom' }> & {
  data: InterruptedToolCallsRecord
} {
  if (entry.type !== 'custom' || entry.customType !== INTERRUPTED_TOOL_CALLS_TYPE) return false
  const data = entry.data as Partial<InterruptedToolCallsRecord> | undefined
  return typeof data?.noticeId === 'string' && Array.isArray(data.calls)
}

/**
 * The calls in the branch's last assistant message that have no result and were made between
 * `since` and `until` (epoch milliseconds). Empty when a user message follows that message, or
 * when pi drops it from the context anyway (an errored or aborted turn).
 */
export function findTrailingOrphanedToolCalls(
  branch: SessionEntry[],
  window: { since: number; until: number }
): { toolCallId: string; toolName: string }[] {
  const answered = new Set<string>()
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!
    if (entry.type === 'compaction' || entry.type === 'branch_summary' || entry.type === 'custom_message') return []
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'toolResult') {
      answered.add(message.toolCallId)
      continue
    }
    if (message.role === 'user') return []
    if (message.role !== 'assistant') continue
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return []
    if (message.timestamp < window.since || message.timestamp > window.until) return []
    return message.content
      .filter((part) => part.type === 'toolCall' && !answered.has(part.id))
      .map((part) => {
        const call = part as Extract<typeof part, { type: 'toolCall' }>
        return { toolCallId: call.id, toolName: call.name }
      })
  }
  return []
}

/**
 * Record the calls this interruption cut off, once per recovery notice. Returns the record, which
 * may list no calls (the interruption happened between tool calls).
 */
export function recordInterruptedToolCalls(
  session: RecordSession,
  interruption: HardInterruption
): InterruptedToolCallsRecord {
  const branch = session.getBranch()
  const existing = branch.find((entry) => isRecord(entry) && entry.data.noticeId === interruption.noticeId)
  if (existing && isRecord(existing)) return existing.data
  const recorded = new Set(
    branch.flatMap((entry) => (isRecord(entry) ? entry.data.calls.map((call) => call.toolCallId) : []))
  )
  const calls = findTrailingOrphanedToolCalls(branch, {
    since: Date.parse(interruption.executionStartedAt),
    until: Date.parse(interruption.recoveredAt),
  })
    .filter((call) => !recorded.has(call.toolCallId))
    .map((call) => ({ ...call, replay: toolReplay(call.toolName) }))
  const record: InterruptedToolCallsRecord = {
    noticeId: interruption.noticeId,
    executionId: interruption.executionId,
    cause: interruption.cause,
    recoveredAt: interruption.recoveredAt,
    calls,
  }
  session.appendCustomEntry(INTERRUPTED_TOOL_CALLS_TYPE, record)
  return record
}

/**
 * Whether the resumed prompt still needs the interruption notice: nothing has been added to the
 * conversation since this interruption was recorded. A pickup that failed before its prompt was
 * sent gets the notice again; a later requeue of the same run does not.
 */
export function interruptionNoticePending(session: Pick<SessionManager, 'getBranch'>, noticeId: string): boolean {
  const branch = session.getBranch()
  const index = branch.findIndex((entry) => isRecord(entry) && entry.data.noticeId === noticeId)
  return index >= 0 && !branch.slice(index + 1).some((entry) => entry.type === 'message')
}

function causeText(cause: InterruptionCause): string {
  return cause === 'lease_lapsed' ? 'an unexpected stop of the Ficus worker running it' : 'an unexpected Core restart'
}

/** The result the model sees for a call a hard interruption cut off. */
export function interruptedToolResultText(
  call: Pick<InterruptedToolCall, 'toolName' | 'replay'>,
  interruption: Pick<InterruptedToolCallsRecord, 'cause' | 'recoveredAt'>
): string {
  const lead = `The ${call.toolName} call was interrupted by ${causeText(interruption.cause)} before it returned a result (recovered at ${interruption.recoveredAt}). No output was kept.`
  if (call.replay === 'safe') return `${lead} ${call.toolName} only reads, so it is safe to run again.`
  if (call.replay === 'idempotent')
    return `${lead} It may or may not have completed. Running it again with the same arguments leaves the same final state, so it is safe to repeat.`
  return `${lead} It may have partially run or completed. Inspect the current state before retrying, and do not repeat an external side effect whose outcome is unknown.`
}

/** Every recorded cut-off call in the branch, by call ID. */
export function interruptedToolCalls(
  branch: SessionEntry[]
): Map<string, InterruptedToolCall & Pick<InterruptedToolCallsRecord, 'cause' | 'recoveredAt'>> {
  const calls = new Map<string, InterruptedToolCall & Pick<InterruptedToolCallsRecord, 'cause' | 'recoveredAt'>>()
  for (const entry of branch) {
    if (!isRecord(entry)) continue
    for (const call of entry.data.calls)
      if (!calls.has(call.toolCallId))
        calls.set(call.toolCallId, { ...call, cause: entry.data.cause, recoveredAt: entry.data.recoveredAt })
  }
  return calls
}

/**
 * Answer each recorded cut-off call that still has no result, right after its assistant message
 * and any results it did get, where pi-ai would otherwise put "No result provided". Returns the
 * messages unchanged (the same array) when there is nothing to answer.
 */
export function answerInterruptedToolCalls(
  messages: AgentMessage[],
  calls: ReturnType<typeof interruptedToolCalls>
): AgentMessage[] {
  if (calls.size === 0) return messages
  let result: AgentMessage[] | undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') continue
    const pending = message.content.filter(
      (part): part is Extract<typeof part, { type: 'toolCall' }> => part.type === 'toolCall' && calls.has(part.id)
    )
    if (pending.length === 0) continue
    let end = index + 1
    const answered = new Set<string>()
    while (end < messages.length && messages[end]!.role === 'toolResult') {
      answered.add((messages[end] as ToolResultMessage).toolCallId)
      end++
    }
    const missing = pending.filter((part) => !answered.has(part.id))
    if (missing.length === 0) continue
    result ??= messages.slice()
    const inserted: ToolResultMessage[] = missing.map((part) => {
      const call = calls.get(part.id)!
      return {
        role: 'toolResult',
        toolCallId: part.id,
        toolName: part.name,
        content: [{ type: 'text', text: interruptedToolResultText(call, call) }],
        isError: true,
        timestamp: message.timestamp,
      }
    })
    // Offsets shift by what earlier groups inserted.
    const offset = result.length - messages.length
    result.splice(end + offset, 0, ...inserted)
  }
  return result ?? messages
}

/** The pi extension that applies the recorded results to every model request. */
export function createInterruptedToolCallsExtension(): Extension {
  return {
    path: EXTENSION_PATH,
    resolvedPath: EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(EXTENSION_PATH, {
      source: 'ficus',
      scope: 'temporary',
      origin: 'top-level',
    }),
    handlers: new Map([
      [
        'context',
        [
          async (event: ContextEvent, ctx: ExtensionContext) => {
            const calls = interruptedToolCalls(ctx.sessionManager.getBranch())
            const messages = answerInterruptedToolCalls(event.messages, calls)
            // Context hooks operate on a copy; the session file keeps the call without a result.
            return messages === event.messages ? undefined : { messages }
          },
        ],
      ],
    ]) as Extension['handlers'],
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  }
}
