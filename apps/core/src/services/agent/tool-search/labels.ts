/**
 * Which Ficus tools a session declares up front and which it may load on demand.
 *
 * Every tool has a runtime-neutral label: `direct` tools are declared on every request,
 * `deferrable` tools may be held back and loaded when the agent asks for them. pi's
 * `tool_search` and Claude Code's own tool search both read the same labels.
 *
 * The global defaults are the `label` field of the tool metadata table
 * (`apps/core/src/tools/metadata.ts`, next to each tool's replay class). An agent type can override
 * them in its YAML:
 *
 * ```yaml
 * tools:
 *   search: auto     # auto | on | off
 *   direct: [browser_*]
 *   deferred: [webfetch]
 * ```
 */
import type { AgentTypeToolSearchPolicy } from '@ficus/shared'
import { toolNameMatchesAny, toolNameMatchesPattern } from '../../../lib/tools'
import { classifiedTools, toolMetadata, type ToolLabel } from '../../../tools/metadata'

export type { ToolLabel }

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
}

/**
 * Tool groups in prompt order. A group names and describes tools; it does not label them (the
 * tool metadata table does). The browser, code navigation and checklist tools default to
 * `deferrable`; the subagent and monitor tools default to `direct` and keep a namespace for agent
 * types that defer them.
 */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    name: 'browser',
    description:
      'Browser automation and visual review: open a page, click, type, scroll, read text, take a screenshot, read console logs',
    tools: ['browser_*'],
  },
  {
    name: 'code_navigation',
    description:
      'Code navigation: list the symbols in a file, find references to a symbol, rename a symbol across the codebase',
    tools: ['ast_*'],
  },
  {
    name: 'subagents',
    description: 'Subagents: dispatch scoped tasks to ephemeral subagents, check their status, stop one',
    tools: ['dispatch', 'check_subagents', 'stop_subagent'],
  },
  {
    name: 'monitors',
    description: 'Background monitors: watch a long-running command and receive its events',
    tools: ['monitor'],
  },
  {
    name: 'checklist',
    description: 'Checklist: add, list, toggle, update and remove todo items',
    tools: ['todo_*'],
  },
]

/** The group a tool belongs to, if any. */
export function toolGroup(name: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => toolNameMatchesAny(group.tools, name))
}

/**
 * The tool's label: the agent type's override when it names the tool, else the global default from
 * the tool metadata table (`direct` for a tool the table does not list).
 */
export function resolveToolLabel(name: string, policy?: ToolSearchPolicy | null): ToolLabel {
  if (policy?.direct && toolNameMatchesAny(policy.direct, name)) return 'direct'
  if (policy?.deferred && toolNameMatchesAny(policy.deferred, name)) return 'deferrable'
  return toolMetadata(name).label
}

/**
 * Patterns in the override's `direct` and `deferred` lists that match no known Ficus tool, so typos
 * are caught. The known tools are the ones in the tool metadata table, which lists every built-in
 * tool. Integration and extension tools are not in it; a pattern that matches only those is
 * reported too, which is why the check warns rather than fails.
 */
export function unknownToolSearchNames(policy: ToolSearchPolicy): string[] {
  const known = [...classifiedTools().keys()]
  const matchesKnown = (pattern: string) => known.some((name) => toolNameMatchesPattern(pattern, name))
  return [...(policy.direct ?? []), ...(policy.deferred ?? [])].filter((pattern) => !matchesKnown(pattern))
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
