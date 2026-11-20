import clsx from 'clsx'
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useFollowScroll } from '../../lib/follow-scroll'
import { ChevronDownIcon } from '../icons'
import { findMatchesInLine, type SystemLogBlock, type SystemLogLine, type SystemLogMatch } from './systemLogBuffer'
import './SystemLogView.css'

interface SystemLogViewProps {
  blocks: readonly SystemLogBlock[]
  partial: SystemLogLine | null
  /** Complete lines received so far; counts what arrived while following is paused. */
  appended: number
  query: string
  activeMatch: SystemLogMatch | null
  /** Wrap long lines; otherwise they stay on one row and the view scrolls sideways. */
  wrap: boolean
  emptyText: string
  className?: string
}

const matchKey = (lineId: number, start: number) => `${lineId}:${start}`

/**
 * The scrolling log pane of Settings → Logs. It stays pinned to the newest line
 * while the user is at the bottom; scrolling up (or jumping to a search match)
 * pauses that, and "Jump to latest" resumes it.
 */
export function SystemLogView({
  blocks,
  partial,
  appended,
  query,
  activeMatch,
  wrap,
  emptyText,
  className,
}: SystemLogViewProps) {
  const { ref, paused, resume, pause, pin, handlers } = useFollowScroll<HTMLDivElement>(true)
  const linesRef = useRef<HTMLDivElement>(null)
  // Remember how many lines had arrived when following paused, to say how many are waiting below.
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  if (paused && pausedAt === null) setPausedAt(appended)
  if (!paused && pausedAt !== null) setPausedAt(null)
  const waiting = paused && pausedAt !== null ? Math.max(0, appended - pausedAt) : 0

  const needle = query.toLowerCase()
  const activeKey = activeMatch ? matchKey(activeMatch.lineId, activeMatch.start) : null
  const activeBlock = activeMatch ? blocks.findIndex((block) => blockContains(block, activeMatch.lineId)) : -1

  // Center the active search match. Following pauses first, so new lines cannot pull it out of view.
  useLayoutEffect(() => {
    const box = ref.current
    const mark = activeKey ? box?.querySelector<HTMLElement>('[data-active-match]') : null
    if (!box || !mark) return
    pause()
    const boxRect = box.getBoundingClientRect()
    const markRect = mark.getBoundingClientRect()
    box.scrollTop += markRect.top - boxRect.top - (box.clientHeight - markRect.height) / 2
    if (markRect.left < boxRect.left || markRect.right > boxRect.left + box.clientWidth) {
      box.scrollLeft += markRect.left - boxRect.left - box.clientWidth / 3
    }
  }, [activeKey, wrap, pause, ref])

  // Off-screen blocks are sized by estimate until the browser draws them (see the CSS), so the rows
  // can grow after a commit, for example when the newest block first wraps at a narrow width.
  // Re-pin whenever they change size, so following stays on the newest line.
  const empty = blocks.length === 0 && !partial
  useEffect(() => {
    const lines = linesRef.current
    if (!lines || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => pin())
    observer.observe(lines)
    return () => observer.disconnect()
  }, [empty, pin])

  return (
    <div className={clsx('relative min-h-0', className)}>
      <div
        ref={ref}
        {...handlers}
        role="log"
        aria-live="off"
        aria-label="System log output"
        tabIndex={0}
        data-follow-scroll=""
        data-wrap={wrap ? 'on' : 'off'}
        className={clsx(
          'ficus-log-view font-mono absolute inset-0 overflow-auto',
          wrap ? 'ficus-log-wrap' : 'ficus-log-nowrap'
        )}
      >
        {empty ? (
          <p className="ficus-log-empty">{emptyText}</p>
        ) : (
          <div ref={linesRef} className="ficus-log-lines">
            {blocks.map((block, index) => (
              <LogBlockRows
                key={block.key}
                block={block}
                needle={needle}
                activeKey={index === activeBlock ? activeKey : null}
                drawn={activeBlock !== -1 && Math.abs(index - activeBlock) <= 1}
              />
            ))}
            {partial && <LogRow line={partial} needle={needle} activeKey={activeKey} />}
          </div>
        )}
      </div>
      {paused && (
        <button
          type="button"
          onClick={resume}
          className="ficus-button ficus-button-primary absolute bottom-4 right-6 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs shadow-xs"
        >
          <ChevronDownIcon className="h-3.5 w-3.5" />
          Jump to latest
          {waiting > 0 && <span className="opacity-80">· {waiting.toLocaleString()} new</span>}
        </button>
      )}
    </div>
  )
}

function blockContains(block: SystemLogBlock, lineId: number): boolean {
  const first = block.lines[0]
  const last = block.lines.at(-1)
  return !!first && !!last && first.id <= lineId && lineId <= last.id
}

// A full block never changes, so streaming re-renders only the newest block. Each block is its own
// element so the browser can skip styling and laying out the blocks outside the pane (see the CSS).
// The active match's block and its neighbours are always drawn: a block the browser skipped only
// has an estimated height, and if it took its real height after the jump to the match, the
// browser's scroll anchoring could carry the match out of the pane.
// A row only sees the search text when it contains it, so typing in the search box re-renders
// the rows that match the old or new text rather than all 10,000.
const LogBlockRows = memo(function LogBlockRows({
  block,
  needle,
  activeKey,
  drawn,
}: {
  block: SystemLogBlock
  needle: string
  activeKey: string | null
  drawn: boolean
}) {
  return (
    <div className={clsx('ficus-log-block', drawn && 'ficus-log-block-drawn')}>
      {block.lines.map((line) => (
        <LogRow
          key={line.id}
          line={line}
          needle={needle && line.text.toLowerCase().includes(needle) ? needle : ''}
          activeKey={activeKey?.startsWith(`${line.id}:`) ? activeKey : null}
        />
      ))}
    </div>
  )
})

const LogRow = memo(function LogRow({
  line,
  needle,
  activeKey,
}: {
  line: SystemLogLine
  needle: string
  activeKey: string | null
}) {
  return (
    <div
      className={clsx(
        'ficus-log-line',
        line.level && `ficus-log-line-${line.level}`,
        line.kind !== 'log' && 'ficus-log-line-control'
      )}
    >
      {renderSpans(line, findMatchesInLine(line, needle), activeKey)}
    </div>
  )
})

/** The line's styled spans, with search matches wrapped in marks (a match may cross span boundaries). */
function renderSpans(line: SystemLogLine, matches: readonly SystemLogMatch[], activeKey: string | null): ReactNode[] {
  const nodes: ReactNode[] = []
  let offset = 0
  let next = 0
  line.spans.forEach((span, index) => {
    const spanEnd = offset + span.text.length
    const parts: ReactNode[] = []
    let cursor = offset
    while (next < matches.length && matches[next].start < spanEnd) {
      const match = matches[next]
      const from = Math.max(match.start, cursor)
      const to = Math.min(match.end, spanEnd)
      if (from > cursor) parts.push(span.text.slice(cursor - offset, from - offset))
      if (to > from) {
        const active = matchKey(line.id, match.start) === activeKey
        parts.push(
          <mark
            key={match.start}
            className={clsx('ficus-log-match', active && 'ficus-log-match-active')}
            data-active-match={active ? '' : undefined}
          >
            {span.text.slice(from - offset, to - offset)}
          </mark>
        )
      }
      cursor = Math.max(cursor, to)
      if (match.end > spanEnd) break
      next++
    }
    if (cursor < spanEnd) parts.push(span.text.slice(cursor - offset))
    nodes.push(
      <span key={index} className={span.className}>
        {parts}
      </span>
    )
    offset = spanEnd
  })
  return nodes
}
