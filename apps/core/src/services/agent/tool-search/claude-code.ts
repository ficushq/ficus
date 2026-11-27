/**
 * Ficus's tool labels as the Claude Code bridge applies them.
 *
 * The bridge only sees the tools pi declares, without their labels, so each session's plan is
 * registered here by pi session id when the session is created, before its first request. The
 * plan is fixed for the session, so what the bridge derives from it (and puts in its signature)
 * never changes between turns.
 */
import { toolGroup } from './labels'
import type { ToolSearchPlan } from './plan'

/**
 * Claude Code reads these MCP tool `_meta` keys (the Claude Agent SDK's `tool()` helper sets them
 * from its `alwaysLoad` and `searchHint` options): `alwaysLoad` true loads the tool up front, never
 * behind tool search; `searchHint` is extra text its tool search matches.
 */
export const CLAUDE_CODE_ALWAYS_LOAD_META = 'anthropic/alwaysLoad'
export const CLAUDE_CODE_SEARCH_HINT_META = 'anthropic/searchHint'

export interface ClaudeCodeToolLabels {
  /** Tools Claude Code's tool search may hold back; every other tool is marked always-load. */
  deferred: ReadonlySet<string>
  /**
   * `ENABLE_TOOL_SEARCH` for the Claude Code process: `true` when tools are held back, `false`
   * otherwise (agent types with `search: off`, sessions under the size threshold), so Claude Code
   * declares every tool, as pi does for those sessions.
   */
  enableToolSearch: 'true' | 'false'
}

const MAX_SESSIONS = 2_000
const labels = new Map<string, ClaudeCodeToolLabels>()

/** Record the plan of a pi session for the bridge. */
export function registerClaudeCodeToolLabels(sessionId: string, plan: ToolSearchPlan): void {
  const deferred = new Set(plan.mode === 'claude-code' ? plan.hidden : [])
  labels.delete(sessionId)
  labels.set(sessionId, { deferred, enableToolSearch: deferred.size > 0 ? 'true' : 'false' })
  // Oldest first: drop sessions no longer in use. A dropped live session falls back to the default.
  while (labels.size > MAX_SESSIONS) labels.delete(labels.keys().next().value!)
}

/**
 * The labels of a pi session. A session that registered none (created outside AgentSession)
 * gets every tool loaded up front and Claude Code's tool search off.
 */
export function claudeCodeToolLabels(sessionId: string | undefined): ClaudeCodeToolLabels {
  return (sessionId ? labels.get(sessionId) : undefined) ?? { deferred: new Set(), enableToolSearch: 'false' }
}

/**
 * The MCP `_meta` of a tool the bridge lists: always-load unless Claude Code may defer it, and a
 * deferred tool carries its group's purpose as a search hint.
 */
export function claudeCodeToolMeta(name: string, toolLabels: ClaudeCodeToolLabels): Record<string, unknown> {
  if (!toolLabels.deferred.has(name)) return { [CLAUDE_CODE_ALWAYS_LOAD_META]: true }
  const group = toolGroup(name)
  return group ? { [CLAUDE_CODE_SEARCH_HINT_META]: group.description } : {}
}

export function clearClaudeCodeToolLabelsForTest(): void {
  labels.clear()
}
