// An agent chat composer at a chosen width inside a wide viewport, with the real components and
// stylesheet and made-up messages. The checker (check-composer-narrow.ts) opens it with:
// - ?layout=window&w=340 — a real floating agent window (title bar included) of that width;
// - ?layout=panel&w=420 — the chat in a side panel of that width beside page content;
// - ?layout=page — the chat across a wide page;
// and &busy=1 for a running turn (Stop, the Interrupt / Follow up split button and its Auto hint).
// &state=waiting-sandbox (or another execution state) shows its word beside the context ring.
// window.composerFixture.setBusy(boolean) starts or ends the turn in place, without a reload.
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-react'
import type { Agent, ExecutionStatus, Message, Squad } from '@ficus/shared'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { queries } from '../../src/queryOptions'
import { chatWindowsStorageKey } from '../../src/lib/chatWindows'
import { ChatView } from '../../src/components/ChatView'
import { AgentChatWindow } from '../../src/components/AgentChatWindow'
import { AgentComposerStatus } from '../../src/components/AgentComposerStatus'
import { FloatingChatButton } from '../../src/components/FloatingChatButton'
import { FloatingWindowsProvider } from '../../src/components/FloatingWindows'
import '../../src/index.css'

const AGENT = '7d0c7a52-5b8e-4a55-9a4e-2f1f6c1a9e01'
const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')
const layout = params.get('layout') ?? 'window'
const width = Number(params.get('w') ?? 340)
let fixtureBusy = params.get('busy') === '1'
const busyListeners = new Set<() => void>()
;(window as unknown as { composerFixture: { setBusy(next: boolean): void } }).composerFixture = {
  setBusy(next) {
    fixtureBusy = next
    for (const listener of busyListeners) listener()
  },
}
const subscribeBusy = (listener: () => void) => {
  busyListeners.add(listener)
  return () => busyListeners.delete(listener)
}

const now = new Date('2026-11-20T09:00:00Z')
const agent = {
  id: AGENT,
  squadId: 'squad-1',
  agentTypeId: 'engineer',
  status: fixtureBusy ? 'active' : 'idle',
  metadata: { purpose: 'Linear null-creator handling in the polling runtime' },
  createdAt: now,
} as unknown as Agent
const squad = {
  id: 'squad-1',
  name: 'Ficus',
  purpose: 'Build Ficus',
  status: 'active',
  managerAgentId: null,
  metadata: {},
  createdAt: now,
  updatedAt: now,
} as unknown as Squad

const lines: Array<[Message['role'], string]> = [
  ['human', 'Is the Linear fix ready to merge?'],
  [
    'assistant',
    'All 333 Linear and relay tests pass on the merged code, including the polling runtime. The full Core suite and typecheck are running in CI on the new head now.',
  ],
  ['human', 'Keep auto-merge off until that passes.'],
  ['assistant', 'Auto-merge stays off. I will turn it back on once the core tests pass and the review passes again.'],
]
const items: RenderItem[] = lines.map(([role, content], index) => {
  const message: Message = {
    id: `m${index}`,
    agentId: AGENT,
    role,
    content,
    metadata: null,
    pending: false,
    createdAt: new Date(now.getTime() + index * 60_000),
  }
  return { kind: 'persisted', id: message.id, message, mergedFrom: [message], blocks: [] }
})

/** The composer the way an agent chat fills it: every action, the context ring and the pop-out control. */
function FixtureChat({ agentId }: { agentId: string }) {
  const busy = useSyncExternalStore(subscribeBusy, () => fixtureBusy)
  return (
    <ChatView
      items={items}
      agentId={agentId}
      enableHistorySearch
      enableFullscreen={false}
      hasOlderMessages={false}
      onLoadOlder={() => Promise.resolve()}
      onSend={() => undefined}
      showRawText={false}
      onToggleRawText={() => undefined}
      composerStatus={
        <AgentComposerStatus
          status={(params.get('state') as ExecutionStatus | null) ?? undefined}
          context={{ percent: 18.2, tokens: 36_400, contextWindow: 200_000 }}
          canManageSession={!busy}
          onCompact={() => undefined}
          onReset={() => undefined}
        />
      }
      composerControls={<FloatingChatButton agentId={agentId} />}
      {...(busy
        ? {
            executionStatus: 'running' as const,
            onStop: () => undefined,
            deliveryMode: 'steer' as const,
            onDeliveryModeChange: () => undefined,
            suggestedDelivery: { now: true },
          }
        : {})}
      dependencies={{ useImageSrcsHook: () => ({}), useVoiceEnabledHook: () => true }}
    />
  )
}

function FixtureWindow(props: Parameters<typeof AgentChatWindow>[0]) {
  return (
    <AgentChatWindow
      {...props}
      dependencies={{ ConversationComponent: FixtureChat as never, loadAgent: async () => agent }}
    />
  )
}

if (layout === 'window') {
  localStorage.setItem(
    chatWindowsStorageKey('user:u1'),
    JSON.stringify({
      assistantZ: 0,
      windows: [{ agentId: AGENT, rect: { x: 40, y: 24, w: width, h: 640 }, z: 1 }],
      remembered: {},
    })
  )
} else {
  localStorage.removeItem(chatWindowsStorageKey('user:u1'))
}

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
cache.setQueryData(queries.agents.detail(AGENT).queryKey, agent)
cache.setQueryData(queries.squads.list().queryKey, [squad])
cache.setQueryData(queries.agentTypes.list().queryKey, [{ id: 'engineer', name: 'Engineer' }] as never)
cache.setQueryData(queries.agents.activeExecution(AGENT).queryKey, { active: false })

/** Stand-in page content behind and beside the chat. */
const pageContent = (
  <div className="space-y-3 p-6">
    <h1 className="text-lg font-semibold">Work</h1>
    {Array.from({ length: 6 }, (_, index) => (
      <div key={index} className="h-14 rounded-lg border border-th-border bg-surface" />
    ))}
  </div>
)

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/feed']}>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({
          permissions: ['*'],
          can: () => true,
          isLoading: false,
          isError: false,
          identity: { type: 'user', userId: 'u1' },
        })}
      >
        <FloatingWindowsProvider dependencies={{ WindowComponent: FixtureWindow }}>
          <div className="fixed inset-0 flex bg-page text-primary">
            {layout === 'page' ? (
              <div className="flex min-h-0 grow flex-col p-0 md:p-4">
                <div className="flex min-h-0 grow flex-col rounded-lg border border-th-border bg-surface">
                  <FixtureChat agentId={AGENT} />
                </div>
              </div>
            ) : layout === 'panel' ? (
              <>
                <div className="min-w-0 grow">{pageContent}</div>
                <aside
                  data-testid="side-panel"
                  style={{ width }}
                  className="flex min-h-0 shrink-0 flex-col border-l border-th-border bg-surface"
                >
                  <FixtureChat agentId={AGENT} />
                </aside>
              </>
            ) : (
              <div className="min-w-0 grow">{pageContent}</div>
            )}
          </div>
        </FloatingWindowsProvider>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
