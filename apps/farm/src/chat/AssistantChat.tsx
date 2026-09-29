import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useConversationClient } from '@ficus/client-react'
import type { AssistantEntry } from '@ficus/shared'
import { createAssistantApi, type AssistantApi } from './assistantApi'
import { AgentConversation } from './ChatPanel'
import { AssistantTaskUpdates } from './AssistantTaskUpdates'
import { ChatShell } from './ChatShell'
import { Markdown } from './Markdown'

export interface AssistantChatProps {
  /** An existing assistant conversation; omitted → the most recent one, or a new one if there are none. */
  conversationId?: string
  /** Start a new conversation instead of reopening the most recent one. */
  fresh?: boolean
  leading?: ReactNode
  onClose: () => void
  /** Test seam; defaults to the assistant routes over the conversation client's transport. */
  api?: AssistantApi
  /** Test seam for the id of a new conversation. */
  newId?: () => string
}

interface Opened {
  id: string
  agentId: string
  archive: AssistantEntry[]
  before?: number
  hasMore: boolean
}

/** Which conversation to open: the given one, else the latest saved Assistant chat, else a fresh id to create. */
async function pickConversation(
  api: AssistantApi,
  conversationId: string | undefined,
  newId: () => string,
  fresh = false
) {
  if (conversationId) return { id: conversationId, existing: true }
  if (fresh) return { id: newId(), existing: false }
  const { conversations } = await api.list()
  const latest = conversations.find((c) => c.kind === 'assistant')
  return latest ? { id: latest.id, existing: true } : { id: newId(), existing: false }
}

/**
 * The user's Assistant. Opening follows the web's AssistantConversationView:
 * create the conversation if it's new, read its history, then ensure its agent
 * and chat with that agent through the normal conversation engine (a user
 * message is a plain agent send; `assistantApi.message` is only for replies to
 * task updates). The task updates a reply covers show inline under it, and
 * having the chat open reads them.
 */
export function AssistantChat({ conversationId, fresh, leading, onClose, api: apiProp, newId }: AssistantChatProps) {
  const client = useConversationClient()
  const queryClient = useQueryClient()
  const api = useMemo(() => apiProp ?? createAssistantApi(client.transport), [apiProp, client])
  const [opened, setOpened] = useState<Opened | null>(null)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  useEffect(() => {
    let active = true
    setError(undefined)
    void (async () => {
      const target = await pickConversation(api, conversationId, newId ?? (() => crypto.randomUUID()), fresh)
      if (!target.existing) await api.create(target.id, undefined, 'assistant')
      const history = await api.history(target.id)
      const binding = await api.ensureAgent(target.id)
      if (!active) return
      setOpened({
        id: target.id,
        agentId: binding.agentId,
        archive: history.entries,
        before: history.before,
        hasMore: history.hasMore,
      })
      // The farm's assistant list (farm query) now includes this conversation.
      void queryClient.invalidateQueries({ queryKey: ['farm', 'assistant'] })
    })().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Conversation could not be loaded.')
    })
    return () => {
      active = false
    }
  }, [api, conversationId, fresh, newId, attempt, queryClient])

  // Open here is viewing it: its task updates (inline under the replies that cover them) are read, which
  // clears the Assistant's badge. Refreshed with the farm's other Assistant queries as updates arrive.
  const activity = useQuery({
    queryKey: ['farm', 'assistant', 'conversation', opened?.id ?? ''],
    queryFn: () => api.conversationActivity(opened!.id),
    enabled: !!opened,
  })
  const unread = activity.data?.conversation.unreadUpdates ?? 0
  const latestSequence = activity.data?.conversation.latestUpdateSequence ?? 0
  useEffect(() => {
    if (!opened || !unread || !latestSequence) return
    void api
      .seenThrough(opened.id, latestSequence)
      .then(() => queryClient.invalidateQueries({ queryKey: ['farm', 'assistant'] }))
      .catch(() => {})
  }, [api, opened, unread, latestSequence, queryClient])

  const loadEarlier = async () => {
    if (!opened || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const page = await api.history(opened.id, opened.before)
      setOpened((current) =>
        current
          ? {
              ...current,
              archive: [
                ...page.entries.filter((e) => !current.archive.some((row) => row.id === e.id)),
                ...current.archive,
              ],
              before: page.before,
              hasMore: page.hasMore,
            }
          : current
      )
    } finally {
      setLoadingEarlier(false)
    }
  }

  return (
    <ChatShell title="Assistant" subtitle="Your helper" leading={leading} onClose={onClose}>
      {error && (
        <div className="g-chat-error" role="alert">
          {error}{' '}
          {!opened && (
            <button type="button" className="g-chat-link" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      {opened ? (
        <>
          <AgentConversation
            key={opened.agentId}
            agentId={opened.agentId}
            hideInboxMessages
            renderReplyFooter={(item) => <AssistantTaskUpdates api={api} conversationId={opened.id} item={item} />}
            placeholder="Ask anything…"
            draftKey={`assistant:${opened.id}`}
            beforeConversation={
              opened.archive.length > 0 || opened.hasMore ? (
                <>
                  {opened.hasMore && (
                    <button
                      type="button"
                      className="g-chat-older"
                      disabled={loadingEarlier}
                      onClick={() => void loadEarlier()}
                    >
                      {loadingEarlier ? 'Loading older messages…' : 'Load older messages'}
                    </button>
                  )}
                  {opened.archive
                    .filter((entry) => entry.role !== 'tool' && entry.text.trim())
                    .map((entry) =>
                      entry.role === 'user' ? (
                        <div key={entry.id} className="g-chat-msg g-chat-human">
                          <div className="g-chat-bubble">
                            <Markdown>{entry.text}</Markdown>
                          </div>
                        </div>
                      ) : (
                        <div key={entry.id} className="g-chat-msg g-chat-agent">
                          <Markdown>{entry.text}</Markdown>
                        </div>
                      )
                    )}
                </>
              ) : undefined
            }
          />
        </>
      ) : (
        !error && (
          <p className="g-chat-system" role="status">
            Loading conversation…
          </p>
        )
      )}
    </ChatShell>
  )
}
