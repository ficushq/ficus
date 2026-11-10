// An agent chat with made-up messages embedded the way squad agent threads embed it: the parent draws
// its own title bar and passes enableFullscreen={false}, so ChatView has no header content of its own.
// The checker (check-history-search-placement.ts) opens it with ?composer=hidden for a read-only
// transcript, where the history search button falls back to ChatView's header.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-react'
import type { Message } from '@ficus/shared'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { ChatView } from '../../src/components/ChatView'
import { ChevronDownIcon, ExpandIcon } from '../../src/components/icons'
import '../../src/index.css'

const AGENT = '7d0c7a52-5b8e-4a55-9a4e-2f1f6c1a9e01'
const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')
const hideComposer = params.get('composer') === 'hidden'

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

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[`/chat/${AGENT}`]}>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        <div className="fixed inset-0 flex flex-col bg-page p-0 text-primary md:p-4">
          <div className="flex flex-col min-h-0 grow rounded-lg border border-th-border bg-surface">
            {/* The parent's own title bar, like squad agent threads. */}
            <div data-testid="parent-title-bar" className="flex items-center gap-2 border-b border-th-border px-3 py-2">
              <span className="text-sm font-medium">Engineer</span>
              <span className="ficus-button ficus-button-ghost flex items-center gap-1 rounded-md px-2 py-1 text-sm">
                Chat <ChevronDownIcon className="h-3 w-3" />
              </span>
              <span className="flex-1" />
              <span className="ficus-button ficus-button-ghost rounded-md p-1.5" aria-hidden="true">
                <ExpandIcon className="h-4 w-4" />
              </span>
            </div>
            <ChatView
              items={items}
              agentId={AGENT}
              enableHistorySearch
              enableFullscreen={false}
              hideComposer={hideComposer}
              hasOlderMessages={false}
              onLoadOlder={() => Promise.resolve()}
              onSend={() => undefined}
              dependencies={{ useImageSrcsHook: () => ({}), useVoiceEnabledHook: () => false }}
            />
          </div>
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
