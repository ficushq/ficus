import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { Agent } from '@ficus/shared'
import { getAgentPurpose, getAgentName } from '../lib/agentDisplay'
import { Presence } from './Presence'
import { ChevronDownIcon, PlusIcon } from './icons'

export function assistantConversationTitle(agent: Agent): string {
  return (
    getAgentPurpose(agent) ?? (getAgentName(agent) === 'system-manager' ? 'Untitled conversation' : getAgentName(agent))
  )
}

function updatedAt(agent: Agent): number {
  return new Date(agent.lastMessageAt ?? agent.updatedAt).getTime()
}
function recentTime(agent: Agent): string {
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt(agent)) / 60_000))
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`
}

export function AssistantConversationList({
  agents,
  onSelect,
  selectedId,
  limit,
}: {
  agents: readonly Agent[]
  onSelect: (id: string) => void
  selectedId?: string
  limit?: number
}) {
  const location = useLocation()
  const ordered = [...agents].sort((a, b) => updatedAt(b) - updatedAt(a)).slice(0, limit)
  return (
    <div className="space-y-1">
      {ordered.map((agent) => {
        const params = new URLSearchParams(location.search)
        params.set('chat', 'open')
        params.set('assistantChat', agent.id)
        const working = agent.status === 'active'
        return (
          <Link
            key={agent.id}
            to={`${location.pathname}?${params}`}
            onClick={(event) => {
              if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0)
                onSelect(agent.id)
            }}
            aria-current={selectedId === agent.id ? 'true' : undefined}
            className={clsx(
              'ficus-button flex w-full items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-surface-secondary',
              selectedId === agent.id && 'bg-accent/10'
            )}
          >
            <span
              className={clsx(
                'h-2 w-2 rounded-full shrink-0',
                working ? 'bg-status-progress-500' : 'bg-status-neutral-400'
              )}
              aria-label={working ? 'Working' : 'Idle'}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-primary">{assistantConversationTitle(agent)}</span>
              <time
                className="block mt-0.5 text-xs text-muted"
                dateTime={new Date(updatedAt(agent)).toISOString()}
                title={new Date(updatedAt(agent)).toLocaleString()}
              >
                {recentTime(agent)}
              </time>
            </span>
            <span aria-hidden="true" className="text-muted">
              ›
            </span>
          </Link>
        )
      })}
    </div>
  )
}

export function AssistantConversationSwitcher({
  agents,
  selectedId,
  onSelect,
  onNew,
  canCreate,
  openRequest = 0,
}: {
  agents: readonly Agent[]
  selectedId?: string
  onSelect: (id: string) => void
  onNew: () => void
  canCreate: boolean
  openRequest?: number
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (openRequest) {
      setOpen(true)
      setFilter('')
    }
  }, [openRequest])
  const [filter, setFilter] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    container.current?.querySelector('input')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const selected = agents.find((agent) => agent.id === selectedId)
  const filtered = agents.filter((agent) =>
    assistantConversationTitle(agent).toLowerCase().includes(filter.trim().toLowerCase())
  )
  return (
    <div ref={container} className="relative w-full min-w-0 px-3 pb-3 pt-2">
      <div className="flex items-center gap-2">
        <button
          ref={trigger}
          aria-expanded={open}
          aria-controls="assistant-conversations"
          onClick={() => setOpen(!open)}
          className="ficus-button flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm text-primary hover:bg-surface-secondary"
          title="Switch conversation"
        >
          <span className="truncate">{selected ? assistantConversationTitle(selected) : 'New conversation'}</span>
          <ChevronDownIcon className="w-4 h-4 text-muted shrink-0" />
        </button>
        <button
          aria-label="New chat"
          title="New chat"
          disabled={!canCreate}
          onClick={() => {
            setOpen(false)
            onNew()
          }}
          className="ficus-button flex items-center gap-1 text-sm text-accent-light px-2 py-2 shrink-0 disabled:opacity-40"
        >
          <PlusIcon className="w-4 h-4" />
          <span className="hidden sm:inline">New chat</span>
        </button>
      </div>
      <Presence
        open={open}
        id="assistant-conversations"
        className="absolute top-full left-3 right-3 z-20 ficus-glass shadow-theme-lg rounded-xl p-2"
      >
        <input
          aria-label="Search assistant conversations"
          placeholder="Search conversations…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="ficus-field w-full px-3 py-2 text-base sm:text-sm mb-2"
        />
        <div className="max-h-64 overflow-y-auto">
          <AssistantConversationList
            agents={filtered}
            selectedId={selectedId}
            onSelect={(id) => {
              onSelect(id)
              setOpen(false)
            }}
          />
          {!filtered.length && <p className="p-3 text-sm text-muted">No matching conversations.</p>}
        </div>
      </Presence>
    </div>
  )
}
