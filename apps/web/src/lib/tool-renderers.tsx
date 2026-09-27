import { SUBAGENT_STATUS_ROLE } from '@ficus/shared'
import { extractToolResultDetails } from './tool-inline-actions'
import { webStatus } from './statusPresentation'
import clsx from 'clsx'
import { type FC, type ReactNode, useRef, useEffect, useState, useCallback } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AnsiText } from '../components/AnsiText'
import { parseMemoryProvenance, stripProvenanceBlock } from './memory-provenance'

// --- Types ---

export interface ToolRenderer {
  summary: (args: Record<string, any>) => string
  ArgsView: FC<{ args: Record<string, any> }>
  ResultView: FC<{ result: string; isError: boolean; autoScroll?: boolean }>
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

function extractResultText(result: string): string {
  try {
    const parsed = JSON.parse(result)
    if (parsed?.content && Array.isArray(parsed.content)) {
      return processCarriageReturns(
        parsed.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
      )
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
  const ref = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [autoScroll, children])

  return (
    <pre
      ref={ref}
      className={clsx(
        'rounded p-1.5 text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-48 overflow-y-auto',
        isError
          ? 'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300'
          : 'bg-code-bg text-code-text'
      )}
    >
      {children}
    </pre>
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
  const ref = useRef<HTMLPreElement>(null)
  const [localAutoScroll, setLocalAutoScroll] = useState(true)
  const userScrollingRef = useRef(false)
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track user-initiated scrolling (wheel/touch)
  const markUserScrolling = useCallback(() => {
    userScrollingRef.current = true
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    userScrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false
    }, 150)
  }, [])

  // Handle scroll: disable auto-scroll if user scrolls up, re-enable when at bottom
  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight

    if (userScrollingRef.current && localAutoScroll && distFromBottom > 30) {
      setLocalAutoScroll(false)
    } else if (!localAutoScroll && distFromBottom < 10) {
      setLocalAutoScroll(true)
    }
  }, [localAutoScroll])

  // Auto-scroll when content changes (if enabled)
  useEffect(() => {
    if (autoScroll && localAutoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [autoScroll, localAutoScroll, children])

  // Show scroll-to-bottom button when auto-scroll is paused and streaming
  const showScrollButton = autoScroll && !localAutoScroll

  return (
    <div className="relative">
      <pre
        ref={ref}
        onScroll={handleScroll}
        onWheel={markUserScrolling}
        onTouchMove={markUserScrolling}
        className={clsx(
          'rounded p-1.5 text-[11px] whitespace-pre-wrap break-all overflow-hidden max-h-48 overflow-y-auto',
          isError
            ? 'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300'
            : 'bg-code-bg text-code-text'
        )}
      >
        <AnsiText>{children}</AnsiText>
      </pre>
      {showScrollButton && (
        <button
          onClick={() => {
            setLocalAutoScroll(true)
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
          }}
          className="ficus-button absolute bottom-2 right-2 p-1 rounded bg-accent/90 hover:bg-accent text-on-accent text-[10px] shadow-sm"
          title="Resume auto-scroll"
        >
          ↓ Follow
        </button>
      )}
    </div>
  )
}

const bashRenderer: ToolRenderer = {
  summary: (args) => truncate(args.command ?? '', 60),
  ArgsView: ({ args }) => (
    <div className="bg-status-neutral-800 dark:bg-status-neutral-900 text-status-neutral-300 rounded p-1.5 text-[11px] font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
      <span className="text-muted select-none">$ </span>
      {args.command ?? ''}
    </div>
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

const editRenderer: ToolRenderer = {
  summary: (args) => (args.path ? basename(args.path) : ''),
  ArgsView: ({ args }) => (
    <div className="space-y-1">
      <InlineCode>{args.path ?? 'unknown'}</InlineCode>
      {args.oldText && (
        <LabeledField label="Old">
          <pre className="bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-800 dark:text-status-danger-300 rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
            {args.oldText}
          </pre>
        </LabeledField>
      )}
      {args.newText && (
        <LabeledField label="New">
          <pre className="bg-status-success-50 dark:bg-status-success-900/30 text-status-success-800 dark:text-status-success-300 rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
            {args.newText}
          </pre>
        </LabeledField>
      )}
    </div>
  ),
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
  summary: (args) => (args.path ? basename(args.path) : ''),
  ArgsView: ({ args }) => (
    <div className="space-y-1">
      <InlineCode>{args.path ?? 'unknown'}</InlineCode>
      {args.content && (
        <LabeledField label="Content">
          <pre className="bg-code-bg text-code-text rounded p-1 text-[11px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
            {truncate(args.content, 500)}
          </pre>
        </LabeledField>
      )}
    </div>
  ),
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
  summary: (args) => {
    const count = Array.isArray(args.questions) ? args.questions.length : 0
    return `${count} question${count !== 1 ? 's' : ''}`
  },
  ArgsView: ({ args }) => {
    const questions: Array<{
      id: string
      type?: string
      question: string
      context?: string
      options?: { value: string; label?: string }[]
      optional?: boolean
    }> = Array.isArray(args.questions) ? args.questions : []

    if (questions.length === 0) {
      return <span className="text-muted text-[11px]">No questions</span>
    }

    return (
      <div className="space-y-2">
        {questions.map((q, i) => (
          <div
            key={q.id || i}
            className={clsx('border rounded-md p-2', humanWaitStatus.borderClass, humanWaitStatus.surfaceClass)}
          >
            <div className="flex items-start gap-2">
              <span className={clsx('shrink-0', humanWaitStatus.textClass)}>?</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <code
                    className={clsx(
                      'px-1 py-0.5 rounded text-[10px] font-mono',
                      humanWaitStatus.surfaceClass,
                      humanWaitStatus.textClass
                    )}
                  >
                    {q.id}
                  </code>
                  <span className="text-[10px] text-muted">{q.type || 'text'}</span>
                  {q.optional && <span className="text-[10px] text-muted italic">optional</span>}
                </div>
                <p className="text-sm text-primary mt-1">{q.question}</p>
                {typeof q.context === 'string' && q.context.trim() && (
                  <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{q.context.trim()}</p>
                )}
                {q.options && q.options.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {q.options.map((opt) => (
                      <span
                        key={opt.value}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-surface-secondary text-secondary"
                      >
                        {opt.label ?? opt.value}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
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
          className="inline-flex items-center gap-1 text-status-progress-600 dark:text-status-progress-400 hover:text-status-progress-800 dark:hover:text-status-progress-300 hover:underline text-[12px] font-medium"
        >
          {isPrompt ? 'Go to ' : ''}
          <code className="bg-status-progress-50 dark:bg-status-progress-900/30 text-status-progress-700 dark:text-status-progress-300 px-1.5 py-0.5 rounded text-[11px]">
            {path}
          </code>
          {isPrompt && <span aria-hidden="true">&rarr;</span>}
        </Link>
        {!isPrompt && <span className="text-[10px] text-muted">auto</span>}
      </div>
    )
  },
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return isError ? (
      <CodeBlock isError>{text}</CodeBlock>
    ) : (
      <div className="text-status-progress-600 text-[11px]">{text}</div>
    )
  },
}

const requestNextBeatRenderer: ToolRenderer = {
  summary: (args) => args.delay ?? '',
  ArgsView: ({ args }) => (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-status-danger-500 dark:text-status-danger-400 text-[11px]">⏱</span>
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
  summary: (args) => {
    const icon = args.urgency === 'action_needed' ? '🔴' : args.urgency === 'warning' ? '🟡' : '🔵'
    return `${icon} ${truncate(args.message ?? '', 50)}`
  },
  ArgsView: ({ args }) => {
    const urgencyColors: Record<string, string> = {
      info: 'bg-status-progress-50 dark:bg-status-progress-900/30 text-status-progress-700 dark:text-status-progress-300',
      warning: 'bg-status-review-50 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-300',
      action_needed:
        'bg-status-danger-50 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-300',
    }
    const colorClass = urgencyColors[args.urgency] ?? urgencyColors.info
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium', colorClass)}>
            {args.urgency ?? 'info'}
          </span>
        </div>
        <div className="text-[11px] text-primary">{args.message}</div>
        {args.question && (
          <div className={clsx('text-[11px] italic', humanWaitStatus.textClass)}>❓ {args.question}</div>
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
  summary: (args) => args.path ?? '',
  ArgsView: ({ args }) => <InlineCode>{args.path ?? ''}</InlineCode>,
  ResultView: ({ result, isError, autoScroll }) => (
    <CodeBlock isError={isError} autoScroll={autoScroll}>
      {extractResultText(result)}
    </CodeBlock>
  ),
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
  stopped: { label: 'stopped', icon: '⏹' },
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

function specLabel(spec: { label?: string }, index: number): string {
  return spec.label?.trim() || `subagent ${index + 1}`
}

function dispatchModelMode(spec: { model?: string; inheritModel?: boolean }): string {
  if (spec.inheritModel === true) return 'Inherited parent chain'
  if (spec.model?.trim()) return 'Explicit model'
  return 'Standard tier (default)'
}

const dispatchRenderer: ToolRenderer = {
  summary: (args) => {
    const count = Array.isArray(args.subagents) ? args.subagents.length : 0
    return `${count} subagent${count === 1 ? '' : 's'}`
  },
  ArgsView: ({ args }) => {
    const specs: Array<{
      label?: string
      model?: string
      inheritModel?: boolean
      agentType?: string
      instructions?: string
    }> = Array.isArray(args.subagents) ? args.subagents : []
    if (specs.length === 0) return <span className="text-muted text-[11px]">No subagents</span>
    return (
      <div className="space-y-1.5">
        {specs.map((spec, i) => (
          <div key={i} className="border border-default rounded-md p-2 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-medium text-primary">{specLabel(spec, i)}</span>
              <span className="text-[10px] text-muted">{dispatchModelMode(spec)}</span>
              {spec.model && <code className="text-[10px] text-muted">{spec.model}</code>}
              {spec.agentType && spec.agentType !== 'subagent' && (
                <code className="bg-code-bg text-code-text px-1 py-0.5 rounded text-[10px]">{spec.agentType}</code>
              )}
            </div>
            {spec.instructions && (
              <p className="text-[11px] text-secondary whitespace-pre-wrap break-words">
                {truncate(spec.instructions, 240)}
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
      return <div className={clsx('text-[11px]', webStatus('neutral').textClass)}>⏹ Stopped</div>
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
  dispatch: dispatchRenderer,
  check_subagents: checkSubagentsRenderer,
  stop_subagent: stopSubagentRenderer,
}

// --- Exported components ---

export function ToolSummary({
  toolName,
  args,
  renderers,
}: {
  toolName: string
  args?: string
  renderers: ToolRenderers
}) {
  const renderer = renderers[toolName]
  if (!renderer || !args) return null
  const parsed = tryParseArgs(args)
  if (!parsed) return null
  const summary = renderer.summary(parsed)
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
}: {
  toolName: string
  args: string
  renderers: ToolRenderers
}) {
  const renderer = renderers[toolName]
  const parsed = tryParseArgs(args)

  if (!renderer || !parsed) {
    // Fallback: raw JSON
    return (
      <pre className="bg-code-bg rounded p-1 text-[11px] text-code-text whitespace-pre-wrap break-all overflow-hidden max-h-32 overflow-y-auto">
        {args}
      </pre>
    )
  }

  return <renderer.ArgsView args={parsed} />
}

export function ToolResultView({
  toolName,
  result,
  isError,
  autoScroll,
  renderers,
}: {
  renderers: ToolRenderers
  toolName: string
  result: string
  isError?: boolean
  autoScroll?: boolean
}) {
  const renderer = renderers[toolName]

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

const delegateTaskRenderer: ToolRenderer = {
  summary: (args) => `Background task: ${truncate(args.label ?? 'background task', 60)}`,
  ArgsView: ({ args }) => <div className="whitespace-pre-wrap text-[12px]">{args.request ?? ''}</div>,
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

/** Site assistant tools share only these semantics with the normal agent tools. */
export const siteAssistantToolRenderers: ToolRenderers = {
  navigate: navigateRenderer,
  memory_search: memorySearchRenderer,
  memory_get: memoryGetRenderer,
  request_next_beat: requestNextBeatRenderer,
  notify_contact: notifyContactRenderer,
  delegate_task: delegateTaskRenderer,
  assistant_inbox: taskUpdateRenderer,
  search_tau: searchFicusRenderer,
}
