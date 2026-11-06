import clsx from 'clsx'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MESSAGE_SEARCH_MAX_QUERY_LENGTH, type MessageSearchResult, type MessageSearchSnippet } from '@ficus/shared'
import { queries } from '../queryOptions'
import { dayLabel, fullTimestamp, messageTimeLabel } from '../lib/chatTimestamps'
import { CloseIcon, SearchIcon, SpinnerIcon } from './icons'
import { senderLabel } from '../lib/chatHistorySearch'

/** Wait this long after typing stops before searching. */
const SEARCH_DEBOUNCE_MS = 250

/** What selecting a result led to, so the panel can explain a jump that could not land. */
export type ChatHistoryJumpOutcome = 'found' | 'not-found' | 'too-far' | 'cancelled'

export interface ChatHistorySearchProps {
  agentId: string
  /** Load enough history to show the message, then scroll to and highlight it. */
  onSelect: (result: MessageSearchResult) => Promise<ChatHistoryJumpOutcome>
  onClose: () => void
}

/** The snippet as text with each matched range in a mark. */
export function SnippetText({ snippet }: { snippet: MessageSearchSnippet }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of snippet.highlights) {
    if (start < at || end <= start) continue
    if (start > at) parts.push(snippet.text.slice(at, start))
    parts.push(
      <mark key={start} className="rounded-sm bg-accent/25 text-primary px-0.5 -mx-0.5">
        {snippet.text.slice(start, end)}
      </mark>
    )
    at = end
  }
  if (at < snippet.text.length) parts.push(snippet.text.slice(at))
  return (
    <>
      {snippet.truncatedStart && '…'}
      {parts}
      {snippet.truncatedEnd && '…'}
    </>
  )
}

function resultTimeLabel(createdAt: string): string {
  const date = new Date(createdAt)
  return `${dayLabel(date, new Date())}, ${messageTimeLabel(date)}`
}

const JUMP_MESSAGES: Record<Exclude<ChatHistoryJumpOutcome, 'found' | 'cancelled'>, string> = {
  'not-found': 'That message is not shown in this chat view.',
  'too-far': 'That message is too far back to open in the chat. Its excerpt is shown above.',
}

/**
 * Search this conversation's whole history, not only the loaded messages, and jump to a result.
 * Results come from the server newest first; arrow keys move through them and Enter opens one.
 */
export function ChatHistorySearch({ agentId, onSelect, onClose }: ChatHistorySearchProps) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [jump, setJump] = useState<{ id: string; state: 'loading' | ChatHistoryJumpOutcome } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const trimmed = input.trim()
    if (trimmed === query) return
    const timer = setTimeout(() => setQuery(trimmed), trimmed ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  }, [input, query])

  const search = useInfiniteQuery(queries.agents.messageSearch(agentId, query))
  // keepPreviousData shows the last results while a new query loads; never show another query's.
  const showingQuery = search.isPlaceholderData ? null : query
  const results = useMemo(() => search.data?.pages.flatMap((page) => page.results) ?? [], [search.data])

  useEffect(() => {
    setActiveIndex(0)
    setJump(null)
  }, [query])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const open = async (result: MessageSearchResult) => {
    setJump({ id: result.id, state: 'loading' })
    const outcome = await onSelect(result)
    setJump((current) => (current?.id === result.id ? { id: result.id, state: outcome } : current))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const result = results[activeIndex]
      if (result) void open(result)
    }
  }

  const activeResultId = results[activeIndex] ? `${listId}-${activeIndex}` : undefined
  const typing = input.trim() !== query
  const status = !query
    ? null
    : search.isError
      ? 'Search failed. Try again.'
      : (search.isPending || typing || showingQuery === null) && results.length === 0
        ? 'Searching…'
        : results.length === 0
          ? 'No messages match.'
          : null

  return (
    <div className="shrink-0 border-b border-th-border bg-surface" data-testid="chat-history-search">
      <div className="flex items-center gap-2 px-3 md:px-4 py-2">
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeResultId}
            aria-label="Search this conversation"
            placeholder="Search this conversation"
            maxLength={MESSAGE_SEARCH_MAX_QUERY_LENGTH}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            className="ficus-field w-full pl-8 pr-8 py-1.5 text-base md:text-sm"
          />
          {(search.isFetching || typing) && query !== '' && (
            <SpinnerIcon className="w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 text-muted animate-spin" />
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ficus-button ficus-button-ghost p-1.5 rounded-md shrink-0"
          aria-label="Close search"
          title="Close search (Escape)"
        >
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
      {status && (
        <p className="px-3 md:px-4 pb-2 text-sm text-muted" role="status">
          {status}
        </p>
      )}
      {results.length > 0 && (
        <div className="max-h-[min(40vh,20rem)] overflow-y-auto overscroll-contain border-t border-th-border">
          <ul ref={listRef} id={listId} role="listbox" aria-label="Matching messages">
            {results.map((result, index) => {
              const jumpState = jump?.id === result.id ? jump.state : null
              return (
                <li
                  key={result.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-result-index={index}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => void open(result)}
                  className={clsx(
                    'cursor-pointer px-3 md:px-4 py-2 text-sm transition-colors',
                    index === activeIndex ? 'bg-accent/10' : 'hover:bg-surface-secondary'
                  )}
                >
                  <div className="flex items-baseline gap-2 text-xs text-muted">
                    <span className="font-medium text-secondary truncate">{senderLabel(result)}</span>
                    <time dateTime={result.createdAt} title={fullTimestamp(new Date(result.createdAt))}>
                      {resultTimeLabel(result.createdAt)}
                    </time>
                    {jumpState === 'loading' && (
                      <span className="ml-auto inline-flex items-center gap-1">
                        <SpinnerIcon className="w-3 h-3 animate-spin" />
                        Loading history…
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-primary break-words line-clamp-2">
                    <SnippetText snippet={result.snippet} />
                  </p>
                  {(jumpState === 'not-found' || jumpState === 'too-far') && (
                    <p className="mt-1 text-xs text-status-warning-600" role="status">
                      {JUMP_MESSAGES[jumpState]}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          {search.hasNextPage && (
            <div className="px-3 md:px-4 py-2">
              <button
                type="button"
                onClick={() => void search.fetchNextPage()}
                disabled={search.isFetchingNextPage}
                className="ficus-button ficus-button-ghost px-2 py-1 text-sm"
              >
                {search.isFetchingNextPage ? 'Loading…' : 'Show older matches'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
