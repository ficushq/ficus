import { expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { useState } from 'react'
import { ExpandableChatPanel } from './ExpandableChatPanel'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { RenderItem } from '@ficus/client-react'
import { PermissionsProvider } from '../hooks/usePermissions'
import { acquireDomHarness } from '../test/domHarness'
import { ChatView } from './ChatView'
import { ChatFullscreenContext } from './ChatFullscreenContext'

const permissions = () => ({
  permissions: ['agents:write'],
  can: () => true,
  isLoading: false,
  isError: false,
})

const dependencies = {
  useImageSrcsHook: () => ({}),
  usePermissionsHook: permissions,
  useVoiceEnabledHook: () => false,
  useVoiceRecorderHook: () => ({
    state: 'idle' as const,
    elapsed: 0,
    volume: 0,
    isSupported: false,
    isHoldMode: false,
    start: () => undefined,
    stop: () => undefined,
    stopAndSend: () => undefined,
    cancel: () => undefined,
    beginPress: () => undefined,
    endPress: () => undefined,
    cancelPress: () => undefined,
    isPressing: false,
  }),
}

function chatElement(items: RenderItem[] = []) {
  return (
    <PermissionsProvider usePermissions={permissions}>
      <ChatView dependencies={dependencies} items={items} onSend={() => undefined} hideComposer enableFullscreen />
    </PermissionsProvider>
  )
}

function chatRouter(entry: string, items: RenderItem[] = []) {
  return createMemoryRouter([{ path: '/chat/:agentId', element: chatElement(items) }], {
    initialEntries: [entry],
  })
}

test('fullscreen controls update only their router search and replace history', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/a?scope=all&fullscreen=1' })
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:agentId',
        element: chatElement(),
      },
      { path: '/before', element: <div>Before</div> },
    ],
    { initialEntries: ['/before', '/chat/a?scope=all&fullscreen=1'], initialIndex: 1 }
  )
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    expect(router.state.location.pathname).toBe('/chat/a')
    expect(router.state.location.search).toBe('?scope=all&fullscreen=1')

    const exit = dom.window.document.querySelector('[aria-label="Exit fullscreen"]') as unknown as HTMLElement
    expect(exit).not.toBeNull()
    await dom.act(async () => exit.click())
    expect(router.state.location.search).toBe('?scope=all')

    const enter = dom.window.document.querySelector('[aria-label="Fullscreen"]') as unknown as HTMLElement
    await dom.act(async () => enter.click())
    expect(router.state.location.search).toBe('?scope=all&fullscreen=1')

    await dom.act(async () => router.navigate(-1))
    expect(router.state.location.pathname).toBe('/before')
  } finally {
    await dom.cleanup()
  }
})

test('a real rendered Link navigates its router while preserving the target search', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/a' })
  const navigateItem = {
    kind: 'streaming',
    id: 'navigate-stream',
    agentId: 'a',
    status: 'complete',
    blocks: [
      {
        type: 'tool_use',
        id: 'navigate-tool',
        _done: true,
        toolCall: { toolName: 'navigate', args: JSON.stringify({ path: '/chat/b?scope=squad', prompt: true }) },
      },
    ],
  } as RenderItem
  const router = chatRouter('/chat/a', [navigateItem])
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    const link = dom.window.document.querySelector('a[href="/chat/b?scope=squad"]') as unknown as HTMLElement
    expect(link).not.toBeNull()
    expect(router.state.location.pathname + router.state.location.search).toBe('/chat/a')
    await dom.act(async () => link.click())
    expect(router.state.location.pathname + router.state.location.search).toBe('/chat/b?scope=squad')
  } finally {
    await dom.cleanup()
  }
})

test('fresh routers stay isolated in both creation orders', async () => {
  for (const reverse of [false, true]) {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const a = chatRouter('/chat/a?scope=A')
    const b = chatRouter('/chat/b?scope=B')
    const ordered = reverse ? [b, a] : [a, b]
    const roots = ordered.map(() => dom.createRoot())
    try {
      for (let index = 0; index < ordered.length; index++) {
        await dom.act(async () => roots[index]!.root.render(<RouterProvider router={ordered[index]!} />))
      }
      expect(a.state.location.pathname + a.state.location.search).toBe('/chat/a?scope=A')
      expect(b.state.location.pathname + b.state.location.search).toBe('/chat/b?scope=B')
      await dom.act(async () => a.navigate('/chat/a?scope=A&fullscreen=1'))
      expect(a.state.location.search).toBe('?scope=A&fullscreen=1')
      expect(b.state.location.search).toBe('?scope=B')
    } finally {
      await dom.cleanup()
    }
  }
})

test('two overlapping live ChatView roots keep URL mutations instance-local', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const a = chatRouter('/chat/a?scope=A')
  const b = chatRouter('/chat/b?scope=B')
  const rootA = dom.createRoot()
  const rootB = dom.createRoot()
  try {
    await dom.act(async () => {
      rootA.root.render(<RouterProvider router={a} />)
      rootB.root.render(<RouterProvider router={b} />)
    })
    const buttonA = rootA.container.querySelector('[aria-label="Fullscreen"]') as HTMLElement
    const buttonB = rootB.container.querySelector('[aria-label="Fullscreen"]') as HTMLElement
    expect(a.state.location.search).toBe('?scope=A')
    expect(b.state.location.search).toBe('?scope=B')
    await dom.act(async () => buttonA.click())
    expect(a.state.location.search).toBe('?scope=A&fullscreen=1')
    expect(b.state.location.search).toBe('?scope=B')
    await dom.act(async () => buttonB.click())
    expect(a.state.location.search).toBe('?scope=A&fullscreen=1')
    expect(b.state.location.search).toBe('?scope=B&fullscreen=1')
  } finally {
    await dom.cleanup()
  }
})

for (const enableFullscreen of [true, false]) {
  test(`mobile composer tap expands ${enableFullscreen ? 'routed' : 'embedded'} chat and retains draft, caret, and focus`, async () => {
    const dom = await acquireDomHarness({
      url: 'http://localhost/chat/a?scope=all',
      windowOptions: { innerWidth: 390 },
    })
    const router = createMemoryRouter(
      [
        {
          path: '/chat/:agentId',
          element: (
            <ChatView
              dependencies={dependencies}
              items={[]}
              onSend={() => undefined}
              enableFullscreen={enableFullscreen}
            />
          ),
        },
      ],
      { initialEntries: ['/chat/a?scope=all'] }
    )
    const rendered = dom.createRoot()
    try {
      await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
      const textarea = dom.window.document.querySelector('textarea')!
      await dom.act(async () => {
        fireEvent.input(textarea, { target: { value: 'Draft before expanding' } })
        textarea.focus()
        textarea.setSelectionRange(3, 8)
      })
      // Existing autofocus and focus restoration must not open a modal.
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull()
      await dom.act(async () => textarea.click())
      const expanded = dom.window.document.querySelector('[role="dialog"] textarea')! as HTMLTextAreaElement
      expect(expanded).not.toBeNull()
      expect(expanded.value).toBe('Draft before expanding')
      expect(expanded.selectionStart).toBe(3)
      expect(expanded.selectionEnd).toBe(8)
      expect(dom.window.document.activeElement).toBe(expanded)
      expect(router.state.location.search).toBe('?scope=all')
      await dom.act(async () => expanded.click())
      expect(dom.window.document.querySelectorAll('[role="dialog"]').length).toBe(1)
      await dom.act(async () => {
        fireEvent.input(expanded, { target: { value: 'Draft after expanding' } })
        dom.window.document.querySelector<HTMLElement>('[aria-label="Exit fullscreen"]')!.click()
      })
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull()
      expect(dom.window.document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Draft after expanding')
      expect(router.state.location.search).toBe('?scope=all')
    } finally {
      await dom.cleanup()
    }
  })
}

for (const scenario of [
  { name: 'desktop', width: 768, alreadyFullscreen: false, context: null },
  { name: 'an existing phone fullscreen modal', width: 390, alreadyFullscreen: true, context: null },
  { name: 'the assistant modal', width: 390, alreadyFullscreen: false, context: false as const },
]) {
  test(`composer tap does not expand in ${scenario.name}`, async () => {
    const dom = await acquireDomHarness({
      url: 'http://localhost/chat/a',
      windowOptions: { innerWidth: scenario.width },
    })
    const router = createMemoryRouter(
      [
        {
          path: '/chat/:agentId',
          element: (
            <ChatFullscreenContext value={scenario.context}>
              <div className={scenario.alreadyFullscreen ? 'mobile-chat-modal' : undefined}>
                <ChatView dependencies={dependencies} items={[]} onSend={() => undefined} enableFullscreen />
              </div>
            </ChatFullscreenContext>
          ),
        },
      ],
      { initialEntries: ['/chat/a?scope=all'] }
    )
    const rendered = dom.createRoot()
    try {
      await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
      const textarea = dom.window.document.querySelector('textarea')!
      await dom.act(async () => textarea.click())
      expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull()
      expect(dom.window.document.querySelector('textarea')).toBe(textarea)
      expect(router.state.location.search).toBe('?scope=all')
    } finally {
      await dom.cleanup()
    }
  })
}

test('a retained conversation closes its mobile fullscreen portal when it becomes inactive', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/a', windowOptions: { innerWidth: 390 } })
  function RetainedChat() {
    const [active, setActive] = useState(true)
    return (
      <>
        <button onClick={() => setActive(false)}>Switch conversation</button>
        <div hidden={!active}>
          <ChatView dependencies={dependencies} items={[]} onSend={() => undefined} keyboardShortcutsEnabled={active} />
        </div>
      </>
    )
  }
  const router = createMemoryRouter([{ path: '/chat/:agentId', element: <RetainedChat /> }], {
    initialEntries: ['/chat/a'],
  })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    await dom.act(async () => dom.window.document.querySelector('textarea')!.click())
    expect(dom.window.document.querySelector('[role="dialog"]')).not.toBeNull()
    await dom.act(async () => rendered.container.querySelector('button')!.click())
    expect(dom.window.document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    await dom.cleanup()
  }
})

test('composer and button expansion share the parent header without remounting the conversation', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/a', windowOptions: { innerWidth: 390 } })
  function ParentChat() {
    const [fullscreen, setFullscreen] = useState(false)
    const [tab, setTab] = useState('Chat')
    return (
      <ExpandableChatPanel
        isFullscreen={fullscreen}
        onExitFullscreen={() => setFullscreen(false)}
        title="Investigate mobile startup crash"
        titleContent={
          <span>
            Investigate mobile startup crash <small>Consultant · Kai</small>
          </span>
        }
        headerExtra={<button onClick={() => setTab(tab === 'Chat' ? 'Info' : 'Chat')}>{tab}</button>}
        className="inline-chat"
        inlineHeader={<button onClick={() => setFullscreen(true)}>Fullscreen</button>}
      >
        <ChatView dependencies={dependencies} items={[]} onSend={() => undefined} />
      </ExpandableChatPanel>
    )
  }
  const router = createMemoryRouter([{ path: '/chat/:agentId', element: <ParentChat /> }], {
    initialEntries: ['/chat/a'],
  })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    const textarea = dom.window.document.querySelector('textarea')!
    await dom.act(async () => {
      fireEvent.input(textarea, { target: { value: 'Unsent draft' } })
      textarea.setSelectionRange(2, 5)
      textarea.click()
    })
    let dialog = dom.window.document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Investigate mobile startup crash')
    expect(dialog.querySelector('h3')!.textContent).toContain('Consultant · Kai')
    expect(dialog.querySelector('textarea')).toBe(textarea)
    expect(dom.window.document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(2)
    expect(textarea.selectionEnd).toBe(5)
    const tapHeading = dialog.querySelector('h3')!.textContent
    await dom.act(async () => dialog.querySelector<HTMLElement>('[aria-label="Close"]')!.click())
    expect(rendered.container.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Unsent draft')
    await dom.act(async () => rendered.container.querySelector('button')!.click())
    dialog = dom.window.document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h3')!.textContent).toBe(tapHeading)
    expect(dialog.querySelector('textarea')).toBe(textarea)
    await dom.act(async () => {
      const tabs = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Chat')!
      tabs.click()
    })
    expect(dialog.textContent).toContain('Info')
    expect(dialog.querySelector('textarea')).toBe(textarea)
    expect(dom.window.document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  } finally {
    await dom.cleanup()
  }
})
