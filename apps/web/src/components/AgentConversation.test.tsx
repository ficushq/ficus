import { PermissionsProvider } from '../hooks/usePermissions'
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatApiProvider } from '../api/ChatApiProvider'
// ---------------------------------------------------------------------------
// Module mocks — must be declared before any lazy imports
// ---------------------------------------------------------------------------

// Control permissions in tests
let _permissions = new Set<string>()

// Control active execution in tests (for Stop-button RBAC test)
let _activeExecution: { active: boolean; status?: string } | undefined = undefined
let _agentStatus = 'idle'
let _agentSquadId: string | undefined
let _slotWaits: Array<{ waiterId: string; poolKey: string; queuedAt: string }> = []

// Control the live sandbox-wait signal AgentChat's useAgentConversation would supply to the composer status
let _waitingForSandbox = false

// Mock @tanstack/react-query hooks to avoid dual-React hook issues in renderToStaticMarkup.
// AgentConversationBody calls useQueryClient/useQuery/useMutation for header chrome.
// We preserve queryOptions (used by queryOptions.ts) by re-exporting it.
// useQuery call order: 1=agent, 2=activeExecution (AgentConversationBody), 3=slot waits (AgentSlotWaitStatus).
let _useQueryCallCount = 0
import { ReactQueryHooksProvider } from '../reactQueryHooks'

const reactQueryOverrides = {
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: () => {
    const call = ++_useQueryCallCount
    if (call === 2 && _activeExecution !== undefined) {
      return { data: _activeExecution }
    }
    // call 1 = agent: return a minimal agent so the header renders
    if (call === 1 && _activeExecution !== undefined) {
      return { data: { id: 'a1', status: _agentStatus, terminatedAt: null, squadId: _agentSquadId } }
    }
    if (call === 3) return { data: _slotWaits }
    return { data: undefined }
  },
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}

// Mock usePermissions so tests control agents:run
const usePermissionsMock = () => ({
  permissions: [..._permissions],
  can: (permission: string) => _permissions.has(permission),
  isLoading: false,
  isError: false,
})

// Mock AgentChat so we can assert it's rendered with the right props
const TestAgentChat = ({
  agentId,
  embedded,
  enableFullscreen,
  isReview,
  inputDisabled,
  viewingUserId,
  composerStatus,
  showRawText,
  onToggleRawText,
}: {
  agentId?: string
  embedded?: boolean
  enableFullscreen?: boolean
  isReview?: boolean
  inputDisabled?: boolean
  viewingUserId?: string
  composerStatus?: ReactNode | ((state: { waitingForSandbox: boolean }) => ReactNode)
  showRawText?: boolean
  onToggleRawText?: () => void
}) => (
  <div
    data-testid="agent-chat"
    data-agent-id={agentId ?? ''}
    data-embedded={String(embedded ?? false)}
    data-enable-fullscreen={String(enableFullscreen ?? true)}
    data-is-review={String(isReview ?? false)}
    data-input-disabled={String(inputDisabled ?? false)}
    data-viewing-user-id={viewingUserId ?? ''}
    data-show-raw-text={String(showRawText)}
    data-has-raw-text-toggle={String(typeof onToggleRawText === 'function')}
  >
    {composerStatus && (
      <div data-testid="agent-chat-composer-status">
        {typeof composerStatus === 'function'
          ? composerStatus({ waitingForSandbox: _waitingForSandbox })
          : composerStatus}
      </div>
    )}
  </div>
)

// ---------------------------------------------------------------------------
// Lazy import (after all mocks are established)
// ---------------------------------------------------------------------------

const { AgentConversation } = await import('./AgentConversation.tsx')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function render(props: Parameters<typeof AgentConversation>[0]) {
  _useQueryCallCount = 0
  return renderToStaticMarkup(
    <PermissionsProvider usePermissions={usePermissionsMock}>
      <ReactQueryHooksProvider hooks={reactQueryOverrides}>
        <ChatApiProvider
          overrides={{
            getAgent: async () => null as never,
            getActiveExecution: async () => ({ active: false }) as never,
          }}
        >
          <AgentConversation {...props} dependencies={{ AgentChatComponent: TestAgentChat }} />
        </ChatApiProvider>
      </ReactQueryHooksProvider>
    </PermissionsProvider>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentConversation wraps AgentChat', () => {
  test('keeps queued slot context out of the composer', () => {
    _agentSquadId = 'squad-a'
    _permissions = new Set(['slots:use'])
    _activeExecution = { active: true, status: 'running' }
    _slotWaits = [{ waiterId: 'waiter-a', poolKey: 'shared-box-intensive', queuedAt: '2026-09-14T21:49:49Z' }]
    try {
      const html = render({ agentId: 'a1' })
      expect(html).not.toContain('Queued for slots:')
      expect(html).not.toContain('shared-box-intensive')
      // Plain "running" is the composer's Stop and the transcript's working row, not a label.
      expect(html).not.toContain('>running<')
      expect(html).not.toContain('agent-chat-header')
    } finally {
      _agentSquadId = undefined
      _permissions = new Set()
      _activeExecution = undefined
      _slotWaits = []
    }
  })

  test('renders AgentChat with agentId forwarded', () => {
    const html = render({ agentId: 'my-agent' })
    expect(html).toContain('data-testid="agent-chat"')
    expect(html).toContain('data-agent-id="my-agent"')
  })

  test('forwards embedded=true to AgentChat', () => {
    const html = render({ agentId: 'a1', embedded: true })
    expect(html).toContain('data-embedded="true"')
  })

  test('forwards enableFullscreen=false to AgentChat', () => {
    const html = render({ agentId: 'a1', enableFullscreen: false })
    expect(html).toContain('data-enable-fullscreen="false"')
  })

  test('forwards isReview to AgentChat', () => {
    const html = render({ agentId: 'a1', isReview: true })
    expect(html).toContain('data-is-review="true"')
  })

  test('forwards viewingUserId to AgentChat', () => {
    const html = render({ agentId: 'a1', viewingUserId: 'user-42' })
    expect(html).toContain('data-viewing-user-id="user-42"')
  })

  test('owns rendered mode by default and forwards the raw text toggle API', () => {
    const html = render({ agentId: 'a1' })

    expect(html).toContain('data-show-raw-text="false"')
    expect(html).toContain('data-has-raw-text-toggle="true"')
  })
})

describe('AgentConversation RBAC gating (agents:run)', () => {
  test('inputDisabled=true when agents:run permission is absent', () => {
    _permissions = new Set()
    const html = render({ agentId: 'a1' })
    // usePermissions returns can('agents:run') = false → canRunAgent = false → inputDisabled={!canRunAgent} = true
    expect(html).toContain('data-input-disabled="true"')
  })

  test('inputDisabled=false when agents:run permission is granted', () => {
    _permissions = new Set(['agents:run'])
    const html = render({ agentId: 'a1' })
    expect(html).toContain('data-input-disabled="false"')
  })

  test("the status has no Stop of its own: the composer's Stop is gated by inputDisabled", () => {
    for (const permissions of [new Set<string>(), new Set(['agents:run'])]) {
      _permissions = permissions
      _activeExecution = { active: true, status: 'running' }
      try {
        const html = render({ agentId: 'a1' })
        expect(html).not.toContain('>Stop<')
        expect(html).toContain(`data-input-disabled="${permissions.size === 0}"`)
      } finally {
        _activeExecution = undefined
      }
    }
  })
})

describe('AgentConversation status badge', () => {
  test('says when the session is compacting or resetting', () => {
    _activeExecution = { active: false }
    for (const [status, label] of [
      ['compacting', 'Compacting…'],
      ['resetting', 'Resetting…'],
    ]) {
      _agentStatus = status!
      const html = render({ agentId: 'a1' })
      expect(html).toContain(`>${label}<`)
    }
    _agentStatus = 'idle'
    _activeExecution = undefined
  })
})

describe('AgentConversation execution badge (sandbox wait)', () => {
  test('labels a running execution "Waiting for sandbox" while the live stream says the turn is blocked on its sandbox', () => {
    // The DB status stays 'running' during a normal in-turn sandbox ensure; the
    // runner streams execution_phase:waiting_sandbox for exactly that window.
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'running' }
    _waitingForSandbox = true
    try {
      const html = render({ agentId: 'a1' })
      expect(html).toContain('Waiting for sandbox')
      expect(html).not.toContain('>running<')
    } finally {
      _activeExecution = undefined
      _waitingForSandbox = false
    }
  })

  test('drops the sandbox label once sandbox_ready clears the live signal', () => {
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'running' }
    _waitingForSandbox = false
    try {
      const html = render({ agentId: 'a1' })
      expect(html).not.toContain('Waiting for sandbox')
    } finally {
      _activeExecution = undefined
    }
  })

  test('still labels the reactive DB status waiting-sandbox as "Waiting for sandbox" without the live signal', () => {
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'waiting-sandbox' }
    _waitingForSandbox = false
    try {
      const html = render({ agentId: 'a1' })
      expect(html).toContain('Waiting for sandbox')
    } finally {
      _activeExecution = undefined
    }
  })
})
