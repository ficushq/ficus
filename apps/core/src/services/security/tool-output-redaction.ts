/**
 * Tool-output redaction.
 *
 * Every byte a tool produces leaves `execute` through one of three channels, and
 * each one is redacted here before pi sees it:
 *
 * - The returned result. `content` is what the model reads and the session file
 *   stores; `details` is stored with it and, like `structuredContent`, is
 *   serialized into the `tool_execution_end` event that clients receive and the
 *   persisted chat message keeps.
 * - A thrown error. pi turns `error.message` into the model-visible error result,
 *   and pi's bash tool throws on timeout/abort with the output in the message.
 * - `onUpdate` partials. They never reach the model, but they are streamed to
 *   clients as `tool_update` events and a run that stops mid-command persists
 *   the last one as the tool's result.
 *
 * Partials need more than exact-value replacement. pi's shell tools stream a
 * cumulative snapshot of the output so far, so a stored value still being
 * printed can sit at the end of one snapshot as an incomplete prefix that
 * exact matching cannot see. Each partial therefore holds back a trailing
 * fragment that starts a stored value (at most one value's length; the next
 * snapshot or the final result shows it, redacted if it completes). A snapshot
 * or result whose start was truncated away can likewise begin with the end of a
 * value, so truncated text also drops such a leading fragment.
 *
 * It is total: agents run with `noTools: 'builtin'`, so wrapping the registered
 * tool list covers every tool the agent can call, including ones added later.
 *
 * Content the agent itself authored (tool arguments, assistant text) is not
 * redacted. It is the operator's own data on the way back to the operator.
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ContentSafetyPort } from './content-safety'

/** A stored-value match found in content the original tool already produced. */
export interface StoredToolResultMatch {
  toolCallId: string
  storedKeys: readonly string[]
}

export type OnStoredToolResult = (match: StoredToolResultMatch) => Promise<void> | void

/** pi's footer on output whose start was truncated away (results and thrown errors). */
const HEAD_TRUNCATION_FOOTER = /\n\n\[Showing [^\n]*Full output: [^\n]*\]/
/** pi's marker between the head and tail of truncated `structuredContent.output`. */
const OMISSION_MARKER = /\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/

type Phase = 'partial' | 'final'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHeadTruncated(text: string, details: unknown): boolean {
  return (
    (isRecord(details) && isRecord(details.truncation) && details.truncation.truncated === true) ||
    HEAD_TRUNCATION_FOOTER.test(text)
  )
}

/** Remove stored-value fragments cut at the edges of redacted output. */
function trimFragments(value: unknown, phase: Phase, safety: ContentSafetyPort): unknown {
  if (typeof value === 'string') {
    return safety.trimStoredValueFragments(value, {
      leading: isHeadTruncated(value, undefined),
      trailing: phase === 'partial',
    })
  }
  if (!isRecord(value)) return value
  const { details } = value
  const output: Record<string, unknown> = { ...value }
  if (Array.isArray(value.content)) {
    output.content = value.content.map((block: unknown) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return block
      const text = safety.trimStoredValueFragments(block.text, {
        leading: isHeadTruncated(block.text, details),
        trailing: phase === 'partial',
      })
      return text === block.text ? block : { ...block, text }
    })
  }
  // pi's shell details repeat the shown (truncated) text as `truncation.content`.
  if (isRecord(details) && isRecord(details.truncation) && typeof details.truncation.content === 'string') {
    output.details = {
      ...details,
      truncation: {
        ...details.truncation,
        content: safety.trimStoredValueFragments(details.truncation.content, {
          leading: details.truncation.truncated === true,
          trailing: phase === 'partial',
        }),
      },
    }
  }
  const structured = value.structuredContent
  if (isRecord(structured) && structured.truncated === true && typeof structured.output === 'string') {
    // Head and tail of the full output: values can be cut on both sides of the omission.
    const marker = OMISSION_MARKER.exec(structured.output)
    if (marker) {
      const head = structured.output.slice(0, marker.index)
      const tail = structured.output.slice(marker.index + marker[0].length)
      output.structuredContent = {
        ...structured,
        output:
          safety.trimStoredValueFragments(head, { trailing: true }) +
          marker[0] +
          safety.trimStoredValueFragments(tail, { leading: true }),
      }
    }
  }
  return output
}

/**
 * Wrap one tool so its results, partial updates and errors are redacted before
 * the model, clients or storage see them.
 *
 * `onStoredToolResult` observes stored-value matches in raw tool output after
 * the tool produced it and before the redacted copy reaches the caller — the
 * truthful post-execution audit point. Observing never changes what is returned.
 */
export function wrapToolWithOutputRedaction<T extends ToolDefinition>(
  tool: T,
  safety: ContentSafetyPort,
  onStoredToolResult?: OnStoredToolResult
): T {
  const execute = tool.execute.bind(tool) as (...args: unknown[]) => Promise<unknown>
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const toolCallId = args[0] as string
      const report = async (storedKeys: readonly string[]): Promise<void> => {
        if (storedKeys.length > 0 && onStoredToolResult) await onStoredToolResult({ toolCallId, storedKeys })
      }
      const redact = <V>(value: V, phase: Phase): { value: V; report: Promise<void> } => {
        const inspected = redactOutput(value, safety)
        return { value: trimFragments(inspected.value, phase, safety) as V, report: report(inspected.storedKeys) }
      }

      const onUpdate = args[3]
      if (typeof onUpdate === 'function') {
        args[3] = (partial: unknown) => {
          const safe = redact(partial, 'partial')
          // Deliver in order; pi awaits the returned promise before finishing the call.
          return Promise.all([onUpdate(safe.value), safe.report]).then(() => undefined)
        }
      }

      let result: unknown
      try {
        result = await execute(...args)
      } catch (error) {
        throw await redactThrown(error, safety, report)
      }
      if (result === null || result === undefined) return result
      const safe = redact(result, 'final')
      await safe.report
      return safe.value
    },
  } as unknown as T
}

/**
 * Redact a result or partial. `details` is free-form tool metadata; if it holds
 * something the redactor refuses (an accessor, a promise), drop it rather than
 * fail the tool or pass it through unredacted.
 */
function redactOutput<V>(value: V, safety: ContentSafetyPort): { value: V; storedKeys: readonly string[] } {
  try {
    return safety.redactWithStoredKeys(value)
  } catch (error) {
    if (!isRecord(value) || value.details === undefined) throw error
    return safety.redactWithStoredKeys({ ...value, details: undefined })
  }
}

/** Redact a thrown value; pi shows `error.message` (or `String(error)`) to the model. */
async function redactThrown(
  error: unknown,
  safety: ContentSafetyPort,
  report: (storedKeys: readonly string[]) => Promise<void>
): Promise<unknown> {
  const inspected = safety.redactWithStoredKeys(error)
  await report(inspected.storedKeys)
  const safe = inspected.value
  if (typeof safe === 'string') return trimFragments(safe, 'final', safety)
  if (!(safe instanceof Error)) return safe
  const truncated = isHeadTruncated(safe.message, undefined)
  // Nothing to hide: keep the original so its class and fields survive for callers.
  if (
    error instanceof Error &&
    !truncated &&
    inspected.storedKeys.length === 0 &&
    safe.message === error.message &&
    safe.stack === error.stack
  ) {
    return error
  }
  if (!truncated) return safe
  const message = safety.trimStoredValueFragments(safe.message, { leading: true })
  if (message === safe.message) return safe
  // The stack starts with the message, fragment included.
  if (safe.stack) {
    safe.stack = safe.stack.includes(safe.message)
      ? safe.stack.replace(safe.message, message)
      : `${safe.name}: ${message}`
  }
  safe.message = message
  return safe
}

/** Wrap every registered tool. Applied once at session construction. */
export function wrapToolsWithOutputRedaction<T extends ToolDefinition>(
  tools: readonly T[],
  safety: ContentSafetyPort,
  onStoredToolResult?: OnStoredToolResult
): T[] {
  return tools.map((tool) => wrapToolWithOutputRedaction(tool, safety, onStoredToolResult))
}
