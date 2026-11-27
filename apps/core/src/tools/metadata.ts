/**
 * Runtime-neutral metadata for Ficus tools, in one place.
 *
 * `replay` says what running a call again does when its first run's outcome is unknown (a hard
 * Core restart cut it off, or its sandbox went away mid-call):
 *
 * - `safe`: the tool only reads. Running it again changes nothing.
 * - `idempotent`: the tool changes state, but running it again with the same arguments leaves the
 *   same final state (an overwrite, or a guarded change that a repeat refuses).
 * - `unsafe`: running it again may repeat an effect (an append, a new question, a sent message, a
 *   shell command), or its effect depends on state the first run may have changed.
 *
 * Ficus never reruns a call by itself. The class picks the result the model sees for a call a hard
 * restart cut off (`services/agent/interrupted-tool-calls.ts`) and whether an interrupted call
 * spends the unexplained-failure budget (`services/recovery/runtime.ts`).
 *
 * Every built-in tool is listed by exact name. A tool that is not listed, such as a tool from a
 * pi extension or an integration added later, is `unsafe`. The table is authoritative: a tool's
 * own self-description cannot make Ficus treat it as safer.
 *
 * The same shape is meant to carry the tool-search label (`direct` or `deferrable`) as a second
 * field, so both labels are read from one table instead of two parallel mechanisms.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

export type ToolReplay = 'safe' | 'idempotent' | 'unsafe'

export const TOOL_REPLAY_CLASSES: readonly ToolReplay[] = ['safe', 'idempotent', 'unsafe']

/** What Ficus knows about a tool, whatever runtime (pi or the Claude Code bridge) runs it. */
export interface ToolMetadata {
  replay: ToolReplay
}

/** The class of a tool no one classified. */
export const DEFAULT_TOOL_METADATA: Readonly<ToolMetadata> = Object.freeze({ replay: 'unsafe' })

interface ToolMetadataGroup extends ToolMetadata {
  /** Why these tools have this class, for a reviewer changing one. */
  why: string
  tools: readonly string[]
}

const TOOL_METADATA_GROUPS: readonly ToolMetadataGroup[] = [
  {
    replay: 'safe',
    why: 'Reads only.',
    tools: [
      // Files and workspace
      'read',
      'read_attachment',
      'sandbox_status',
      // Memory and notes
      'memory_get',
      'memory_search',
      'memory_outline',
      'memory_backlinks',
      'short_term_memory_read',
      'todo_list',
      // Subagents
      'check_subagents',
      // Web
      'websearch',
      'web_search_exa',
      'webfetch',
      // Browser: reads the current page, does not act on it
      'browser_read',
      'browser_screenshot',
      'browser_console',
      // Code navigation (the code-ast extension)
      'ast_symbols',
      'ast_references',
      // Routing
      'suggest_squad',
      // BigBrain vault reads
      'bigbrain_load_memory',
      'bigbrain_search_vault',
      'bigbrain_read_note',
      'bigbrain_shared_vaults',
      'bigbrain_shared_overview',
      'bigbrain_shared_search_vault',
      'bigbrain_shared_read_record',
      'bigbrain_shared_recent',
      // Assistant reads
      'list_conversation_images',
      'read_task_update',
      'list_task_updates',
      'list_tasks',
      'get_work',
      'read_activity',
      'list_squads',
      'search_ficus',
      'read_squad_files',
      'read_thread',
      'read_inbox',
      'read_conversation_history',
    ],
  },
  {
    replay: 'idempotent',
    why: 'Overwrites with the given value, or makes a guarded change that a repeat refuses or leaves as is.',
    tools: [
      // Overwrites
      'write',
      'memory_write',
      'short_term_memory_write',
      'set_agent_purpose',
      'im_done',
      'artifact_status',
      'channel_edit',
      // Loads tools into the session; a repeat finds them already loaded
      'tool_search',
      // A repeat is refused or has nothing left to do
      'stop_subagent',
      'mark_read',
      'answer_question',
      'continue_task',
      'retry_task',
      'cancel_task',
      'ast_rename',
    ],
  },
  {
    replay: 'unsafe',
    why: 'A repeat can duplicate an effect, or the effect depends on state the first run may have changed.',
    tools: [
      // Arbitrary commands
      'bash',
      'squad_bash',
      // Exact-match replace: a repeat applies again when the new text contains the old text
      'edit',
      'memory_patch',
      'short_term_memory_edit',
      // Appends, and index-based or toggling list changes
      'memory_append',
      'todo_add',
      'todo_remove',
      'todo_toggle',
      'todo_update',
      // Creates a record, sends a message or starts work
      'ask_human',
      'notify_contact',
      'dispatch',
      'monitor',
      'channel_respond',
      'channel_send',
      'artifact_question',
      // Appends to the artifact's publish history and announces it again
      'artifact_publish',
      // Navigation reloads the page and drops the state earlier steps built; navigate with a
      // prompt shows the person another link
      'browser_open',
      'navigate',
      'delegate_task',
      'message_agent',
      'bigbrain_drop',
      // Acts on the current page
      'browser_click',
      'browser_type',
      'browser_scroll',
    ],
  },
]

const TOOL_METADATA = new Map<string, ToolMetadata>()
for (const group of TOOL_METADATA_GROUPS) {
  for (const name of group.tools) {
    if (TOOL_METADATA.has(name)) throw new Error(`Tool ${name} is classified twice`)
    TOOL_METADATA.set(name, Object.freeze({ replay: group.replay }))
  }
}

/** Every classified tool name with its metadata. */
export function classifiedTools(): ReadonlyMap<string, ToolMetadata> {
  return TOOL_METADATA
}

/** The tool's metadata; a tool no one classified is `unsafe`. */
export function toolMetadata(name: string): ToolMetadata {
  return TOOL_METADATA.get(name) ?? DEFAULT_TOOL_METADATA
}

export function toolReplay(name: string): ToolReplay {
  return toolMetadata(name).replay
}

/** Whether running the call again after an unknown outcome is harmless. */
export function replayIsHarmless(replay: ToolReplay): boolean {
  return replay !== 'unsafe'
}

/**
 * pi's tool annotations (the MCP hint vocabulary) for a class, so runtimes that read standard hints
 * see the same classification. Unclassified tools keep whatever annotations they declare.
 */
function annotationsFor(replay: ToolReplay): NonNullable<ToolDefinition['annotations']> {
  if (replay === 'safe') return { readOnlyHint: true }
  return { readOnlyHint: false, idempotentHint: replay === 'idempotent' }
}

/** A tool definition that carries its Ficus metadata. */
export type ClassifiedToolDefinition<T extends ToolDefinition = ToolDefinition> = T & { ficus: ToolMetadata }

/**
 * Put the tool's classification on its definition: `ficus` for Ficus code, `annotations` for pi and
 * other readers of the standard hints. The recovery wrapper applies it to every session tool,
 * extension tools included. Any `ficus` value the tool brought is replaced by the table's.
 */
export function withToolMetadata<T extends ToolDefinition>(tool: T): ClassifiedToolDefinition<T> {
  const classified = TOOL_METADATA.get(tool.name)
  return {
    ...tool,
    ficus: classified ?? DEFAULT_TOOL_METADATA,
    ...(classified ? { annotations: { ...tool.annotations, ...annotationsFor(classified.replay) } } : {}),
  }
}
