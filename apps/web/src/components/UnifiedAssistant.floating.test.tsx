import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import type { Agent } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { apiUnavailable } from '../test/apiMock'
import { PermissionsProvider } from '../hooks/usePermissions'
import { integrationQueries, queries } from '../queryOptions'
import { chatWindowsStorageKey } from '../lib/chatWindows'
import { readAssistantNavigation } from '../hooks/useAssistantNavigation'
import { FloatingWindowsProvider } from './FloatingWindows'
import { AgentChatWindow } from './AgentChatWindow'
import { AssistantConversationLinkRow } from './AssistantConversationLinkRow'
import { UnifiedAssistant } from './UnifiedAssistant'
import type { AssistantConversationView } from './AssistantConversationView'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const now = new Date('2026-11-20T00:00:00Z')
const researcher = {
  id: A,
  squadId: 'squad-1',
  agentTypeId: 'consultant',
  status: 'idle',
  metadata: { name: 'Researcher' },
  createdAt: now,
} as unknown as Agent

function StubConversation({ agentId }: { agentId: string }) {
  return (
    <div data-stub-conversation={agentId}>
      <textarea aria-label="Window composer" />
    </div>
  )
}
function Window(props: { win: Parameters<typeof AgentChatWindow>[0]['win'] }) {
  return <AgentChatWindow {...props} dependencies={{ ConversationComponent: StubConversation as never }} />
}

async function setup({ floating = false }: { floating?: boolean } = {}) {
  // The assistant list, its activity and the update settings stay unavailable; these tests cover
  // the floating layout.
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    windowOptions: { innerWidth: 1400, innerHeight: 900 },
    api: {
      '/api/assistant': apiUnavailable,
      '/api/assistant/activity': apiUnavailable,
      '/api/updates/settings': apiUnavailable,
    },
  })
  const media = { matches: true, addEventListener() {}, removeEventListener() {} }
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => media })
  dom.window.localStorage.clear()
  if (floating)
    dom.window.localStorage.setItem(
      chatWindowsStorageKey('user:u1'),
      JSON.stringify({
        assistantZ: 0,
        windows: [{ agentId: A, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1, minimized: true }],
        remembered: {},
      })
    )
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const [key, value] of [
    [queries.voice.status().queryKey, { enabled: false }],
    [queries.squads.list().queryKey, []],
    [queries.squads.allWorkStreams().queryKey, []],
    [queries.agents.list({ agentTypeId: 'consultant' }).queryKey, []],
    [queries.agents.detail(A).queryKey, researcher],
    [queries.actions.pending().queryKey, []],
    [queries.agentTypes.list().queryKey, []],
    [integrationQueries.catalog().queryKey, { integrations: [] }],
  ] as const)
    cache.setQueryData(key, value)
  let parent: Parameters<typeof AssistantConversationView>[0] | undefined
  let chat: Record<string, unknown> | undefined
  let search = ''
  // Stubs report what they rendered with through these, never by assigning outside themselves.
  const seen = {
    parent: (props: Parameters<typeof AssistantConversationView>[0]) => {
      parent = props
    },
    chat: (props: Record<string, unknown>) => {
      chat = props
    },
    search: (value: string) => {
      search = value
    },
  }
  function Conversation(props: Parameters<typeof AssistantConversationView>[0]) {
    seen.parent(props)
    return (
      <div>
        <input aria-label="Assistant draft" />
        <AssistantConversationLinkRow
          conversation={{ agentId: A, squadId: 'squad-1', label: 'Researcher' }}
          onOpen={props.onOpenConversation!}
        />
      </div>
    )
  }
  function Chat(props: Record<string, unknown>) {
    seen.chat(props)
    return <div data-inline-chat>{props.composerControls as never}</div>
  }
  function Probe() {
    seen.search(useLocation().search)
    return null
  }
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={['/feed?chat=open&assistantConversation=parent']}>
          <PermissionsProvider
            usePermissions={() => ({
              can: () => true,
              permissions: ['chat:send'],
              isLoading: false,
              isError: false,
              identity: { type: 'user', userId: 'u1' },
            })}
          >
            <FloatingWindowsProvider dependencies={{ WindowComponent: Window }}>
              <UnifiedAssistant dependencies={{ ConversationComponent: Conversation, ChatComponent: Chat as never }} />
              <Probe />
            </FloatingWindowsProvider>
          </PermissionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  const assistant = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Assistant"]')!
  const agentWindow = () => document.querySelector<HTMLElement>(`[data-floating-window="${A}"]`)
  const linkRow = () => document.querySelector<HTMLButtonElement>(`button[data-agent-chat-id="${A}"]`)!
  const stack = () => readAssistantNavigation(new URLSearchParams(search)).map((entry) => entry.kind)
  const click = async (target: Element, init: MouseEventInit = {}) => {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
    await dom.act(async () => target.dispatchEvent(event))
    return event
  }
  const key = async (target: Element, init: KeyboardEventInit) =>
    dom.act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  return {
    dom,
    parent: () => parent,
    chat: () => chat,
    assistant,
    agentWindow,
    linkRow,
    stack,
    click,
    key,
    cleanup: async () => {
      await dom.cleanup()
      cache.clear()
    },
  }
}

test('Shift- or Alt-click on an assistant conversation link opens a floating window; the assistant stays where it was', async () => {
  const t = await setup()
  try {
    expect(t.stack()).toEqual(['assistant'])
    await t.click(t.linkRow(), { shiftKey: true })
    expect(t.agentWindow()).not.toBeNull()
    expect(t.stack()).toEqual(['assistant'])
    expect(t.parent()!.visible).toBe(true)
    expect(t.chat()).toBeUndefined()
    // A plain click still drills in.
    await t.click(t.agentWindow()!.querySelector('button[aria-label="Close window"]')!)
    await t.click(t.linkRow())
    expect(t.stack()).toEqual(['assistant', 'chat'])
    expect(t.chat()!.agentId).toBe(A)
  } finally {
    await t.cleanup()
  }
})

test('the pop-out on a chat inside the assistant moves it to a floating window and the assistant steps back', async () => {
  const t = await setup()
  try {
    await t.click(t.linkRow())
    expect(t.stack()).toEqual(['assistant', 'chat'])
    const popOut = document.querySelector<HTMLButtonElement>(
      '[data-inline-chat] button[aria-label="Open in floating window"]'
    )!
    expect(popOut).not.toBeNull()
    await t.click(popOut)
    expect(t.agentWindow()).not.toBeNull()
    expect(t.stack()).toEqual(['assistant'])
    expect(t.parent()!.visible).toBe(true)
    expect(t.assistant().hidden).toBe(false)
  } finally {
    await t.cleanup()
  }
})

test('a plain click on an agent that already floats brings its window forward, restored, instead of drilling in', async () => {
  const t = await setup({ floating: true })
  try {
    // Minimized at first; the opened assistant is in front of it.
    expect(t.agentWindow()!.style.display).toBe('none')
    await t.click(t.linkRow())
    expect(t.stack()).toEqual(['assistant'])
    expect(t.chat()).toBeUndefined()
    expect(t.agentWindow()!.style.display).toBe('')
    expect(Number(t.agentWindow()!.style.zIndex)).toBeGreaterThan(Number(t.assistant().style.zIndex))
  } finally {
    await t.cleanup()
  }
})

test('the assistant shares the stack with agent windows, and its Escape applies only when it is the window in use', async () => {
  const t = await setup()
  try {
    await t.click(t.linkRow(), { altKey: true })
    const windowComposer = t.agentWindow()!.querySelector('textarea')!
    // Focusing the agent window brings it in front of the assistant.
    await t.dom.act(async () => windowComposer.focus())
    expect(Number(t.agentWindow()!.style.zIndex)).toBeGreaterThan(Number(t.assistant().style.zIndex))
    await t.key(windowComposer, { key: 'Escape' })
    expect(t.stack()).toEqual(['assistant'])
    expect(t.assistant().hidden).toBe(false)
    expect(t.agentWindow()).not.toBeNull()
    // Back in the assistant, Escape is the assistant's again (it closes from its root conversation).
    const assistantDraft = t.assistant().querySelector<HTMLInputElement>('[aria-label="Assistant draft"]')!
    await t.dom.act(async () => assistantDraft.focus())
    expect(Number(t.assistant().style.zIndex)).toBeGreaterThan(Number(t.agentWindow()!.style.zIndex))
    await t.key(assistantDraft, { key: 'Escape' })
    expect(t.stack()).toEqual([])
    expect(t.agentWindow()).not.toBeNull()
  } finally {
    await t.cleanup()
  }
})
