import { SUBAGENT_STATUS_ROLE } from '@ficus/shared'
import { extractToolResultDetails } from './tool-inline-actions'
import { webStatus } from './statusPresentation'
import clsx from 'clsx'
import { parse as parsePartialJson } from 'partial-json'
import { type FC, type ReactNode, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AnsiText } from '../components/AnsiText'
import { parseMemoryProvenance, stripProvenanceBlock } from './memory-provenance'
import { ClockIcon, QuestionIcon, StopIcon } from '../components/icons'
import { ArgsScrollBox, FollowScrollBox, ToolArgsFollowProvider } from './follow-scroll'
import { extractResultImages, imageSrcsFromContent, toolImageAlt, withoutImagePlaceholder } from './tool-result-images'
import { ToolImageStrip } from '../components/ToolImageStrip'

// --- Types ---

export interface ToolRenderer {
  summary: (args: Record<string, any>) => string
  /**
   * `partial` is set when `args` is a best-effort parse of arguments that are still streaming in
   * (only for renderers that opt in with `streamingArgs`).
   */
  ArgsView: FC<{ args: Record<string, any>; partial?: boolean }>
  ResultView: FC<{ result: string; isError: boolean; autoScroll?: boolean }>
  /** Pure bookkeeping (e.g. marking a message read): chat transcripts leave the call out entirely. */
  hidden?: boolean
  /**
   * While the call is in progress and its JSON arguments are still incomplete, `summary` and `ArgsView`
   * receive a partial parse instead of the raw fallback. They must then tolerate missing fields, cut-off
   * strings and half-built array entries (e.g. `{}` or an option without its `value`).
   */
  streamingArgs?: boolean
}

/** Drop tool calls whose renderer marks them hidden; every other block keeps its order. */
export function withoutHiddenToolCalls<B extends { type: string }>(blocks: B[], renderers: ToolRenderers): B[] {
  const visible = blocks.filter((block) => {
    if (block.type !== 'tool_use') return true
    const toolName = (block as { toolCall?: { toolName?: string } }).toolCall?.toolName
    return !(toolName && renderers[toolName]?.hidden)
  })
  return visible.length === blocks.length ? blocks : visible
}

// --- Helpers ---

/** Parse Pi SDK result format and extract plain text from content[].text */
/**
 * Process carriage returns in terminal output for display.
 * Terminal progress indicators use \r to rewrite the current line in-place.
 * This collapses those into just the final version of each line.
 */
function processCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      return parts[parts.length - 1]
    })
    .join('\n')
}

/**
 * The text of a tool result. When the result also carries an image that the chat shows as a thumbnail,
 * the read tool's "Read image file [image/png]" stand-in line is dropped; other text is kept.
 */
export function extractResultText(result: string): string {
  try {
    const parsed = JSON.parse(result)
    if (parsed?.content && Array.isArray(parsed.content)) {
      const text = parsed.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      const showsImage = imageSrcsFromContent(parsed.content).length > 0
      return processCarriageReturns(showsImage ? withoutImagePlaceholder(text).trim() : text)
    }
    // If it's a plain string or doesn't have content array, return as-is
    return processCarriageReturns(result)
  } catch {
    return processCarriageReturns(result)
  }
}

function tryParseArgs(args: string): Record<string, any> | null {
  try {
    return JSON.parse(args)
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string field of partially parsed args, or '' when it is missing (or not a string yet). */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Best-effort parse of JSON that may still be streaming in: unfinished strings, arrays and objects are
 * closed, a key without its value is left out and a cut-off escape sequence is dropped.
 * Returns undefined when nothing usable can be read yet.
 */
function parsePartialJsonValue(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return parsePartialJson(text)
  } catch {
    return undefined
  }
}

/** Partial-JSON parse of a tool call's arguments; null unless they read as an object. */
function parsePartialArgs(args: string): Record<string, any> | null {
  const value = parsePartialJsonValue(args)
  return isPlainObject(value) ? value : null
}

interface DecodedArgs {
  args: Record<string, any>
  /** The arguments are incomplete (still streaming) and were read with the partial parser. */
  partial: boolean
}

/** Strict JSON first; the partial parser only when the caller allows it and the JSON is not complete yet. */
function decodeArgs(args: string | undefined, allowPartial: boolean): DecodedArgs | null {
  if (!args) return null
  const strict = tryParseArgs(args)
  if (strict) return { args: strict, partial: false }
  if (!allowPartial) return null
  const partial = parsePartialArgs(args)
  return partial ? { args: partial, partial: true } : null
}

function useDecodedArgs(args: string | undefined, allowPartial: boolean): DecodedArgs | null {
  return useMemo(() => decodeArgs(args, allowPartial), [args, allowPartial])
}

function parseObject(text: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : undefined
  } catch {
    return undefined
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '...'
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

// --- Shared sub-components ---

function CodeBlock({ children, isError, autoScroll }: { children: string; isError?: boolean; autoScroll?: boolean }) {
  return (
    <FollowScrollBox
      as="pre"
      follow={autoScroll ?? false}
      className={clsx(
        'rounded p-1.5 text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-48 overflow-y-auto',
        isError
          ? 'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300'
          : 'bg-code-bg text-code-text'
      )}
    >
      {children}
    </FollowScrollBox>
  )
}

function DiffCodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded p-1.5 text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-48 overflow-y-auto bg-code-bg text-code-text">
      {children.split('\n').map((line, index, lines) => {
        const isAddition = line.startsWith('+')
        const isDeletion = line.startsWith('-')

        return (
          <span
            key={index}
            className={clsx(
              'block min-h-[1em]',
              isAddition &&
                'bg-status-success-50 text-status-success-800 dark:bg-status-success-900/30 dark:text-status-success-300',
              isDeletion &&
                'bg-status-danger-50 text-status-danger-800 dark:bg-status-danger-900/30 dark:text-status-danger-300'
            )}
          >
            {line}
            {index < lines.length - 1 ? '\n' : ''}
          </span>
        )
      })}
    </pre>
  )
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted text-[10px] uppercase tracking-wider">{label}</div>
      {children}
    </div>
  )
}

function InlineCode({ children }: { children: string }) {
  return <code className="bg-code-bg text-code-text px-1 py-0.5 rounded text-[11px]">{children}</code>
}

// --- Tool renderers ---

const readRenderer: ToolRenderer = {
  summary: (args) => {
    let s = args.path ?? ''
    if (args.offset != null || args.limit != null) {
      s += `:${args.offset ?? 0}`
      if (args.limit != null) s += `-${(args.offset ?? 0) + args.limit}`
    }
    return s
  },
  ArgsView: ({ args }) => <InlineCode>{args.path ?? 'unknown'}</InlineCode>,
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return <CodeBlock isError={isError}>{text}</CodeBlock>
  },
}

function BashCodeBlock({
  children,
  isError,
  autoScroll,
}: {
  children: string
  isError?: boolean
  autoScroll?: boolean
}) {
  return (
    <FollowScrollBox
      as="pre"
      follow={autoScroll ?? false}
      className={clsx(
        'rounded p-1.5 text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-48 overflow-y-auto',
        isError
          ? 'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300'
          : 'bg-code-bg text-code-text'
      )}
    >
      <AnsiText>{children}</AnsiText>
    </FollowScrollBox>
  )
}

const bashRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => truncate(str(args.command), 60),
  ArgsView: ({ args }) => (
    <ArgsScrollBox className="bg-code-bg text-code-text rounded p-1.5 text-[11px] font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
      <span className="text-muted select-none">$ </span>
      {str(args.command)}
    </ArgsScrollBox>
  ),
  ResultView: ({ result, isError, autoScroll }) => {
    const text = extractResultText(result)
    return (
      <BashCodeBlock isError={isError} autoScroll={autoScroll}>
        {text}
      </BashCodeBlock>
    )
  },
}

interface EditPair {
  oldText?: string
  newText?: string
}

/**
 * The edit tool's replacements, in the order the tool applies them: the `edits` array (which may also
 * arrive as a JSON string), then the legacy top-level `oldText`/`newText` pair. Entries may be half-built
 * while the call streams.
 */
function editPairs(args: Record<string, any>): EditPair[] {
  let edits: unknown = args.edits
  if (typeof edits === 'string') edits = parsePartialJsonValue(edits)
  const pairs: EditPair[] = Array.isArray(edits)
    ? edits.filter(isPlainObject).map((edit) => ({
        oldText: typeof edit.oldText === 'string' ? edit.oldText : undefined,
        newText: typeof edit.newText === 'string' ? edit.newText : undefined,
      }))
    : []
  if (typeof args.oldText === 'string' || typeof args.newText === 'string') {
    pairs.push({
      oldText: typeof args.oldText === 'string' ? args.oldText : undefined,
      newText: typeof args.newText === 'string' ? args.newText : undefined,
    })
  }
  return pairs
}

function EditPairView({ pair }: { pair: EditPair }) {
  return (
    <>
      {pair.oldText ? (
        <LabeledField label="Old">
          <ArgsScrollBox
            as="pre"
            className="bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-800 dark:text-status-danger-300 rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto"
          >
            {pair.oldText}
          </ArgsScrollBox>
        </LabeledField>
      ) : null}
      {pair.newText !== undefined && (
        <LabeledField label="New">
          <ArgsScrollBox
            as="pre"
            className="bg-status-success-50 dark:bg-status-success-900/30 text-status-success-800 dark:text-status-success-300 rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto"
          >
            {pair.newText}
          </ArgsScrollBox>
        </LabeledField>
      )}
    </>
  )
}

const editRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => {
    const path = str(args.path)
    if (!path) return ''
    const count = editPairs(args).length
    return count > 1 ? `${basename(path)} (${count} edits)` : basename(path)
  },
  ArgsView: ({ args, partial }) => {
    const path = str(args.path)
    const pairs = editPairs(args)
    return (
      <div className="space-y-1">
        {(path || !partial) && <InlineCode>{path || 'unknown'}</InlineCode>}
        {pairs.map((pair, index) => (
          // Edits only ever append while streaming, so the position is a stable key.
          <div key={index} className="space-y-1">
            {pairs.length > 1 && (
              <div className="text-muted text-[10px]">
                Edit {index + 1} of {pairs.length}
              </div>
            )}
            <EditPairView pair={pair} />
          </div>
        ))}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    // Check if there's a diff in details
    try {
      const parsed = JSON.parse(result)
      if (parsed?.details?.diff) {
        return (
          <div className="space-y-1">
            <div className="text-status-success-600 dark:text-status-success-400 text-[11px]">{text}</div>
            {isError ? (
              <CodeBlock isError={isError}>{parsed.details.diff}</CodeBlock>
            ) : (
              <DiffCodeBlock>{parsed.details.diff}</DiffCodeBlock>
            )}
          </div>
        )
      }
    } catch {
      /* fall through */
    }
    return <CodeBlock isError={isError}>{text}</CodeBlock>
  },
}

const writeRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => (str(args.path) ? basename(args.path) : ''),
  ArgsView: ({ args, partial }) => {
    const path = str(args.path)
    const content = str(args.content)
    return (
      <div className="space-y-1">
        {(path || !partial) && <InlineCode>{path || 'unknown'}</InlineCode>}
        {content && (
          <LabeledField label="Content">
            <ArgsScrollBox
              as="pre"
              className="bg-code-bg text-code-text rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto"
            >
              {content}
            </ArgsScrollBox>
          </LabeledField>
        )}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return isError ? (
      <CodeBlock isError>{text}</CodeBlock>
    ) : (
      <div className="text-status-success-600 dark:text-status-success-400 text-[11px]">{text}</div>
    )
  },
}

const grepRenderer: ToolRenderer = {
  summary: (args) => {
    let s = `"${truncate(args.pattern ?? '', 30)}"`
    if (args.path) s += ` ${args.path}`
    return s
  },
  ArgsView: ({ args }) => (
    <div className="space-y-0.5">
      <LabeledField label="Pattern">
        <InlineCode>{args.pattern ?? ''}</InlineCode>
      </LabeledField>
      {args.path && (
        <LabeledField label="Path">
          <InlineCode>{args.path}</InlineCode>
        </LabeledField>
      )}
      {args.glob && (
        <LabeledField label="Glob">
          <InlineCode>{args.glob}</InlineCode>
        </LabeledField>
      )}
      {(args.ignoreCase || args.literal || args.context != null) && (
        <div className="flex gap-2 text-[10px] text-muted">
          {args.ignoreCase && <span>ignore-case</span>}
          {args.literal && <span>literal</span>}
          {args.context != null && <span>context: {args.context}</span>}
        </div>
      )}
    </div>
  ),
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return <CodeBlock isError={isError}>{text}</CodeBlock>
  },
}

const findRenderer: ToolRenderer = {
  summary: (args) => {
    let s = `"${truncate(args.pattern ?? '', 30)}"`
    if (args.path) s += ` ${args.path}`
    return s
  },
  ArgsView: ({ args }) => (
    <div className="space-y-0.5">
      <LabeledField label="Pattern">
        <InlineCode>{args.pattern ?? ''}</InlineCode>
      </LabeledField>
      {args.path && (
        <LabeledField label="Path">
          <InlineCode>{args.path}</InlineCode>
        </LabeledField>
      )}
    </div>
  ),
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return <CodeBlock isError={isError}>{text}</CodeBlock>
  },
}

const lsRenderer: ToolRenderer = {
  summary: (args) => args.path ?? '.',
  ArgsView: ({ args }) => <InlineCode>{args.path ?? '.'}</InlineCode>,
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return <CodeBlock isError={isError}>{text}</CodeBlock>
  },
}

const humanWaitStatus = webStatus('humanWait')

const askHumanRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => {
    const count = Array.isArray(args.questions) ? args.questions.length : 0
    return `${count} question${count !== 1 ? 's' : ''}`
  },
  ArgsView: ({ args, partial }) => {
    // Entries can be half-built while streaming: any field may be missing yet.
    const questions: Array<{
      id?: string
      type?: string
      question?: string
      context?: string
      options?: unknown
      optional?: boolean
    }> = Array.isArray(args.questions) ? args.questions.filter(isPlainObject) : []

    if (questions.length === 0) {
      return partial ? null : <span className="text-muted text-[11px]">No questions</span>
    }

    return (
      <div className="space-y-2">
        {questions.map((q, i) => {
          const options: Array<{ value?: unknown; label?: unknown }> = Array.isArray(q.options)
            ? q.options.filter(isPlainObject)
            : []
          return (
            <div
              // Ids stream in (and may briefly match another question's), so key by position.
              key={i}
              className={clsx('border rounded-md p-2', humanWaitStatus.borderClass, humanWaitStatus.surfaceClass)}
            >
              <div className="flex items-start gap-2">
                <span className={clsx('shrink-0', humanWaitStatus.textClass)}>?</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {str(q.id) && (
                      <code
                        className={clsx(
                          'px-1 py-0.5 rounded text-[10px] font-mono',
                          humanWaitStatus.surfaceClass,
                          humanWaitStatus.textClass
                        )}
                      >
                        {str(q.id)}
                      </code>
                    )}
                    <span className="text-[10px] text-muted">{str(q.type) || 'text'}</span>
                    {q.optional === true && <span className="text-[10px] text-muted italic">optional</span>}
                  </div>
                  <p className="text-sm text-primary mt-1">{str(q.question)}</p>
                  {str(q.context).trim() && (
                    <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{str(q.context).trim()}</p>
                  )}
                  {options.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {options.map((opt, optionIndex) => (
                        <span
                          // Option values stream in (or are still missing), so key by position.
                          key={optionIndex}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-surface-secondary text-secondary"
                        >
                          {str(opt.label) || str(opt.value)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return isError ? (
      <CodeBlock isError>{text}</CodeBlock>
    ) : (
      <div className={clsx('text-[11px]', humanWaitStatus.textClass)}>{text}</div>
    )
  },
}

const navigateRenderer: ToolRenderer = {
  summary: (args) => args.path ?? '',
  ArgsView: ({ args }) => {
    const path = args.path ?? '/'
    const isPrompt = args.prompt === true
    return (
      <div className="flex items-center gap-2">
        <Link
          to={path}
          className="inline-flex items-center gap-1 text-accent-light hover:text-link-hover hover:underline text-[12px] font-medium"
        >
          {isPrompt ? 'Go to ' : ''}
          <code className="bg-accent/10 text-accent-light px-1.5 py-0.5 rounded text-[11px]">{path}</code>
          {isPrompt && <span aria-hidden="true">&rarr;</span>}
        </Link>
        {!isPrompt && <span className="text-[10px] text-muted">auto</span>}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return isError ? <CodeBlock isError>{text}</CodeBlock> : <div className="text-accent-light text-[11px]">{text}</div>
  },
}

const requestNextBeatRenderer: ToolRenderer = {
  summary: (args) => args.delay ?? '',
  ArgsView: ({ args }) => (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <ClockIcon className="h-3.5 w-3.5 text-status-danger-500 dark:text-status-danger-400" />
        <InlineCode>{args.delay ?? '?'}</InlineCode>
      </div>
      {args.reason && <div className="text-[11px] text-muted">{args.reason}</div>}
    </div>
  ),
  ResultView: ({ result, isError }) => {
    if (isError) return <CodeBlock isError>{extractResultText(result)}</CodeBlock>
    try {
      const parsed = JSON.parse(extractResultText(result))
      if (parsed?.nextBeatAt) {
        const d = new Date(parsed.nextBeatAt)
        return (
          <div className="text-status-success-600 dark:text-status-success-400 text-[11px]">
            Next beat at {d.toLocaleTimeString()}
          </div>
        )
      }
    } catch {
      /* fall through */
    }
    return (
      <div className="text-status-success-600 dark:text-status-success-400 text-[11px]">
        {extractResultText(result)}
      </div>
    )
  },
}

const notifyContactRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => {
    const prefix = args.urgency === 'action_needed' ? 'action needed: ' : args.urgency === 'warning' ? 'warning: ' : ''
    return `${prefix}${truncate(str(args.message), 50)}`
  },
  ArgsView: ({ args }) => {
    const urgencyColors: Record<string, string> = {
      info: 'bg-status-progress-50 dark:bg-status-progress-900/30 text-status-progress-700 dark:text-status-progress-300',
      warning: 'bg-status-review-50 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-300',
      action_needed:
        'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300',
    }
    const urgency = str(args.urgency)
    const colorClass = urgencyColors[urgency] ?? urgencyColors.info
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium', colorClass)}>{urgency || 'info'}</span>
        </div>
        <div className="text-[11px] text-primary">{str(args.message)}</div>
        {str(args.question) && (
          <div className={clsx('flex items-start gap-1 text-[11px] italic', humanWaitStatus.textClass)}>
            <QuestionIcon className="mt-px h-3.5 w-3.5 shrink-0" /> {str(args.question)}
          </div>
        )}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return isError ? (
      <CodeBlock isError>{text}</CodeBlock>
    ) : (
      <div className="text-status-success-600 dark:text-status-success-400 text-[11px]">{text}</div>
    )
  },
}

const memorySearchRenderer: ToolRenderer = {
  summary: (args) => truncate(args.query ?? args.q ?? '', 60),
  ArgsView: ({ args }) => <InlineCode>{args.query ?? args.q ?? ''}</InlineCode>,
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    const provenance = parseMemoryProvenance(text)
    const human = stripProvenanceBlock(text).trim()
    return (
      <div className="space-y-1">
        <CodeBlock isError={isError}>{human}</CodeBlock>
        {provenance && provenance.length > 0 && (
          <details className="text-[11px] text-muted">
            <summary className="cursor-pointer">
              Searched memory ({provenance.length} source{provenance.length === 1 ? '' : 's'})
            </summary>
            <ul className="mt-1 space-y-0.5">
              {provenance.map((p, i) => (
                <li key={p.documentId ?? i} className="truncate">
                  <span className="font-mono">{p.sourceSquadId.slice(0, 8)}</span>
                  {' · '}
                  <span>{p.sourceType ?? 'unknown'}</span>
                  {' · '}
                  <span>{p.sensitivity}</span>
                  {p.path ? (
                    <>
                      {' · '}
                      <span className="font-mono">{p.path}</span>
                    </>
                  ) : null}
                  {p.url ? (
                    <>
                      {' · '}
                      <a href={p.url} target="_blank" rel="noreferrer" className="text-accent-light hover:underline">
                        Open source
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    )
  },
}

const memoryGetRenderer: ToolRenderer = {
  summary: (args) => (args.section ? `${args.path ?? ''} › ${args.section}` : (args.path ?? '')),
  ArgsView: ({ args }) => (
    <InlineCode>{args.section ? `${args.path ?? ''} › ${args.section}` : (args.path ?? '')}</InlineCode>
  ),
  ResultView: ({ result, isError, autoScroll }) => (
    <CodeBlock isError={isError} autoScroll={autoScroll}>
      {extractResultText(result)}
    </CodeBlock>
  ),
}

const memoryOutlineRenderer: ToolRenderer = {
  summary: (args) => (args.query ? `“${truncate(args.query, 50)}”` : args.path || 'Memory map'),
  ArgsView: ({ args }) => <InlineCode>{args.query ? `query: ${args.query}` : args.path || 'Memory map'}</InlineCode>,
  ResultView: ({ result, isError }) => <CodeBlock isError={isError}>{extractResultText(result)}</CodeBlock>,
}

// --- Subagent shared pieces (reused by check_subagents) ---

function subagentTabSearch(currentSearch: string, subagentId: string): string {
  const params = new URLSearchParams(currentSearch)
  params.set('view', 'subagents')
  params.set('subagent', subagentId)
  return `?${params.toString()}`
}

function SubagentTranscriptLink({
  subagentId,
  children,
  className,
}: {
  subagentId: string
  children: ReactNode
  className?: string
}) {
  const location = useLocation()
  return (
    <Link to={subagentTabSearch(location.search, subagentId)} className={className}>
      {children}
    </Link>
  )
}

export type SubagentPillStatus = 'queued' | 'running' | 'idle' | 'done' | 'failed' | 'stopped'

function pillStatusFromChild(status: string, resultStatus: string | null | undefined): SubagentPillStatus {
  if (status !== 'terminated') {
    if (status === 'queued') return 'queued'
    if (status === 'running') return 'running'
    return 'idle'
  }
  if (resultStatus === 'completed') return 'done'
  if (resultStatus === 'failed') return 'failed'
  if (resultStatus === 'stopped') return 'stopped'
  return 'done'
}

const PILL_META: Record<SubagentPillStatus, { label: string; icon: string }> = {
  queued: { label: 'queued', icon: '•' },
  running: { label: 'running', icon: '●' },
  idle: { label: 'idle', icon: '○' },
  done: { label: 'done', icon: '✓' },
  failed: { label: 'failed', icon: '✗' },
  stopped: { label: 'stopped', icon: '■' },
}

function SubagentStatusPill({ status }: { status: SubagentPillStatus }) {
  const meta = PILL_META[status]
  const treatment = webStatus(SUBAGENT_STATUS_ROLE[status])
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
        treatment.surfaceClass,
        treatment.textClass
      )}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  )
}

function specLabel(spec: { label?: unknown }, index: number): string {
  return str(spec.label).trim() || `subagent ${index + 1}`
}

function dispatchModelMode(spec: { model?: unknown; inheritModel?: unknown }): string {
  if (spec.inheritModel === true) return 'Inherited parent chain'
  if (str(spec.model).trim()) return 'Explicit model'
  return 'Standard tier (default)'
}

const dispatchRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => {
    const count = Array.isArray(args.subagents) ? args.subagents.length : 0
    return `${count} subagent${count === 1 ? '' : 's'}`
  },
  ArgsView: ({ args, partial }) => {
    // Entries can be half-built while streaming: any field may be missing yet.
    const specs: Array<{
      label?: unknown
      model?: unknown
      inheritModel?: unknown
      agentType?: unknown
      instructions?: unknown
    }> = Array.isArray(args.subagents) ? args.subagents.filter(isPlainObject) : []
    if (specs.length === 0) return partial ? null : <span className="text-muted text-[11px]">No subagents</span>
    return (
      <div className="space-y-1.5">
        {specs.map((spec, i) => (
          <div key={i} className="border border-default rounded-md p-2 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-medium text-primary">{specLabel(spec, i)}</span>
              <span className="text-[10px] text-muted">{dispatchModelMode(spec)}</span>
              {str(spec.model) && <code className="text-[10px] text-muted">{str(spec.model)}</code>}
              {str(spec.agentType) && spec.agentType !== 'subagent' && (
                <code className="bg-code-bg text-code-text px-1 py-0.5 rounded text-[10px]">{str(spec.agentType)}</code>
              )}
            </div>
            {str(spec.instructions) && (
              <p className="text-[11px] text-secondary whitespace-pre-wrap break-words">
                {truncate(str(spec.instructions), 240)}
              </p>
            )}
          </div>
        ))}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    if (isError) return <CodeBlock isError>{extractResultText(result)}</CodeBlock>
    let children: Array<{ subagentId: string; label: string }> = []
    const details = extractToolResultDetails(result)
    if (Array.isArray(details?.subagents)) children = details.subagents
    else return <CodeBlock>{extractResultText(result)}</CodeBlock>
    if (children.length === 0) return <div className="text-muted text-[11px]">No subagents dispatched</div>
    return (
      <div className="space-y-1">
        {children.map((child) => (
          <SubagentTranscriptLink
            key={child.subagentId}
            subagentId={child.subagentId}
            className="flex items-center justify-between gap-2 hover:bg-surface-secondary rounded px-1 -mx-1 transition-colors"
          >
            <div className="min-w-0 flex items-center gap-2">
              <span className="text-[12px] text-primary truncate">{child.label || child.subagentId}</span>
              <code className="bg-code-bg text-code-text px-1 py-0.5 rounded text-[10px] shrink-0">
                {child.subagentId}
              </code>
            </div>
            <SubagentStatusPill status="queued" />
          </SubagentTranscriptLink>
        ))}
      </div>
    )
  },
}

const checkSubagentsRenderer: ToolRenderer = {
  summary: () => 'check status',
  ArgsView: () => <span className="text-muted text-[11px]">Reads the caller&apos;s subagents</span>,
  ResultView: ({ result, isError }) => {
    if (isError) return <CodeBlock isError>{extractResultText(result)}</CodeBlock>
    let children: Array<{
      subagentId: string
      label: string
      status: string
      lastActivityAt: string | null
      resultStatus: string | null
    }> = []
    const details = extractToolResultDetails(result)
    if (Array.isArray(details?.subagents)) children = details.subagents
    else return <CodeBlock>{extractResultText(result)}</CodeBlock>
    if (children.length === 0) return <div className="text-muted text-[11px]">No subagents</div>
    return (
      <div className="space-y-1">
        {children.map((child) => (
          <SubagentTranscriptLink
            key={child.subagentId}
            subagentId={child.subagentId}
            className="flex items-center justify-between gap-2 hover:bg-surface-secondary rounded px-1 -mx-1 transition-colors"
          >
            <div className="min-w-0 flex items-center gap-2">
              <span className="text-[12px] text-primary truncate">{child.label || child.subagentId}</span>
              <code className="bg-code-bg text-code-text px-1 py-0.5 rounded text-[10px] shrink-0">
                {child.subagentId}
              </code>
            </div>
            <SubagentStatusPill status={pillStatusFromChild(child.status, child.resultStatus)} />
          </SubagentTranscriptLink>
        ))}
      </div>
    )
  },
}

const stopSubagentRenderer: ToolRenderer = {
  summary: (args) => args.subagentId ?? '',
  ArgsView: ({ args }) => <InlineCode>{args.subagentId ?? 'unknown'}</InlineCode>,
  ResultView: ({ result, isError }) => {
    if (isError) return <CodeBlock isError>{extractResultText(result)}</CodeBlock>
    const details = extractToolResultDetails(result)
    const statusValue = details?.status ?? details?.resultStatus
    const status = typeof statusValue === 'string' ? statusValue : ''
    if (status === 'stopped') {
      return (
        <div className={clsx('flex items-center gap-1 text-[11px]', webStatus('neutral').textClass)}>
          <StopIcon className="h-3 w-3" /> Stopped
        </div>
      )
    }
    if (status === 'already-terminated') return <div className="text-muted text-[11px]">Already terminated</div>
    return <div className="text-secondary text-[11px]">{status}</div>
  },
}

// Renderer sets are passed by the owning chat. Names are local to that interface.
export type ToolRenderers = Readonly<Record<string, ToolRenderer>>
export const genericToolRenderers: ToolRenderers = {}

// --- Agent tools ---

export const agentToolRenderers: ToolRenderers = {
  read: readRenderer,
  bash: bashRenderer,
  // squad_bash (the squad warm-box shell) renders identically to bash.
  squad_bash: bashRenderer,
  edit: editRenderer,
  write: writeRenderer,
  grep: grepRenderer,
  find: findRenderer,
  ls: lsRenderer,
  ask_human: askHumanRenderer,
  navigate: navigateRenderer,
  request_next_beat: requestNextBeatRenderer,
  notify_contact: notifyContactRenderer,
  memory_search: memorySearchRenderer,
  memory_get: memoryGetRenderer,
  memory_outline: memoryOutlineRenderer,
  dispatch: dispatchRenderer,
  check_subagents: checkSubagentsRenderer,
  stop_subagent: stopSubagentRenderer,
}

// --- Generic view (tools without a renderer) ---

/** `subagentId` / `max_results` → `subagent id` / `max results` (the label is shown upper-cased). */
function fieldLabel(key: string): string {
  return (
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim()
      .toLowerCase() || key
  )
}

const genericValueBoxClass =
  'bg-code-bg text-code-text rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-32 overflow-y-auto'

function GenericArgValue({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return (
      <ArgsScrollBox as="pre" className={genericValueBoxClass}>
        {value}
      </ArgsScrollBox>
    )
  }
  if (typeof value === 'object' && value !== null) {
    return (
      <ArgsScrollBox as="pre" className={genericValueBoxClass}>
        {JSON.stringify(value, null, 2)}
      </ArgsScrollBox>
    )
  }
  return <InlineCode>{String(value)}</InlineCode>
}

/** Any tool's arguments as labeled fields: strings verbatim (real newlines), everything else as JSON. */
function GenericArgsView({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args)
  if (entries.length === 0) return <span className="text-muted text-[11px]">No arguments</span>
  return (
    <div className="space-y-1">
      {entries.map(([key, value]) => (
        <LabeledField key={key} label={fieldLabel(key)}>
          <GenericArgValue value={value} />
        </LabeledField>
      ))}
    </div>
  )
}

// --- Exported components ---

export function ToolSummary({
  toolName,
  args,
  renderers,
  inProgress,
}: {
  toolName: string
  args?: string
  renderers: ToolRenderers
  /** The call is still in progress: renderers with `streamingArgs` summarize partially streamed arguments. */
  inProgress?: boolean
}) {
  const renderer = renderers[toolName]
  const decoded = useDecodedArgs(args, Boolean(inProgress && renderer?.streamingArgs))
  if (!renderer || !decoded) return null
  const summary = renderer.summary(decoded.args)
  if (!summary) return null
  return (
    <span className="text-muted font-normal truncate ml-1" title={summary}>
      {truncate(summary, 50)}
    </span>
  )
}

export function ToolArgsView({
  toolName,
  args,
  renderers,
  follow,
}: {
  toolName: string
  args: string
  renderers: ToolRenderers
  /**
   * The call is still in progress (its arguments may still be streaming): keep the args box pinned to the
   * bottom, and let renderers with `streamingArgs` (and the generic view) show partially streamed arguments.
   */
  follow?: boolean
}) {
  const renderer = renderers[toolName]
  const following = follow ?? false
  // Tools without a renderer get the generic view, which handles partial arguments like an opted-in renderer.
  const decoded = useDecodedArgs(args, following && (renderer ? renderer.streamingArgs === true : true))

  if (renderer && decoded) {
    return (
      <ToolArgsFollowProvider value={following}>
        <renderer.ArgsView args={decoded.args} partial={decoded.partial} />
      </ToolArgsFollowProvider>
    )
  }

  // The generic view needs an object; while streaming it waits for the first field before replacing the raw text.
  const genericArgs =
    !renderer && decoded && isPlainObject(decoded.args) && (!decoded.partial || Object.keys(decoded.args).length > 0)
      ? decoded.args
      : null
  if (genericArgs) {
    return (
      <ToolArgsFollowProvider value={following}>
        <GenericArgsView args={genericArgs} />
      </ToolArgsFollowProvider>
    )
  }

  // Last resort: the raw arguments (not parseable at all yet, or an unflagged renderer still streaming).
  return (
    <FollowScrollBox
      as="pre"
      follow={following}
      className="bg-code-bg rounded p-1 text-[11px] text-code-text whitespace-pre-wrap break-all overflow-hidden max-h-32 overflow-y-auto"
    >
      {args}
    </FollowScrollBox>
  )
}

export function ToolResultView({
  toolName,
  args,
  result,
  isError,
  autoScroll,
  renderers,
}: {
  renderers: ToolRenderers
  toolName: string
  /** The call's raw arguments: a read path becomes the alt text of any image the result carries. */
  args?: string
  result: string
  isError?: boolean
  autoScroll?: boolean
}) {
  const renderer = renderers[toolName]
  const images = useMemo(
    () => extractResultImages(result, { alt: toolImageAlt(toolName, args) }),
    [result, toolName, args]
  )

  if (images.length > 0) {
    // Any tool's image parts show as thumbnails; the remaining text (if any) renders as usual, but never
    // the raw JSON with its base64 payload.
    const text = extractResultText(result)
    return (
      <div className="space-y-1">
        <ToolImageStrip images={images} />
        {text.trim() &&
          (renderer ? (
            <renderer.ResultView result={result} isError={isError ?? false} autoScroll={autoScroll} />
          ) : (
            <CodeBlock isError={isError}>{text}</CodeBlock>
          ))}
      </div>
    )
  }

  if (!renderer) {
    // Fallback: raw display
    return (
      <pre
        className={clsx(
          'rounded p-1 text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-32 overflow-y-auto',
          isError
            ? 'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300'
            : 'bg-code-bg text-code-text'
        )}
      >
        {result}
      </pre>
    )
  }

  return <renderer.ResultView result={result} isError={isError ?? false} autoScroll={autoScroll} />
}

/**
 * What a delegated task is called: its label, else the request's first non-blank line (the rule Core
 * uses to label the task row), else '' while neither has streamed in.
 */
function delegateTaskName(args: Record<string, any>): string {
  const label = str(args.label).trim()
  if (label) return label
  return (
    str(args.request)
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  )
}

const delegateTaskRenderer: ToolRenderer = {
  streamingArgs: true,
  summary: (args) => {
    const name = delegateTaskName(args)
    return name ? truncate(name, 60) : 'Background task'
  },
  ArgsView: ({ args }) => <div className="whitespace-pre-wrap text-[12px]">{str(args.request)}</div>,
  ResultView: ({ result, isError }) => {
    const parsed = parseObject(extractResultText(result))
    if (isError || !parsed || parsed.error) return <CodeBlock isError>{extractResultText(result)}</CodeBlock>
    return <div className="text-[11px] text-muted">Running in the background. Updates will appear here.</div>
  },
}

const taskUpdateRenderer: ToolRenderer = {
  summary: () => 'Task update',
  ArgsView: () => null,
  ResultView: ({ result }) => {
    const parsed = parseObject(result)
    // Catch-up batches carry several updates; single updates keep the legacy `content` shape.
    const updates = Array.isArray(parsed?.updates)
      ? (parsed.updates as Array<Record<string, unknown>>).filter((update) => typeof update.content === 'string')
      : null
    if (updates && updates.length)
      return (
        <div className="space-y-2 text-[12px]">
          {updates.map((update, index) => (
            <div key={typeof update.messageId === 'string' ? update.messageId : index} className="whitespace-pre-wrap">
              {typeof update.senderName === 'string' && <span className="text-muted">{update.senderName}: </span>}
              {update.content as string}
            </div>
          ))}
        </div>
      )
    const content = typeof parsed?.content === 'string' ? parsed.content : extractResultText(result)
    return <div className="whitespace-pre-wrap text-[12px]">{content}</div>
  },
}

const searchFicusRenderer: ToolRenderer = {
  summary: (args) => `Searched Ficus for “${truncate(args.query ?? args.q ?? '', 40)}”`,
  ArgsView: ({ args }) => <InlineCode>{args.query ?? args.q ?? ''}</InlineCode>,
  ResultView: ({ result, isError }) => <CodeBlock isError={isError}>{extractResultText(result)}</CodeBlock>,
}

// The Assistant's read state for task updates is recorded for it; a call here is bookkeeping only.
const markReadRenderer: ToolRenderer = {
  hidden: true,
  summary: (args) => args.messageId ?? '',
  ArgsView: ({ args }) => <InlineCode>{args.messageId ?? 'unknown'}</InlineCode>,
  ResultView: ({ result, isError }) => <CodeBlock isError={isError}>{extractResultText(result)}</CodeBlock>,
}

/** Site assistant tools share only these semantics with the normal agent tools. */
export const siteAssistantToolRenderers: ToolRenderers = {
  mark_read: markReadRenderer,
  navigate: navigateRenderer,
  memory_search: memorySearchRenderer,
  memory_get: memoryGetRenderer,
  request_next_beat: requestNextBeatRenderer,
  notify_contact: notifyContactRenderer,
  delegate_task: delegateTaskRenderer,
  assistant_inbox: taskUpdateRenderer,
  search_ficus: searchFicusRenderer,
}
