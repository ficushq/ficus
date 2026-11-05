// An agent chat with made-up messages where teammates are typing. The checker
// (check-teammates-typing-layout.ts) sets who is typing with window.setTypers, delivered the way the
// server does: agentChat.typing events on the agent's topic.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-react'
import type { AgentChatTypingEventData, Message } from '@ficus/shared'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { WebSocketContext, type WebSocketContextValue } from '../../src/hooks/useWebSocket'
import { ChatView } from '../../src/components/ChatView'
import '../../src/index.css'

declare global {
  interface Window {
    setTypers: (names: string[]) => void
  }
}

const AGENT = '7d0c7a52-5b8e-4a55-9a4e-2f1f6c1a9e01'
const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')

const start = Date.parse('2026-11-05T09:00:00Z')
const lines: Array<[Message['role'], string]> = [
  ['human', 'Can you check why the nightly import job failed?'],
  [
    'assistant',
    'The nightly import failed at 02:14 because the upstream CSV gained a new `region_code` column. The parser rejects unknown columns, so every row after the header was skipped.',
  ],
  ['human', 'Is anything else affected?'],
  [
    'assistant',
    'Two downstream reports read from the same table, so they show yesterday’s numbers. Nothing was lost: the raw file is still in the landing bucket and can be replayed.',
  ],
]
const items: RenderItem[] = lines.map(([role, content], index) => {
  const message: Message = {
    id: `m${index}`,
    role,
    content,
    metadata: null,
    createdAt: new Date(start + index * 60_000).toISOString(),
  }
  return { kind: 'persisted', id: message.id, message, mergedFrom: [message], blocks: [] }
})

// A stand-in socket: the chat subscribes to its agent's topic, and setTypers delivers typing events.
const listeners = new Set<(entry: { event: string; data: unknown }) => void>()
const socket: WebSocketContextValue = {
  subscribe: ((_topic: string, callback: (entry: { event: string; data: unknown }) => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }) as WebSocketContextValue['subscribe'],
  isConnected: true,
  send: () => true,
}
let typing: string[] = []
window.setTypers = (names) => {
  const emit = (data: AgentChatTypingEventData) => {
    for (const listener of listeners) listener({ event: 'agentChat.typing', data })
  }
  for (const name of typing) if (!names.includes(name)) emit({ agentId: AGENT, userId: name, typing: false })
  for (const name of names) emit({ agentId: AGENT, userId: name, typing: true, name })
  typing = names
}

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[`/chat/${AGENT}`]}>
    <QueryClientProvider client={cache}>
      <WebSocketContext.Provider value={socket}>
        <PermissionsProvider
          usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
        >
          <div className="fixed inset-0 flex flex-col bg-page p-0 text-primary md:p-4">
            <ChatView
              items={items}
              agentId={AGENT}
              showTeammateTyping
              onSend={() => undefined}
              header={<span className="text-sm font-medium">Engineer</span>}
              dependencies={{ useImageSrcsHook: () => ({}), useVoiceEnabledHook: () => false }}
            />
          </div>
        </PermissionsProvider>
      </WebSocketContext.Provider>
    </QueryClientProvider>
  </MemoryRouter>
)
