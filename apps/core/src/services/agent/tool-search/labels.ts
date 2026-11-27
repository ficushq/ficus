/**
 * Which Ficus tools a session declares up front and which it may load on demand.
 *
 * Every tool has a runtime-neutral label: `direct` tools are declared on every request,
 * `deferrable` tools may be held back and loaded when the agent asks for them. pi's
 * `tool_search` and Claude Code's own tool search both read the same labels.
 *
 * The labels are global defaults (below), which an agent type can override in its YAML:
 *
 * ```yaml
 * tools:
 *   search: auto     # auto | on | off
 *   direct: [browser_*]
 *   deferred: [webfetch]
 * ```
 */
import type { AgentTypeToolSearchPolicy } from '@ficus/shared'
import { toolNameMatchesAny } from '../../../lib/tools'

export type ToolLabel = 'direct' | 'deferrable'

/** An agent type's override of the global labels (`tools.search`, `tools.direct`, `tools.deferred`). */
export type ToolSearchPolicy = AgentTypeToolSearchPolicy

/** `auto` decides per session (size and provider), `on` skips the size check, `off` declares every tool. */
export type ToolSearchMode = NonNullable<ToolSearchPolicy['search']>

export const TOOL_SEARCH_MODES: readonly ToolSearchMode[] = ['auto', 'on', 'off']

/** A group of related tools, so a search for "screenshot the page" finds the browser tools. */
export interface ToolGroup {
  /** pi namespace name. */
  name: string
  /** Short purpose shown in the system prompt and searched by `tool_search`. */
  description: string
  /** Name patterns of the tools in the group. */
  tools: string[]
  /** The group's global default label. */
  label: ToolLabel
}

/**
 * Tool groups in prompt order. Only rarely used, heavy tools default to `deferrable`; the tools the
 * system prompt tells every agent to use by name (shell, files, memory, ask_human, notify_contact,
 * sandbox_status, short-term memory, set_agent_purpose) stay `direct`. A tool in no group is `direct`.
 */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    name: 'browser',
    description:
      'Browser automation and visual review: open a page, click, type, scroll, read text, take a screenshot, read console logs',
    tools: ['browser_*'],
    label: 'deferrable',
  },
  {
    name: 'code_navigation',
    description:
      'Code navigation: list the symbols in a file, find references to a symbol, rename a symbol across the codebase',
    tools: ['ast_*'],
    label: 'deferrable',
  },
  {
    name: 'subagents',
    description: 'Subagents: dispatch scoped tasks to ephemeral subagents, check their status, stop one',
    tools: ['dispatch', 'check_subagents', 'stop_subagent'],
    label: 'deferrable',
  },
  {
    name: 'monitors',
    description: 'Background monitors: watch a long-running command and receive its events',
    tools: ['monitor'],
    label: 'deferrable',
  },
  {
    name: 'checklist',
    description: 'Checklist: add, list, toggle, update and remove todo items',
    tools: ['todo_*'],
    label: 'deferrable',
  },
]

/** The group a tool belongs to, if any. */
export function toolGroup(name: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => toolNameMatchesAny(group.tools, name))
}

/** The tool's label: the agent type's override when it names the tool, else the global default. */
export function resolveToolLabel(name: string, policy?: ToolSearchPolicy | null): ToolLabel {
  if (policy?.direct && toolNameMatchesAny(policy.direct, name)) return 'direct'
  if (policy?.deferred && toolNameMatchesAny(policy.deferred, name)) return 'deferrable'
  return toolGroup(name)?.label ?? 'direct'
}

/** The tool's search mode, `auto` when the agent type does not set one. */
export function resolveToolSearchMode(policy?: ToolSearchPolicy | null): ToolSearchMode {
  return policy?.search ?? 'auto'
}

/**
 * Validate the `search`, `direct` and `deferred` keys of an agent type's `tools` object. Returns
 * undefined when none is set. Throws a message naming the bad key.
 */
export function parseToolSearchPolicy(tools: Record<string, unknown>): ToolSearchPolicy | undefined {
  const policy: ToolSearchPolicy = {}
  if (tools.search !== undefined && tools.search !== null) {
    if (typeof tools.search !== 'string' || !TOOL_SEARCH_MODES.includes(tools.search as ToolSearchMode)) {
      throw new Error(`'tools.search' must be one of ${TOOL_SEARCH_MODES.join(', ')}`)
    }
    policy.search = tools.search as ToolSearchMode
  }
  for (const key of ['direct', 'deferred'] as const) {
    const value = tools[key]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      throw new Error(`'tools.${key}' must be an array of tool names`)
    }
    policy[key] = value as string[]
  }
  return Object.keys(policy).length > 0 ? policy : undefined
}

/** Whether a stored value is a well-formed policy, for values read back from the database or metadata. */
export function isToolSearchPolicy(value: unknown): value is ToolSearchPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    parseToolSearchPolicy(value as Record<string, unknown>)
    return Object.keys(value).every((key) => key === 'search' || key === 'direct' || key === 'deferred')
  } catch {
    return false
  }
}
