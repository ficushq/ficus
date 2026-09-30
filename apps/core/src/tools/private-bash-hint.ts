import type { AgentTool } from '@earendil-works/pi-agent-core'

/**
 * Self-correcting private `bash` for squad members on the vm runtime.
 *
 * On the vm runtime a member's private box is a separate unix user from the
 * squad box, so a private `bash` command that touches the shared squad
 * workspace fails with "Permission denied". The system prompt says so, but in
 * practice models still try `cd <squad workspace>` in `bash` first, and some of
 * them then conclude that `squad_bash` does not exist and give up on the
 * shared workspace entirely (observed live: subagents reporting "my sandbox
 * lacks the squad_bash tool" to their parent while the tool was registered).
 *
 * The cheapest fix is to answer the failure at the point it happens: when a
 * private bash result mentions "Permission denied" AND the command or output
 * references a shared squad path, append a hint naming `squad_bash`.
 */
export interface SharedWorkspaceHintOptions {
  /** Absolute shared paths private bash cannot reach (workspace, memory). */
  sharedRoots: string[]
  /** The shared squad workspace mount, named in the hint as squad_bash's cwd. */
  workspaceMount: string
}

const PERMISSION_DENIED = /permission denied/i

export function buildSharedWorkspaceHint(workspaceMount: string): string {
  return (
    `[Ficus] \`${workspaceMount}\` is the SHARED squad workspace. Private \`bash\` runs in your own box and cannot see it; ` +
    `run this command with \`squad_bash\` instead (it starts in \`${workspaceMount}\`). ` +
    '`read`/`write`/`edit` reach shared paths by absolute path.'
  )
}

/** True when a private-bash outcome looks like a denied touch of a shared squad path. */
export function needsSharedWorkspaceHint(
  input: { command: string; output: string },
  options: SharedWorkspaceHintOptions
): boolean {
  if (!PERMISSION_DENIED.test(input.output)) return false
  const haystack = `${input.command}\n${input.output}`
  return options.sharedRoots.some((root) => root && haystack.includes(root))
}

function appendHint(text: string, hint: string): string {
  if (text.includes(hint)) return text
  return text.length === 0 ? hint : `${text}\n\n${hint}`
}

/**
 * Wrap a private bash tool so a denied touch of a shared squad path comes back
 * with the `squad_bash` hint, whether pi's bash tool returns the result (a zero
 * exit such as `... || true`, or a non-zero exit, which pi reports as an
 * `isError` result) or throws (timeouts, aborts, missing exit codes).
 */
export function withSharedWorkspaceHint<T extends AgentTool<any>>(tool: T, options: SharedWorkspaceHintOptions): T {
  const hint = buildSharedWorkspaceHint(options.workspaceMount)
  const execute = tool.execute.bind(tool)
  tool.execute = async (toolCallId, params, signal, onUpdate) => {
    const command =
      typeof (params as { command?: unknown })?.command === 'string' ? (params as { command: string }).command : ''
    try {
      const result = await execute(toolCallId, params, signal, onUpdate)
      const blocks = Array.isArray(result?.content) ? result.content : []
      const output = blocks
        .filter(
          (block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string'
        )
        .map((block) => block.text)
        .join('\n')
      if (!needsSharedWorkspaceHint({ command, output }, options)) return result
      const last = [...blocks].reverse().find((block) => block?.type === 'text')
      if (last && last.type === 'text') {
        last.text = appendHint(last.text, hint)
      } else {
        blocks.push({ type: 'text', text: hint })
      }
      return { ...result, content: blocks }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if (!needsSharedWorkspaceHint({ command, output: error.message }, options)) throw error
      error.message = appendHint(error.message, hint)
      throw error
    }
  }
  return tool
}
