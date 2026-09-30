import { useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStableRef } from './useStableRef'
import { useKeepAssistantAcrossPages } from './useKeepAssistantAcrossPages'
import type { CommandDestination } from '../lib/commandCenterSearch'

export type AssistantDestination =
  | CommandDestination
  | { kind: 'assistant'; id: string; label: string; draft?: boolean }
  | { kind: 'recent'; id: 'recent'; label: string }

const labels = {
  squad: 'Squad',
  work: 'Work stream',
  action: 'Needs you',
  chat: 'Conversation',
  assistant: 'Assistant',
  recent: 'Recent chats',
}
const navigationKeys = [
  'commandStack',
  'commandQuery',
  'assistantConversation',
  'assistantChat',
  'agentConversation',
  'assistantTask',
]

/** Store only navigation identifiers, never prompts or message contents. */
export function assistantNavigationParams(params: URLSearchParams, entries: AssistantDestination[], query: string) {
  const next = new URLSearchParams(params)
  for (const key of navigationKeys) next.delete(key)
  next.set('chat', 'open')
  if (query) next.set('commandQuery', query)
  if (entries.length)
    next.set(
      'commandStack',
      JSON.stringify(
        entries.map((entry) => {
          if (entry.kind === 'chat')
            return ['chat', entry.id, entry.squadId ?? '', entry.agentId ?? '', entry.readOnly ? 'read-only' : '']
          if (entry.kind === 'work') return ['work', entry.id, entry.squadId]
          if (entry.kind === 'assistant') return ['assistant', entry.id, entry.draft ? 'draft' : '']
          return [entry.kind, entry.id]
        })
      )
    )
  return next
}

export function readAssistantNavigation(params: URLSearchParams): AssistantDestination[] {
  const raw = params.get('commandStack')
  if (!raw) {
    const id = params.get('assistantConversation')
    return id ? [{ kind: 'assistant', id, label: 'Assistant' }] : []
  }
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || rows.length > 30) return []
    const entries: AssistantDestination[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || row.some((value) => typeof value !== 'string') || !row[1]) break
      const [kind, id, extra, mode, access] = row as string[]
      if (kind === 'squad' || kind === 'action') entries.push({ kind, id, label: labels[kind] })
      else if (kind === 'work' && extra) entries.push({ kind, id, squadId: extra, label: labels.work })
      else if (kind === 'chat' && (extra || mode))
        entries.push({
          kind,
          id,
          squadId: extra || undefined,
          agentId: mode || undefined,
          label: labels.chat,
          ...(access === 'read-only' ? { readOnly: true } : {}),
        })
      else if (kind === 'assistant') entries.push({ kind, id, draft: extra === 'draft', label: labels.assistant })
      else if (kind === 'recent') entries.push({ kind, id: 'recent', label: labels.recent })
      else break
    }
    return entries
  } catch {
    return []
  }
}

export function useAssistantNavigation() {
  const params = useKeepAssistantAcrossPages()
  const [, setParams] = useSearchParams()
  const paramsRef = useStableRef(params)
  const rawState = params.get('chat')
  const state = rawState === 'open' || rawState === 'expanded' ? rawState : 'closed'
  const setState = useCallback(
    (value: 'open' | 'expanded' | 'closed') => {
      const next = new URLSearchParams(paramsRef.current)
      if (value === 'closed') next.delete('chat')
      else next.set('chat', value)
      setParams(next, { replace: true })
    },
    [paramsRef, setParams]
  )
  const ephemeral = useRef(new Map<string, CommandDestination>())
  const serialized = params.get('commandStack')
  const legacyId = params.get('assistantConversation')
  const entries = useMemo(
    () =>
      readAssistantNavigation(
        new URLSearchParams({
          ...(serialized ? { commandStack: serialized } : {}),
          ...(legacyId ? { assistantConversation: legacyId } : {}),
        })
      ).map((entry) => {
        const cached = ephemeral.current.get(entry.id)
        return cached && entry.kind === 'chat'
          ? { ...entry, label: cached.label, initialText: cached.kind === 'chat' ? cached.initialText : undefined }
          : entry
      }),
    [serialized, legacyId]
  )
  const query = params.get('commandQuery') ?? ''
  const current = useStableRef({ entries, query })
  const update = useCallback(
    (next: AssistantDestination[], nextQuery = current.current.query) => {
      // Update the ref immediately so consecutive actions cannot overwrite a push.
      current.current = { entries: next, query: nextQuery }
      setParams((previous) => assistantNavigationParams(previous, next, nextQuery), { replace: true })
    },
    [current, setParams]
  )
  const push = useCallback(
    (entry: AssistantDestination) => {
      if (entry.kind === 'chat') ephemeral.current.set(entry.id, entry)
      update([...current.current.entries, entry])
    },
    [current, update]
  )
  const back = useCallback(() => update(current.current.entries.slice(0, -1)), [current, update])
  const reset = useCallback(() => update([]), [update])
  const setQuery = useCallback((value: string) => update(current.current.entries, value), [current, update])
  const replace = useCallback(
    (entry: AssistantDestination) => update([...current.current.entries.slice(0, -1), entry]),
    [current, update]
  )
  const chatCreated = useCallback(
    (draftId: string, agentId: string) => {
      update(
        current.current.entries.map((entry) =>
          entry.kind === 'chat' && entry.id === draftId ? { ...entry, agentId } : entry
        )
      )
    },
    [current, update]
  )
  const close = useCallback(() => {
    current.current = { entries: [], query: '' }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        for (const key of [...navigationKeys, 'chat']) next.delete(key)
        return next
      },
      { replace: true }
    )
  }, [current, setParams])
  return { params, state, setState, entries, query, setQuery, push, back, reset, replace, close, chatCreated }
}
