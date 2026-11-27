/**
 * Applying a session's tool-search plan to pi.
 */
import { getCurrentTools } from '@earendil-works/pi-ai'
import { createToolSearchExtension, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { toolGroup } from './labels'
import type { ToolSearchPlan } from './plan'
import { TOOL_SEARCH_TOOL_NAME } from './prompt'

/** The pi session operations tool search needs. */
export interface ToolSearchSession {
  getActiveToolNames(): string[]
  getAllTools(): ReturnType<ExtensionAPI['getAllTools']>
  setActiveToolsByName(names: string[]): void
  sessionManager: { getBranch(): readonly unknown[] }
}

/**
 * Mark the plan's hidden tools `deferred`, with their group as namespace, so pi registers them
 * without declaring them and `tool_search` can find them. Applied to the already wrapped
 * definitions, so the firewall, recovery, redaction and content-safety wrappers run for a tool
 * whether it was declared up front or loaded later. Other plans leave the tools as they are.
 */
export function labelToolForPlan<T extends ToolDefinition>(tool: T, plan: ToolSearchPlan): T {
  if (plan.mode !== 'search' || !plan.hidden.includes(tool.name)) return tool
  const group = toolGroup(tool.name)
  return {
    ...tool,
    exposure: 'deferred',
    ...(group ? { namespace: { name: group.name, description: group.description } } : {}),
  }
}

/**
 * pi's `tool_search` tool, bound to a session that is created after it. pi only exports the tool
 * as an extension factory; the factory registers exactly one tool and reads and sets the active
 * tools through the extension API at call time, so a lazy binding to the session is enough.
 */
export function createToolSearchTool(getSession: () => ToolSearchSession | undefined): ToolDefinition {
  const session = () => {
    const current = getSession()
    if (!current) throw new Error('tool_search is not ready yet')
    return current
  }
  const registered: ToolDefinition[] = []
  const api = {
    registerTool: (definition: ToolDefinition) => registered.push(definition),
    getActiveTools: () => session().getActiveToolNames(),
    getAllTools: () => session().getAllTools(),
    setActiveTools: (names: string[]) => session().setActiveToolsByName(names),
  }
  createToolSearchExtension()(api as unknown as ExtensionAPI)
  const tool = registered.find((definition) => definition.name === TOOL_SEARCH_TOOL_NAME)
  if (registered.length !== 1 || !tool) throw new Error('pi tool search extension did not register tool_search')
  return tool
}

/** Names of the tools the session transcript currently declares (including tools loaded earlier). */
function transcriptToolNames(session: ToolSearchSession): Set<string> {
  const systemMessages = session.sessionManager.getBranch().flatMap((entry) => {
    const candidate = entry as { type?: string; message?: { role?: string } }
    return candidate.type === 'message' && candidate.message?.role === 'system' ? [candidate.message] : []
  })
  return new Set(getCurrentTools(systemMessages as Parameters<typeof getCurrentTools>[0]).map((tool) => tool.name))
}

/**
 * Activate `tool_search`, and every hidden tool the session loaded on an earlier turn. pi restores
 * a session's tools from its transcript only when it manages the default tools itself, which
 * Ficus turns off, so each new pi session over the same session file restores them here. The
 * result equals the transcript's tool set, so resuming records no tool change.
 */
export function activateToolSearch(session: ToolSearchSession, plan: ToolSearchPlan): void {
  if (plan.mode !== 'search') return
  const declared = transcriptToolNames(session)
  const loaded = plan.hidden.filter((name) => declared.has(name))
  const active = session.getActiveToolNames()
  session.setActiveToolsByName([...new Set([...active, TOOL_SEARCH_TOOL_NAME, ...loaded])])
}
