/**
 * Line buffer behind Settings → Logs.
 *
 * The system logs WebSocket sends raw log bytes in arbitrary chunks. This module
 * splits them into lines, parses ANSI colors into styled spans, recognises the
 * `[api] ` / `[worker] ` prefix the server adds to every line, and guesses a
 * level so errors and warnings stand out. Lines live in fixed-size blocks: a
 * full block is never changed again, so the view can skip re-rendering it and
 * the search can cache its matches.
 */
import { parseAnsiCodes } from '../AnsiText'

export type SystemLogComponent = 'api' | 'worker'
export type SystemLogLevel = 'error' | 'warn' | 'debug'
/** `log` is a line from the stream; `info` and `error` are the stream's own control messages. */
export type SystemLogKind = 'log' | 'info' | 'error'

export interface SystemLogSpan {
  text: string
  className?: string
}

export interface SystemLogLine {
  /** Unique for the buffer's lifetime, including across clears. */
  id: number
  kind: SystemLogKind
  component: SystemLogComponent | null
  level: SystemLogLevel | null
  /** Visible text, exactly the concatenation of `spans`. */
  text: string
  spans: readonly SystemLogSpan[]
}

export interface SystemLogBlock {
  key: number
  lines: readonly SystemLogLine[]
}

export interface SystemLogSnapshot {
  blocks: readonly SystemLogBlock[]
  /** The trailing line that has not ended with a newline yet. */
  partial: SystemLogLine | null
  /** Complete lines appended since the last clear, including any already trimmed. */
  appended: number
  lineCount: number
}

export interface SystemLogMatch {
  lineId: number
  start: number
  end: number
}

/** Matches the previous xterm scrollback. */
export const SYSTEM_LOG_MAX_LINES = 10_000
export const SYSTEM_LOG_BLOCK_SIZE = 200

const COMPONENT_PREFIX = /^\[(api|worker)\] /
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/g
// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
// Every other C0 control except tab, plus a lone ESC left over from a sequence split across lines.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
// 256-color and truecolor arguments are not mapped; drop them so their numbers are not read as other codes.
const EXTENDED_COLOR = /(^|;)[34]8;(?:5;\d*|2;\d*;\d*;\d*)/g
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/

const ANSI_CLASS: Record<string, string> = {
  'ansi-black': 'log-ansi-black',
  'ansi-red': 'log-ansi-red',
  'ansi-green': 'log-ansi-green',
  'ansi-yellow': 'log-ansi-yellow',
  'ansi-blue': 'log-ansi-blue',
  'ansi-magenta': 'log-ansi-magenta',
  'ansi-cyan': 'log-ansi-cyan',
  'ansi-white': 'log-ansi-white',
  'ansi-bright-black': 'log-ansi-bright-black',
  'ansi-bright-red': 'log-ansi-bright-red',
  'ansi-bright-green': 'log-ansi-bright-green',
  'ansi-bright-yellow': 'log-ansi-bright-yellow',
  'ansi-bright-blue': 'log-ansi-bright-blue',
  'ansi-bright-magenta': 'log-ansi-bright-magenta',
  'ansi-bright-cyan': 'log-ansi-bright-cyan',
  'ansi-bright-white': 'log-ansi-bright-white',
}

const COLOR_LEVEL: Record<string, SystemLogLevel> = {
  'ansi-red': 'error',
  'ansi-bright-red': 'error',
  'ansi-yellow': 'warn',
  'ansi-bright-yellow': 'warn',
  'ansi-bright-black': 'debug',
}

interface SgrState {
  fg?: string
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

interface StyledSpan {
  text: string
  fg?: string
  className?: string
}

function classNameFor(state: SgrState): string | undefined {
  const classes: string[] = []
  if (state.fg && ANSI_CLASS[state.fg]) classes.push(ANSI_CLASS[state.fg])
  if (state.bold) classes.push('font-bold')
  if (state.dim) classes.push('opacity-60')
  if (state.underline) classes.push('underline')
  return classes.length ? classes.join(' ') : undefined
}

function applySgr(state: SgrState, params: string): SgrState {
  const codes = params.replace(EXTENDED_COLOR, '$1')
  // An empty parameter list (ESC[m) is a reset; ignore what would only be left-over separators.
  if (params !== '' && codes.replace(/;/g, '') === '') return state
  const changes = parseAnsiCodes(codes)
  const next: SgrState = { ...state }
  if ('fg' in changes) next.fg = changes.fg
  if ('bold' in changes) next.bold = changes.bold
  if ('dim' in changes) next.dim = changes.dim
  if ('underline' in changes) next.underline = changes.underline
  return next
}

/** Split one raw line into styled spans, carrying SGR state across lines as a terminal does. */
function parseAnsi(raw: string, initial: SgrState): { spans: StyledSpan[]; state: SgrState } {
  const spans: StyledSpan[] = []
  let state = initial
  const push = (text: string) => {
    const clean = text.replace(CONTROL, '')
    if (!clean) return
    const className = classNameFor(state)
    const last = spans.at(-1)
    if (last && last.className === className && last.fg === state.fg) last.text += clean
    else spans.push({ text: clean, fg: state.fg, className })
  }
  let index = 0
  for (const match of raw.matchAll(CSI)) {
    push(raw.slice(index, match.index))
    if (match[2] === 'm') state = applySgr(state, match[1])
    index = match.index + match[0].length
  }
  push(raw.slice(index))
  return { spans, state }
}

/** The color most of the line's visible characters use, ignoring whitespace. */
function dominantColorLevel(spans: readonly StyledSpan[]): SystemLogLevel | null {
  const counts = new Map<string, number>()
  for (const span of spans) {
    const visible = span.text.replace(/\s/g, '').length
    if (visible) counts.set(span.fg ?? '', (counts.get(span.fg ?? '') ?? 0) + visible)
  }
  let best = ''
  let bestCount = 0
  for (const [fg, count] of counts) {
    if (count > bestCount) {
      best = fg
      bestCount = count
    }
  }
  return COLOR_LEVEL[best] ?? null
}

const STACK_FRAME = /^\s+at\s+\S/
const LEVEL_FIELD_ERROR = /\blevel["']?\s*[:=]\s*["']?(?:error|fatal|50|60)\b/i
const LEVEL_FIELD_WARN = /\blevel["']?\s*[:=]\s*["']?(?:warn|warning|40)\b/i
const ERROR_START = /^(?:error|exception|fatal|panic|failed|failure|uncaught|unhandled)\b/i
const ERROR_TYPE_START = /^[A-Z]\w*(?:Error|Exception)\b/
const ERROR_WORD = /\b(?:ERROR|FATAL|PANIC)\b|(?:^|\s)(?:[A-Z]\w*)?Error: /
const WARN_START = /^(?:warn|warning|deprecated)\b/i
const WARN_WORD = /\b(?:WARN|WARNING)\b/
// The HTTP access log: `--> GET /path 500 133ms`.
const HTTP_SERVER_ERROR = /(?:-->|<--)\s+[A-Z]+\s+\S+\s+5\d\d\b/
const LEADING_TAGS = /^(?:\[[^\]]*\]\s*)+/

/**
 * Production logs usually carry no colors, so the level is guessed from the text:
 * an error-like word at the start of the message (after the timestamp and the
 * `[service]` tag), an upper-case ERROR/WARN, a `level=` field, a stack frame or
 * an HTTP 5xx. Colored logs use the dominant color instead.
 */
export function detectLevel(message: string, spans: readonly StyledSpan[] = []): SystemLogLevel | null {
  const colored = dominantColorLevel(spans)
  if (colored) return colored
  if (STACK_FRAME.test(message)) return 'error'
  const rest = message.trimStart().replace(TIMESTAMP, '').trimStart()
  const body = rest.replace(LEADING_TAGS, '')
  if (
    LEVEL_FIELD_ERROR.test(message) ||
    ERROR_START.test(body) ||
    ERROR_TYPE_START.test(body) ||
    ERROR_WORD.test(rest) ||
    HTTP_SERVER_ERROR.test(body)
  )
    return 'error'
  if (LEVEL_FIELD_WARN.test(message) || WARN_START.test(body) || WARN_WORD.test(rest)) return 'warn'
  return null
}

/** What a carriage return leaves visible: the text after the last one, unless it only ends the line. */
function afterCarriageReturn(raw: string): string {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const index = trimmed.lastIndexOf('\r')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

export function parseSystemLogLine(
  raw: string,
  id: number,
  state: SgrState = {}
): { line: SystemLogLine; state: SgrState } {
  let text = afterCarriageReturn(raw).replace(OSC, '')
  const prefix = COMPONENT_PREFIX.exec(text)
  const component = (prefix?.[1] as SystemLogComponent | undefined) ?? null
  if (prefix) text = text.slice(prefix[0].length)
  const parsed = parseAnsi(text, state)
  const message = parsed.spans
  const level = detectLevel(message.map((span) => span.text).join(''), message)
  const spans: SystemLogSpan[] = []
  if (prefix) spans.push({ text: prefix[0], className: `ficus-log-component ficus-log-component-${component}` })
  const first = message[0]
  const timestamp = first && !first.className ? TIMESTAMP.exec(first.text) : null
  for (const [index, span] of message.entries()) {
    if (index === 0 && timestamp) {
      spans.push({ text: timestamp[0], className: 'ficus-log-timestamp' })
      if (span.text.length > timestamp[0].length) spans.push({ text: span.text.slice(timestamp[0].length) })
    } else {
      spans.push(span.className ? { text: span.text, className: span.className } : { text: span.text })
    }
  }
  return {
    line: { id, kind: 'log', component, level, text: spans.map((span) => span.text).join(''), spans },
    state: parsed.state,
  }
}

export class SystemLogBuffer {
  private blocks: SystemLogBlock[] = []
  private partial: SystemLogLine | null = null
  private pending = ''
  private state: SgrState = {}
  private nextId = 0
  private nextBlockKey = 0
  private appended = 0
  private lineCount = 0

  constructor(
    private readonly maxLines = SYSTEM_LOG_MAX_LINES,
    private readonly blockSize = SYSTEM_LOG_BLOCK_SIZE
  ) {}

  /** Append decoded log text. A trailing piece without a newline stays visible as the partial line. */
  appendText(text: string): void {
    if (!text) return
    const pieces = (this.pending + text).split('\n')
    this.pending = pieces.pop() ?? ''
    const lines: SystemLogLine[] = []
    for (const raw of pieces) {
      const parsed = parseSystemLogLine(raw, this.nextId++, this.state)
      this.state = parsed.state
      lines.push(parsed.line)
    }
    this.push(lines)
    this.partial = this.pending ? parseSystemLogLine(this.pending, this.nextId, this.state).line : null
  }

  /** A control message from the stream ends any partial line and sits on its own line. */
  appendControl(kind: 'info' | 'error', message: string): void {
    const lines: SystemLogLine[] = []
    if (this.pending) {
      const parsed = parseSystemLogLine(this.pending, this.nextId++, this.state)
      this.state = parsed.state
      lines.push(parsed.line)
      this.pending = ''
      this.partial = null
    }
    const text = `[${message}]`
    lines.push({
      id: this.nextId++,
      kind,
      component: null,
      level: kind === 'error' ? 'error' : null,
      text,
      spans: [{ text }],
    })
    this.push(lines)
  }

  clear(): void {
    this.blocks = []
    this.partial = null
    this.pending = ''
    this.state = {}
    this.appended = 0
    this.lineCount = 0
  }

  snapshot(): SystemLogSnapshot {
    return { blocks: this.blocks, partial: this.partial, appended: this.appended, lineCount: this.lineCount }
  }

  private push(lines: SystemLogLine[]): void {
    if (lines.length === 0) return
    // Copy on write: the outer array and the changed blocks are new objects, untouched blocks keep their identity.
    const blocks = this.blocks.slice()
    let tail: SystemLogLine[] | null = null
    for (const line of lines) {
      const last = blocks.at(-1)
      if (!tail && last && last.lines.length < this.blockSize) {
        tail = last.lines.slice()
        blocks[blocks.length - 1] = { key: last.key, lines: tail }
      }
      if (!tail || tail.length >= this.blockSize) {
        tail = []
        blocks.push({ key: this.nextBlockKey++, lines: tail })
      }
      tail.push(line)
    }
    this.appended += lines.length
    this.lineCount += lines.length
    let excess = this.lineCount - this.maxLines
    while (excess > 0 && blocks.length > 0) {
      const first = blocks[0]
      if (first.lines.length <= excess) {
        blocks.shift()
        excess -= first.lines.length
        this.lineCount -= first.lines.length
      } else {
        blocks[0] = { key: first.key, lines: first.lines.slice(excess) }
        this.lineCount -= excess
        excess = 0
      }
    }
    this.blocks = blocks
  }
}

export function findMatchesInLine(line: SystemLogLine, needle: string): SystemLogMatch[] {
  if (!needle) return []
  const haystack = line.text.toLowerCase()
  const matches: SystemLogMatch[] = []
  for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + needle.length)) {
    matches.push({ lineId: line.id, start, end: start + needle.length })
  }
  return matches
}

// Blocks never change once created (a changed block is a new object), so their matches can be cached.
const blockMatchCache = new WeakMap<SystemLogBlock, { needle: string; matches: SystemLogMatch[] }>()

function blockMatches(block: SystemLogBlock, needle: string): SystemLogMatch[] {
  const cached = blockMatchCache.get(block)
  if (cached?.needle === needle) return cached.matches
  const matches = block.lines.flatMap((line) => findMatchesInLine(line, needle))
  blockMatchCache.set(block, { needle, matches })
  return matches
}

/** Case-insensitive matches in display order, oldest first. */
export function searchSystemLog(
  snapshot: Pick<SystemLogSnapshot, 'blocks' | 'partial'>,
  query: string
): SystemLogMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches = snapshot.blocks.flatMap((block) => blockMatches(block, needle))
  if (snapshot.partial) matches.push(...findMatchesInLine(snapshot.partial, needle))
  return matches
}

export function sameMatch(a: SystemLogMatch | null, b: SystemLogMatch | null): boolean {
  return !!a && !!b && a.lineId === b.lineId && a.start === b.start
}
