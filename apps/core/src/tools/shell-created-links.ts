/**
 * Shell created links
 *
 * When a shell command creates a pull request (`gh pr create`) or a work stream
 * (`ficus workstream create` / `ficus ws create`), the shell tool result gets
 * `details.createdLinks`, so the chat can offer "Open PR #N" / "Open work stream #N"
 * under the call without guessing from arbitrary output in the client.
 *
 * The recognizer is deliberately conservative: the command must have exited 0,
 * the command text must invoke the creating command, and the output must contain
 * that command's own success line (a bare PR URL on its own line for `gh`; the
 * CLI's "Created work stream #N: …" line for Ficus).
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

export type ShellCreatedLink =
  { kind: 'pull_request'; url: string; number: number } | { kind: 'work_stream'; number: number }

/** The shell tools whose results can carry created links. */
const SHELL_TOOL_NAMES = new Set(['bash', 'squad_bash'])

// `gh pr create` at the start of a command or after a separator, not inside another word or path.
const GH_PR_CREATE = /(?:^|[\s;&|(`$])gh\s+pr\s+create\b/m
// `ficus [global options] workstream|ws create`, within one command (no separator in between).
const FICUS_WS_CREATE = /(?:^|[\s;&|(`$])ficus(?:\s+[^\s;&|]+)*?\s+(?:workstream|ws)\s+create\b/m
// `gh pr create` prints the new PR's URL alone on a line.
const PR_URL_LINE = /^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+)$/
// The Ficus CLI's create confirmation; a reused (`--from-event`) stream prints a different line.
const WS_CREATED_LINE = /^Created work stream #(\d+): /

/**
 * Links created by a successful shell command, recognized from its command text and output.
 * Returns nothing unless the command both invoked a creating command and printed its success line.
 */
export function recognizeShellCreatedLinks(command: string, output: string): ShellCreatedLink[] {
  const createsPr = GH_PR_CREATE.test(command)
  const createsWorkStream = FICUS_WS_CREATE.test(command)
  if (!createsPr && !createsWorkStream) return []

  const links: ShellCreatedLink[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const pr = createsPr ? PR_URL_LINE.exec(line) : null
    if (pr) {
      const key = `pr:${line}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ kind: 'pull_request', url: line, number: Number(pr[1]) })
      }
      continue
    }
    const workStream = createsWorkStream ? WS_CREATED_LINE.exec(line) : null
    if (workStream) {
      const key = `ws:${workStream[1]}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ kind: 'work_stream', number: Number(workStream[1]) })
      }
    }
  }
  return links.filter((link) => Number.isSafeInteger(link.number) && link.number > 0)
}

type ShellToolResult = {
  content?: Array<{ type: string; text?: string }>
  details?: unknown
  structuredContent?: { output?: unknown; exit_code?: unknown }
  isError?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Add `details.createdLinks` to a successful shell result whose command created a PR or work stream. */
export function withShellCreatedLinks<R>(params: unknown, result: R): R {
  const shell = result as ShellToolResult
  if (!shell || shell.isError || !isRecord(params) || typeof params.command !== 'string') return result
  const exitCode = shell.structuredContent?.exit_code
  if (exitCode !== undefined && exitCode !== 0) return result
  const output =
    typeof shell.structuredContent?.output === 'string'
      ? shell.structuredContent.output
      : (shell.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
  const createdLinks = recognizeShellCreatedLinks(params.command, output)
  if (createdLinks.length === 0) return result
  return { ...shell, details: { ...(isRecord(shell.details) ? shell.details : {}), createdLinks } } as R
}

/** Wrap the shell tools so their results carry created links; other tools are returned as they are. */
export function wrapShellToolsWithCreatedLinks<T extends ToolDefinition>(tools: readonly T[]): T[] {
  return tools.map((tool) => {
    if (!SHELL_TOOL_NAMES.has(tool.name)) return tool
    const execute = tool.execute.bind(tool) as (...args: unknown[]) => Promise<unknown>
    return {
      ...tool,
      execute: async (...args: unknown[]) => withShellCreatedLinks(args[1], await execute(...args)),
    } as unknown as T
  })
}
