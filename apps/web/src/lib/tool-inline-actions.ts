import {
  TOOL_FIREWALL_INTENTS,
  type MessageToolCall,
  type ToolFirewallFlag,
  type ToolFirewallIntent,
} from '@ficus/shared'

type JsonRecord = Record<string, unknown>

/**
 * A link a completed tool call offers under its row (and under a collapsed group holding it).
 * Every kind carries its own `label`, the button's text and accessible name, so the row renders any kind
 * without per-kind branches; `key` identifies what it opens, so the same target shows once per group.
 */
export type ToolInlineAction =
  | { kind: 'monitor'; key: string; label: string; monitorId: string }
  | { kind: 'subagent'; key: string; label: string; subagentId: string; subagentLabel: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function extractToolResultDetails(result: string): JsonRecord | null {
  const parsed = parseRecord(result)
  return parsed && isRecord(parsed.details) ? parsed.details : null
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function extractMonitorActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const args = parseRecord(toolCall.args)
  const details = extractToolResultDetails(toolCall.result ?? '')
  if (args?.action !== 'create' || !details || details.success === false) return []
  const monitorId = nonBlankString(details.monitorId)
  return monitorId ? [{ kind: 'monitor', key: `monitor:${monitorId}`, label: 'Open monitor', monitorId }] : []
}

function extractDispatchActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const details = extractToolResultDetails(toolCall.result ?? '')
  if (!details || details.success === false || !Array.isArray(details.subagents)) return []
  const seen = new Set<string>()
  const actions: ToolInlineAction[] = []
  for (const child of details.subagents) {
    if (!isRecord(child)) continue
    const subagentId = nonBlankString(child.subagentId)
    if (!subagentId || seen.has(subagentId)) continue
    seen.add(subagentId)
    const subagentLabel = nonBlankString(child.label) ?? subagentId
    actions.push({
      kind: 'subagent',
      key: `subagent:${subagentId}`,
      label: `Open ${subagentLabel} chat`,
      subagentId,
      subagentLabel,
    })
  }
  return actions
}

type ActionExtractor = (toolCall: MessageToolCall) => ToolInlineAction[]
const extractors: Partial<Record<string, ActionExtractor>> = {
  monitor: extractMonitorActions,
  dispatch: extractDispatchActions,
}

export function getToolInlineActions(input: { toolCall: MessageToolCall; completed: boolean }): ToolInlineAction[] {
  if (!input.completed || input.toolCall.isError || !input.toolCall.result) return []
  return extractors[input.toolCall.toolName]?.(input.toolCall) ?? []
}

/** A transcript block as either renderer holds it: saved blocks carry only the call, live ones also `_done`. */
export type InlineActionBlock = { type: string; toolCall?: MessageToolCall; _done?: boolean }

/**
 * Every inline action of the completed tool calls in a run of blocks, in call order, each target once (by `key`):
 * what a collapsed group shows under its header. A completed call is one whose row would show its actions:
 * saved calls once they have a result or an error, live calls (`live`) once marked `_done`.
 */
export function getBlocksInlineActions(
  blocks: ReadonlyArray<InlineActionBlock>,
  options: { live?: boolean } = {}
): ToolInlineAction[] {
  const seen = new Set<string>()
  const actions: ToolInlineAction[] = []
  for (const block of blocks) {
    if (block.type !== 'tool_use' || !block.toolCall) continue
    const { toolCall } = block
    const completed = options.live ? block._done === true : Boolean(toolCall.result) || toolCall.isError
    for (const action of getToolInlineActions({ toolCall, completed })) {
      if (seen.has(action.key)) continue
      seen.add(action.key)
      actions.push(action)
    }
  }
  return actions
}

/** The tool result firewall's flag on a tool call, when it found instructions aimed at the agent. */
export function getToolFirewallFlag(toolCall: Pick<MessageToolCall, 'result'>): ToolFirewallFlag | null {
  const firewall = extractToolResultDetails(toolCall.result ?? '')?.firewall
  if (!isRecord(firewall) || firewall.flagged !== true || typeof firewall.instructsAgent !== 'number') return null
  return {
    flagged: true,
    severity: firewall.severity === 'high' ? 'high' : 'medium',
    instructsAgent: firewall.instructsAgent,
    ...(TOOL_FIREWALL_INTENTS.includes(firewall.intent as ToolFirewallIntent)
      ? { intent: firewall.intent as ToolFirewallIntent }
      : {}),
    ...(firewall.partial === true ? { partial: true } : {}),
    ...(firewall.withheld === true ? { withheld: true } : {}),
  }
}
