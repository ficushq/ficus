import { PermissionsProvider } from '../hooks/usePermissions'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { useState } from 'react'
import { fireEvent } from '@testing-library/dom'
import type { RenderItem, StreamingContentBlock } from '@ficus/client-react'
import type { Message, MessageMetadata } from '@ficus/shared'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import type { ToolInlineActionModalProps } from './ToolInlineActionModal'
import type { AgentConversation } from './AgentConversationBody'
import { MemoryRouter } from 'react-router-dom'

const useImageSrcsFixture = () => ({})

const usePermissionsMock = () => ({ can: () => true, isLoading: false, isError: false, permissions: ['agents:write'] })

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
  test('right-aligns the clear pending button above the chat input', async () => {
    const pendingItems: RenderItem[] = [
      {
        kind: 'pending',
        id: 'pending-1',
        content: 'Queued prompt',
        status: 'queued',
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

    // The name "Me" should NOT appear as a sender label
    // (body still contains "me" in class names etc. but not as a standalone label text)
    const body = window.document.body.innerHTML
    // The span with sender name would contain the text in a specific span pattern
    // We check it doesn't contain the name as a sender label by checking the specific class
    expect(body).not.toContain('text-[11px] text-muted self-end mr-1 mb-0.5')
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
    expect(window.document.querySelector('select[aria-label="Message delivery"]')).not.toBeNull()
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
    const select = window.document.querySelector('select[aria-label="Message delivery"]') as HTMLSelectElement
    expect(select.value).toBe('steer')
    await dom.act(async () => fireEvent.change(select, { target: { value: 'follow-up' } }))
    expect(onDeliveryModeChange).toHaveBeenCalledWith('follow-up')
    expect(onSend).not.toHaveBeenCalled()
  })

  test('delivery is one split button: the send half names the mode, the chevron explains each choice', async () => {
    const onDeliveryModeChange = mock(() => {})
    const { window } = await renderChatView(
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
    const select = group.querySelector('select[aria-label="Message delivery"]') as HTMLSelectElement
    // Both halves live in one container that owns the shape and colour.
    expect(group.className).toContain('rounded-md')
    expect(group.className).toContain('bg-accent')
    expect(submit.textContent).toBe('Interrupt')
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Interrupt: send now',
      'Follow up: send after this turn',
    ])
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
    const event = new window.Event('drop', { bubbles: true, cancelable: true }) as Event & {
      dataTransfer: { files: File[] }
    }
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [new window.File(['x'], 'notes.txt', { type: 'text/plain' })] },
    })
    await dom.act(async () => form.dispatchEvent(event))
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
    const event = new window.Event('dragenter', { bubbles: true, cancelable: true })
    await dom.act(async () => form.dispatchEvent(event))
    await flushReact()
    const body = window.document.body.textContent ?? ''
    expect(body).toContain('Drop files here')
    expect(body).not.toContain('Drop images here')
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
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }
        observe(element: Element) {
          observedElements.push(element)
        }
        disconnect() {}
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
