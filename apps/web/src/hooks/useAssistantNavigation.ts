import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
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
  // Chats opened in this tab keep their label and initial text, which the URL does not carry.
  const [ephemeral, setEphemeral] = useState<ReadonlyMap<string, CommandDestination>>(() => new Map())
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
        const cached = ephemeral.get(entry.id)
        return cached && entry.kind === 'chat'
          ? { ...entry, label: cached.label, initialText: cached.kind === 'chat' ? cached.initialText : undefined }
          : entry
      }),
    [serialized, legacyId, ephemeral]
  )
  const query = params.get('commandQuery') ?? ''
  const currentRef = useStableRef({ entries, query })
  const update = useCallback(
    (next: AssistantDestination[], nextQuery = currentRef.current.query) => {
      // Update the ref immediately so consecutive actions cannot overwrite a push.
      currentRef.current = { entries: next, query: nextQuery }
      setParams((previous) => assistantNavigationParams(previous, next, nextQuery), { replace: true })
    },
    [currentRef, setParams]
  )
  const push = useCallback(
    (entry: AssistantDestination) => {
      if (entry.kind === 'chat') setEphemeral((current) => new Map(current).set(entry.id, entry))
      update([...currentRef.current.entries, entry])
    },
    [currentRef, update]
  )
  const back = useCallback(() => update(currentRef.current.entries.slice(0, -1)), [currentRef, update])
  const reset = useCallback(() => update([]), [update])
  const setQuery = useCallback((value: string) => update(currentRef.current.entries, value), [currentRef, update])
  const replace = useCallback(
    (entry: AssistantDestination) => update([...currentRef.current.entries.slice(0, -1), entry]),
    [currentRef, update]
  )
  const chatCreated = useCallback(
    (draftId: string, agentId: string) => {
      update(
        currentRef.current.entries.map((entry) =>
          entry.kind === 'chat' && entry.id === draftId ? { ...entry, agentId } : entry
        )
      )
    },
    [currentRef, update]
  )
  const close = useCallback(() => {
    currentRef.current = { entries: [], query: '' }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        for (const key of [...navigationKeys, 'chat']) next.delete(key)
        return next
      },
      { replace: true }
    )
  }, [currentRef, setParams])
  return { params, state, setState, entries, query, setQuery, push, back, reset, replace, close, chatCreated }
}
