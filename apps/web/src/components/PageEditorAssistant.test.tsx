import { expect, mock, spyOn, test } from 'bun:test'
import { StrictMode, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import {
  createBlankWorkflow,
  assistantEditorInstructionsByKind,
  assistantEditorToolDefinitionsByKind,
  type AssistantEditorState,
} from '@ficus/shared'
import { assistantApi } from '../api/assistant'
import { queries } from '../queryOptions'
import { PermissionsProvider } from '../hooks/usePermissions'
import { acquireDomHarness } from '../test/domHarness'
import { PageEditorAssistant } from './PageEditorAssistant'

test('StrictMode keeps the editor open, synchronizes current drafts, and closes its capability on unmount', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queries.voice.status().queryKey, { enabled: true })
  let stored: AssistantEditorState | undefined
  let synced!: () => void
  let syncBoundary = new Promise<void>((resolve) => {
    synced = resolve
  })
  const create = spyOn(assistantApi, 'create').mockImplementation(async (id) => ({ id }) as any)
  const sync = spyOn(assistantApi, 'syncEditor').mockImplementation(async (_id, value) => {
    stored = value
    synced()
    return value
  })
  const read = spyOn(assistantApi, 'editor').mockImplementation(async () => ({ ...stored!, contract: '' }))
  let closed!: () => void
  const closeBoundary = new Promise<void>((resolve) => {
    closed = resolve
  })
  const close = spyOn(assistantApi, 'closeEditor').mockImplementation(async () => {
    closed()
    return {}
  })
  const fakeConversationApi = {
    ...assistantApi,
    ensureAgent: async () => ({ agentId: 'brain' }),
    history: async () => ({ entries: [], hasMore: false }),
    inbox: async () => ({ acquired: true, messages: [], pending: 0 }),
    release: async () => ({}),
  }
  const setLiveAudio = mock(async () => {})
  const retryConnection = mock(async () => {})
  const voice = {
    retryConnection,
    history: [],
    status: 'idle',
    error: null,
    isLiveAudio: false,
    isConnected: false,
    disconnect() {},
    setLiveAudio,
  }
  const useAssistant = () => voice
  const root = dom.createRoot()
  const onProposal = mock(() => undefined)
  const render = (revision: number) =>
    root.root.render(
      <StrictMode>
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <PermissionsProvider
              usePermissions={() => ({ can: () => true, permissions: ['*'], isLoading: false, isError: false })}
            >
              <PageEditorAssistant
                draft={{ kind: 'workflow', target: {}, revision, document: createBlankWorkflow() }}
                onProposal={onProposal}
                title="What flow do you want?"
                subtitle="Build and refine your flow together. Graph edits appear immediately and can be undone."
                conversationTitle="Design a workflow"
                instructions={assistantEditorInstructionsByKind.workflow}
                tools={assistantEditorToolDefinitionsByKind.workflow}
                conversationDependencies={{
                  api: fakeConversationApi as any,
                  useAssistant: useAssistant as any,
                  Chat: (({ onConversation }: any) => {
                    useEffect(() => {
                      onConversation?.({ items: [] })
                    }, [onConversation])
                    return null
                  }) as any,
                }}
              />
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>
    )
  try {
    await dom.act(async () => {
      render(0)
      await Promise.resolve()
    })
    await dom.act(async () => {
      await syncBoundary
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(stored?.revision).toBe(0)
    syncBoundary = new Promise<void>((resolve) => {
      synced = resolve
    })
    await dom.act(async () => render(1))
    await syncBoundary
    expect(stored?.revision).toBe(1)
    expect(document.body.textContent).not.toContain('Continue in text')
    expect(document.body.textContent).not.toContain('Use user assistant')
    const mic = document.querySelector('[aria-label="Enable microphone"]') as HTMLButtonElement
    await dom.act(async () => mic.click())
    expect(setLiveAudio.mock.calls).toEqual([[true]])
    const inlineMic = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'enable your microphone'
    )!
    await dom.act(async () => inlineMic.click())
    expect(setLiveAudio).toHaveBeenCalledTimes(2)
    Object.assign(voice, { error: 'Connection failed', status: 'error' })
    await dom.act(async () => render(1))
    const reconnect = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!
    expect(reconnect).toBeDefined()
    expect(document.body.textContent).not.toContain('Continue in text')
    await dom.act(async () => reconnect.click())
    expect(retryConnection).toHaveBeenCalledTimes(1)
    expect(setLiveAudio).toHaveBeenCalledTimes(2) // Reconnecting must not enable the microphone.
    expect(document.querySelector('[aria-label="Enable microphone"]')).not.toBeNull()
    await dom.act(async () => root.root.render(null))
    await closeBoundary
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    await dom.cleanup()
    cache.clear()
    for (const spy of [create, sync, read, close]) spy.mockRestore()
  }
})
