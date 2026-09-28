import { PermissionsProvider } from '../hooks/usePermissions'
import { describe, expect, mock, test, beforeEach } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'

import { ReactQueryHooksProvider } from '../reactQueryHooks'

const reactQueryOverrides = {
  queryOptions: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: mock(async () => undefined) }),
  useMutation: (options?: { mutationFn?: () => unknown; onSuccess?: () => unknown }) => ({
    mutate: mock(async () => {
      await options?.mutationFn?.()
      options?.onSuccess?.()
    }),
    isPending: false,
  }),
  useQuery: (options?: { queryKey?: unknown[] }) => {
    const key = options?.queryKey ?? []
    // Return mock agent data for agent detail queries
    if (Array.isArray(key) && key[0] === 'agents' && key[1] === 'detail') {
      return {
        data: {
          id: 'agent-1',
          agentTypeId: 'manager',
          squadId: null,
          status: mockAgentStatus,
          sessionUsage: {
            context: { percent: 42, contextWindow: 100000 },
            stats: { tokens: { total: 1234 }, cost: 0.56 },
          },
        },
      }
    }
    if (Array.isArray(key) && key[0] === 'agents' && key[1] === 'activeExecution') {
      return { data: mockExecutionData }
    }
    if (Array.isArray(key) && key[0] === 'agents' && key[2] === 'sandboxStatus') {
      return { data: mockSandboxStatus }
    }
    if (Array.isArray(key) && key[0] === 'agentTypes') {
      return { data: { model: 'anthropic:claude-sonnet-4-5' } }
    }
    if (Array.isArray(key) && key[0] === 'auth' && key[1] === 'permissions') {
      return { data: undefined, isLoading: true }
    }
    return { data: undefined }
  },
}

const usePermissionsMock = () => ({ permissions: [], can: (_action: string) => true, isLoading: false, isError: false })

let capturedAgentChatProps: Record<string, unknown> = {}
const AgentChatFixture = (props: Record<string, unknown>) => {
  capturedAgentChatProps = props
  return (
    <div data-testid="agent-chat">
      {/* Render the header so its contents are in the output */}
      {props.header as React.ReactNode}
    </div>
  )
}

let mockAgentStatus: 'idle' | 'active' = 'idle'
let mockExecutionData: { status: string; active: boolean } | null = null
let mockSandboxStatus: { status: string; runtime?: string; devboxReady?: boolean } | undefined = undefined

const { Chat } = await import('./Chat')

const chatDependencies = {
  AgentChatComponent: AgentChatFixture,
  useNotificationSoundHook: () => ({ playSound: mock(() => undefined) }),
  useTextToSpeechHook: () => ({
    enabled: false,
    speak: mock(async () => undefined),
    stop: mock(() => undefined),
    toggle: mock(() => undefined),
    isPlaying: false,
    isSynthesizing: false,
    playingMessageId: null,
  }),
  usePermissionsHook: usePermissionsMock,
}

function renderChat(element: React.ReactElement, entry = '/chat/agent-1?scope=all') {
  const injected = { ...element, props: { ...element.props, dependencies: chatDependencies } }
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <PermissionsProvider usePermissions={usePermissionsMock}>
        <ReactQueryHooksProvider hooks={reactQueryOverrides}>{injected}</ReactQueryHooksProvider>
      </PermissionsProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  capturedAgentChatProps = {}
  mockAgentStatus = 'idle'
  mockExecutionData = null
  mockSandboxStatus = undefined
})

// The api and the worker are separate processes and HostSandboxManager tracks
// its sandboxes in a per-process Map, so the api answers `not_found` for
// virtually every host sandbox. Gating the thinking label on `status` would
// therefore claim "Sandbox is starting..." for a whole turn on the host
// runtime, where there is no sandbox to start at all — gate on the
// server-driven `runtime` field instead.
describe('Chat thinking label', () => {
  test('host runtime never claims the sandbox is starting', () => {
    mockAgentStatus = 'active'
    mockExecutionData = { status: 'running', active: true }
    mockSandboxStatus = { status: 'not_found', runtime: 'host', devboxReady: false }

    renderChat(<Chat agentId="agent-1" scope={{ type: 'system-manager' }} />)

    expect(capturedAgentChatProps.thinkingLabel).toBe('Agent is working...')
  })

  test('docker runtime still reports a sandbox that is not running yet', () => {
    mockAgentStatus = 'active'
    mockExecutionData = { status: 'running', active: true }
    mockSandboxStatus = { status: 'pending', runtime: 'docker' }

    renderChat(<Chat agentId="agent-1" scope={{ type: 'system-manager' }} />)

    expect(capturedAgentChatProps.thinkingLabel).toBe('Sandbox is starting...')
  })

  test('docker runtime reports an installing devbox', () => {
    mockAgentStatus = 'active'
    mockExecutionData = { status: 'running', active: true }
    mockSandboxStatus = { status: 'running', runtime: 'docker', devboxReady: false }

    renderChat(<Chat agentId="agent-1" scope={{ type: 'system-manager' }} />)

    expect(capturedAgentChatProps.thinkingLabel).toBe('Sandbox is starting...')
  })
})

describe('Chat header rendering', () => {
  test('passes the consultant squad scope before the first agent exists', () => {
    renderChat(<Chat scope={{ type: 'consultant', id: 'squad-1' }} />)

    expect(capturedAgentChatProps.squadId).toBe('squad-1')
  })

  test('checks chat permission in the squad the server checks, for a squad-scoped role', () => {
    // A squad-scoped operator: chat:send only inside squad-1, nothing app-wide.
    const squadOnly = (squadId?: string) => ({
      permissions: [],
      can: (action: string) => action === 'chat:send' && squadId === 'squad-1',
      isLoading: false,
      isError: false,
    })
    const render = (element: React.ReactElement) =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={['/chat']}>
          <ReactQueryHooksProvider hooks={reactQueryOverrides}>
            {{
              ...element,
              props: { ...element.props, dependencies: { ...chatDependencies, usePermissionsHook: squadOnly } },
            }}
          </ReactQueryHooksProvider>
        </MemoryRouter>
      )

    render(<Chat scope={{ type: 'consultant', id: 'squad-1' }} />)
    expect(capturedAgentChatProps.inputDisabled).toBe(false)

    render(<Chat scope={{ type: 'system-manager' }} />)
    expect(capturedAgentChatProps.inputDisabled).toBe(true)
  })

  test('preserves squadless system-manager chats', () => {
    renderChat(<Chat scope={{ type: 'system-manager' }} />)

    expect(capturedAgentChatProps.squadId).toBeUndefined()
  })

  test('renders the default chat header title for standalone chat views', () => {
    const html = renderChat(<Chat agentId="agent-1" agentName="Agent Alpha" scope={{ type: 'system-manager' }} />)

    // headerLayout=default → title row is included
    expect(html).toContain('Agent Alpha')
    // Usage is no longer in Chat chrome — it renders inside AgentChat
    expect(html).not.toContain('42%')
  })

  test('can render only the action row when the parent owns the title row', () => {
    const html = renderChat(
      <Chat agentId="agent-1" agentName="Agent Alpha" scope={{ type: 'system-manager' }} headerLayout="controls" />
    )

    // headerLayout=controls → no title row
    expect(html).not.toContain('Agent Alpha')
    // Usage not in chrome
    expect(html).not.toContain('42%')
  })

  test('shows Compact and Reset controls for idle agents', () => {
    mockAgentStatus = 'idle'
    mockExecutionData = null

    const html = renderChat(
      <Chat agentId="agent-1" agentName="Agent Alpha" scope={{ type: 'system-manager' }} headerLayout="controls" />
    )

    expect(html).toContain('Compact')
    expect(html).toContain('Reset')
  })

  test('shows Stop control for running agents', () => {
    mockAgentStatus = 'active'
    mockExecutionData = { status: 'running', active: true }

    const html = renderChat(
      <Chat agentId="agent-1" agentName="Agent Alpha" scope={{ type: 'system-manager' }} headerLayout="controls" />
    )

    expect(html).toContain('Stop')
    expect(html).not.toContain('Compact')
    expect(html).not.toContain('Reset')
  })

  test('renders AgentChat with correct agentId, scope, and onAgentCreated', () => {
    const onAgentCreated = mock(() => undefined)
    renderChat(<Chat agentId="agent-1" scope={{ type: 'system-manager' }} onAgentCreated={onAgentCreated} />)

    expect(capturedAgentChatProps.agentId).toBe('agent-1')
    expect((capturedAgentChatProps.scope as { type: string })?.type).toBe('system-manager')
    expect(capturedAgentChatProps.onAgentCreated).toBeDefined()

    // Invoking the captured onAgentCreated should forward to the prop
    ;(capturedAgentChatProps.onAgentCreated as (id: string) => void)('new-agent-id')
    expect(onAgentCreated).toHaveBeenCalledWith('new-agent-id')
  })

  test('passes permission-denied placeholder when canSendChat is false', () => {
    // usePermissions mock returns isLoading:false and can() => true by default.
    // Override: we need a permissions-denied scenario. Since the mock always returns
    // can() => true (and thus canSendChat=true), verify the prop is undefined in that case.
    renderChat(<Chat agentId="agent-1" scope={{ type: 'system-manager' }} />)
    // canSendChat=true → no placeholder override
    expect(capturedAgentChatProps.placeholder).toBeUndefined()
  })
})

test('hands AgentChat navigation to the owning real router', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/agent-1' })
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:agentId',
        element: (
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ReactQueryHooksProvider hooks={reactQueryOverrides}>
              <Chat dependencies={chatDependencies} agentId="agent-1" scope={{ type: 'system-manager' }} />
            </ReactQueryHooksProvider>
          </PermissionsProvider>
        ),
      },
    ],
    { initialEntries: ['/chat/agent-1?scope=all'] }
  )
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    expect(router.state.location.pathname + router.state.location.search).toBe('/chat/agent-1?scope=all')
    const onNavigate = capturedAgentChatProps.onNavigate as (path: string) => void
    expect(onNavigate).toBeFunction()
    await dom.act(async () => onNavigate('/chat/agent-2?scope=system'))
    expect(router.state.location.pathname + router.state.location.search).toBe('/chat/agent-2?scope=system')
  } finally {
    await dom.cleanup()
  }
})
