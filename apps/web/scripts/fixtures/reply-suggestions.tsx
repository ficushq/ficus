// An agent chat with made-up messages and one-tap reply suggestions floating over the end of the
// transcript. The checker (check-reply-suggestions-layout.ts) toggles the replies with window.setReplies.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-react'
import type { Message } from '@ficus/shared'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { ChatView } from '../../src/components/ChatView'
import { ReplySuggestions } from '../../src/components/ReplySuggestions'
import '../../src/index.css'

declare global {
  interface Window {
    setReplies: (replies: string[]) => void
  }
}

const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')

const start = Date.parse('2026-10-26T09:00:00Z')
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
  ['human', 'OK, what do you suggest?'],
  [
    'assistant',
    'I can make the parser ignore unknown columns (with a warning in the job log), add a test with the new file, and replay last night’s import once it is merged. Want me to open a work stream for that?',
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

const initialReplies = params.get('replies') === '0' ? [] : ['Yes, start it', 'Not now', 'Explain the replay first']

function Fixture() {
  const [replies, setReplies] = useState(initialReplies)
  window.setReplies = setReplies
  return (
    <div className="fixed inset-0 flex flex-col bg-page p-0 text-primary md:p-4">
      <ChatView
        items={items}
        agentId="agent-fixture"
        onSend={() => undefined}
        header={<span className="text-sm font-medium">Engineer</span>}
        stickyAfterMessages={
          replies.length ? (
            <ReplySuggestions replies={replies} onSend={() => undefined} onEdit={() => undefined} />
          ) : undefined
        }
        dependencies={{
          useImageSrcsHook: () => ({}),
          useVoiceEnabledHook: () => false,
        }}
      />
    </div>
  )
}

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/chat/agent-fixture']}>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        <Fixture />
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
