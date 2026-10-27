import {
  TOOL_FIREWALL_INTENTS,
  type MessageToolCall,
  type ToolFirewallFlag,
  type ToolFirewallIntent,
} from '@ficus/shared'

type JsonRecord = Record<string, unknown>

/**
 * What the viewer needs to open an action. The row hides an action the viewer can't open.
 * - `permission`: checked in `squadId` when set (a cross-squad memory note), else in the chat's squad.
 * - `needs`: the action opens through the chat's own agent (its questions and artifacts) or squad (its memory),
 *   so the chat must know it.
 */
export type ToolInlineActionAccess = { permission?: string; squadId?: string; needs?: 'agent' | 'squad' }

/**
 * A link a completed tool call offers under its row (and under a collapsed group holding it).
 * Every kind carries its own `label`, the button's text and accessible name, so the row renders any kind
 * without per-kind branches; `key` identifies what it opens, so the same target shows once per group.
 */
export type ToolInlineAction = { key: string; label: string; access?: ToolInlineActionAccess } & (
  | { kind: 'monitor'; monitorId: string }
  | { kind: 'subagent'; subagentId: string; subagentLabel: string }
  | { kind: 'question'; questionId: string }
  /** `workStreamRef` is the work stream's id or its instance-wide number; lookups accept either. */
  | { kind: 'work_stream'; workStreamRef: string }
  | { kind: 'artifact'; artifactId: string; title?: string }
  | { kind: 'local_app'; localDeploymentId: string }
  /** `path` is in the memory viewer's `/memory/<rel>` form; `squadId` is set for a write to another squad. */
  | { kind: 'memory_note'; path: string; squadId?: string }
  | { kind: 'pull_request'; url: string; number: number }
)

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

/** Whether a tool's result details report success: not `success: false` and no `error`. */
function succeeded(details: JsonRecord | null): details is JsonRecord {
  return details !== null && details.success !== false && details.error === undefined
}

function extractQuestionActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const details = extractToolResultDetails(toolCall.result ?? '')
  const questionId = succeeded(details) ? nonBlankString(details.questionId) : null
  return questionId
    ? [
        {
          kind: 'question',
          key: `question:${questionId}`,
          label: 'View question',
          questionId,
          access: { needs: 'agent' },
        },
      ]
    : []
}

const workStreamAccess: ToolInlineActionAccess = { permission: 'workstreams:read' }

function extractNotifyContactActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const details = extractToolResultDetails(toolCall.result ?? '')
  const workStreamId = succeeded(details) ? nonBlankString(details.workStreamId) : null
  return workStreamId
    ? [
        {
          kind: 'work_stream',
          key: `work_stream:${workStreamId}`,
          label: 'Open work stream',
          workStreamRef: workStreamId,
          access: workStreamAccess,
        },
      ]
    : []
}

function extractArtifactActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const details = extractToolResultDetails(toolCall.result ?? '')
  if (!succeeded(details)) return []
  const manifest = isRecord(details.manifest) ? details.manifest : null
  const artifactId = nonBlankString(details.artifactId) ?? nonBlankString(manifest?.id)
  if (!artifactId) return []
  const title = nonBlankString(manifest?.title)
  return [
    {
      kind: 'artifact',
      key: `artifact:${artifactId}`,
      label: 'Open artifact',
      artifactId,
      ...(title ? { title } : {}),
      access: { permission: 'artifacts:read', needs: 'agent' },
    },
  ]
}

function extractLocalAppActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const localDeploymentId = nonBlankString(parseRecord(toolCall.args)?.localDeploymentId)
  if (!localDeploymentId) return []
  // A successful open has empty details or none (with a screenshot); a failure reports `details.error`.
  const result = parseRecord(toolCall.result ?? '')
  if (!result || (isRecord(result.details) && !succeeded(result.details))) return []
  return [
    {
      kind: 'local_app',
      key: `local_app:${localDeploymentId}`,
      label: 'Open app',
      localDeploymentId,
      access: { permission: 'deployments:read' },
    },
  ]
}

const SQUAD_MEMORY_ROOT = /^\/memory\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(.+)$/i

/**
 * A memory tool path in the memory viewer's `/memory/<rel>` form. Agents pass either a bare squad-relative path
 * or one under their squad memory root, which is `/memory/<squadId>` or a box's `<home>/memory`.
 */
export function normalizeMemoryNotePath(rawPath: string): string | null {
  const path = rawPath.trim()
  let relative: string
  if (path.startsWith('/')) {
    const match = SQUAD_MEMORY_ROOT.exec(path) ?? /\/memory\/(.+)$/.exec(path)
    if (!match) return null
    relative = match[1]!
  } else {
    relative = path.replace(/^(\.\/)+/, '')
  }
  const segments = relative.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return null
  return `/memory/${segments.join('/')}`
}

function extractMemoryNoteActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const args = parseRecord(toolCall.args)
  const details = extractToolResultDetails(toolCall.result ?? '')
  if (!args || !succeeded(details) || details.deleted === true) return []
  // memory_write with null content deletes the note.
  if (toolCall.toolName === 'memory_write' && args.content === null) return []
  const rawPath = nonBlankString(args.path) ?? nonBlankString(details.path)
  const path = rawPath ? normalizeMemoryNotePath(rawPath) : null
  if (!path) return []
  const squadId =
    nonBlankString(args.targetSquadId) ?? nonBlankString(details.targetSquadId) ?? nonBlankString(args.squad)
  return [
    {
      kind: 'memory_note',
      key: `memory_note:${squadId ?? ''}:${path}`,
      label: 'Open note',
      path,
      ...(squadId ? { squadId } : {}),
      access: { permission: 'memory:read', needs: 'squad', ...(squadId ? { squadId } : {}) },
    },
  ]
}

const PULL_REQUEST_URL = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+$/

/** The PRs and work streams Core recognized a shell command creating (`details.createdLinks`). */
function extractShellCreatedLinkActions(toolCall: MessageToolCall): ToolInlineAction[] {
  const details = extractToolResultDetails(toolCall.result ?? '')
  if (!succeeded(details) || !Array.isArray(details.createdLinks)) return []
  const actions: ToolInlineAction[] = []
  const seen = new Set<string>()
  const add = (action: ToolInlineAction) => {
    if (seen.has(action.key)) return
    seen.add(action.key)
    actions.push(action)
  }
  for (const link of details.createdLinks) {
    if (!isRecord(link)) continue
    const number =
      typeof link.number === 'number' && Number.isSafeInteger(link.number) && link.number > 0 ? link.number : null
    if (link.kind === 'pull_request') {
      const url = nonBlankString(link.url)
      if (!url || !number || !PULL_REQUEST_URL.test(url)) continue
      add({ kind: 'pull_request', key: `pull_request:${url}`, label: `Open PR #${number}`, url, number })
    } else if (link.kind === 'work_stream') {
      const workStreamRef = number ? String(number) : nonBlankString(link.id)
      if (!workStreamRef) continue
      add({
        kind: 'work_stream',
        key: `work_stream:${workStreamRef}`,
        label: number ? `Open work stream #${number}` : 'Open work stream',
        workStreamRef,
        access: workStreamAccess,
      })
    }
  }
  return actions
}

type ActionExtractor = (toolCall: MessageToolCall) => ToolInlineAction[]
const extractors: Partial<Record<string, ActionExtractor>> = {
  monitor: extractMonitorActions,
  dispatch: extractDispatchActions,
  ask_human: extractQuestionActions,
  notify_contact: extractNotifyContactActions,
  artifact_publish: extractArtifactActions,
  browser_open: extractLocalAppActions,
  memory_write: extractMemoryNoteActions,
  memory_patch: extractMemoryNoteActions,
  memory_append: extractMemoryNoteActions,
  bash: extractShellCreatedLinkActions,
  squad_bash: extractShellCreatedLinkActions,
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
