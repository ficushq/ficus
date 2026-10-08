import {
  TOOL_FIREWALL_INTENTS,
  type MessageToolCall,
  type ToolFirewallFlag,
  type ToolFirewallIntent,
} from '@ficus/shared'

type JsonRecord = Record<string, unknown>

export type ToolInlineAction =
  | { kind: 'monitor'; key: string; monitorId: string; label: 'Open monitor' }
  | { kind: 'subagent'; key: string; subagentId: string; label: string }

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
  return monitorId ? [{ kind: 'monitor', key: `monitor:${monitorId}`, monitorId, label: 'Open monitor' }] : []
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
    actions.push({
      kind: 'subagent',
      key: `subagent:${subagentId}`,
      subagentId,
      label: nonBlankString(child.label) ?? subagentId,
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
  }
}
