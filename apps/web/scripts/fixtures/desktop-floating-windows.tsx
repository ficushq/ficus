import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import type { Agent } from '@ficus/shared'
import { AppHeader } from '../../src/components/AppNav'
import { InboxPopupProvider } from '../../src/components/InboxPopupProvider'
import { InboxPopup } from '../../src/components/InboxPopup'
import { ActionCenter } from '../../src/components/ActionCenter'
import { ThemeProvider } from '../../src/providers/ThemeProvider'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { useDesktopShellChrome } from '../../src/hooks/useDesktopShellChrome'
import { assistantQueries, integrationQueries, queries } from '../../src/queryOptions'
import { FloatingWindowsProvider } from '../../src/components/FloatingWindows'
import { AgentChatWindow } from '../../src/components/AgentChatWindow'
import { UnifiedAssistant } from '../../src/components/UnifiedAssistant'
import { TemplateDiffDialog } from '../../src/components/settings/TemplateDiffDialog'
import { TemplateFieldActions } from '../../src/components/settings/TemplateFieldActions'
import { FileUpload } from '../../src/components/workspace/FileUpload'
import type { WorkspaceSource } from '../../src/components/workspace/workspaceSource'
import type { UploadResponse } from '../../src/api/workspace'
import '../../src/index.css'

/** The agents whose chat windows check-desktop-floating-windows stores before the page loads. */
export const AGENTS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] as const
const now = new Date('2026-11-20T00:00:00Z')

function StubConversation({ agentId }: { agentId: string }) {
  return (
    <div className="flex grow flex-col gap-2 p-3 text-sm text-secondary" data-stub-conversation={agentId}>
      <p>Transcript of {agentId.slice(0, 8)}</p>
      <textarea className="ficus-field mt-auto" aria-label={`Message ${agentId.slice(0, 8)}`} />
    </div>
  )
}

function Window(props: { win: Parameters<typeof AgentChatWindow>[0]['win'] }) {
  return <AgentChatWindow {...props} dependencies={{ ConversationComponent: StubConversation as never }} />
}

const TEMPLATE = { name: 'Researcher', model: 'deep', instructions: 'Read the brief and the history first.' }
const CURRENT = { name: 'Researcher', model: 'standard', instructions: 'Read the brief first.' }

/** A workspace where every file already exists, so an upload always asks whether to overwrite. */
const workspace = {
  id: 'squad:squad-1',
  treeQueryPrefix: ['fixture-workspace'],
  canWrite: true,
  upload: async (files, { overwrite }) => {
    await new Promise((done) => setTimeout(done, 50))
    return {
      results: files.map((file) => ({ path: file.relativePath, status: overwrite ? 'uploaded' : 'skipped' })),
    } as UploadResponse
  },
} as Pick<WorkspaceSource, 'id' | 'treeQueryPrefix' | 'canWrite' | 'upload'> as WorkspaceSource

function AssistantConversation() {
  return <div className="p-3 text-sm text-secondary">Assistant conversation</div>
}

export function Fixture() {
  useDesktopShellChrome()
  const [diff, setDiff] = useState(false)
  return (
    <>
      <AppHeader usePendingActions={() => ({ data: [] })} />
      <main className="flex items-center gap-3 p-4">
        <button className="ficus-button ficus-button-secondary" onClick={() => setDiff(true)}>
          Open template diff
        </button>
        <TemplateFieldActions
          field="model"
          current={CURRENT}
          template={TEMPLATE}
          fieldOverrides={['model']}
          onRevert={() => undefined}
        />
        <div className="relative">
          <FileUpload source={workspace} />
        </div>
      </main>
      <UnifiedAssistant dependencies={{ ConversationComponent: AssistantConversation as never }} />
      {/* The header dropdowns, opened by their app events. */}
      <InboxPopup />
      <ActionCenter />
      <TemplateDiffDialog
        isOpen={diff}
        onClose={() => setDiff(false)}
        title="Template differences"
        current={CURRENT}
        template={TEMPLATE}
        onRevert={() => setDiff(false)}
      />
    </>
  )
}

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
for (const [index, id] of AGENTS.entries())
  cache.setQueryData(queries.agents.detail(id).queryKey, {
    id,
    squadId: 'squad-1',
    agentTypeId: 'consultant',
    status: 'idle',
    metadata: { name: index ? 'Reviewer' : 'Researcher' },
    createdAt: now,
  } as unknown as Agent)
for (const [key, value] of [
  [queries.voice.status().queryKey, { enabled: false }],
  [queries.squads.list().queryKey, []],
  [queries.agents.list({ agentTypeId: 'consultant' }).queryKey, []],
  [queries.actions.pending().queryKey, []],
  [queries.agentTypes.list().queryKey, []],
  [integrationQueries.catalog().queryKey, { integrations: [] }],
  [
    assistantQueries.activity('u1').queryKey,
    {
      totals: {
        unreadConversations: 0,
        unreadUpdates: 0,
        workingTasks: 0,
        waitingTasks: 0,
        needsInputTasks: 0,
        unavailableTasks: 0,
      },
      conversations: [],
      hasMore: false,
    },
  ],
] as const)
  cache.setQueryData(key, value)

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={cache}>
    <ThemeProvider>
      <BrowserRouter>
        <PermissionsProvider
          usePermissions={() => ({
            can: () => true,
            permissions: ['chat:send'],
            isLoading: false,
            isError: false,
            identity: { type: 'user', userId: 'u1' },
          })}
        >
          <InboxPopupProvider>
            <FloatingWindowsProvider dependencies={{ WindowComponent: Window }}>
              <Fixture />
            </FloatingWindowsProvider>
          </InboxPopupProvider>
        </PermissionsProvider>
      </BrowserRouter>
    </ThemeProvider>
  </QueryClientProvider>
)
