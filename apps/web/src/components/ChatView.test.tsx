import { PermissionsProvider } from '../hooks/usePermissions'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { restPointerOn } from '../test/hoverTimer'
import { useEffect, useState } from 'react'
import { fireEvent } from '@testing-library/dom'
import type { RenderItem, StreamingContentBlock } from '@ficus/client-react'
import type { Message, MessageMetadata } from '@ficus/shared'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import type { ToolInlineActionModalProps } from './ToolInlineActionModal'
import type { AgentConversation } from './AgentConversationBody'
import { MemoryRouter } from 'react-router-dom'

const useImageSrcsFixture = () => ({})

// Permissions the viewer lacks; everything else is granted.
let deniedPermissions = new Set<string>()
const usePermissionsMock = () => ({
  can: (permission: string) => !deniedPermissions.has(permission),
  isLoading: false,
  isError: false,
  permissions: ['agents:write'],
})

const uploadImagesMock = mock(async () => [] as string[])
const uploadAgentFileMock = mock(() => new Promise(() => {}))
let voiceEnabled = true
const useVoiceEnabledFixture = () => voiceEnabled
let recorderSupported = true
const useVoiceRecorderFixture = () => ({
  state: 'idle' as const,
  elapsed: 0,
  volume: 0,
  isSupported: recorderSupported,
  isHoldMode: false,
  start: () => {},
  stop: () => {},
  stopAndSend: () => {},
  cancel: () => {},
  beginPress: () => {},
  endPress: () => {},
  cancelPress: () => {},
  isPressing: false,
})

let openedToolAction: ToolInlineAction | null = null
function TestToolInlineActionModal({ action, onClose }: ToolInlineActionModalProps) {
  openedToolAction = action
  return (
    <button data-testid="tool-action-modal" onClick={onClose}>
      Close tool action
    </button>
  )
}

const chatViewDependencies = {
  useImageSrcsHook: useImageSrcsFixture,
  usePermissionsHook: usePermissionsMock,
  useVoiceEnabledHook: useVoiceEnabledFixture,
  useVoiceRecorderHook: useVoiceRecorderFixture,
  uploadAgentFile: uploadAgentFileMock,
  deleteAgentFile: mock(async () => undefined),
  uploadImages: uploadImagesMock,
  ToolInlineActionModalComponent: TestToolInlineActionModal,
}

const { ChatView } = await import('./ChatView')
const { ToolInlineActionModal } = await import('./ToolInlineActionModal')
const { getImageAttachState } = await import('../lib/imageAttach')

let activeDom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

async function installDom() {
  return (activeDom = await acquireDomHarness({
    url: 'http://localhost/chat',
    configureWindow(window) {
      globalThis.FileReader = window.FileReader
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    },
  }))
}

/** A drag event carrying files (or, with `types`, something else) dispatched at `target`. */
function drag(
  window: Window | Awaited<ReturnType<typeof acquireDomHarness>>['window'],
  type: string,
  target: Element,
  files: File[] = [],
  dispatch = true,
  types = ['Files']
) {
  const event = new window.Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } })
  if (dispatch) target.dispatchEvent(event)
  return event
}

function pasteFiles(
  window: Window | Awaited<ReturnType<typeof acquireDomHarness>>['window'],
  target: Element,
  files: File[]
) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true }) as unknown as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })) },
  })
  target.dispatchEvent(event)
  return event
}

async function flushReact() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function renderChatView(
  element: React.ReactElement,
  entry = '/chat/agent-1?scope=all'
): Promise<{
  dom: Awaited<ReturnType<typeof acquireDomHarness>>
  root: ReturnType<Awaited<ReturnType<typeof acquireDomHarness>>['createRoot']>['root']
  window: Awaited<ReturnType<typeof acquireDomHarness>>['window']
}> {
  const dom = await installDom()
  const { window } = dom
  const { root } = dom.createRoot()

  const injected = {
    ...element,
    props: {
      ...element.props,
      dependencies: { ...chatViewDependencies, ...element.props.dependencies },
    },
  }
  await dom.act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <PermissionsProvider usePermissions={usePermissionsMock}>{injected}</PermissionsProvider>
      </MemoryRouter>
    )
  })
  await flushReact()

  return { dom, root, window }
}

beforeEach(() => {
  openedToolAction = null
  deniedPermissions = new Set()
  voiceEnabled = true
  recorderSupported = true
  URL.createObjectURL = mock(() => 'blob:test-image')
  URL.revokeObjectURL = mock(() => undefined)
})

afterEach(async () => {
  await activeDom?.cleanup()
  activeDom = undefined
})

// Helper fixture builders
function humanMsg(id: string, content: string, metadata?: MessageMetadata | null): Message {
  return { id, role: 'human', content, metadata: metadata ?? null, createdAt: new Date().toISOString() }
}

function assistantMsg(id: string, content: string, metadata?: MessageMetadata | null): Message {
  return { id, role: 'assistant', content, metadata: metadata ?? null, createdAt: new Date().toISOString() }
}

function RawTextToggleHarness({
  items,
  dependencies,
}: {
  items: RenderItem[]
  dependencies?: React.ComponentProps<typeof ChatView>['dependencies']
}) {
  const [showRawText, setShowRawText] = useState(false)

  return (
    <ChatView
      items={items}
      dependencies={dependencies}
      onSend={() => undefined}
      hideComposer
      enableFullscreen={false}
      showRawText={showRawText}
      onToggleRawText={() => setShowRawText((showRaw) => !showRaw)}
    />
  )
}

describe('ChatView raw message toggle', () => {
  test('switches exact assistant source text to raw mode and back without another header action', async () => {
    const source = 'Copy **this exact** `_source_`'
    const message = assistantMsg('a1', source)
    const items: RenderItem[] = [{ kind: 'persisted', id: 'a1', message, mergedFrom: [message], blocks: [] }]
    const { dom, root, window } = await renderChatView(<RawTextToggleHarness items={items} />)

    expect(window.document.querySelector('button[aria-label="Show raw text"]')).not.toBeNull()
    expect(window.document.querySelector('strong')?.textContent).toBe('this exact')
    expect(window.document.querySelector('pre')).toBeNull()

    await dom.act(async () => {
      window.document
        .querySelector('button[aria-label="Show raw text"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    expect(window.document.querySelector('button[aria-label="Show rendered markdown"]')).not.toBeNull()
    expect(window.document.querySelector('pre')?.textContent).toBe(source)
    expect(window.document.querySelector('strong')).toBeNull()

    await dom.act(async () => {
      window.document
        .querySelector('button[aria-label="Show rendered markdown"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    expect(window.document.querySelector('button[aria-label="Show raw text"]')).not.toBeNull()
    expect(window.document.querySelector('strong')?.textContent).toBe('this exact')
    expect(window.document.querySelector('pre')).toBeNull()
  })
})

describe('ChatView image upload gating', () => {
  test('allows image attach when permissions and selected model both allow images', () => {
    expect(getImageAttachState({ canUploadImages: true, selectedModelSupportsImages: true })).toEqual({
      allowed: true,
      title: 'Attach images',
    })
  })

  test('disables image attach with an explanatory hint when the selected model does not support images', () => {
    expect(getImageAttachState({ canUploadImages: true, selectedModelSupportsImages: false })).toEqual({
      allowed: false,
      title: 'This model does not support images',
    })
  })
})

async function attachImageAndSend(
  dom: Awaited<ReturnType<typeof acquireDomHarness>>,
  window: Awaited<ReturnType<typeof acquireDomHarness>>['window'],
  contents = 'png bytes'
) {
  const input = window.document.querySelector('input[type="file"][accept^="image/png"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new window.File([contents], 'reported-3824x2474.png', { type: 'image/png' })],
  })
  await dom.act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    const deadline = Date.now() + 1000
    while (!window.document.querySelector('img') && Date.now() < deadline) await flushReact()
  })
  expect(window.document.querySelector('img')).not.toBeNull()
  await dom.act(async () => {
    window.document
      .querySelector('form')
      ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await flushReact()
  })
}

test('mounted floating content that renders nothing leaves no gap in the transcript', async () => {
  function Chips() {
    const [visible, setVisible] = useState(true)
    return visible ? (
      <button data-testid="chips" onClick={() => setVisible(false)}>
        Hide chips
      </button>
    ) : null
  }
  const { dom, window } = await renderChatView(
    <ChatView items={[]} onSend={() => {}} stickyAfterMessages={<Chips />} />
  )
  const chips = window.document.querySelector('[data-testid="chips"]')!
  const slot = chips.parentElement!
  expect(slot.getAttribute('data-testid')).toBe('chat-sticky-after-messages')
  await dom.act(async () => chips.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  expect(slot.matches(':empty')).toBe(true)
  expect(slot.classList.contains('empty:hidden')).toBe(true)
})

test('the floating slot is see-through: no strip above the composer, and only its controls take clicks', async () => {
  const { window } = await renderChatView(
    <ChatView
      items={[]}
      onSend={() => {}}
      stickyAfterMessages={
        <>
          <button data-testid="banner">1 pending question</button>
          <div data-testid="chips">Yes</div>
        </>
      }
    />
  )
  const messages = window.document.querySelector('[data-testid="chat-messages"]')!
  const slot = window.document.querySelector<HTMLElement>('[data-testid="chat-sticky-after-messages"]')!
  // Inside the scrolling transcript, not a strip of its own between the transcript and the composer.
  expect(messages.contains(slot)).toBe(true)
  expect(window.document.querySelector('[data-testid="chat-before-composer"]')).toBeNull()
  expect(messages.nextElementSibling!.contains(window.document.querySelector('textarea'))).toBe(true)
  const classes = slot.className.split(/\s+/)
  expect(classes.some((name) => name.startsWith('bg-'))).toBe(false)
  // The slot passes clicks to the messages underneath (each control opts back in), not overriding
  // a control's own pass-through gaps.
  expect(classes).toContain('pointer-events-none')
  expect(classes.some((name) => name.includes('pointer-events-auto'))).toBe(false)
  // Stacked controls keep apart, and a control's negative bottom margin overhangs the padding (same
  // height at the bottom and pinned) instead of collapsing through the slot.
  expect(classes).toEqual(expect.arrayContaining(['space-y-2', 'flow-root']))
})

test('sticky content ends the message flow and floats above the plant while it peeks', async () => {
  const notice = <div data-testid="notice">Compacting</div>
  const row = <button data-testid="row">1 pending question</button>
  const { dom, root, window } = await renderChatView(
    <ChatView
      items={[{ kind: 'working', id: '__working__' }]}
      onSend={() => {}}
      afterMessages={notice}
      stickyAfterMessages={row}
    />
  )
  const messages = window.document.querySelector('[data-testid="chat-messages"]')!
  const slot = () => window.document.querySelector('[data-testid="chat-sticky-after-messages"]')!
  // In the scroll container, after afterMessages, and nowhere near the composer.
  expect(messages.lastElementChild).toBe(slot())
  expect(slot().previousElementSibling).toBe(window.document.querySelector('[data-testid="notice"]'))
  expect(slot().contains(window.document.querySelector('[data-testid="row"]'))).toBe(true)
  expect(window.document.querySelector('[data-testid="chat-before-composer"]')).toBeNull()
  // Pinned inside the container's bottom padding, the plant's room, so the peeking plant never covers it.
  expect(slot().classList.contains('sticky')).toBe(true)
  expect(slot().classList.contains('bottom-0')).toBe(true)
  expect(messages.classList.contains('pb-8')).toBe(true)

  await dom.act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/chat/agent-1?scope=all']}>
        <PermissionsProvider usePermissions={usePermissionsMock}>
          <ChatView
            items={[]}
            onSend={() => {}}
            afterMessages={notice}
            stickyAfterMessages={row}
            dependencies={chatViewDependencies}
          />
        </PermissionsProvider>
      </MemoryRouter>
    )
  )
  // The room shrinks back only once the plant's jump out of sight is over.
  expect(messages.classList.contains('pb-8')).toBe(false)
  expect(messages.classList.contains('delay-[600ms]')).toBe(true)
})

describe('ChatView image upload targeting and recovery', () => {
  test('mobile expansion keeps staged images attached to the draft and sends them once', async () => {
    const upload = mock(async () => ['image-mobile'])
    const onSend = mock(async () => undefined)
    const { dom, window } = await renderChatView(
      <ChatView items={[]} agentId="agent-1" onSend={onSend} dependencies={{ uploadImages: upload }} />
    )
    window.innerWidth = 390
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'Look at this image' } }))
    const input = window.document.querySelector('input[type="file"][accept^="image/png"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['png bytes'], 'mobile.png', { type: 'image/png' })],
    })
    await dom.act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
      const deadline = Date.now() + 1000
      while (!window.document.querySelector('img') && Date.now() < deadline) await flushReact()
    })
    expect(window.document.querySelector('img')).not.toBeNull()
    await dom.act(async () => textarea.click())
    const expanded = window.document.querySelector('[role="dialog"]')!
    expect(expanded.querySelector('img')).not.toBeNull()
    expect(expanded.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Look at this image')
    expect(onSend).not.toHaveBeenCalled()
    await dom.act(async () => {
      expanded.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      await flushReact()
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('Look at this image', ['image-mobile'])
  })

  test.each([
    { name: 'an existing agent', props: { agentId: 'agent-1', squadId: 'squad-1' }, target: { agentId: 'agent-1' } },
    { name: 'a new scoped consultant', props: { squadId: 'squad-1' }, target: { squadId: 'squad-1' } },
    { name: 'a squadless conversation', props: {}, target: {} },
  ])('scopes the upload for $name', async ({ props, target }) => {
    const upload = mock(async () => ['image-1'])
    const onSend = mock(async () => undefined)
    const { dom, window } = await renderChatView(
      <ChatView items={[]} {...props} onSend={onSend} dependencies={{ uploadImages: upload }} />
    )

    await attachImageAndSend(dom, window)

    expect(upload).toHaveBeenCalledTimes(1)
    const options = upload.mock.calls[0]?.[1]
    expect(options).toMatchObject(target)
    expect('agentId' in (options ?? {})).toBe('agentId' in target)
    expect('squadId' in (options ?? {})).toBe('squadId' in target)
    expect(onSend).toHaveBeenCalledWith('', ['image-1'])
  })

  test('keeps an upload rejection by the composer and lets the user retry it or remove it', async () => {
    const upload = mock(async () => ['image-2'])
    upload.mockRejectedValueOnce(new Error('Image exceeds 5 MB limit'))
    const onSend = mock(async () => undefined)
    const { dom, window } = await renderChatView(
      <ChatView items={[]} agentId="agent-1" onSend={onSend} dependencies={{ uploadImages: upload }} />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'keep this draft' } }))

    await attachImageAndSend(dom, window)

    const alert = window.document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Image upload failed: Image exceeds 5 MB limit')
    expect(textarea.value).toBe('keep this draft')
    expect(window.document.querySelector('img')).not.toBeNull()
    expect(onSend).not.toHaveBeenCalled()

    // Submitting again must not silently drop the errored image and send only the draft.
    await dom.act(async () => {
      window.document
        .querySelector('form')
        ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      await flushReact()
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe('keep this draft')
    expect(window.document.querySelector('img')).not.toBeNull()

    await dom.act(async () => {
      window.document
        .querySelector('button[aria-label="Retry image upload"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await flushReact()
    await dom.act(async () => {
      window.document
        .querySelector('form')
        ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      await flushReact()
    })

    expect(upload).toHaveBeenCalledTimes(2)
    expect(onSend).toHaveBeenCalledWith('keep this draft', ['image-2'])
    expect(window.document.querySelector('[role="alert"]')).toBeNull()
    expect(window.document.querySelector('img')).toBeNull()
  })

  test('shows a preparation error, cleans previews, and recovers when the image is reselected', async () => {
    const { dom, window } = await renderChatView(<ChatView items={[]} agentId="agent-1" onSend={() => undefined} />)
    const input = window.document.querySelector('input[type="file"][accept^="image/png"]') as HTMLInputElement
    const workingFileReader = window.FileReader
    class FailingFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
      readAsDataURL() {
        this.onerror?.(new window.Event('error') as ProgressEvent<FileReader>)
      }
    }
    globalThis.FileReader = FailingFileReader as unknown as typeof FileReader
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['unreadable'], 'unreadable.png', { type: 'image/png' })],
    })

    await dom.act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
      await flushReact()
    })

    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain(
      'Image attachment failed: Could not read the selected image. Please reselect it or choose another file.'
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-image')
    expect(window.document.querySelector('img')).toBeNull()

    globalThis.FileReader = workingFileReader
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['readable'], 'readable.png', { type: 'image/png' })],
    })
    await dom.act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
      const deadline = Date.now() + 1000
      while (!window.document.querySelector('img') && Date.now() < deadline) await flushReact()
    })

    expect(window.document.querySelector('[role="alert"]')).toBeNull()
    expect(window.document.querySelector('img')).not.toBeNull()
  })

  test('removes a rejected upload while retaining the draft', async () => {
    const upload = mock(async () => {
      throw new Error('Unsupported image format: image/svg+xml')
    })
    const { dom, window } = await renderChatView(
      <ChatView items={[]} agentId="agent-1" onSend={() => undefined} dependencies={{ uploadImages: upload }} />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'keep this draft' } }))

    await attachImageAndSend(dom, window)
    await dom.act(async () => {
      window.document
        .querySelector('button[aria-label="Remove image"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    expect(textarea.value).toBe('keep this draft')
    expect(window.document.querySelector('img')).toBeNull()
    expect(window.document.querySelector('[role="alert"]')).toBeNull()
  })

  test('locks the composer against duplicate sends and mutation until acceptance resolves', async () => {
    const acceptance = deferred<void>()
    const onSend = mock(() => acceptance.promise)
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        agentId="agent-1"
        onSend={onSend}
        dependencies={{ uploadImages: mock(async () => ['image-1']) }}
      />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'send once' } }))

    await attachImageAndSend(dom, window)

    const composer = window.document.querySelector('[aria-busy="true"]') as HTMLElement
    expect(composer?.inert).toBe(true)
    expect(window.document.body.textContent).toContain('Sending...')
    expect(onSend).toHaveBeenCalledTimes(1)
    await dom.act(async () => {
      fireEvent.input(textarea, { target: { value: 'mutated underneath' } })
      window.document
        .querySelector('form')
        ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      await flushReact()
    })
    expect(textarea.value).toBe('send once')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(window.document.querySelector('img')).not.toBeNull()

    await dom.act(async () => {
      acceptance.resolve()
      await acceptance.promise
      await flushReact()
    })
    expect(window.document.querySelector('[aria-busy="true"]')).toBeNull()
    expect(textarea.value).toBe('')
    expect(window.document.querySelector('img')).toBeNull()
  })

  test('unlocks the retained composer when deferred acceptance rejects', async () => {
    const acceptance = deferred<void>()
    const onSend = mock(() => acceptance.promise)
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        agentId="agent-1"
        onSend={onSend}
        dependencies={{ uploadImages: mock(async () => ['image-1']) }}
      />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'retain me' } }))

    await attachImageAndSend(dom, window)
    expect((window.document.querySelector('[aria-busy="true"]') as HTMLElement).inert).toBe(true)

    await dom.act(async () => {
      acceptance.reject(new Error('Invalid attachment'))
      await acceptance.promise.catch(() => undefined)
      await flushReact()
    })

    const composer = window.document.querySelector('[aria-busy="false"]') as HTMLElement
    expect(composer.inert).toBe(false)
    expect(textarea.value).toBe('retain me')
    expect(window.document.querySelector('img')).not.toBeNull()
    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain(
      'The attachment could not be added. Re-upload it before sending again.'
    )
  })

  test('re-uploads a known invalid attachment instead of retrying its rejected id', async () => {
    const upload = mock(async () => ['correctly-scoped-image'])
    upload.mockResolvedValueOnce(['wrongly-scoped-image'])
    const onSend = mock(async () => undefined)
    onSend.mockRejectedValueOnce(new Error('Invalid attachment'))
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        agentId="agent-1"
        squadId="squad-1"
        onSend={onSend}
        dependencies={{ uploadImages: upload }}
      />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'analyze this' } }))

    await attachImageAndSend(dom, window)

    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain(
      'The attachment could not be added. Re-upload it before sending again.'
    )
    expect(textarea.value).toBe('analyze this')
    expect(onSend).toHaveBeenLastCalledWith('analyze this', ['wrongly-scoped-image'])

    await dom.act(async () => {
      window.document
        .querySelector('button[aria-label="Retry image upload"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await flushReact()
    await dom.act(async () => {
      window.document
        .querySelector('form')
        ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
      await flushReact()
    })

    expect(upload).toHaveBeenCalledTimes(2)
    expect(onSend).toHaveBeenLastCalledWith('analyze this', ['correctly-scoped-image'])
    expect(window.document.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('ChatView items-contract rendering', () => {
  test('renders one bubble per RenderItem and a streaming item', async () => {
    const streamingBlock: StreamingContentBlock = { type: 'text', id: 't', content: 'hi…' }
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'h1',
        message: humanMsg('h1', 'hello'),
        mergedFrom: [humanMsg('h1', 'hello')],
        blocks: [],
      },
      {
        kind: 'streaming',
        id: 'S',
        agentId: 'a',
        status: 'streaming',
        blocks: [streamingBlock],
      },
    ]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const body = window.document.body.innerHTML
    expect(body).toContain('hello')
    expect(body).toContain('hi…')
  })

  test('renders persisted assistant message with blocks', async () => {
    const msg = assistantMsg('a1', 'done', {
      content: [{ type: 'text', id: 't1', content: 'assistant reply' }],
    })
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'a1',
        message: msg,
        blocks: msg.metadata?.content ?? [],
      },
    ]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    expect(window.document.body.innerHTML).toContain('assistant reply')
  })

  test('renders pending item with sending status', async () => {
    const items: RenderItem[] = [
      {
        kind: 'pending',
        id: 'p1',
        content: 'queued message',
        status: 'sending',
      },
    ]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    expect(window.document.body.innerHTML).toContain('queued message')
  })

  test('renders retry button for failed pending item', async () => {
    const items: RenderItem[] = [
      {
        kind: 'pending',
        id: 'p1',
        content: 'failed message',
        status: 'failed',
      },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} onRetry={() => {}} hideComposer />
    )

    const body = window.document.body.innerHTML
    expect(body).toContain('failed message')
    expect(body).toContain('Retry')
  })

  test('renders pending inbox-source messages as an inbox card', async () => {
    const metadata: MessageMetadata = {
      source: 'inbox',
      deliveryMode: 'steer',
      inboxDeliveryMode: 'steer',
      inboxMessageIds: ['m1'],
      inboxMessageSummaries: [
        {
          id: 'm1',
          senderType: 'agent',
          senderId: 'agent-1',
          subject: 'Status',
          preview: 'Build is ready',
          senderDisplay: 'Builder',
        },
      ],
    }
    const items: RenderItem[] = [
      {
        kind: 'pending',
        id: 'pending-inbox',
        content: 'Full raw inbox delivery prompt',
        status: 'queued',
        deliveryMode: 'steer',
        queued: true,
        metadata,
      },
    ]

    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const body = window.document.body.innerHTML
    expect(body).toContain('Inbox message from Builder')
    expect(body).toContain('Build is ready')
    expect(body).not.toContain('bg-accent text-on-accent')
  })

  test('renders inbox-source human messages without the outer accent user bubble', async () => {
    const metadata: MessageMetadata = {
      source: 'inbox',
      inboxDeliveryMode: 'follow-up',
      inboxMessageIds: ['m1'],
      inboxMessageSummaries: [
        {
          id: 'm1',
          senderType: 'voice_assistant',
          senderId: 'workspace',
          subject: 'Status',
          preview: 'Build is ready',
          senderDisplay: 'Builder',
        },
      ],
    }

    const msg = humanMsg('m1', 'Full prompt', metadata)
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'm1',
        message: msg,
        blocks: [],
      },
    ]

    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const body = window.document.body.innerHTML
    expect(body).toContain('Inbox message from Builder')
    expect(body).not.toContain('bg-accent text-on-accent')
  })

  test('inbox delivery card toggles the truncated body with Show more / Show less', async () => {
    const longBody = `${'word '.repeat(120)}THE_TAIL_SHOULD_BE_HIDDEN`
    const content = `You have 1 unread message(s) in your inbox. Process them and take any required action.

### Message m1

**From:** Builder

**Subject:** Status

${longBody}

**Mark one or more messages as read after processing:**`
    const metadata: MessageMetadata = {
      source: 'inbox',
      inboxMessageIds: ['m1'],
      inboxMessageSummaries: [
        {
          id: 'm1',
          senderType: 'agent',
          senderId: 'a1',
          subject: 'Status',
          preview: 'word word',
          senderDisplay: 'Builder',
        },
      ],
    }
    const items: RenderItem[] = [
      { kind: 'persisted', id: 'm1', message: humanMsg('m1', content, metadata), blocks: [] },
    ]

    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const doc = window.document
    expect(doc.body.innerHTML).not.toContain('THE_TAIL_SHOULD_BE_HIDDEN')
    const toggle = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Show more')
    expect(toggle).toBeDefined()
    fireEvent.click(toggle!)
    await new Promise((r) => setTimeout(r, 0))
    expect(doc.body.innerHTML).toContain('THE_TAIL_SHOULD_BE_HIDDEN')
    const less = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Show less')
    expect(less).toBeDefined()
    fireEvent.click(less!)
    await new Promise((r) => setTimeout(r, 0))
    expect(doc.body.innerHTML).not.toContain('THE_TAIL_SHOULD_BE_HIDDEN')
  })

  test('collapses very long human messages behind a show more button', async () => {
    const longContent = `${'a'.repeat(2200)}THE_TAIL_SHOULD_BE_HIDDEN`
    const msg = humanMsg('m1', longContent)
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'm1',
        message: msg,
        blocks: [],
      },
    ]

    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const body = window.document.body.innerHTML
    expect(body).toContain('Show more')
    expect(body).not.toContain('THE_TAIL_SHOULD_BE_HIDDEN')
  })

  test('renders empty state when items is empty', async () => {
    const { dom, root, window } = await renderChatView(<ChatView items={[]} onSend={() => {}} hideComposer />)

    expect(window.document.body.innerHTML).toContain('Send a message to start chatting')
  })
})

describe('ChatView clear pending queue', () => {
  test('shows a failed clear without restoring input, and restores it only after a successful retry', async () => {
    const { flushSync } = await import('react-dom')
    const onCancelQueue = mock(async () => {
      throw new Error('Worker could not confirm cancellation')
    })
    const { dom, window } = await renderChatView(
      <ChatView
        items={[{ kind: 'pending', id: 'queued', content: 'Keep this queued', status: 'queued', queued: true }]}
        onSend={() => undefined}
        onCancelQueue={onCancelQueue}
      />
    )
    const button = [...window.document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('pending message')
    )!
    const click = () =>
      dom.act(async () => {
        flushSync(() => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
      })
    await click()
    await click()
    expect(window.document.querySelector('textarea')?.value).toBe('')
    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not clear pending messages: Worker could not confirm cancellation'
    )
    onCancelQueue.mockImplementation(async () => undefined)
    await click()
    await click()
    expect(window.document.querySelector('textarea')?.value).toBe('Keep this queued')
    expect(window.document.querySelector('[role="alert"]')).toBeNull()
  })

  test('right-aligns the clear pending button above the chat input', async () => {
    const pendingItems: RenderItem[] = [
      {
        kind: 'pending',
        id: 'pending-1',
        content: 'Queued prompt',
        status: 'queued',
        queued: true,
      },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView items={pendingItems} onSend={() => undefined} onCancelQueue={async () => undefined} />
    )

    const button = [...window.document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('pending message')
    )
    if (!button) throw new Error('Clear pending button not found')

    expect(button.parentElement?.className).toContain('justify-end')
  })

  test('requires a second tap before clearing pending messages', async () => {
    const { flushSync } = await import('react-dom')
    const onCancelQueue = mock(async () => undefined)
    const pendingItems: RenderItem[] = [
      {
        kind: 'pending',
        id: 'pending-1',
        content: 'Queued prompt',
        status: 'queued',
        queued: true,
      },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView items={pendingItems} onSend={() => undefined} onCancelQueue={onCancelQueue} />
    )

    const button = [...window.document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('pending message')
    )
    if (!button) throw new Error('Clear pending button not found')

    await dom.act(async () => {
      flushSync(() => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    })

    expect(onCancelQueue).not.toHaveBeenCalled()
    expect(button.textContent).toContain('Tap again to clear')

    await dom.act(async () => {
      flushSync(() => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    })

    expect(onCancelQueue).toHaveBeenCalledTimes(1)
  })
})

describe('ChatView system RenderItem', () => {
  test('renders a system RenderItem via SystemMessageRow', async () => {
    const items: RenderItem[] = [{ kind: 'system', id: 'sys-1', text: 'Retrying (attempt 1/3)' }]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    expect(window.document.body.innerHTML).toContain('Retrying (attempt 1/3)')
  })
})

describe('ChatView monitor-source and sender label', () => {
  test('monitor-source human message renders right-aligned without the accent bubble', async () => {
    const metadata: MessageMetadata = {
      source: 'monitor',
    }

    const msg = humanMsg('m1', 'Monitor triggered message', metadata)
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'm1',
        message: msg,
        blocks: [],
      },
    ]

    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const body = window.document.body.innerHTML
    // Should be right-aligned (justify-end)
    expect(body).toContain('justify-end')
    // Should NOT have the user bubble classes
    expect(body).not.toContain('bg-accent text-on-accent')
  })

  test('plain human message renders the themed accent user bubble', async () => {
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'm1',
        message: humanMsg('m1', 'Hello from the human'),
        blocks: [],
      },
    ]

    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    expect(window.document.body.innerHTML).toContain('bg-accent text-on-accent')
  })

  test('renders sender label above bubble when sender differs from viewing user and previous sender', async () => {
    const metadata: MessageMetadata = {
      sender: { userId: 'other', name: 'Alice' },
    }
    const msg = humanMsg('m1', 'Hello from Alice', metadata)
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'm1',
        message: msg,
        blocks: [],
      },
    ]

    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer viewingUserId="me" />
    )

    expect(window.document.body.innerHTML).toContain('Alice')
  })

  test('re-renders sender label for a user message that follows a non-user message', async () => {
    const aliceMeta: MessageMetadata = { sender: { userId: 'other', name: 'Alice' } }
    const items: RenderItem[] = [
      { kind: 'persisted', id: 'm1', message: humanMsg('m1', 'First from Alice', aliceMeta), blocks: [] },
      { kind: 'persisted', id: 'm2', message: assistantMsg('m2', 'Agent reply'), blocks: [] },
      { kind: 'persisted', id: 'm3', message: humanMsg('m3', 'Second from Alice', aliceMeta), blocks: [] },
    ]

    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer viewingUserId="me" />
    )

    // Both of Alice's messages are broken apart by the agent reply, so the name
    // label appears above each — not just the first.
    const labelClass = 'text-[11px] text-muted self-end mr-1 mb-0.5'
    const occurrences = window.document.body.innerHTML.split(labelClass).length - 1
    expect(occurrences).toBe(2)
  })

  test('does not repeat the sender label for back-to-back messages from the same user', async () => {
    const aliceMeta: MessageMetadata = { sender: { userId: 'other', name: 'Alice' } }
    const items: RenderItem[] = [
      { kind: 'persisted', id: 'm1', message: humanMsg('m1', 'One', aliceMeta), blocks: [] },
      { kind: 'persisted', id: 'm2', message: humanMsg('m2', 'Two', aliceMeta), blocks: [] },
    ]

    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer viewingUserId="me" />
    )

    const labelClass = 'text-[11px] text-muted self-end mr-1 mb-0.5'
    const occurrences = window.document.body.innerHTML.split(labelClass).length - 1
    expect(occurrences).toBe(1)
  })

  test('does not render sender label when sender is the viewing user', async () => {
    const metadata: MessageMetadata = {
      sender: { userId: 'me', name: 'Me' },
    }
    const msg = humanMsg('m1', 'Hello from me', metadata)
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'm1',
        message: msg,
        blocks: [],
      },
    ]

    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer viewingUserId="me" />
    )

    // The name "Me" should NOT appear as a sender label; the meta line above the
    // viewer's own bubble carries only the time.
    expect(window.document.querySelector('[data-testid="message-sender"]')).toBeNull()
    const meta = window.document.querySelector('[data-testid="message-meta"]')
    expect(meta?.textContent).toBe(meta?.querySelector('time')?.textContent)
    expect(meta?.textContent).not.toContain('Me')
  })
})

describe('ChatView timestamps', () => {
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  const at = (minutes: number, dayOffset = 0) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, 12, minutes, 10)

  function timed(message: Message, date: Date): Message {
    return { ...message, createdAt: date.toISOString() } as Message
  }

  function persisted(message: Message, mergedFrom?: Message[]): RenderItem {
    return { kind: 'persisted', id: message.id, message, mergedFrom, blocks: [] }
  }

  function metaFor(doc: ParentNode, id: string) {
    const container = doc.querySelector(`[data-message-id~="${id}"]`)
    return container?.querySelector('[data-testid="message-meta"]') ?? null
  }

  test('the group head shows a <time>; a message within five minutes shows none; a 6-minute gap shows one', async () => {
    const items: RenderItem[] = [
      persisted(timed(humanMsg('h1', 'first'), at(0))),
      persisted(timed(humanMsg('h2', 'second'), at(4))),
      persisted(timed(humanMsg('h3', 'third'), at(10))),
    ]
    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const head = metaFor(window.document, 'h1')?.querySelector('time')
    expect(head).not.toBeNull()
    expect(head?.getAttribute('datetime')).toBe(at(0).toISOString())
    expect(head?.textContent).toBe(at(0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
    expect(metaFor(window.document, 'h2')).toBeNull()
    expect(metaFor(window.document, 'h3')?.querySelector('time')).not.toBeNull()
  })

  test('agent replies show a left-aligned time from their earliest merged row, grouped the same way', async () => {
    const a1 = timed(assistantMsg('a1', 'part one'), at(2))
    const a1b = timed(assistantMsg('a1b', 'part two'), at(3))
    const items: RenderItem[] = [
      persisted(timed(humanMsg('h1', 'question'), at(0))),
      persisted(a1, [a1, a1b]),
      persisted(timed(assistantMsg('a2', 'follow-up'), at(5))),
    ]
    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const agentTime = metaFor(window.document, 'a1')?.querySelector('time')
    expect(agentTime?.getAttribute('datetime')).toBe(at(2).toISOString())
    expect(metaFor(window.document, 'a1')?.className).not.toContain('self-end')
    expect(metaFor(window.document, 'a2')).toBeNull()
  })

  test('a day divider appears between two days and the next message shows its time', async () => {
    const items: RenderItem[] = [
      persisted(timed(humanMsg('h1', 'yesterday'), at(0, -1))),
      persisted(timed(humanMsg('h2', 'today'), at(1))),
    ]
    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const dividers = [...window.document.querySelectorAll('[data-testid="day-divider"]')].map((d) => d.textContent)
    expect(dividers).toEqual(['Yesterday', 'Today'])
    expect(metaFor(window.document, 'h2')?.querySelector('time')).not.toBeNull()
  })

  test('another user keeps the sender name joined to the time exactly where it appeared before', async () => {
    const alice: MessageMetadata = { sender: { userId: 'other', name: 'Alice' } }
    const items: RenderItem[] = [
      persisted(timed(humanMsg('h1', 'one', alice), at(0))),
      persisted(timed(humanMsg('h2', 'two', alice), at(1))),
      persisted(timed(humanMsg('h3', 'three', alice), at(20))),
    ]
    const { window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer viewingUserId="me" />
    )

    const time = at(0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    expect(metaFor(window.document, 'h1')?.textContent).toBe(`Alice · ${time}`)
    expect(metaFor(window.document, 'h2')).toBeNull()
    // A new group after the gap shows its time, but the name only repeats when it did before.
    expect(metaFor(window.document, 'h3')?.querySelector('[data-testid="message-sender"]')).toBeNull()
    expect(metaFor(window.document, 'h3')?.querySelector('time')).not.toBeNull()
    expect(window.document.querySelectorAll('[data-testid="message-sender"]')).toHaveLength(1)
  })

  test('every message has the full timestamp as its tooltip', async () => {
    const items: RenderItem[] = [
      persisted(timed(humanMsg('h1', 'first'), at(0))),
      persisted(timed(humanMsg('h2', 'second'), at(1))),
      persisted(timed(assistantMsg('a1', 'reply'), at(2))),
      persisted(timed(assistantMsg('s1', '[System] Agent restarted'), at(3))),
    ]
    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const full = (date: Date) =>
      date.toLocaleString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
    for (const [id, date] of [
      ['h1', at(0)],
      ['h2', at(1)],
      ['a1', at(2)],
      ['s1', at(3)],
    ] as const) {
      expect(window.document.querySelector(`[data-message-id~="${id}"]`)?.getAttribute('title')).toBe(full(date))
    }
  })

  test('system rows reset grouping and pending or streaming items show no time', async () => {
    const items: RenderItem[] = [
      persisted(timed(assistantMsg('a1', 'reply'), at(0))),
      persisted(timed(assistantMsg('s1', '[System] Context compacted'), at(1))),
      persisted(timed(assistantMsg('a2', 'another reply'), at(2))),
      { kind: 'pending', id: 'client-1', content: 'optimistic', status: 'sending' },
      {
        kind: 'streaming',
        id: 'sg-1',
        agentId: 'agent-1',
        blocks: [{ type: 'text', content: 'streaming text' }] as StreamingContentBlock[],
        status: 'streaming',
      },
    ]
    const { window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    expect(metaFor(window.document, 'a2')?.querySelector('time')).not.toBeNull()
    expect(window.document.querySelectorAll('[data-testid="message-meta"]')).toHaveLength(2)
    expect(window.document.querySelectorAll('[data-testid="day-divider"]')).toHaveLength(1)
  })
})

describe('ChatView working indicator', () => {
  // The indicator is now a deterministic RenderItem emitted by combine(); ChatView just renders it
  // wherever it appears in `items`. (When/where it's emitted is covered by combine.test.ts.)
  test('renders the typing indicator for a working RenderItem', async () => {
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'h1',
        message: humanMsg('h1', 'do the thing'),
        mergedFrom: [humanMsg('h1', 'do the thing')],
        blocks: [],
      },
      { kind: 'working', id: '__working__' },
    ]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    expect(window.document.querySelector('[data-testid="typing-indicator"]')).not.toBeNull()
  })

  test('renders exactly one indicator alongside streaming content', async () => {
    const items: RenderItem[] = [
      {
        kind: 'streaming',
        id: 'S',
        agentId: 'a',
        status: 'streaming',
        blocks: [{ type: 'text', id: 't', content: 'partial answer' }],
      },
      { kind: 'working', id: '__working__' },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer isStreaming />
    )

    expect(window.document.querySelectorAll('[data-testid="typing-indicator"]').length).toBe(1)
  })

  test('renders the sandbox-wait copy when the working item is tagged waitingFor: sandbox', async () => {
    const items: RenderItem[] = [{ kind: 'working', id: '__working__', waitingFor: 'sandbox' }]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const indicator = window.document.querySelector('[data-testid="typing-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator?.getAttribute('aria-label')).toBe('Waiting for the sandbox to start…')
  })

  test('renders the default thinking label when the working item has no waitingFor', async () => {
    const items: RenderItem[] = [{ kind: 'working', id: '__working__' }]
    const { dom, root, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)

    const indicator = window.document.querySelector('[data-testid="typing-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator?.getAttribute('aria-label')).toBe('Thinking...')
  })

  test('renders no indicator without a working RenderItem', async () => {
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: 'a1',
        message: assistantMsg('a1', 'all done'),
        mergedFrom: [assistantMsg('a1', 'all done')],
        blocks: [],
      },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView items={items} onSend={() => {}} hideComposer executionStatus="completed" />
    )

    expect(window.document.querySelector('[data-testid="typing-indicator"]')).toBeNull()
  })
})

describe('ChatView loading state', () => {
  test('shows message skeletons without the empty hint while messages are loading', async () => {
    const { dom, root, window } = await renderChatView(<ChatView items={[]} onSend={() => {}} hideComposer isLoading />)

    expect(window.document.querySelector('[role="status"][aria-label="Loading conversation"]')).not.toBeNull()
    expect(window.document.querySelector('[aria-label="Loading conversation"] .animate-spin')).toBeNull()
    expect(
      window.document.querySelectorAll('[aria-label="Loading conversation"] [aria-hidden="true"]').length
    ).toBeGreaterThan(3)
    expect(window.document.body.innerHTML).not.toContain('Send a message to start chatting')
  })

  test('shows the empty hint once loading resolves with no messages', async () => {
    const { dom, root, window } = await renderChatView(<ChatView items={[]} onSend={() => {}} hideComposer />)

    expect(window.document.querySelector('[aria-label="Loading conversation"]')).toBeNull()
    expect(window.document.body.innerHTML).toContain('Send a message to start chatting')
  })
})

describe('ChatView sandbox recovery composer behavior', () => {
  test('treats waiting-sandbox as busy and keeps intervention delivery controls', async () => {
    const { dom, root, window } = await renderChatView(
      <ChatView
        items={[{ kind: 'working', id: '__working__', waitingFor: 'sandbox' }]}
        onSend={() => {}}
        executionStatus="waiting-sandbox"
        deliveryMode="steer"
        onDeliveryModeChange={() => {}}
      />
    )

    expect(window.document.querySelector('button[type="submit"][aria-label="Interrupt"]')).not.toBeNull()
    expect(window.document.querySelector('button[aria-label="Message delivery"]')).not.toBeNull()
  })
})

describe('ChatView microphone gating', () => {
  async function renderComposer() {
    const { dom, root, window } = await renderChatView(<ChatView items={[]} onSend={() => {}} />)
    return { dom, root, html: window.document.body.innerHTML }
  }

  test('retained chats release voice shortcuts when inactive and ignore keys outside their composer', async () => {
    const start = mock(() => {})
    const beginPress = mock(() => {})
    let setActive!: (active: boolean) => void
    function Harness() {
      const [active, updateActive] = useState(true)
      setActive = updateActive
      return (
        <>
          <input aria-label="Command search" />
          <ChatView
            items={[]}
            onSend={() => {}}
            keyboardShortcutsEnabled={active}
            dependencies={{
              ...chatViewDependencies,
              useVoiceRecorderHook: () => ({
                ...useVoiceRecorderFixture(),
                start,
                beginPress,
                isPressing: () => false,
              }),
            }}
          />
        </>
      )
    }
    const { dom, window } = await renderChatView(<Harness />)
    const search = window.document.querySelector<HTMLInputElement>('[aria-label="Command search"]')!
    const composer = window.document.querySelector<HTMLTextAreaElement>('textarea')!
    const key = async (target: HTMLElement, key: string, modifiers = {}) =>
      dom.act(async () => {
        target.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
        )
      })
    await key(search, 'ArrowUp')
    await key(search, 'V', { ctrlKey: true, shiftKey: true })
    expect(start).not.toHaveBeenCalled()
    expect(beginPress).not.toHaveBeenCalled()
    await key(composer, 'ArrowUp')
    expect(start).toHaveBeenCalledTimes(1)
    await dom.act(async () => setActive(false))
    await key(search, 'ArrowUp')
    await key(composer, 'ArrowUp')
    await key(composer, 'V', { ctrlKey: true, shiftKey: true })
    expect(start).toHaveBeenCalledTimes(1)
    expect(beginPress).not.toHaveBeenCalled()
    await dom.act(async () => setActive(true))
    await key(composer, 'ArrowUp')
    expect(start).toHaveBeenCalledTimes(2)
  })

  test('offers the microphone when the server has voice configured', async () => {
    voiceEnabled = true
    recorderSupported = true

    const { dom, root, html } = await renderComposer()
    expect(html).toContain('Record voice message')
  })

  test('hides the microphone when the server reports voice disabled', async () => {
    // No OpenAI key server-side: a mic here would record and then fail on the
    // transcribe round-trip, so it must not be offered at all.
    voiceEnabled = false
    recorderSupported = true

    const { dom, root, html } = await renderComposer()
    expect(html).not.toContain('Record voice message')
    expect(html).not.toContain('Voice message')
  })

  test('still hides the microphone when the browser cannot record', async () => {
    voiceEnabled = true
    recorderSupported = false

    const { dom, root, html } = await renderComposer()
    expect(html).not.toContain('Record voice message')
  })
})

describe('ChatView mobile options overlay', () => {
  test('lets mobile users choose delivery without sending a message', async () => {
    const onSend = mock(() => {})
    const onDeliveryModeChange = mock(() => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={onSend}
        executionStatus="running"
        deliveryMode="steer"
        onDeliveryModeChange={onDeliveryModeChange}
      />
    )
    const trigger = window.document.querySelector<HTMLButtonElement>('button[aria-label="Message delivery"]')!
    await dom.act(async () => trigger.click())
    const option = [...window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((row) =>
      row.textContent?.includes('Follow up')
    )!
    await dom.act(async () => option.click())
    expect(onDeliveryModeChange).toHaveBeenCalledWith('follow-up')
    expect(onSend).not.toHaveBeenCalled()
  })

  test('delivery is one split button: the send half names the mode, the chevron explains each choice', async () => {
    const onDeliveryModeChange = mock(() => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={() => {}}
        executionStatus="running"
        deliveryMode="steer"
        onDeliveryModeChange={onDeliveryModeChange}
      />
    )
    const group = window.document.querySelector('.chat-composer-delivery') as HTMLElement
    const submit = group.querySelector('button[type="submit"]') as HTMLButtonElement
    const trigger = group.querySelector<HTMLButtonElement>('button[aria-label="Message delivery"]')!
    // Both halves live in one container that owns the shape and colour.
    expect(group.className).toContain('rounded-md')
    expect(group.className).toContain('bg-accent')
    expect(submit.textContent).toBe('Interrupt')
    await dom.act(async () => trigger.click())
    expect(
      [...window.document.querySelectorAll('[role="option"]')].map((option) => option.getAttribute('aria-label'))
    ).toEqual(['Interrupt', 'Follow up'])
    expect(window.document.querySelector('[role="listbox"]')?.textContent).toContain('next delivery point')
    // No separate icon-only toggle remains.
    expect(window.document.querySelector('[title^="Interrupt: click"]')).toBeNull()
  })

  test('follow-up mode colours the whole split button and names its send half', async () => {
    const { window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={() => {}}
        executionStatus="running"
        deliveryMode="follow-up"
        onDeliveryModeChange={() => {}}
      />
    )
    const group = window.document.querySelector('.chat-composer-delivery') as HTMLElement
    expect(group.className).toContain('bg-status-attention-600')
    expect(group.querySelector('button[type="submit"]')!.textContent).toBe('Follow up')
  })

  test('a mode the composer picked shows a quiet Auto indicator that says why', async () => {
    const { root, dom, window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={() => {}}
        executionStatus="running"
        deliveryMode="follow-up"
        onDeliveryModeChange={() => {}}
        suggestedDelivery={{ now: false }}
      />
    )
    const submit = window.document.querySelector('.chat-composer-delivery button[type="submit"]') as HTMLElement
    const indicator = submit.querySelector('.chat-composer-auto') as HTMLElement
    expect(indicator.textContent).toBe('Auto')
    expect(indicator.querySelector('svg')).not.toBeNull()
    expect(indicator.getAttribute('title')).toBe('Suggested because this looks like separate work that can wait')
    expect(submit.getAttribute('aria-label')).toBe('Follow up (suggested)')
    expect(submit.getAttribute('title')).toStartWith('Suggested because this looks like separate work')

    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ChatView
              items={[]}
              onSend={() => {}}
              executionStatus="running"
              deliveryMode="steer"
              onDeliveryModeChange={() => {}}
              suggestedDelivery={{ now: true }}
              dependencies={chatViewDependencies}
            />
          </PermissionsProvider>
        </MemoryRouter>
      )
    )
    expect(window.document.querySelector('.chat-composer-auto')?.getAttribute('title')).toBe(
      'Suggested because this should reach the agent now'
    )

    // A mode the person chose shows no indicator.
    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ChatView
              items={[]}
              onSend={() => {}}
              executionStatus="running"
              deliveryMode="steer"
              onDeliveryModeChange={() => {}}
              suggestedDelivery={null}
              dependencies={chatViewDependencies}
            />
          </PermissionsProvider>
        </MemoryRouter>
      )
    )
    expect(window.document.querySelector('.chat-composer-auto')).toBeNull()
    expect(window.document.querySelector('.chat-composer-delivery button[type="submit"]')!.textContent).toBe(
      'Interrupt'
    )
  })

  test('reports every draft change, including the clear after a send', async () => {
    const drafts: string[] = []
    const onSend = mock(async () => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={onSend}
        executionStatus="running"
        deliveryMode="steer"
        onDeliveryModeChange={() => {}}
        onDraftChange={(draft) => drafts.push(draft)}
      />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'also fix the tests' } }))
    expect(drafts.at(-1)).toBe('also fix the tests')
    await dom.act(async () => {
      fireEvent.submit(textarea.closest('form')!)
    })
    await flushReact()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(drafts.at(-1)).toBe('')
  })

  for (const fullscreen of [false, true]) {
    test(`escapes chat stacking contexts and closes before ${fullscreen ? 'fullscreen' : 'page'} navigation`, async () => {
      const { dom, window } = await renderChatView(<ChatView items={[]} onSend={() => {}} enableFullscreen />)
      if (fullscreen) {
        await dom.act(async () => fireEvent.click(window.document.querySelector('[aria-label="Fullscreen"]')!))
      }
      const trigger = window.document.querySelector(
        'button[aria-label="Attach or change controls"]'
      ) as HTMLButtonElement
      const composer = trigger.closest('form')!
      composer.style.transform = 'translateZ(0)'
      composer.style.overflow = 'hidden'
      await dom.act(async () => fireEvent.click(trigger))
      const dialog = window.document.querySelector(
        '[role="dialog"][aria-label="Attach or change controls"]'
      ) as HTMLElement
      const layer = dialog.parentElement!
      expect(layer.parentElement).toBe(window.document.body)
      expect(composer.contains(dialog)).toBe(false)
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(dialog.textContent).toContain('Attach image')
      expect(dialog.textContent).toContain('Auto-scroll on')
      expect(window.document.activeElement).toBe(dialog)
      await dom.act(async () => fireEvent.keyDown(dialog, { key: 'Escape' }))
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(layer.getAttribute('aria-hidden')).toBe('true')
      expect(window.document.activeElement).toBe(trigger)
      if (fullscreen) expect(window.document.querySelector('[aria-label="Exit fullscreen"]')).not.toBeNull()
    })
  }

  test('keeps options in the visual viewport and restores focus after an option or backdrop dismissal', async () => {
    const { dom, window } = await renderChatView(<ChatView items={[]} onSend={() => {}} />)
    const viewport = new window.EventTarget()
    Object.assign(viewport, { height: 340, offsetTop: 24 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const trigger = window.document.querySelector('button[aria-label="Attach or change controls"]') as HTMLButtonElement
    await dom.act(async () => fireEvent.click(trigger))
    const dialog = window.document.querySelector(
      '[role="dialog"][aria-label="Attach or change controls"]'
    ) as HTMLElement
    const layer = dialog.parentElement!
    expect(layer.style.getPropertyValue('--chat-options-height')).toBe('340px')
    expect(layer.style.getPropertyValue('--chat-options-top')).toBe('24px')
    Object.assign(viewport, { height: 280, offsetTop: 60 })
    await dom.act(async () => viewport.dispatchEvent(new window.Event('resize')))
    expect(layer.style.getPropertyValue('--chat-options-height')).toBe('280px')
    expect(layer.style.getPropertyValue('--chat-options-top')).toBe('60px')
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    buttons.at(-1)!.focus()
    await dom.act(async () => fireEvent.keyDown(buttons.at(-1)!, { key: 'Tab' }))
    expect(window.document.activeElement).toBe(buttons[0])
    await dom.act(async () => fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true }))
    expect(window.document.activeElement).toBe(buttons.at(-1)!)
    const autoScroll = buttons.find((button) => button.textContent?.includes('Auto-scroll on'))!
    await dom.act(async () => fireEvent.click(autoScroll))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(window.document.activeElement).toBe(trigger)
    await dom.act(async () => fireEvent.click(trigger))
    expect(dialog.textContent).toContain('Auto-scroll off')
    await dom.act(async () => fireEvent.click(layer))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(window.document.activeElement).toBe(trigger)
  })
})

describe('ChatView ordinary file attachments', () => {
  test('inserts a provisional reference at the active selection', async () => {
    const { dom, root, window } = await renderChatView(
      <ChatView items={[]} agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d" onSend={() => {}} />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'read this now' } }))
    await flushReact()
    textarea.focus()
    textarea.setSelectionRange(5, 9)
    const attachButton = window.document.querySelector('[aria-label="Attach a file"]') as HTMLButtonElement
    attachButton.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    attachButton.focus()
    const input = window.document.querySelector('input[type="file"][accept="*/*"]') as HTMLInputElement
    const file = new window.File(['hello'], 'report.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await dom.act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    await flushReact()
    expect(textarea.value).toMatch(/^read @\/private\/chat-attachments\/[0-9a-f-]+\/report\.pdf now$/)
    expect(uploadAgentFileMock).toHaveBeenCalledTimes(1)
  })

  test('advances the insertion caret for multiple selected files', async () => {
    const { dom, root, window } = await renderChatView(
      <ChatView items={[]} agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d" onSend={() => {}} />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'compare now'
    ;(textarea as HTMLTextAreaElement & { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(
      ''
    )
    await dom.act(async () => textarea.dispatchEvent(new window.Event('input', { bubbles: true })))
    textarea.focus()
    textarea.setSelectionRange(0, 7)
    const attachButton = window.document.querySelector('[aria-label="Attach a file"]') as HTMLButtonElement
    attachButton.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    attachButton.focus()
    const input = window.document.querySelector('input[type="file"][accept="*/*"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['a'], 'a.txt'), new window.File(['b'], 'b.txt')],
    })
    await dom.act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    expect(textarea.value.match(/@\/private\/chat-attachments\//g)).toHaveLength(2)
    expect(textarea.value).toContain('/a.txt @/private/chat-attachments/')
  })

  test('does not upload ordinary file drops while disabled', async () => {
    uploadAgentFileMock.mockClear()
    const { dom, root, window } = await renderChatView(
      <ChatView items={[]} agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d" inputDisabled onSend={() => {}} />
    )
    const form = window.document.querySelector('form') as HTMLFormElement
    const event = drag(window, 'drop', form, [new window.File(['x'], 'notes.txt', { type: 'text/plain' })], false)
    await dom.act(async () => form.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(uploadAgentFileMock).not.toHaveBeenCalled()
  })

  // Adoption rewrites the composer under the user; it must not yank the caret
  // to the end of what they are typing, nor pull focus away from wherever they
  // are (the textarea was not focused here — the attach button was).
  test('keeps the caret and focus where the user left them when adopting', async () => {
    const upload = deferred<{ path: string }>()
    const uploadMock = mock(() => upload.promise)
    const { dom, root, window } = await renderChatView(
      <ChatView
        items={[]}
        agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d"
        onSend={() => {}}
        dependencies={{ uploadAgentFile: uploadMock as never }}
      />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => fireEvent.input(textarea, { target: { value: 'read this' } }))
    textarea.focus()
    textarea.setSelectionRange(5, 5)
    const attachButton = window.document.querySelector('[aria-label="Attach a file"]') as HTMLButtonElement
    attachButton.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    attachButton.focus()
    const input = window.document.querySelector('input[type="file"][accept="*/*"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['x'], 'report.pdf', { type: 'application/pdf' })],
    })
    await dom.act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    await flushReact()

    // Caret parked right after the token, with the user's own words still to
    // its RIGHT — so a caret that jumps to the end of the value is detectable.
    const provisional = textarea.value.match(/@\S+report\.pdf/)![0]
    const caretAfterToken = textarea.value.indexOf(provisional) + provisional.length
    expect(caretAfterToken).toBeLessThan(textarea.value.length)
    textarea.setSelectionRange(caretAfterToken, caretAfterToken)
    const adopted = provisional.replace('@/private', '@/Users/n/.tau/private/agent_1')
    // Park focus off the composer: adoption is server-driven, not a user
    // action, so it must leave focus wherever the user actually is.
    attachButton.focus()
    await dom.act(async () => {
      upload.resolve({ path: adopted.slice(1) })
      await Promise.resolve()
    })
    await flushReact()

    expect(textarea.value).toContain(adopted)
    expect(textarea.selectionStart).toBe(caretAfterToken + (adopted.length - provisional.length))
    expect(textarea.selectionStart).toBeLessThan(textarea.value.length)
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe('Attach a file')
  })

  // Removing an attachment IS an explicit user action: the composer gets focus
  // back so the user can keep typing where the token used to be.
  test('returns focus to the composer when a chip is removed', async () => {
    const { dom, root, window } = await renderChatView(
      <ChatView items={[]} agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d" onSend={() => {}} />
    )
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    const input = window.document.querySelector('input[type="file"][accept="*/*"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['x'], 'report.pdf', { type: 'application/pdf' })],
    })
    await dom.act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    await flushReact()
    expect(textarea.value).toContain('report.pdf')

    const remove = window.document.querySelector('[aria-label="Remove report.pdf"]') as HTMLButtonElement
    remove.focus()
    expect(window.document.activeElement).not.toBe(textarea)
    await dom.act(async () => remove.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await flushReact()
    expect(textarea.value).not.toContain('report.pdf')
    expect(window.document.activeElement?.tagName).toBe('TEXTAREA')
  })

  // Server error CODES are protocol, not prose: the chip has to say what they
  // mean or the user is left with an acronym and a Retry button.
  test('explains a known error code in the chip', async () => {
    const failingUpload = mock(async () => {
      throw new Error('ATTACHMENT_TOO_LARGE')
    })
    const { dom, root, window } = await renderChatView(
      <ChatView
        items={[]}
        agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d"
        onSend={() => {}}
        dependencies={{ uploadAgentFile: failingUpload as never }}
      />
    )
    const input = window.document.querySelector('input[type="file"][accept="*/*"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['x'], 'big.bin', { type: 'application/octet-stream' })],
    })
    await dom.act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    await flushReact()
    const body = window.document.body.textContent ?? ''
    expect(body).toContain('This file is larger than the upload size limit')
    expect(body).not.toContain('ATTACHMENT_TOO_LARGE')
  })

  // A failed upload used to render as the bare word "error" next to a Retry
  // button: the server's reason (409 "Attachment unavailable", a quota refusal,
  // a transport failure) was parsed, stored on the item and then thrown away at
  // render, leaving nothing to act on.
  test('shows why an upload failed instead of a bare retry', async () => {
    const failingUpload = mock(async () => {
      throw new Error('Attachment unavailable')
    })
    const { dom, root, window } = await renderChatView(
      <ChatView
        items={[]}
        agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d"
        onSend={() => {}}
        dependencies={{ uploadAgentFile: failingUpload as never }}
      />
    )
    const input = window.document.querySelector('input[type="file"][accept="*/*"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['x'], 'file.json', { type: 'application/json' })],
    })
    await dom.act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    await flushReact()
    expect(failingUpload).toHaveBeenCalledTimes(1)
    const body = window.document.body.textContent ?? ''
    expect(body).toContain('Attachment unavailable')
    expect(body).toContain('Retry')
  })

  // The drop zone accepts ANY file (images become image attachments, everything
  // else an agent file), so promising images turns away the files that work.
  test('offers the drop zone for files, not only images', async () => {
    const { dom, root, window } = await renderChatView(
      <ChatView items={[]} agentId="6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d" onSend={() => {}} />
    )
    const form = window.document.querySelector('form') as HTMLFormElement
    await dom.act(async () => void drag(window, 'dragenter', form))
    await flushReact()
    const body = window.document.body.textContent ?? ''
    expect(body).toContain('Drop to attach to this chat')
    expect(body).toContain('other files as agent files')
    expect(body).not.toContain('Drop images here')
  })
})

describe('ChatView whole-surface drops and pastes', () => {
  const agentId = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'
  const image = (window: Awaited<ReturnType<typeof acquireDomHarness>>['window']) =>
    new window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }) as unknown as File
  const text = (window: Awaited<ReturnType<typeof acquireDomHarness>>['window']) =>
    new window.File(['notes'], 'notes.txt', { type: 'text/plain' }) as unknown as File
  const overlay = (window: Awaited<ReturnType<typeof acquireDomHarness>>['window']) =>
    window.document.querySelector('[data-testid="chat-drop-overlay"]')
  const attachedImages = (window: Awaited<ReturnType<typeof acquireDomHarness>>['window']) =>
    window.document.querySelectorAll('[aria-label="Remove image"]').length
  const chat = (window: Awaited<ReturnType<typeof acquireDomHarness>>['window']) => ({
    surface: window.document.querySelector('[data-drop-scope="chat"]') as HTMLElement,
    messages: window.document.querySelector('[data-testid="chat-messages"]') as HTMLElement,
    form: window.document.querySelector('form') as HTMLFormElement,
  })

  test('a drop on the messages area attaches images as images and other files as agent files', async () => {
    uploadAgentFileMock.mockClear()
    const { dom, window } = await renderChatView(
      <ChatView items={[]} agentId={agentId} selectedModelSupportsImages onSend={() => {}} />
    )
    const { messages } = chat(window)
    const dropped = await dom.act(async () => drag(window, 'drop', messages, [image(window), text(window)]))
    expect(dropped.defaultPrevented).toBe(true)
    await flushReact()
    expect(attachedImages(window)).toBe(1)
    expect(uploadAgentFileMock).toHaveBeenCalledTimes(1)
  })

  test('dragging over nested children neither flickers nor sticks', async () => {
    const { dom, window } = await renderChatView(<ChatView items={[]} agentId={agentId} onSend={() => {}} />)
    const { messages, form } = chat(window)
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    await dom.act(async () => void drag(window, 'dragenter', messages))
    expect(overlay(window)?.textContent).toContain('Drop to attach to this chat')
    // Moving into the composer enters the new child before leaving the old one.
    await dom.act(async () => {
      drag(window, 'dragenter', form)
      drag(window, 'dragleave', messages)
      drag(window, 'dragenter', textarea)
      drag(window, 'dragleave', form)
    })
    expect(overlay(window)).not.toBeNull()
    // Leaving the chat altogether clears it.
    await dom.act(async () => void drag(window, 'dragleave', textarea))
    expect(overlay(window)).toBeNull()
    // A drag that ends elsewhere does not leave it stuck either.
    await dom.act(async () => void drag(window, 'dragenter', messages))
    expect(overlay(window)).not.toBeNull()
    await dom.act(async () => void window.dispatchEvent(new window.Event('dragend')))
    expect(overlay(window)).toBeNull()
    // Nor does a drop, after which a new drag starts counting from zero.
    await dom.act(async () => {
      drag(window, 'dragenter', messages)
      drag(window, 'drop', messages)
    })
    expect(overlay(window)).toBeNull()
    await dom.act(async () => void drag(window, 'dragenter', form))
    expect(overlay(window)).not.toBeNull()
    await dom.act(async () => void drag(window, 'dragleave', form))
    expect(overlay(window)).toBeNull()
  })

  test('internal drags (selected text, page elements) are left alone', async () => {
    uploadAgentFileMock.mockClear()
    const { dom, window } = await renderChatView(<ChatView items={[]} agentId={agentId} onSend={() => {}} />)
    const { messages } = chat(window)
    const types = ['text/plain', 'text/html']
    const entered = await dom.act(async () => drag(window, 'dragenter', messages, [], true, types))
    const over = await dom.act(async () => drag(window, 'dragover', messages, [], true, types))
    expect(overlay(window)).toBeNull()
    expect(entered.defaultPrevented).toBe(false)
    expect(over.defaultPrevented).toBe(false)
    const dropped = await dom.act(async () => drag(window, 'drop', messages, [], true, types))
    expect(dropped.defaultPrevented).toBe(false)
    expect(uploadAgentFileMock).not.toHaveBeenCalled()
  })

  test('a read-only chat shows no overlay but still keeps the browser from opening a dropped file', async () => {
    const { dom, window } = await renderChatView(
      <ChatView items={[]} agentId={agentId} hideComposer onSend={() => {}} />
    )
    const { surface } = chat(window)
    await dom.act(async () => void drag(window, 'dragenter', surface))
    expect(overlay(window)).toBeNull()
    const dropped = await dom.act(async () => drag(window, 'drop', surface, [image(window)]))
    expect(dropped.defaultPrevented).toBe(true)
  })

  test('an image pasted with focus on the chat surface attaches once; in the composer, once too', async () => {
    const { dom, window } = await renderChatView(
      <ChatView items={[]} agentId={agentId} selectedModelSupportsImages onSend={() => {}} />
    )
    const { surface, messages } = chat(window)
    // Clicking the messages focuses the surface (it is the nearest focusable ancestor).
    surface.focus()
    expect(window.document.activeElement).toBe(surface)
    const pasted = await dom.act(async () => pasteFiles(window, messages, [image(window)]))
    expect(pasted.defaultPrevented).toBe(true)
    await flushReact()
    expect(attachedImages(window)).toBe(1)
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()
    await dom.act(async () => void pasteFiles(window, textarea, [image(window)]))
    await flushReact()
    expect(attachedImages(window)).toBe(2)
  })

  test('beside the page-wide screenshot drop: chats keep their drops and pastes, the page opens the review card', async () => {
    const dom = await installDom()
    const { window } = dom
    const { root } = dom.createRoot()
    const guessed: string[] = []
    const filed: string[] = []
    const { ScreenshotFiling } = await import('./ScreenshotFiling')
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    await dom.act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <QueryClientProvider client={new QueryClient()}>
            <PermissionsProvider usePermissions={usePermissionsMock}>
              <p data-testid="page">Page content</p>
              <ChatView
                items={[]}
                agentId={agentId}
                selectedModelSupportsImages
                onSend={() => {}}
                dependencies={chatViewDependencies}
              />
              <ScreenshotFiling
                dependencies={
                  {
                    upload: async () => ['image-1'],
                    api: {
                      guess: async (imageId: string) => {
                        guessed.push(imageId)
                        return { guess: null }
                      },
                      file: async ({ imageId }: { imageId: string }) => {
                        filed.push(imageId)
                        return { conversationId: 'c' }
                      },
                    },
                  } as never
                }
              />
            </PermissionsProvider>
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    await flushReact()
    const page = window.document.querySelector('[data-testid="page"]')!
    const pageOverlay = () => window.document.querySelector('[data-testid="screenshot-drop-overlay"]')
    const reviewCard = () => window.document.querySelector('[data-testid="screenshot-review-card"]')
    const { surface, messages } = chat(window)

    // Outside the chat the page-wide target works; inside it only the chat's overlay shows.
    await dom.act(async () => void drag(window, 'dragenter', page))
    expect(pageOverlay()).not.toBeNull()
    await dom.act(async () => {
      drag(window, 'dragenter', messages)
      drag(window, 'dragleave', page)
    })
    expect(pageOverlay()).toBeNull()
    expect(overlay(window)).not.toBeNull()
    await dom.act(async () => void drag(window, 'dragover', messages))
    expect(pageOverlay()).toBeNull()
    await dom.act(async () => void drag(window, 'drop', messages, [image(window)]))
    await flushReact()
    expect(attachedImages(window)).toBe(1)
    expect(guessed).toEqual([])
    expect(reviewCard()).toBeNull()

    // A paste with focus on the chat attaches to it; with focus outside every chat, it opens the
    // screenshot review card, which files nothing until it is confirmed.
    surface.focus()
    await dom.act(async () => void pasteFiles(window, surface, [image(window)]))
    await flushReact()
    expect(attachedImages(window)).toBe(2)
    expect(guessed).toEqual([])
    expect(reviewCard()).toBeNull()
    surface.blur()
    await dom.act(async () => void pasteFiles(window, page, [image(window)]))
    await flushReact()
    expect(reviewCard()).not.toBeNull()
    expect(guessed).toEqual(['image-1'])
    expect(filed).toEqual([])
    expect(attachedImages(window)).toBe(2)
  })
})

function StubAgentConversation({ agentId }: React.ComponentProps<typeof AgentConversation>) {
  return <div data-testid="selected-agent-conversation">Conversation for {agentId}</div>
}

function TestRealToolInlineActionModal(props: ToolInlineActionModalProps) {
  return <ToolInlineActionModal {...props} dependencies={{ AgentConversationComponent: StubAgentConversation }} />
}

describe('ChatView inline tool actions', () => {
  test('anchors a monitor action below its persisted tool row and closes its modal', async () => {
    const message = assistantMsg('a-monitor', 'created')
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: message.id,
        message,
        blocks: [
          {
            type: 'tool_use',
            id: 'tc-monitor',
            toolCall: {
              toolCallId: 'tc-monitor',
              toolName: 'monitor',
              args: '{"action":"create"}',
              isError: false,
              result: JSON.stringify({ details: { success: true, monitorId: 'monitor-1' } }),
            },
          },
        ],
      },
    ]
    const { dom, window } = await renderChatView(<ChatView items={items} onSend={() => {}} hideComposer />)
    const row = window.document.querySelector('[data-tool-call-row="tc-monitor"]')!
    const action = window.document.querySelector('button[aria-label="Open monitor"]')!
    expect(row.nextElementSibling).toBe(action.parentElement)
    await dom.act(async () => action.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(openedToolAction).toEqual(expect.objectContaining({ kind: 'monitor', monitorId: 'monitor-1' }))
    const close = window.document.querySelector('[data-testid="tool-action-modal"]')!
    await dom.act(async () => close.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(window.document.querySelector('[data-testid="tool-action-modal"]')).toBeNull()
  })

  test('anchors dispatch actions below completed streaming rows but hides them while incomplete', async () => {
    const toolCall = {
      toolCallId: 'tc-dispatch',
      toolName: 'dispatch',
      args: '{}',
      isError: false,
      result: JSON.stringify({
        details: {
          subagents: [
            { subagentId: 'child-1', label: 'Research' },
            { subagentId: 'child-2', label: 'Build' },
          ],
        },
      }),
    }
    const completed: RenderItem[] = [
      {
        kind: 'streaming',
        id: 'S',
        agentId: 'a',
        status: 'streaming',
        blocks: [{ type: 'tool_use', id: 'tc-dispatch', _done: true, toolCall }],
      },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView
        dependencies={{ ToolInlineActionModalComponent: TestRealToolInlineActionModal }}
        items={completed}
        onSend={() => {}}
        hideComposer
      />
    )
    const initialSearch = window.location.search
    const row = window.document.querySelector('[data-tool-call-row="tc-dispatch"]')!
    const action = window.document.querySelector('button[aria-label="Open Research chat"]')!
    expect(row.nextElementSibling).toBe(action.parentElement)
    await dom.act(async () => action.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    const dialog = window.document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Research chat')
    expect(dialog.textContent).toContain('Conversation for child-1')
    expect(dialog.textContent).not.toContain('Build')
    expect(window.location.search).toBe(initialSearch)

    const close = dialog.querySelector('button[aria-label="Close"]')!
    await dom.act(async () => close.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(window.document.querySelector('[role="dialog"]')).toBeNull()
    expect(window.location.search).toBe(initialSearch)

    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <ChatView
            dependencies={chatViewDependencies}
            items={[
              {
                ...completed[0],
                blocks: [{ type: 'tool_use', id: 'tc-dispatch', _done: false, toolCall }],
              },
            ]}
            onSend={() => {}}
            hideComposer
          />
        </MemoryRouter>
      )
    )
    expect(window.document.querySelector('button[aria-label="Open Research chat"]')).toBeNull()
  })

  test('shows finished calls’ actions under a collapsed live group, and only on the rows once expanded', async () => {
    const monitor = {
      toolCallId: 'tc-monitor',
      toolName: 'monitor',
      args: '{"action":"create"}',
      isError: false,
      result: JSON.stringify({ details: { success: true, monitorId: 'monitor-1' } }),
    }
    const dispatch = {
      toolCallId: 'tc-dispatch',
      toolName: 'dispatch',
      args: '{}',
      isError: false,
      result: JSON.stringify({ details: { subagents: [{ subagentId: 'child-1', label: 'Research' }] } }),
    }
    // Text after the group makes it no longer the active group, so it stays collapsed.
    const streaming = (dispatchDone: boolean): RenderItem[] => [
      {
        kind: 'streaming',
        id: 'S',
        agentId: 'a',
        status: 'streaming',
        blocks: [
          { type: 'thinking', id: 'th', content: 'plan' },
          { type: 'tool_use', id: 'tc-monitor', _done: true, toolCall: monitor },
          { type: 'tool_use', id: 'tc-dispatch', _done: dispatchDone, toolCall: dispatch },
          { type: 'text', id: 'txt', content: 'Watching.' },
        ],
      },
    ]
    const { dom, root, window } = await renderChatView(
      <ChatView items={streaming(false)} onSend={() => {}} hideComposer />
    )
    const labels = () =>
      [...window.document.querySelectorAll('[data-tool-inline-actions] button')].map((button) =>
        button.getAttribute('aria-label')
      )
    expect(window.document.body.textContent).toContain('2 tools • 1 thinking')
    expect(window.document.querySelector('[data-tool-call-row]')).toBeNull()
    expect(labels()).toEqual(['Open monitor'])

    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ChatView dependencies={chatViewDependencies} items={streaming(true)} onSend={() => {}} hideComposer />
          </PermissionsProvider>
        </MemoryRouter>
      )
    )
    expect(labels()).toEqual(['Open monitor', 'Open Research chat'])
    const action = window.document.querySelector('button[aria-label="Open Research chat"]')!
    await dom.act(async () => action.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(openedToolAction).toEqual(expect.objectContaining({ kind: 'subagent', subagentId: 'child-1' }))
    expect(window.document.querySelector('[data-tool-call-row]')).toBeNull()

    const header = [...window.document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('2 tools • 1 thinking')
    )!
    await dom.act(async () => header.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    const rows = [...window.document.querySelectorAll('[data-tool-inline-actions]')]
    expect(rows.map((row) => row.previousElementSibling?.getAttribute('data-tool-call-row'))).toEqual([
      'tc-monitor',
      'tc-dispatch',
    ])
  })
})

describe('ChatView event inline actions', () => {
  const result = (details: Record<string, unknown>) => JSON.stringify({ details })
  const eventCalls = [
    {
      toolCallId: 'tc-ask',
      toolName: 'ask_human',
      args: '{"questions":[]}',
      isError: false,
      result: result({ questionId: 'question-1', async: true }),
    },
    {
      toolCallId: 'tc-note',
      toolName: 'memory_write',
      args: JSON.stringify({ path: 'decisions/inline-actions.md', content: '# Inline actions' }),
      isError: false,
      result: result({ path: '/home/box/memory/decisions/inline-actions.md', success: true }),
    },
    {
      toolCallId: 'tc-pr',
      toolName: 'squad_bash',
      args: JSON.stringify({ command: 'gh pr create --fill' }),
      isError: false,
      result: result({
        createdLinks: [{ kind: 'pull_request', url: 'https://github.com/ficushq/ficus/pull/684', number: 684 }],
      }),
    },
    {
      toolCallId: 'tc-app',
      toolName: 'browser_open',
      args: JSON.stringify({ localDeploymentId: 'ld-1' }),
      isError: false,
      result: JSON.stringify({
        content: [{ type: 'text', text: 'Local preview opened. (screenshot unavailable)' }],
        details: {},
      }),
    },
    {
      toolCallId: 'tc-notify',
      toolName: 'notify_contact',
      args: '{"title":"PR ready"}',
      isError: false,
      result: result({ success: true, routedTo: 'owner', workStreamId: 'ws-1' }),
    },
  ]
  const items = (): RenderItem[] => {
    const message = assistantMsg('a-events', 'Done.', {
      content: eventCalls.map((toolCall) => ({ type: 'tool_use' as const, id: toolCall.toolCallId, toolCall })),
    })
    return [{ kind: 'persisted', id: message.id, message, blocks: message.metadata!.content! }]
  }
  const labels = (document: Document) =>
    [...document.querySelectorAll('[data-tool-inline-actions] button')].map((button) =>
      button.getAttribute('aria-label')
    )
  const click = (window: Window, label: string) =>
    window.document
      .querySelector(`button[aria-label="${label}"]`)!
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

  test('a collapsed group shows every event action, and each opens its target', async () => {
    const openExternalUrl = mock((_url: string) => undefined)
    const openLocalApp = mock(async (_id: string) => true)
    const { dom, window } = await renderChatView(
      <ChatView
        items={items()}
        agentId="agent-1"
        squadId="squad-1"
        onSend={() => {}}
        hideComposer
        dependencies={{ openExternalUrl, openLocalApp }}
      />
    )
    expect(window.document.querySelector('[data-tool-call-row]')).toBeNull()
    expect(labels(window.document)).toEqual([
      'View question',
      'Open note',
      'Open PR #684',
      'Open app',
      'Open work stream',
    ])

    await dom.act(async () => click(window, 'Open PR #684'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/ficushq/ficus/pull/684')
    await dom.act(async () => click(window, 'Open app'))
    expect(openLocalApp).toHaveBeenCalledWith('ld-1')
    // New-tab targets don't open the in-place modal.
    expect(openedToolAction).toBeNull()

    await dom.act(async () => click(window, 'View question'))
    expect(openedToolAction).toEqual(expect.objectContaining({ kind: 'question', questionId: 'question-1' }))
    await dom.act(async () => click(window, 'Open note'))
    expect(openedToolAction).toEqual(
      expect.objectContaining({ kind: 'memory_note', path: '/memory/decisions/inline-actions.md' })
    )
    await dom.act(async () => click(window, 'Open work stream'))
    expect(openedToolAction).toEqual(expect.objectContaining({ kind: 'work_stream', workStreamRef: 'ws-1' }))
  })

  test('a local app that cannot be opened says so, and the notice can be dismissed', async () => {
    const openLocalApp = mock(async (_id: string) => false)
    const { dom, window } = await renderChatView(
      <ChatView
        items={items()}
        agentId="agent-1"
        squadId="squad-1"
        onSend={() => {}}
        hideComposer
        dependencies={{ openLocalApp }}
      />
    )
    expect(window.document.querySelector('[data-inline-action-notice]')).toBeNull()
    await dom.act(async () => click(window, 'Open app'))
    expect(openLocalApp).toHaveBeenCalledWith('ld-1')
    const notice = window.document.querySelector('[data-inline-action-notice]')!
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('That local app is no longer available.')
    expect(openedToolAction).toBeNull()
    await dom.act(async () => click(window, 'Dismiss'))
    expect(window.document.querySelector('[data-inline-action-notice]')).toBeNull()
  })

  test('a local app that opens shows no notice', async () => {
    const { dom, window } = await renderChatView(
      <ChatView
        items={items()}
        agentId="agent-1"
        squadId="squad-1"
        onSend={() => {}}
        hideComposer
        dependencies={{ openLocalApp: async () => true }}
      />
    )
    await dom.act(async () => click(window, 'Open app'))
    expect(window.document.querySelector('[data-inline-action-notice]')).toBeNull()
  })

  test('a target the modal reports unavailable shows its notice', async () => {
    function UnavailableModal({ onClose, onUnavailable }: ToolInlineActionModalProps) {
      useEffect(() => {
        onUnavailable?.()
        onClose()
      }, [onClose, onUnavailable])
      return null
    }
    const { dom, window } = await renderChatView(
      <ChatView
        items={items()}
        agentId="agent-1"
        squadId="squad-1"
        onSend={() => {}}
        hideComposer
        dependencies={{ ToolInlineActionModalComponent: UnavailableModal }}
      />
    )
    await dom.act(async () => click(window, 'Open work stream'))
    expect(window.document.querySelector('[data-inline-action-notice]')!.textContent).toContain(
      'That work stream could not be found.'
    )
  })

  test('hides actions the viewer cannot open', async () => {
    deniedPermissions = new Set(['memory:read', 'deployments:read'])
    const { window } = await renderChatView(
      <ChatView items={items()} squadId="squad-1" onSend={() => {}} hideComposer />
    )
    // No memory or deployment access, and no agent for the question to open through.
    expect(labels(window.document)).toEqual(['Open PR #684', 'Open work stream'])
  })
})

describe('ChatView streaming tool images', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const read = (result?: string) => ({
    toolCallId: 'tc-read',
    toolName: 'read',
    args: JSON.stringify({ path: '/tmp/shots/after.png' }),
    isError: false,
    ...(result ? { result } : {}),
  })
  const streaming = (blocks: StreamingContentBlock[]): RenderItem[] => [
    { kind: 'streaming', id: 'S', agentId: 'a', status: 'streaming', blocks },
  ]
  const imageResult = JSON.stringify({
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', mimeType: 'image/png', data: PNG },
    ],
  })

  test('the image shows as soon as the tool_end result arrives, and stays on the row once it collapses', async () => {
    const { dom, root, window } = await renderChatView(
      <ChatView
        items={streaming([{ type: 'tool_use', id: 'tc-read', _done: false, toolCall: read() }])}
        onSend={() => {}}
        hideComposer
      />
    )
    const thumbnails = () => [...window.document.querySelectorAll('[data-tool-image-strip] img')]
    expect(thumbnails()).toHaveLength(0)

    const rerender = (blocks: StreamingContentBlock[]) =>
      dom.act(async () =>
        root.render(
          <MemoryRouter>
            <ChatView dependencies={chatViewDependencies} items={streaming(blocks)} onSend={() => {}} hideComposer />
          </MemoryRouter>
        )
      )
    const done: StreamingContentBlock = { type: 'tool_use', id: 'tc-read', _done: true, toolCall: read(imageResult) }
    await rerender([done])
    expect(thumbnails().map((img) => img.getAttribute('src'))).toEqual([`data:image/png;base64,${PNG}`])
    expect(window.document.body.textContent).not.toContain('Read image file')

    // More output pushes the call up and collapses it; the thumbnail stays visible under the row.
    await rerender([done, { type: 'text', id: 'txt', content: 'Looks right.' }])
    expect(window.document.querySelector('[data-tool-call-row="tc-read"]')).toBeTruthy()
    expect(thumbnails().map((img) => img.getAttribute('alt'))).toEqual(['/tmp/shots/after.png'])
  })
})

/**
 * Like renderChatView, but patches Element.scrollIntoView with a spy BEFORE the
 * first render/mount — the focusMessageId search can find and scroll to its
 * target within the very first effect flush, too early to patch afterward.
 */
async function renderChatViewWithScrollSpy(element: React.ReactElement) {
  const scrollIntoViewMock = mock(function (this: Element) {
    return undefined
  })
  const dom = await acquireDomHarness({
    url: 'http://localhost/chat',
    configureWindow(window) {
      window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(callback, 0)
      window.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        disconnect() {}
      }
      window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock as unknown as () => void
    },
  })
  activeDom = dom
  const { window } = dom
  const { root } = dom.createRoot()
  const injected = {
    ...element,
    props: {
      ...element.props,
      dependencies: { ...chatViewDependencies, ...element.props.dependencies },
    },
  }
  await dom.act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/chat/agent-1?scope=all']}>
        <PermissionsProvider usePermissions={usePermissionsMock}>{injected}</PermissionsProvider>
      </MemoryRouter>
    )
  })
  await flushReact()
  return { dom, root, window, scrollIntoViewMock }
}

describe('ChatView focusMessageId', () => {
  test('loads older pages until the target message lands, then scrolls to and highlights it', async () => {
    const target = humanMsg('target-1', 'Found me')
    const targetItem: RenderItem = {
      kind: 'persisted',
      id: 'target-1',
      message: target,
      mergedFrom: [target],
      blocks: [],
    }
    const recentMsg = humanMsg('recent-1', 'Recent message')
    const initialItems: RenderItem[] = [
      { kind: 'persisted', id: 'recent-1', message: recentMsg, mergedFrom: [recentMsg], blocks: [] },
    ]
    let loadOlderCalls = 0

    function Harness({ dependencies }: { dependencies?: React.ComponentProps<typeof ChatView>['dependencies'] }) {
      const [items, setItems] = useState<RenderItem[]>(initialItems)
      const [hasOlder, setHasOlder] = useState(true)
      return (
        <ChatView
          items={items}
          dependencies={dependencies}
          onSend={() => undefined}
          hideComposer
          enableFullscreen={false}
          hasOlderMessages={hasOlder}
          onLoadOlder={() => {
            loadOlderCalls += 1
            setItems((prev) => [targetItem, ...prev])
            setHasOlder(false)
          }}
          focusMessageId="target-1"
        />
      )
    }

    const { dom, window, scrollIntoViewMock } = await renderChatViewWithScrollSpy(<Harness />)

    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    expect(loadOlderCalls).toBe(1)
    const targetEl = window.document.querySelector('[data-message-id~="target-1"]')
    expect(targetEl).not.toBeNull()
    expect(targetEl?.textContent).toContain('Found me')
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
    expect(scrollIntoViewMock.mock.calls[0]?.[0]).toEqual({ block: 'center' })
    expect(targetEl?.className).toContain('ring-2')
  })

  test('an inbox target focuses the transcript message that delivered it', async () => {
    const delivery = humanMsg('delivery-1', '[Inbox] Findings for Task 1')
    delivery.metadata = { ...(delivery.metadata ?? {}), inboxMessageIds: ['inbox-42', 'inbox-43'] } as never
    const items: RenderItem[] = [
      { kind: 'persisted', id: 'delivery-1', message: delivery, mergedFrom: [delivery], blocks: [] },
    ]

    function Harness({ dependencies }: { dependencies?: React.ComponentProps<typeof ChatView>['dependencies'] }) {
      return (
        <ChatView
          items={items}
          dependencies={dependencies}
          onSend={() => undefined}
          hideComposer
          enableFullscreen={false}
          focusInboxMessageId="inbox-42"
        />
      )
    }

    const { dom, window, scrollIntoViewMock } = await renderChatViewWithScrollSpy(<Harness />)
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })

    const targetEl = window.document.querySelector('[data-message-id~="delivery-1"]')
    expect(targetEl).not.toBeNull()
    expect(scrollIntoViewMock).toHaveBeenCalled()
    expect(targetEl?.className).toContain('ring-2')
  })

  test('gives up after the bounded page limit when the target is never found', async () => {
    let loadOlderCalls = 0

    function Harness({ dependencies }: { dependencies?: React.ComponentProps<typeof ChatView>['dependencies'] }) {
      const [items, setItems] = useState<RenderItem[]>([])
      return (
        <ChatView
          items={items}
          dependencies={dependencies}
          onSend={() => undefined}
          hideComposer
          enableFullscreen={false}
          hasOlderMessages
          onLoadOlder={() => {
            loadOlderCalls += 1
            const msg = humanMsg(`filler-${loadOlderCalls}`, `filler ${loadOlderCalls}`)
            setItems((prev) => [
              { kind: 'persisted', id: msg.id, message: msg, mergedFrom: [msg], blocks: [] },
              ...prev,
            ])
          }}
          focusMessageId="never-loaded"
        />
      )
    }

    const { window, scrollIntoViewMock } = await renderChatViewWithScrollSpy(<Harness />)

    // Poll (bounded) instead of a fixed sleep — React scheduling under the test
    // harness is not perfectly uniform per iteration. Deliberately NOT wrapped in
    // dom.act: these are background updates driven by ChatView's own async loop,
    // not something this test triggers synchronously.
    const deadline = Date.now() + 10_000
    while (loadOlderCalls < 10 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Give the loop's final give-up branch a moment to run after the 10th call.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Bounded at 10 pages (see ChatView's MAX_OLDER_PAGES) — never spins forever.
    expect(loadOlderCalls).toBe(10)
    expect(scrollIntoViewMock).not.toHaveBeenCalled()
    expect(window.document.querySelector('[data-message-id~="never-loaded"]')).toBeNull()
  }, 15_000)
})

type ScrollMetrics = {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  scrollWrites: number
  composerHeight: number
}

async function renderChatViewWithControlledLayout(element: React.ReactElement) {
  let resizeCallback: ResizeObserverCallback | undefined
  const observedElements: Element[] = []
  const resizeObservers: { callback: ResizeObserverCallback; elements: Element[] }[] = []
  let nextFrameId = 1
  const frames = new Map<number, FrameRequestCallback>()
  const dom = await acquireDomHarness({
    url: 'http://localhost/chat',
    configureWindow(window) {
      globalThis.FileReader = window.FileReader
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        const id = nextFrameId++
        frames.set(id, callback)
        return id
      }
      window.cancelAnimationFrame = (id: number) => frames.delete(id)
      window.ResizeObserver = class ResizeObserver {
        private readonly record: { callback: ResizeObserverCallback; elements: Element[] }
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
          this.record = { callback, elements: [] }
          resizeObservers.push(this.record)
        }
        observe(element: Element) {
          observedElements.push(element)
          this.record.elements.push(element)
        }
        disconnect() {
          this.record.elements = []
        }
      }
    },
  })
  activeDom = dom
  const { window } = dom
  const { root } = dom.createRoot()
  const inject = (view: React.ReactElement) => ({
    ...view,
    props: {
      ...view.props,
      dependencies: { ...chatViewDependencies, ...view.props.dependencies },
    },
  })
  const render = async (view: React.ReactElement) => {
    await dom.act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat/agent-1?scope=all']}>
          <PermissionsProvider usePermissions={usePermissionsMock}>{inject(view)}</PermissionsProvider>
        </MemoryRouter>
      )
    })
  }

  await render(element)

  const transcript = window.document.querySelector('.flex-1.overflow-y-auto') as HTMLDivElement
  const metrics: ScrollMetrics = {
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 800,
    scrollWrites: 0,
    composerHeight: 100,
  }
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => metrics.scrollTop,
      set: (value: number) => {
        metrics.scrollWrites += 1
        metrics.scrollTop = Math.min(value, metrics.scrollHeight - metrics.clientHeight)
      },
    },
  })
  const installTextareaMetrics = () => {
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement | null
    const composer = textarea?.closest('form')?.parentElement?.parentElement
    if (composer) {
      Object.defineProperty(composer, 'offsetHeight', {
        configurable: true,
        get: () => metrics.composerHeight,
      })
    }
    if (textarea) {
      Object.defineProperty(textarea, 'scrollHeight', {
        configurable: true,
        get: () => {
          // Model the flex sibling growing while the live textarea is temporarily
          // measured at height:auto: the browser clamps the transcript away from bottom.
          metrics.scrollTop -= 12
          metrics.composerHeight = textarea.value.includes('\n') ? 120 : 100
          return 80
        },
      })
    }
    return textarea
  }
  const textarea = installTextareaMetrics()

  const flushFrames = async () => {
    const queued = [...frames.entries()]
    frames.clear()
    await dom.act(async () => {
      for (const [, callback] of queued) callback(performance.now())
    })
  }

  return {
    dom,
    window,
    transcript,
    textarea,
    metrics,
    render,
    flushFrames,
    fireComposerResize: () => resizeCallback?.([], {} as ResizeObserver),
    /** Delivers a resize to every live observer of `element`. */
    fireResize: async (element: Element) => {
      await dom.act(async () => {
        for (const observer of resizeObservers)
          if (observer.elements.includes(element)) observer.callback([], {} as ResizeObserver)
      })
    },
    pendingFrames: () => frames.size,
    observedComposerCount: () => observedElements.length,
    installTextareaMetrics,
  }
}

describe('ChatView composer bottom anchoring', () => {
  test('settles unchanged and row-transition textarea input at the true bottom synchronously', async () => {
    const harness = await renderChatViewWithControlledLayout(<ChatView items={[]} onSend={() => undefined} />)
    const { dom, window, textarea, metrics } = harness
    expect(textarea).not.toBeNull()
    await harness.flushFrames()

    await dom.act(async () => fireEvent.input(textarea!, { target: { value: 'already multiline a' } }))
    expect(metrics.scrollTop).toBe(800)

    metrics.clientHeight = 180
    await dom.act(async () => fireEvent.input(textarea!, { target: { value: 'already multiline a\n' } }))
    expect(metrics.scrollTop).toBe(820)

    const writesAtBottom = metrics.scrollWrites
    harness.fireComposerResize()
    expect(harness.pendingFrames()).toBe(0)
    expect(metrics.scrollWrites).toBe(writesAtBottom)
    expect(window.document.querySelector('button[title="Auto-scroll enabled"]')).not.toBeNull()
  })

  test.each([
    { name: 'manual follow-off mode', focusMessageId: undefined },
    { name: 'focused-message mode', focusMessageId: 'focused-message' },
  ])('preserves the reading position while typing in $name', async ({ focusMessageId }) => {
    const focusedMessage = humanMsg('focused-message', 'Read this message')
    const items: RenderItem[] = focusMessageId
      ? [
          {
            kind: 'persisted',
            id: focusedMessage.id,
            message: focusedMessage,
            mergedFrom: [focusedMessage],
            blocks: [],
          },
        ]
      : []
    const harness = await renderChatViewWithControlledLayout(
      <ChatView items={items} onSend={() => undefined} focusMessageId={focusMessageId} />
    )
    const { dom, window, textarea, transcript, metrics } = harness
    await harness.flushFrames()

    const enabled = window.document.querySelector('button[title="Auto-scroll enabled"]')
    if (enabled) {
      await dom.act(async () => enabled.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    }
    metrics.scrollTop = 500
    metrics.clientHeight = 180
    await dom.act(async () => fireEvent.input(textarea!, { target: { value: 'manual\nreading' } }))
    // Chromium may apply native anchoring after the input handler when the composer
    // really changes height. The observer must restore the pre-resize reading position.
    metrics.scrollTop = 820
    await dom.act(async () => fireEvent.scroll(transcript))
    harness.fireComposerResize()

    expect(metrics.scrollTop).toBe(500)
    expect(window.document.querySelector('button[title="Auto-scroll disabled"]')).not.toBeNull()
    expect(transcript.scrollTop).toBe(500)
  })

  test('keeps a pending manual correction through same-height input before observer delivery', async () => {
    const harness = await renderChatViewWithControlledLayout(<ChatView items={[]} onSend={() => undefined} />)
    const { dom, window, textarea, transcript, metrics } = harness
    await harness.flushFrames()
    await dom.act(async () =>
      window.document
        .querySelector('button[title="Auto-scroll enabled"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    )
    metrics.scrollTop = 500
    metrics.clientHeight = 180

    await dom.act(async () => fireEvent.input(textarea!, { target: { value: 'first row\nsecond row' } }))
    await dom.act(async () => fireEvent.input(textarea!, { target: { value: 'first row\nsecond row x' } }))
    metrics.scrollTop = 820
    await dom.act(async () => fireEvent.scroll(transcript))
    harness.fireComposerResize()

    expect(metrics.scrollTop).toBe(500)
    expect(window.document.querySelector('button[title="Auto-scroll disabled"]')).not.toBeNull()
  })

  test('observes a composer that becomes visible and restores late manual anchoring', async () => {
    const harness = await renderChatViewWithControlledLayout(
      <ChatView items={[]} onSend={() => undefined} hideComposer />
    )
    expect(harness.observedComposerCount()).toBe(0)

    await harness.render(<ChatView items={[]} onSend={() => undefined} />)
    const textarea = harness.installTextareaMetrics()
    expect(textarea).not.toBeNull()
    expect(harness.observedComposerCount()).toBe(1)
    await harness.dom.act(async () =>
      harness.window.document
        .querySelector('button[title="Auto-scroll enabled"]')
        ?.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }))
    )
    harness.metrics.scrollTop = 500
    harness.metrics.clientHeight = 180
    await harness.dom.act(async () => fireEvent.input(textarea!, { target: { value: 'first row\nsecond row' } }))
    harness.metrics.scrollTop = 820
    harness.fireComposerResize()

    expect(harness.metrics.scrollTop).toBe(500)
    expect(harness.window.document.querySelector('button[title="Auto-scroll disabled"]')).not.toBeNull()
  })

  test('disables follow when focused-message mode starts after mount', async () => {
    const focusedMessage = humanMsg('late-focus', 'Read this message')
    const items: RenderItem[] = [
      {
        kind: 'persisted',
        id: focusedMessage.id,
        message: focusedMessage,
        mergedFrom: [focusedMessage],
        blocks: [],
      },
    ]
    const harness = await renderChatViewWithControlledLayout(<ChatView items={items} onSend={() => undefined} />)
    await harness.flushFrames()

    await harness.render(<ChatView items={items} onSend={() => undefined} focusMessageId="late-focus" />)

    expect(harness.window.document.querySelector('button[title="Auto-scroll disabled"]')).not.toBeNull()
    harness.metrics.scrollTop = 500
    await harness.dom.act(async () =>
      fireEvent.input(harness.textarea!, { target: { value: 'keep focused\nwhile typing' } })
    )
    expect(harness.metrics.scrollTop).toBe(500)
  })

  test('does not run a queued follow after manual scroll-away', async () => {
    const first = humanMsg('first', 'first')
    const second = assistantMsg('second', 'second')
    const initialItems: RenderItem[] = [
      { kind: 'persisted', id: first.id, message: first, mergedFrom: [first], blocks: [] },
    ]
    const harness = await renderChatViewWithControlledLayout(<ChatView items={initialItems} onSend={() => undefined} />)
    const { dom, window, transcript, metrics } = harness
    await harness.flushFrames()
    metrics.scrollTop = 800

    await harness.render(
      <ChatView
        items={[
          ...initialItems,
          { kind: 'persisted', id: second.id, message: second, mergedFrom: [second], blocks: [] },
        ]}
        onSend={() => undefined}
      />
    )
    expect(harness.pendingFrames()).toBeGreaterThan(0)

    transcript.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true }))
    metrics.scrollTop = 500
    await dom.act(async () => fireEvent.scroll(transcript))
    expect(window.document.querySelector('button[title="Auto-scroll disabled"]')).not.toBeNull()

    await harness.flushFrames()
    expect(metrics.scrollTop).toBe(500)
  })
})

describe('ChatView beforeMessages', () => {
  const row = (message: Message): RenderItem => ({
    kind: 'persisted',
    id: message.id,
    message,
    mergedFrom: [message],
    blocks: [],
  })
  const archive = (
    <details data-testid="archive">
      <summary>Earlier conversation</summary>
      <p>Archived reply</p>
    </details>
  )

  test('starts the scrolling transcript, before the first message, once no older pages remain', async () => {
    const first = humanMsg('first', 'First live message')
    const { dom, root, window } = await renderChatView(
      <ChatView items={[row(first)]} onSend={() => undefined} beforeMessages={archive} />
    )
    const transcript = window.document.querySelector('[data-testid="chat-messages"]')!
    const details = transcript.querySelector('[data-testid="archive"]')
    expect(details).not.toBeNull()
    const message = transcript.querySelector('[data-message-id~="first"]')!
    expect(details!.compareDocumentPosition(message) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Older live pages come first chronologically: the archive waits until they have loaded.
    await dom.act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat/agent-1?scope=all']}>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ChatView
              items={[row(first)]}
              onSend={() => undefined}
              beforeMessages={archive}
              hasOlderMessages
              dependencies={chatViewDependencies}
            />
          </PermissionsProvider>
        </MemoryRouter>
      )
    })
    expect(window.document.querySelector('[data-testid="archive"]')).toBeNull()
    expect(window.document.body.textContent).toContain('Scroll up for older messages')
  })

  test('expanding it holds the reading position while messages arrive', async () => {
    const first = humanMsg('first', 'first')
    const reply = assistantMsg('reply', 'reply')
    const harness = await renderChatViewWithControlledLayout(
      <ChatView items={[row(first)]} onSend={() => undefined} beforeMessages={archive} />
    )
    const { window, metrics } = harness
    await harness.flushFrames()
    expect(metrics.scrollTop).toBe(800)
    const slot = window.document.querySelector('[data-testid="archive"]')!.parentElement!
    let slotHeight = 40
    Object.defineProperty(slot, 'offsetHeight', { configurable: true, get: () => slotHeight })
    await harness.fireResize(slot)
    expect(window.document.querySelector('button[title="Auto-scroll enabled"]')).not.toBeNull()

    // The reader opens the archive at the top: it grows downwards, pushing the latest message out of view.
    slotHeight = 400
    metrics.scrollHeight = 1360
    await harness.fireResize(slot)
    expect(metrics.scrollTop).toBe(800)
    expect(window.document.querySelector('button[title="Auto-scroll disabled"]')).not.toBeNull()

    // A reply arriving at the end neither follows nor shifts what they are reading.
    metrics.scrollHeight = 1460
    await harness.render(
      <ChatView items={[row(first), row(reply)]} onSend={() => undefined} beforeMessages={archive} />
    )
    await harness.flushFrames()
    expect(metrics.scrollTop).toBe(800)
  })

  test('a resize that keeps the end in view keeps following', async () => {
    const first = humanMsg('first', 'first')
    const harness = await renderChatViewWithControlledLayout(
      <ChatView items={[row(first)]} onSend={() => undefined} beforeMessages={archive} />
    )
    const { window, metrics } = harness
    await harness.flushFrames()
    const slot = window.document.querySelector('[data-testid="archive"]')!.parentElement!
    let slotHeight = 40
    Object.defineProperty(slot, 'offsetHeight', { configurable: true, get: () => slotHeight })
    await harness.fireResize(slot)
    slotHeight = 20
    metrics.scrollHeight = 980
    metrics.scrollTop = 780
    await harness.fireResize(slot)
    expect(window.document.querySelector('button[title="Auto-scroll enabled"]')).not.toBeNull()
  })
})

describe('ChatView scrolled-up position', () => {
  const row = (message: Message): RenderItem => ({
    kind: 'persisted',
    id: message.id,
    message,
    mergedFrom: [message],
    blocks: [],
  })

  async function scrolledUp(items: RenderItem[]) {
    const harness = await renderChatViewWithControlledLayout(<ChatView items={items} onSend={() => undefined} />)
    await harness.flushFrames()
    await harness.dom.act(async () =>
      harness.window.document
        .querySelector('button[title="Auto-scroll enabled"]')
        ?.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }))
    )
    // Record the measured layout as the baseline for the next change.
    await harness.render(<ChatView items={[...items]} onSend={() => undefined} />)
    harness.metrics.scrollTop = 300
    return harness
  }

  test('keeps the reading position when older messages are prepended', async () => {
    const first = humanMsg('first', 'first')
    const older = assistantMsg('older', 'older')
    const harness = await scrolledUp([row(first)])
    harness.metrics.scrollHeight = 1200
    await harness.render(<ChatView items={[row(older), row(first)]} onSend={() => undefined} />)
    expect(harness.metrics.scrollTop).toBe(500)
  })

  test('does not move when a message arrives at the end', async () => {
    const first = humanMsg('first', 'first')
    const reply = assistantMsg('reply', 'reply')
    const harness = await scrolledUp([row(first)])
    harness.metrics.scrollHeight = 1200
    await harness.render(<ChatView items={[row(first), row(reply)]} onSend={() => undefined} />)
    await harness.flushFrames()
    expect(harness.metrics.scrollTop).toBe(300)
  })
})

describe('agent delivery popup', () => {
  test('arrow focus does not commit; Enter changes mode exactly once without sending', async () => {
    const sends = mock(() => {})
    const changes = mock(() => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={sends}
        executionStatus="running"
        deliveryMode="steer"
        onDeliveryModeChange={changes}
      />
    )
    const trigger = window.document.querySelector<HTMLButtonElement>('button[aria-label="Message delivery"]')!
    expect(trigger).not.toBeNull()
    await dom.act(async () => trigger.click())
    await dom.act(flushReact)
    expect(window.document.activeElement?.getAttribute('aria-selected')).toBe('true')
    await dom.act(async () =>
      window.document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    )
    expect(changes).not.toHaveBeenCalled()
    expect(window.document.activeElement?.textContent).toContain('Follow up')
    await dom.act(async () =>
      window.document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    )
    expect(changes).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenCalledWith('follow-up')
    expect(sends).not.toHaveBeenCalled()
    expect(window.document.activeElement).toBe(trigger)
  })
  test('idle and separate user-assistant composers do not gain delivery modes', async () => {
    const { window } = await renderChatView(
      <ChatView
        items={[]}
        onSend={() => {}}
        deliveryMode="steer"
        onDeliveryModeChange={() => {}}
        executionStatus="completed"
      />
    )
    expect(window.document.querySelector('[aria-label="Message delivery"]')).toBeNull()
  })

  describe('hover', () => {
    async function renderDelivery() {
      const sends = mock(() => {})
      const changes = mock(() => {})
      const { dom, window } = await renderChatView(
        <ChatView
          items={[]}
          onSend={sends}
          executionStatus="running"
          deliveryMode="steer"
          onDeliveryModeChange={changes}
        />
      )
      const doc = window.document
      const group = doc.querySelector<HTMLElement>('.chat-composer-delivery')!
      const submit = group.querySelector<HTMLButtonElement>('button[type="submit"]')!
      const trigger = group.querySelector<HTMLButtonElement>('button[aria-label="Message delivery"]')!
      const composer = doc.querySelector<HTMLTextAreaElement>('textarea')!
      const list = () => doc.querySelector<HTMLElement>('[role="listbox"][data-state="open"]')
      const options = () => [...doc.querySelectorAll<HTMLButtonElement>('[data-state="open"] [role="option"]')]
      const wait = (ms: number) => dom.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
      /** A pointer arriving on (`over`, resting past the hover-open delay) or leaving (`out`) an element; React derives enter/leave from these. */
      const pointer = (target: Element, type: 'over' | 'out', pointerType = 'mouse') =>
        type === 'over'
          ? restPointerOn(target, pointerType)
          : dom.act(async () => {
              target.dispatchEvent(new window.PointerEvent(`pointer${type}`, { bubbles: true, pointerType }))
            })
      const click = (target: HTMLElement) => dom.act(async () => target.click())
      return { dom, doc, sends, changes, submit, trigger, composer, list, options, wait, pointer, click }
    }

    test('hovering the chevron opens it without taking focus; leaving closes it after a short delay', async () => {
      const { dom, doc, sends, trigger, composer, list, wait, pointer } = await renderDelivery()
      await dom.act(async () => composer.focus())
      await pointer(trigger, 'over')
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(list()).not.toBeNull()
      expect(doc.activeElement).toBe(composer)

      await pointer(trigger, 'out')
      expect(list()).not.toBeNull() // not yet: the pointer may be crossing the gap
      await wait(200)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(list()).toBeNull()
      expect(doc.activeElement).toBe(composer)
      expect(sends).not.toHaveBeenCalled()
    })

    test('hovering the send half never opens it', async () => {
      const { sends, changes, submit, trigger, wait, pointer } = await renderDelivery()
      await pointer(submit, 'over')
      await wait(200)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      await pointer(submit, 'out')
      expect(submit.textContent).toBe('Interrupt')
      expect(sends).not.toHaveBeenCalled()
      expect(changes).not.toHaveBeenCalled()
    })

    test('re-entering the list or the chevron cancels the close; picking a mode sets it and closes', async () => {
      const { sends, changes, trigger, list, options, wait, pointer, click } = await renderDelivery()
      await pointer(trigger, 'over')
      await pointer(trigger, 'out')
      await pointer(list()!, 'over')
      await wait(200)
      expect(list()).not.toBeNull()

      await pointer(list()!, 'out')
      await pointer(trigger, 'over')
      await wait(200)
      expect(list()).not.toBeNull()

      await pointer(trigger, 'out')
      await pointer(list()!, 'over')
      await click(options().find((option) => option.textContent?.includes('Follow up'))!)
      expect(changes).toHaveBeenCalledTimes(1)
      expect(changes).toHaveBeenCalledWith('follow-up')
      expect(sends).not.toHaveBeenCalled()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
    })

    test('a click on the chevron pins a hover-opened list and focuses the current mode', async () => {
      const { doc, trigger, list, options, wait, pointer, click } = await renderDelivery()
      await pointer(trigger, 'over')
      await click(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(doc.activeElement).toBe(options()[0]!)
      await pointer(trigger, 'out')
      await wait(200)
      expect(list()).not.toBeNull()
    })

    test('a click inside a hover-opened list, off the options, does not pin it', async () => {
      const { changes, trigger, list, wait, pointer, click } = await renderDelivery()
      await pointer(trigger, 'over')
      await pointer(trigger, 'out')
      await pointer(list()!, 'over')
      await click(list()!)
      expect(list()).not.toBeNull()
      await pointer(list()!, 'out')
      await wait(200)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(changes).not.toHaveBeenCalled()
    })

    test('touch and pen never open it on hover; a tap still does and stays open', async () => {
      const { trigger, list, wait, pointer, click } = await renderDelivery()
      await pointer(trigger, 'over', 'touch')
      await pointer(trigger, 'over', 'pen')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      await click(trigger)
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      await pointer(trigger, 'out', 'touch')
      await wait(200)
      expect(list()).not.toBeNull()
    })
  })
})

for (const embedded of [false, true]) {
  test(`header status stays above messages and outside composer (embedded=${embedded})`, async () => {
    const { dom, window } = await renderChatView(
      <ChatView
        agentId="a1"
        items={[]}
        onSend={() => {}}
        embedded={embedded}
        enableFullscreen
        header={<span data-testid="title">Agent</span>}
        headerStatus={<div data-testid="slot-row">Waiting for slot</div>}
      />
    )
    const row = window.document.querySelector('[data-testid="slot-row"]')!
    const title = window.document.querySelector('[data-testid="title"]')!
    expect(row).not.toBeNull()
    expect(title.compareDocumentPosition(row) & 4).toBe(4)
    expect(row.closest('form')).toBeNull()
    expect(row.parentElement?.className).not.toMatch(/absolute|fixed/)
    await dom.act(async () => {
      fireEvent.click(window.document.querySelector('[aria-label="Fullscreen"]')!)
    })
    const expandedRow = window.document.querySelector('[data-testid="slot-row"]')!
    expect(expandedRow.closest('[role="dialog"]')).not.toBeNull()
    expect(expandedRow.closest('form')).toBeNull()
    expect(expandedRow.parentElement?.className).not.toMatch(/absolute|fixed/)
  })
}

describe('ChatView persisted draft', () => {
  const storageKey = 'chat-draft:consultant-new:squad-1'

  /** Mounts a keyed composer in a fresh root, so a test can leave and come back in one DOM. */
  async function mountComposer(dom: Awaited<ReturnType<typeof installDom>>, onSend: () => unknown = () => undefined) {
    const { root, container } = dom.createRoot()
    await dom.act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat']}>
          <PermissionsProvider usePermissions={usePermissionsMock}>
            <ChatView
              items={[]}
              onSend={onSend}
              enableFullscreen={false}
              inputStorageKey="consultant-new:squad-1"
              dependencies={chatViewDependencies}
            />
          </PermissionsProvider>
        </MemoryRouter>
      )
    })
    await flushReact()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    return { textarea, unmount: () => dom.act(async () => root.unmount()) }
  }

  test('restores the saved draft when the composer mounts again', async () => {
    const dom = await installDom()
    dom.window.localStorage.setItem(storageKey, 'half-written question')
    const composer = await mountComposer(dom)
    expect(composer.textarea.value).toBe('half-written question')
    await composer.unmount()
  })

  test('leaving within the save debounce still keeps the typed draft', async () => {
    const dom = await installDom()
    dom.window.localStorage.removeItem(storageKey)
    const composer = await mountComposer(dom)
    await dom.act(async () => fireEvent.input(composer.textarea, { target: { value: 'keep me' } }))
    await composer.unmount()
    expect(dom.window.localStorage.getItem(storageKey)).toBe('keep me')
    const back = await mountComposer(dom)
    expect(back.textarea.value).toBe('keep me')
    await back.unmount()
  })

  test('a successful send removes the draft at once, even when the composer unmounts right after', async () => {
    const dom = await installDom()
    dom.window.localStorage.setItem(storageKey, 'first message')
    const onSend = mock(async () => {})
    const composer = await mountComposer(dom, onSend)
    expect(composer.textarea.value).toBe('first message')
    await dom.act(async () => fireEvent.submit(composer.textarea.closest('form')!))
    await flushReact()
    expect(onSend).toHaveBeenCalledTimes(1)
    // The new-consultant composer hands off to the created agent's chat and unmounts here.
    await composer.unmount()
    expect(dom.window.localStorage.getItem(storageKey)).toBeNull()
    const next = await mountComposer(dom)
    expect(next.textarea.value).toBe('')
    await next.unmount()
  })

  test('a failed send keeps the draft', async () => {
    const dom = await installDom()
    dom.window.localStorage.removeItem(storageKey)
    const composer = await mountComposer(dom, async () => {
      throw new Error('nope')
    })
    await dom.act(async () => fireEvent.input(composer.textarea, { target: { value: 'retry me' } }))
    await dom.act(async () => fireEvent.submit(composer.textarea.closest('form')!))
    await flushReact()
    await composer.unmount()
    expect(dom.window.localStorage.getItem(storageKey)).toBe('retry me')
  })
})

describe('ChatView composer draft', () => {
  test('a composer draft goes after any typed text, focused, and a new id adds it again', async () => {
    const view = (composerDraft?: { id: number; text: string }) => (
      <MemoryRouter initialEntries={['/chat/agent-1?scope=all']}>
        <PermissionsProvider usePermissions={usePermissionsMock}>
          <ChatView
            items={[]}
            onSend={() => undefined}
            enableFullscreen={false}
            composerDraft={composerDraft}
            dependencies={chatViewDependencies}
          />
        </PermissionsProvider>
      </MemoryRouter>
    )
    const { dom, root, window } = await renderChatView(
      <ChatView items={[]} onSend={() => undefined} enableFullscreen={false} />
    )
    const textarea = () => window.document.querySelector('textarea')!
    expect(textarea().value).toBe('')
    await dom.act(async () => root.render(view({ id: 1, text: 'Please move "Fix it" to Billing.' })))
    expect(textarea().value).toBe('Please move "Fix it" to Billing.')
    expect(window.document.activeElement).toBe(textarea())
    expect(textarea().selectionStart).toBe(textarea().value.length)
    // The same draft again is not added twice; a new one goes after it.
    await dom.act(async () => root.render(view({ id: 1, text: 'Please move "Fix it" to Billing.' })))
    await dom.act(async () => root.render(view({ id: 2, text: 'Please move "Docs" to Chlea.' })))
    expect(textarea().value).toBe('Please move "Fix it" to Billing.\n\nPlease move "Docs" to Chlea.')
  })
})

describe('ChatView queued message controls', () => {
  const queued = (overrides: Partial<Extract<RenderItem, { kind: 'pending' }>> = {}): RenderItem => ({
    kind: 'pending',
    id: 'first',
    messageId: 'first',
    content: 'Queued request',
    deliveryMode: 'follow-up',
    status: 'queued',
    queued: true,
    ...overrides,
  })
  const deliveryTrigger = (window: Window | Awaited<ReturnType<typeof installDom>>['window']) =>
    window.document.querySelector<HTMLButtonElement>('button[aria-label="Queued message delivery"]')
  const cancelButton = (window: Window | Awaited<ReturnType<typeof installDom>>['window']) =>
    window.document.querySelector<HTMLButtonElement>('button[aria-label="Cancel queued message"]')

  test('the delivery label opens on hover like the composer delivery menu', async () => {
    const { window } = await renderChatView(
      <ChatView items={[queued()]} onSend={() => {}} onUpdatePendingMessage={mock(async () => {})} />
    )
    await restPointerOn(deliveryTrigger(window)!)
    expect(window.document.querySelector('[role="option"]')).not.toBeNull()
  })

  test('the delivery label switches only this saved message to the chosen mode', async () => {
    const onUpdatePendingMessage = mock(async () => {})
    const { dom, window } = await renderChatView(
      <ChatView items={[queued()]} onSend={() => {}} onUpdatePendingMessage={onUpdatePendingMessage} />
    )
    expect(deliveryTrigger(window)?.textContent).toContain('Follow up')
    await dom.act(async () => deliveryTrigger(window)!.click())
    const option = (label: string) =>
      [...window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((row) =>
        row.textContent?.includes(label)
      )!
    // Re-choosing the current mode sends nothing.
    await dom.act(async () => option('Follow up').click())
    expect(onUpdatePendingMessage).not.toHaveBeenCalled()
    await dom.act(async () => deliveryTrigger(window)!.click())
    await dom.act(async () => option('Interrupt').click())
    expect(onUpdatePendingMessage).toHaveBeenCalledWith('first', 'steer')
  })

  test('canceling one message moves its text back to the composer', async () => {
    const onUpdatePendingMessage = mock(async () => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[queued({ content: 'Bring me back' })]}
        onSend={() => {}}
        onUpdatePendingMessage={onUpdatePendingMessage}
      />
    )
    await dom.act(async () => cancelButton(window)!.click())
    await flushReact()
    expect(onUpdatePendingMessage).toHaveBeenCalledWith('first', 'cancel')
    expect((window.document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Bring me back')
  })

  test('a rejected edit keeps the message and the composer unchanged and says why', async () => {
    const onUpdatePendingMessage = mock(async () => {
      throw new Error('This message is no longer waiting in the queue.')
    })
    const { dom, window } = await renderChatView(
      <ChatView items={[queued()]} onSend={() => {}} onUpdatePendingMessage={onUpdatePendingMessage} />
    )
    await dom.act(async () => cancelButton(window)!.click())
    await flushReact()
    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain('no longer waiting')
    expect(window.document.body.textContent).toContain('Queued request')
    expect((window.document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
  })

  test('controls stay disabled while an edit is in flight', async () => {
    const pending = deferred<void>()
    const onUpdatePendingMessage = mock(() => pending.promise)
    const { dom, window } = await renderChatView(
      <ChatView items={[queued()]} onSend={() => {}} onUpdatePendingMessage={onUpdatePendingMessage} />
    )
    await dom.act(async () => cancelButton(window)!.click())
    expect(cancelButton(window)!.disabled).toBe(true)
    expect(deliveryTrigger(window)!.disabled).toBe(true)
    await dom.act(async () => {
      pending.resolve()
      await pending.promise
    })
  })

  const sendNowButton = (window: Window | Awaited<ReturnType<typeof installDom>>['window']) =>
    [...window.document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      /^Send \d+ now$/.test(button.textContent ?? '')
    )

  test('Send now appears while running with queued interrupts, counting inbox ones, and calls the handler', async () => {
    const onSendQueuedNow = mock(async () => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[
          queued({ id: 'a', messageId: 'a', deliveryMode: 'steer' }),
          queued({ id: 'b', messageId: 'b', deliveryMode: 'steer', metadata: { source: 'inbox' } }),
          queued({ id: 'c', messageId: 'c', deliveryMode: 'follow-up' }),
        ]}
        onSend={() => {}}
        executionStatus="running"
        onSendQueuedNow={onSendQueuedNow}
      />
    )
    expect(sendNowButton(window)?.textContent).toBe('Send 2 now')
    await dom.act(async () => sendNowButton(window)!.click())
    expect(onSendQueuedNow).toHaveBeenCalledTimes(1)
  })

  test('Send now is hidden with only follow-ups queued', async () => {
    const { window } = await renderChatView(
      <ChatView
        items={[queued({ deliveryMode: 'follow-up' })]}
        onSend={() => {}}
        executionStatus="running"
        onSendQueuedNow={mock(async () => {})}
      />
    )
    expect(sendNowButton(window)).toBeUndefined()
  })

  test('Send now is hidden when the agent is not running', async () => {
    const { window } = await renderChatView(
      <ChatView
        items={[queued({ deliveryMode: 'steer' })]}
        onSend={() => {}}
        executionStatus="queued"
        onSendQueuedNow={mock(async () => {})}
      />
    )
    expect(sendNowButton(window)).toBeUndefined()
  })

  test('a failed Send now explains itself in the composer alert', async () => {
    const onSendQueuedNow = mock(async () => {
      throw new Error('The agent is still stopping.')
    })
    const { dom, window } = await renderChatView(
      <ChatView
        items={[queued({ deliveryMode: 'steer' })]}
        onSend={() => {}}
        executionStatus="running"
        onSendQueuedNow={onSendQueuedNow}
      />
    )
    await dom.act(async () => sendNowButton(window)!.click())
    await flushReact()
    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not send queued interrupts now: The agent is still stopping.'
    )
  })

  test('Clear pending messages counts only user-sent messages', async () => {
    const { window } = await renderChatView(
      <ChatView
        items={[
          queued({ id: 'a', messageId: 'a' }),
          queued({ id: 'b', messageId: 'b', metadata: { source: 'inbox' } }),
          queued({ id: 'c', messageId: 'c', metadata: { source: 'monitor' } }),
        ]}
        onSend={() => {}}
        isStreaming
        onCancelQueue={mock(async () => {})}
      />
    )
    expect(window.document.body.textContent).toContain('Clear 1 pending message')
  })

  test('unsaved sends and monitor deliveries keep a plain mode label without controls', async () => {
    const { window } = await renderChatView(
      <ChatView
        items={[
          queued({ id: 'client-1', messageId: undefined, content: 'Still sending' }),
          queued({
            id: 'monitor-1',
            messageId: 'monitor-1',
            content: 'Monitor event',
            metadata: { source: 'monitor' },
          }),
        ]}
        onSend={() => {}}
        onUpdatePendingMessage={mock(async () => {})}
      />
    )
    expect(window.document.body.textContent).toContain('Still sending')
    expect(window.document.querySelectorAll('button[aria-label="Queued message delivery"]')).toHaveLength(0)
    expect(window.document.querySelectorAll('button[aria-label="Cancel queued message"]')).toHaveLength(0)
  })

  test('a queued inbox delivery can switch mode from its pill but cannot be canceled', async () => {
    const onUpdatePendingMessage = mock(async () => {})
    const { dom, window } = await renderChatView(
      <ChatView
        items={[
          queued({
            id: 'inbox-1',
            messageId: 'inbox-1',
            content: 'From inbox',
            deliveryMode: 'follow-up',
            // The sender asked for an interrupt; the queue currently holds it as a follow-up.
            metadata: { source: 'inbox', inboxDeliveryMode: 'steer' },
          }),
        ]}
        onSend={() => {}}
        onUpdatePendingMessage={onUpdatePendingMessage}
      />
    )
    expect(cancelButton(window)).toBeNull()
    expect(deliveryTrigger(window)?.textContent).toContain('Follow up')
    await dom.act(async () => deliveryTrigger(window)!.click())
    const interrupt = [...window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((row) =>
      row.textContent?.includes('Interrupt')
    )!
    await dom.act(async () => interrupt.click())
    expect(onUpdatePendingMessage).toHaveBeenCalledWith('inbox-1', 'steer')
  })
})
