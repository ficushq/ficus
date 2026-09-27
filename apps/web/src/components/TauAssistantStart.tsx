import type { Agent } from '@ficus/shared'
import { AssistantConversationList } from './AssistantConversations'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { integrationQueries, queries } from '../queryOptions'
import { usePermissions } from '../hooks/usePermissions'
import { assistantSearch, type AssistantSearchResult } from '../lib/assistantSearch'
import { ALL_SECTIONS, isSectionAllowed } from './settings/settingsSections'
import { SparklesIcon } from './icons'

const examples = ['What needs my attention?', 'Summarize progress across my squads', 'Help me set up a new project']

export function TauAssistantStart({
  onAsk,
  recentChats = [],
  onSelectChat,
  onViewAllChats,
  canAsk,
  active = true,
}: {
  onAsk: (message: string) => void
  recentChats?: readonly Agent[]
  onSelectChat: (id: string) => void
  onViewAllChats: () => void
  canAsk: boolean
  active?: boolean
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { can, isLoading, isError } = usePermissions()
  const enabled = active && !isLoading && !isError
  const squadsQuery = useQuery({ ...queries.squads.list(), enabled })
  const streamsQuery = useQuery({ ...queries.squads.activeWorkStreams(), enabled })
  const catalog = useQuery({ ...integrationQueries.catalog(), enabled })
  const updates = useQuery({ ...queries.updates.settings(), enabled: enabled && can('updates:read') })
  const integrationAllowed =
    Array.isArray(catalog.data?.integrations) &&
    catalog.data.integrations.some((entry) => can(`integrations:read:${entry.key}`) || can('integrations:read'))
  const allowedSettings = new Set(
    ALL_SECTIONS.filter(
      (section) =>
        isSectionAllowed(section.id, can, isLoading || isError, integrationAllowed) &&
        !(section.id === 'updates' && updates.data?.managed === true)
    ).map((section) => section.id)
  )
  const squads = Array.isArray(squadsQuery.data) ? squadsQuery.data : []
  const streams = Array.isArray(streamsQuery.data) ? streamsQuery.data : []
  const results = assistantSearch(query, squads, streams, allowedSettings)
  const visibleResults = results.slice(0, 30)
  const loading = squadsQuery.isPending || streamsQuery.isPending || isLoading
  const partialError = squadsQuery.isError || streamsQuery.isError || isError
  const selectedIndex = Math.min(selected, Math.max(0, visibleResults.length - 1))
  const go = (result: AssistantSearchResult) => {
    navigate(result.path)
  }
  useEffect(() => {
    if (active) input.current?.focus()
  }, [active])
  useEffect(() => {
    resultsRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="p-4 sm:p-5 space-y-4 overflow-y-auto min-h-0">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const result = visibleResults[selectedIndex]
          if (result) go(result)
          else if (query.trim() && canAsk) onAsk(query.trim())
        }}
        className="flex gap-2"
      >
        <input
          ref={input}
          role="combobox"
          aria-expanded={Boolean(query.trim())}
          aria-controls="ficus-search-results"
          aria-activedescendant={
            query.trim() && visibleResults[selectedIndex] ? `ficus-search-result-${selectedIndex}` : undefined
          }
          aria-autocomplete="list"
          aria-label="Search Ficus or ask anything"
          placeholder="Search Ficus or ask anything…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && visibleResults.length) {
              event.preventDefault()
              setSelected(
                (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + visibleResults.length) % visibleResults.length
              )
            }
          }}
          className="ficus-field ficus-assistant-search w-full min-w-0 rounded-xl px-3 py-2.5 text-base sm:text-sm"
        />
        <button
          type="button"
          onClick={() => {
            if (query.trim()) onAsk(query.trim())
          }}
          disabled={!canAsk || !query.trim()}
          className="ficus-button ficus-button-primary px-3 text-sm shrink-0 disabled:opacity-40"
        >
          Ask Ficus
        </button>
      </form>
      {query.trim() ? (
        <div>
          <div
            ref={resultsRef}
            id="ficus-search-results"
            role="listbox"
            aria-label="Search results"
            className="max-h-72 overflow-y-auto space-y-1"
          >
            {visibleResults.map((item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                id={`ficus-search-result-${index}`}
                data-index={index}
                key={item.id}
                onClick={() => go(item)}
                className={clsx(
                  'ficus-button w-full text-left px-3 py-2.5 text-sm hover:bg-surface-secondary',
                  index === selectedIndex && 'bg-surface-secondary'
                )}
              >
                <span className="flex items-center gap-3 justify-between">
                  <span className="font-medium text-primary truncate">{item.label}</span>
                  <span className="text-xs text-muted shrink-0">{item.kind}</span>
                </span>
                <span className="block text-xs text-muted mt-1 truncate">{item.detail}</span>
              </button>
            ))}
          </div>
          {loading && (
            <p role="status" className="text-xs text-muted px-3 py-2">
              Finding squads and active work…
            </p>
          )}
          {!loading && !results.length && (
            <p role="status" className="text-sm text-muted px-3 py-2">
              No matching destinations. {canAsk && 'Ask Ficus for help with this request.'}
            </p>
          )}
          {partialError && (
            <p role="status" className="text-xs text-muted px-3 py-2">
              Some results are unavailable. Pages and settings are still searchable.
            </p>
          )}
          {results.length > visibleResults.length && (
            <p className="text-xs text-muted px-3 py-2">
              Showing {visibleResults.length} of {results.length} matches. Keep typing to narrow the results.
            </p>
          )}
          <p className="text-xs text-muted px-3 pt-2">
            ↑ ↓ to choose · Enter to open · Ask Ficus to start a conversation
          </p>
        </div>
      ) : (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted">Try asking</h4>
          {examples.map((example) => (
            <button
              key={example}
              disabled={!canAsk}
              onClick={() => onAsk(example)}
              className="ficus-button flex items-center gap-2 w-full text-left px-3 py-2.5 text-sm text-secondary hover:bg-surface-secondary disabled:opacity-40"
            >
              <SparklesIcon className="w-4 h-4 text-accent-light shrink-0" />
              {example}
            </button>
          ))}
        </div>
      )}
      {!query.trim() && recentChats.length > 0 && (
        <section aria-label="Recent assistant chats">
          <div className="mb-1 px-3 flex items-center justify-between">
            <h4 className="text-xs font-medium text-muted">Recent chats</h4>
            {recentChats.length > 5 && (
              <button onClick={onViewAllChats} className="ficus-button text-xs text-muted hover:text-accent-light py-1">
                View all
              </button>
            )}
          </div>
          <AssistantConversationList agents={recentChats} limit={5} onSelect={onSelectChat} />
        </section>
      )}
      {!canAsk && <p className="text-xs text-muted">Your role can browse pages but cannot send assistant messages.</p>}
    </div>
  )
}
