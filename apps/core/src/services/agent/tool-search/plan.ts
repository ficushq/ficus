/**
 * The once-per-session decision of which tools a session holds back for on-demand loading.
 *
 * Decided when a session starts and recorded in its session file, so every later turn, resume
 * and compaction of that session uses the same starting tool set and the same system prompt.
 */
import type { Api, Model } from '@earendil-works/pi-ai'
import { resolveToolLabel, resolveToolSearchMode, type ToolSearchPolicy } from './labels'

/**
 * Below this many estimated tokens of deferrable tool schemas, `auto` declares every tool.
 *
 * A `tool_search` load costs a round trip (one extra model call that re-reads the cached prompt)
 * and, on providers without cache-safe additions, a cache miss. Holding back fewer than about
 * 2,500 tokens saves less per request than one such round trip costs, so it is not worth it.
 * 2,500 sits in the middle of the 2,000 to 3,000 range agreed for this check. Measured on the real
 * tool factories (estimated tokens): browser 584, ast about 400, subagents 479, monitor 824,
 * todo 641. No group reaches it, and neither do the default deferrable groups together
 * (browser, ast and todo, about 1,630), so `auto` declares every tool for the shipped engineer and
 * manager; an agent type turns search on with `search: on` or by deferring more tools.
 */
export const TOOL_SEARCH_MIN_DEFERRED_TOKENS = 2_500

/** pi estimates tokens as characters divided by four; the threshold uses the same estimate. */
const CHARS_PER_TOKEN = 4

/** The parts of a tool that are declared to the model. */
export interface DeclaredTool {
  name: string
  description: string
  parameters: unknown
}

/** Estimated tokens a tool's declaration costs on every request. */
export function estimateToolTokens(tool: DeclaredTool): number {
  return Math.ceil(
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters ?? {} }).length /
      CHARS_PER_TOKEN
  )
}

/**
 * Whether the model's transport can add tools in the middle of a conversation without
 * rewriting the head of the request, so a `tool_search` load keeps the prompt cache:
 * Anthropic inline tool changes, OpenAI Responses `additional_tools` or client tool search,
 * and Chat Completions providers that accept mid-conversation tool additions. These are the
 * conditions pi's transports check before they send tool changes in place.
 */
export function supportsMidConversationToolAdditions(model: Pick<Model<Api>, 'api' | 'compat'>): boolean {
  const compat = (model.compat ?? {}) as Record<string, unknown>
  const midConvoSystem = compat.supportsMidConvoSystemMessages === true
  switch (model.api) {
    case 'anthropic-messages':
      return midConvoSystem && compat.supportsMidConvoToolChanges === true
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return compat.supportsToolSearch === true || (midConvoSystem && compat.supportsAdditionalTools === true)
    case 'openai-completions':
      return midConvoSystem && compat.supportsMidConvoToolAdditions === true
    default:
      return false
  }
}

/**
 * How the session reaches its deferrable tools:
 * - `search`: pi's `tool_search` is registered; `hidden` tools are not declared until loaded.
 * - `direct`: every tool is declared on every request; no `tool_search`.
 * - `claude-code`: the session runs through the Claude Code bridge. pi declares every tool (so the
 *   bridge's tool set never changes), and Claude Code's own tool search holds back `hidden`.
 */
export type ToolSearchSessionMode = 'search' | 'direct' | 'claude-code'

export interface ToolSearchPlan {
  mode: ToolSearchSessionMode
  /** Tools held back at session start, sorted. Empty in `direct` mode. */
  hidden: string[]
  /** Why, for logs and tests. */
  reason: string
}

export interface ToolSearchCapability {
  /** The session's model can add tools mid-conversation (failover candidates are not checked; see capability.ts). */
  supportsToolAdditions: boolean
  /** The session runs through the Claude Code bridge. */
  claudeCode: boolean
}

/** Decide a new session's plan from its tools, the agent type's policy and the model's capability. */
export function planToolSearch(input: {
  tools: readonly DeclaredTool[]
  policy?: ToolSearchPolicy | null
  capability: ToolSearchCapability
  minDeferredTokens?: number
}): ToolSearchPlan {
  const mode = resolveToolSearchMode(input.policy)
  const minTokens = input.minDeferredTokens ?? TOOL_SEARCH_MIN_DEFERRED_TOKENS
  if (mode === 'off') return { mode: 'direct', hidden: [], reason: 'search is off for this agent type' }
  const deferrable = input.tools.filter((tool) => resolveToolLabel(tool.name, input.policy) === 'deferrable')
  if (deferrable.length === 0) return { mode: 'direct', hidden: [], reason: 'no deferrable tools' }
  const tokens = deferrable.reduce((sum, tool) => sum + estimateToolTokens(tool), 0)
  if (mode === 'auto' && tokens < minTokens) {
    return { mode: 'direct', hidden: [], reason: `deferrable tools are ${tokens} tokens, under ${minTokens}` }
  }
  const hidden = [...new Set(deferrable.map((tool) => tool.name))].sort()
  // Claude Code has its own tool search; pi's would restart the Claude Code process on every load.
  if (input.capability.claudeCode) {
    return { mode: 'claude-code', hidden, reason: `Claude Code holds back ${tokens} tokens of tools` }
  }
  if (!input.capability.supportsToolAdditions) {
    return { mode: 'direct', hidden: [], reason: 'the model cannot add tools mid-conversation' }
  }
  return { mode: 'search', hidden, reason: `holding back ${tokens} tokens of tools` }
}

/** Custom session-file entry that records a session's plan. */
export const TOOL_SEARCH_ENTRY_TYPE = 'ficus.tool-search'

interface RecordedPlan {
  version: 1
  mode: ToolSearchSessionMode
  hidden: string[]
}

/** The session-file operations the plan needs; pi's SessionManager provides them. */
export interface PlanStore {
  getEntries(): readonly unknown[]
  appendCustomEntry(customType: string, data?: unknown): string
}

/** The plan recorded in a session file, if any. */
export function readRecordedPlan(store: PlanStore): ToolSearchPlan | undefined {
  for (const entry of [...store.getEntries()].reverse()) {
    const candidate = entry as { type?: string; customType?: string; data?: Partial<RecordedPlan> }
    if (candidate.type !== 'custom' || candidate.customType !== TOOL_SEARCH_ENTRY_TYPE) continue
    const data = candidate.data
    if (
      data?.version !== 1 ||
      (data.mode !== 'search' && data.mode !== 'direct' && data.mode !== 'claude-code') ||
      !Array.isArray(data.hidden)
    ) {
      continue
    }
    return { mode: data.mode, hidden: data.hidden.filter((name) => typeof name === 'string'), reason: 'recorded' }
  }
  return undefined
}

/** Whether the session file already holds a conversation (a session that started before plans were recorded). */
function hasConversation(store: PlanStore): boolean {
  return store.getEntries().some((entry) => (entry as { type?: string }).type === 'message')
}

/**
 * The session's plan: the one recorded in its session file, or a new one that is recorded now.
 *
 * A session that already has a conversation but no recorded plan started before tool search, with
 * every tool declared; it keeps doing that, so its tool set does not change mid-conversation.
 * A recorded plan only names tools the session still has; a tool added since then is declared.
 */
export function resolveSessionPlan(
  store: PlanStore,
  decide: () => ToolSearchPlan,
  registeredToolNames: readonly string[]
): ToolSearchPlan {
  const recorded = readRecordedPlan(store)
  const registered = new Set(registeredToolNames)
  if (recorded) return { ...recorded, hidden: recorded.hidden.filter((name) => registered.has(name)) }
  const plan = hasConversation(store)
    ? { mode: 'direct' as const, hidden: [], reason: 'session started before tool search' }
    : decide()
  store.appendCustomEntry(TOOL_SEARCH_ENTRY_TYPE, {
    version: 1,
    mode: plan.mode,
    hidden: plan.hidden,
  } satisfies RecordedPlan)
  return plan
}
