import type { StreamingContentBlock } from '@ficus/client-react'
import type { ContentBlock } from '@ficus/shared'

/**
 * Presentation helpers for assistant content blocks, following the web's
 * MessageContent / tool-renderers: consecutive thinking + tool blocks collapse
 * into one group, each tool call gets a one-line summary of its arguments.
 */
export type AnyBlock = ContentBlock | StreamingContentBlock

export type BlockGroup<B extends AnyBlock = AnyBlock> =
  | { type: 'single'; block: B; index: number }
  | { type: 'group'; blocks: B[]; startIndex: number }

/** Text blocks break groups; runs of 2+ thinking/tool blocks collapse into one row. */
export function groupBlocks<B extends AnyBlock>(blocks: B[]): BlockGroup<B>[] {
  const out: BlockGroup<B>[] = []
  let run: B[] = []
  let runStart = 0
  const flush = () => {
    if (run.length === 1) out.push({ type: 'single', block: run[0], index: runStart })
    else if (run.length > 1) out.push({ type: 'group', blocks: run, startIndex: runStart })
    run = []
  }
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      flush()
      out.push({ type: 'single', block, index })
    } else {
      if (run.length === 0) runStart = index
      run.push(block)
    }
  })
  flush()
  return out
}

/** "3 tools • 1 thinking" */
export function groupSummary(blocks: AnyBlock[]): string {
  const tools = blocks.filter((b) => b.type === 'tool_use').length
  const thinking = blocks.filter((b) => b.type === 'thinking').length
  const parts: string[] = []
  if (tools > 0) parts.push(`${tools} tool${tools !== 1 ? 's' : ''}`)
  if (thinking > 0) parts.push(`${thinking} thinking`)
  return parts.join(' • ')
}

export function thinkingLabel(durationMs: number | undefined, streamingSeconds?: number): string {
  if (streamingSeconds !== undefined) return `Thinking for ${streamingSeconds}s…`
  const secs = durationMs === undefined ? null : (durationMs / 1000).toFixed(1)
  return secs && secs !== '0.0' ? `Thought for ${secs}s` : 'Thought for a moment'
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

type Args = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const count = (v: unknown, noun: string) => {
  const n = Array.isArray(v) ? v.length : 0
  return `${n} ${noun}${n !== 1 ? 's' : ''}`
}

/** The web's per-tool `summary(args)` for agent and site-assistant tools. */
const SUMMARIES: Record<string, (args: Args) => string> = {
  read: (a) => {
    let s = str(a.path)
    const offset = num(a.offset)
    const limit = num(a.limit)
    if (offset !== undefined || limit !== undefined) {
      s += `:${offset ?? 0}`
      if (limit !== undefined) s += `-${(offset ?? 0) + limit}`
    }
    return s
  },
  bash: (a) => truncate(str(a.command), 60),
  squad_bash: (a) => truncate(str(a.command), 60),
  edit: (a) => (a.path ? basename(str(a.path)) : ''),
  write: (a) => (a.path ? basename(str(a.path)) : ''),
  grep: (a) => `"${truncate(str(a.pattern), 30)}"${a.path ? ` ${str(a.path)}` : ''}`,
  find: (a) => `"${truncate(str(a.pattern), 30)}"${a.path ? ` ${str(a.path)}` : ''}`,
  ls: (a) => str(a.path) || '.',
  ask_human: (a) => count(a.questions, 'question'),
  navigate: (a) => str(a.path),
  request_next_beat: (a) => str(a.delay),
  notify_contact: (a) => {
    const icon = a.urgency === 'action_needed' ? '🔴' : a.urgency === 'warning' ? '🟡' : '🔵'
    return `${icon} ${truncate(str(a.message), 50)}`
  },
  memory_search: (a) => truncate(str(a.query) || str(a.q), 60),
  memory_get: (a) => str(a.path),
  dispatch: (a) => {
    const n = Array.isArray(a.subagents) ? a.subagents.length : 0
    return `${n} subagent${n === 1 ? '' : 's'}`
  },
  check_subagents: () => 'check status',
  stop_subagent: (a) => str(a.subagentId),
  delegate_task: (a) => `Background task: ${truncate(str(a.label) || 'background task', 60)}`,
  assistant_inbox: () => 'Task update',
  search_ficus: (a) => `Searched Ficus for “${truncate(str(a.query) || str(a.q), 40)}”`,
}

function parseArgs(args: string): Args | null {
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Args) : null
  } catch {
    return null
  }
}

/** One-line argument summary for a tool call row, or null when there's nothing useful to show. */
export function toolSummary(toolName: string, args: string | undefined): string | null {
  const summarize = SUMMARIES[toolName]
  if (!summarize || !args) return null
  const parsed = parseArgs(args)
  if (!parsed) return null
  const summary = summarize(parsed)
  return summary ? truncate(summary, 50) : null
}

function processCarriageReturns(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r')
      return i === -1 ? line : line.slice(i + 1)
    })
    .join('\n')
}

/** Tool results are often `{ content: [{ type: 'text', text }] }`; show their text. */
export function resultText(result: string): string {
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown }).content)) {
      const content = (parsed as { content: Array<{ type?: unknown; text?: unknown }> }).content
      return processCarriageReturns(
        content
          .filter((c) => c.type === 'text')
          .map((c) => str(c.text))
          .join('\n')
      )
    }
  } catch {
    // plain text result
  }
  return processCarriageReturns(result)
}

/** Pretty-print JSON args when possible. */
export function prettyArgs(args: string): string {
  const parsed = parseArgs(args)
  return parsed ? JSON.stringify(parsed, null, 2) : args
}
