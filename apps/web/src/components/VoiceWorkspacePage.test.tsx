import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../queryKeys'

let mockVoiceState: Record<string, unknown> = { activeCanvasId: null, canvases: [], displayedApps: [] }
let mockVoiceStatus = 'idle'
let mockIsMicMuted = false
let mockInputLevel = 0
let lastVoiceOptions: unknown
const updateInstructionsMock = mock(() => undefined)
const startUserSpeechMock = mock(() => undefined)

const useFixtureRealtimeVoiceAssistant = ((_controller: unknown, options: unknown) => {
  lastVoiceOptions = options
  return {
    status: mockVoiceStatus as any,
    history: [],
    error: null,
    connect: mock(async () => undefined),
    disconnect: mock(() => undefined),
    restartFresh: mock(async () => undefined),
    updateInstructions: updateInstructionsMock,
    interrupt: mock(() => undefined),
    toggleMicMuted: mock(() => undefined),
    startUserSpeech: startUserSpeechMock,
    submitUserSpeech: mock(() => undefined),
    isConnected: false,
    isMicMuted: mockIsMicMuted,
    inputLevel: mockInputLevel,
    rateLimitRetry: null,
    state: mockVoiceState,
  }
}) as unknown as typeof import('../voice/useRealtimeVoiceAssistant').useRealtimeVoiceAssistant

import {
  VoiceDebugInspector,
  VoiceWorkspacePage,
  scheduleVoiceDebugTranscriptScroll,
  supportsRealtimeVoice,
  type VoiceWorkspaceEnvironment,
  scrollVoiceDebugTranscriptToBottom,
} from './VoiceWorkspacePage'
const {
  getStoredVoiceInputMode,
  handleManualHoldKeyDown,
  handleManualHoldKeyUp,
  handleManualVoiceOrbPointerDown,
  handleManualVoiceOrbPointerUp,
  isManualHoldShortcutKey,
  isVoiceHoldShortcutEditableTarget,
  setStoredVoiceInputMode,
} = await import('./voiceWorkspaceInputMode')
const { buildWorkspaceDisplayInstructions } = await import('../voice/assistants/workspace/displayInstructions')
const { VoiceTranscriptInspector } = await import('../voice/VoiceTranscriptInspector')

const processWindow = globalThis.window
let storedVoiceInputMode: string | null = null
const storage = {
  getItem: mock(() => storedVoiceInputMode),
  setItem: mock((_key: string, value: string) => {
    storedVoiceInputMode = value
  }),
}
const voiceEnvironment: VoiceWorkspaceEnvironment = {
  mediaDevices: { getUserMedia: mock(async () => undefined) },
  isSecureContext: true,
  storage,
}

function renderWorkspacePage(queryClient = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <VoiceWorkspacePage environment={voiceEnvironment} useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant} />
    </QueryClientProvider>
  )
}

describe('VoiceTranscriptInspector', () => {
  test('renders tool call args and results when expanded', () => {
    const html = renderToStaticMarkup(
      <VoiceTranscriptInspector
        defaultToolExpanded
        history={[
          { role: 'user', text: 'Build a launch deck', final: true },
          {
            role: 'tool',
            text: 'Create artifact',
            final: true,
            toolName: 'request_artifact',
            toolCallId: 'call-1',
            toolArgs: JSON.stringify({ action: 'create', title: 'Launch deck' }, null, 2),
            toolResult: JSON.stringify({ agentId: 'agent-1', artifactId: 'artifact-1', status: 'requested' }, null, 2),
          },
        ]}
      />
    )

    expect(html).toContain('request_artifact')
    expect(html).toContain('Launch deck')
    expect(html).toContain('artifact-1')
  })
})

describe('voice workspace display instructions', () => {
  test('summarizes the currently displayed artifact for the voice model', () => {
    const instructions = buildWorkspaceDisplayInstructions(
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        title: 'Quarterly Plan',
        summary: 'Plan summary from index.',
        status: 'working',
        entry: { type: 'markdown', path: 'plan.md' },
        updatedAt: '2026-04-30T12:00:00.000Z',
      },
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        manifest: {
          id: 'artifact-1',
          title: 'Quarterly Plan Final',
          status: 'ready',
          summary: 'Final current summary.',
          entry: { type: 'presentation', path: 'presentation.json' },
          requests: [],
          publishes: [
            {
              at: '2026-04-30T12:25:00.000Z',
              entry: { type: 'presentation', path: 'presentation.json' },
              status: 'ready',
              changeSummary: 'Added final charts and recommendations.',
            },
          ],
          createdAt: '2026-04-30T11:00:00.000Z',
          updatedAt: '2026-04-30T12:30:00.000Z',
          archived: false,
        },
        content: '# Hidden from instructions',
      }
    )

    expect(instructions).toContain('Current Voice Workspace Display')
    expect(instructions).toContain('Title: Quarterly Plan Final')
    expect(instructions).toContain('Artifact ID: artifact-1')
    expect(instructions).toContain('Entry type: presentation')
    expect(instructions).toContain('Summary: Final current summary.')
    expect(instructions).toContain('Added final charts and recommendations.')
    expect(instructions).not.toContain('Hidden from instructions')
  })
})

describe('VoiceWorkspacePage artifacts', () => {
  beforeEach(() => {
    mockVoiceState = { activeCanvasId: null, canvases: [], displayedApps: [] }
    mockVoiceStatus = 'idle'
    mockIsMicMuted = false
    mockInputLevel = 0
    lastVoiceOptions = undefined
    updateInstructionsMock.mockClear()
    startUserSpeechMock.mockClear()
    storedVoiceInputMode = null
    storage.getItem.mockClear()
    storage.setItem.mockClear()
  })

  test('renders without replacing the process browser environment', () => {
    expect(globalThis.window).toBe(processWindow)

    const html = renderWorkspacePage()

    expect(html).toContain('Automatic')
    expect(lastVoiceOptions).toEqual({ autoConnect: true, autoReconnect: true, inputMode: 'automatic' })
    expect(globalThis.window).toBe(processWindow)
  })

  test.each([
    ['supported', voiceEnvironment, true],
    ['missing microphone', { ...voiceEnvironment, mediaDevices: undefined }, false],
    ['insecure context', { ...voiceEnvironment, isSecureContext: false }, false],
  ] as const)('%s environment reports %s', (_name, environment, expected) => {
    expect(supportsRealtimeVoice(environment)).toBe(expected)
  })

  test('renders automatic and manual voice mode controls', () => {
    const html = renderWorkspacePage()

    expect(html).toContain('Automatic')
    expect(html).toContain('Hold to speak')
    expect(html).toContain('aria-pressed="true"')
    expect(lastVoiceOptions).toEqual({ autoConnect: true, autoReconnect: true, inputMode: 'automatic' })
  })

  test('automatic listening orb no longer exposes pause microphone toggle', () => {
    mockVoiceStatus = 'listening'
    mockIsMicMuted = false

    const html = renderWorkspacePage()

    expect(html).toContain('aria-label="Voice workspace status: Listening"')
    expect(html).not.toContain('Pause workspace microphone')
  })

  test('reads and saves voice mode in local storage for future sessions', () => {
    const setItem = mock(() => undefined)

    expect(getStoredVoiceInputMode({ getItem: () => 'manual' })).toBe('manual')
    expect(getStoredVoiceInputMode({ getItem: () => 'automatic' })).toBe('automatic')
    expect(getStoredVoiceInputMode({ getItem: () => 'unknown' })).toBe('automatic')

    setStoredVoiceInputMode({ setItem }, 'manual')

    expect(setItem).toHaveBeenCalledWith('ficus_voice_workspace_input_mode', 'manual')
  })

  test('uses stored manual voice mode as the workspace default', () => {
    storedVoiceInputMode = 'manual'

    renderWorkspacePage()

    expect(lastVoiceOptions).toEqual({ autoConnect: true, autoReconnect: true, inputMode: 'manual' })
  })

  test('manual orb pointer down and up dispatch hold-to-speak callbacks', () => {
    const start = mock(() => undefined)
    const end = mock(() => undefined)
    const preventDefault = mock(() => undefined)
    const setPointerCapture = mock(() => undefined)

    expect(
      handleManualVoiceOrbPointerDown(
        { pointerId: 7, preventDefault, currentTarget: { setPointerCapture } },
        true,
        start
      )
    ).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(setPointerCapture).toHaveBeenCalledWith(7)

    expect(handleManualVoiceOrbPointerUp({ preventDefault }, true, end)).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
  })

  test('automatic listening orb does not dispatch manual hold callbacks', () => {
    const start = mock(() => undefined)
    const preventDefault = mock(() => undefined)
    const setPointerCapture = mock(() => undefined)

    expect(
      handleManualVoiceOrbPointerDown(
        { pointerId: 1, preventDefault, currentTarget: { setPointerCapture } },
        false,
        start
      )
    ).toBe(false)
    expect(start).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(setPointerCapture).not.toHaveBeenCalled()
  })

  test('spacebar hold shortcut dispatches start and end for non-editable targets', () => {
    const start = mock(() => undefined)
    const end = mock(() => undefined)
    const preventDefault = mock(() => undefined)

    expect(handleManualHoldKeyDown({ code: 'Space', target: { tagName: 'DIV' }, preventDefault }, false, start)).toBe(
      true
    )
    expect(handleManualHoldKeyUp({ code: 'Space', target: { tagName: 'DIV' }, preventDefault }, true, end)).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  test('spacebar hold shortcut accepts browser key fallbacks', () => {
    expect(isManualHoldShortcutKey({ code: 'Space' })).toBe(true)
    expect(isManualHoldShortcutKey({ key: ' ' })).toBe(true)
    expect(isManualHoldShortcutKey({ key: 'Spacebar' })).toBe(true)
    expect(isManualHoldShortcutKey({ code: 'Enter', key: 'Enter' })).toBe(false)
  })

  test('spacebar hold shortcut ignores editable and control targets', () => {
    expect(isVoiceHoldShortcutEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isVoiceHoldShortcutEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isVoiceHoldShortcutEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isVoiceHoldShortcutEditableTarget({ tagName: 'BUTTON' })).toBe(true)
    expect(isVoiceHoldShortcutEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isVoiceHoldShortcutEditableTarget({ tagName: 'DIV' })).toBe(false)

    const start = mock(() => undefined)
    const preventDefault = mock(() => undefined)
    expect(handleManualHoldKeyDown({ code: 'Space', target: { tagName: 'INPUT' }, preventDefault }, false, start)).toBe(
      false
    )
    expect(start).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  test('scrolls the debug transcript to the bottom when history changes', () => {
    const container = { scrollTop: 0, scrollHeight: 420 }

    scrollVoiceDebugTranscriptToBottom(container)

    expect(container.scrollTop).toBe(420)
  })

  test('schedules debug transcript scrolling after layout settles', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const frames: FrameRequestCallback[] = []
    const timeouts: TimerHandler[] = []
    const container = { scrollTop: 0, scrollHeight: 100 } as HTMLDivElement

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame
    globalThis.setTimeout = ((callback: TimerHandler) => {
      timeouts.push(callback)
      return timeouts.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout

    try {
      const cancel = scheduleVoiceDebugTranscriptScroll(container)
      expect(container.scrollTop).toBe(100)

      container.scrollHeight = 240
      frames[0]?.(0)
      expect(container.scrollTop).toBe(240)

      container.scrollHeight = 360
      if (typeof timeouts[0] === 'function') timeouts[0]([])
      expect(container.scrollTop).toBe(360)

      cancel()
      container.scrollHeight = 480
      frames[0]?.(0)
      expect(container.scrollTop).toBe(360)
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test('keeps the open debug menu within the mobile viewport instead of extending left off-screen', () => {
    const html = renderToStaticMarkup(
      <VoiceDebugInspector
        open
        status="idle"
        error={null}
        isConnected={false}
        isMicMuted={false}
        history={[]}
        onToggle={() => undefined}
      />
    )

    expect(html).toContain('inset-x-3')
    expect(html).toContain('max-w-[calc(100vw-1.5rem)]')
    expect(html).toContain('flex-wrap')
    expect(html).toContain('w-full')
    expect(html).toContain('min-w-0')
    expect(html).toContain('max-w-full')
    expect(html).toContain('sm:w-[min(26rem,calc(100vw-2rem))]')
  })

  test('renders the latest active artifact entry from the query cache instead of the ephemeral canvas', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.artifacts.list({ includeArchived: false }), [
      {
        agentId: 'agent-old',
        artifactId: 'artifact-old',
        title: 'Old artifact',
        status: 'ready',
        entry: { type: 'markdown', path: 'old.md' },
        updatedAt: '2026-04-29T12:00:00.000Z',
      },
      {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        title: 'Quarterly Plan',
        summary: 'Waiting for the builder to finish the polished version.',
        status: 'ready',
        entry: { type: 'markdown', path: 'plan.md' },
        updatedAt: '2026-04-30T12:00:00.000Z',
      },
    ])
    queryClient.setQueryData(queryKeys.artifacts.context('agent-1', 'artifact-1'), {
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      manifest: {
        id: 'artifact-1',
        title: 'Quarterly Plan',
        status: 'ready',
        summary: 'Waiting for the builder to finish the polished version.',
        entry: { type: 'markdown', path: 'plan.md' },
        requests: [],
        createdAt: '2026-04-30T11:00:00.000Z',
        updatedAt: '2026-04-30T12:00:00.000Z',
        archived: false,
      },
      content: '# Persistent artifact\n\nShown from storage.',
    })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('data-status="idle"')
    expect(html).not.toContain('Active artifact')
    expect(html).not.toContain('Quarterly Plan')
    expect(html).not.toContain('Ready')
    expect(html).toContain('<h1>Persistent artifact</h1>')
    expect(html).toContain('Shown from storage.')
    expect(html).not.toContain('No canvas yet')
    expect(html).not.toContain('Old artifact')
  })

  test('renders a specifically selected artifact instead of the latest artifact', () => {
    mockVoiceState = {
      activeCanvasId: null,
      canvases: [],
      displayedApps: [],
      activeArtifactDisplay: { mode: 'specific', agentId: 'agent-old', artifactId: 'artifact-old' },
    }
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.artifacts.list({ includeArchived: false }), [
      {
        agentId: 'agent-old',
        artifactId: 'artifact-old',
        title: 'Old artifact',
        status: 'ready',
        entry: { type: 'markdown', path: 'old.md' },
        updatedAt: '2026-04-29T12:00:00.000Z',
      },
      {
        agentId: 'agent-new',
        artifactId: 'artifact-new',
        title: 'New artifact',
        status: 'ready',
        entry: { type: 'markdown', path: 'new.md' },
        updatedAt: '2026-04-30T12:00:00.000Z',
      },
    ])
    queryClient.setQueryData(queryKeys.artifacts.context('agent-old', 'artifact-old'), {
      agentId: 'agent-old',
      artifactId: 'artifact-old',
      manifest: {
        id: 'artifact-old',
        title: 'Old artifact',
        status: 'ready',
        entry: { type: 'markdown', path: 'old.md' },
        requests: [],
        createdAt: '2026-04-29T11:00:00.000Z',
        updatedAt: '2026-04-29T12:00:00.000Z',
        archived: false,
      },
      content: '# Old artifact\n\nSelected by voice.',
    })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('<h1>Old artifact</h1>')
    expect(html).toContain('Selected by voice.')
    expect(html).not.toContain('New artifact')
  })

  test('renders presentation artifacts in the voice workspace without a fixed-height artifact entry', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.artifacts.list({ includeArchived: false }), [
      {
        agentId: 'agent-4',
        artifactId: 'artifact-4',
        title: 'Sequential deck',
        status: 'ready',
        entry: { type: 'presentation', path: 'presentation.json' },
        updatedAt: '2026-04-30T15:00:00.000Z',
      },
    ])
    queryClient.setQueryData(queryKeys.artifacts.context('agent-4', 'artifact-4'), {
      agentId: 'agent-4',
      artifactId: 'artifact-4',
      manifest: {
        id: 'artifact-4',
        title: 'Sequential deck',
        status: 'ready',
        entry: { type: 'presentation', path: 'presentation.json' },
        requests: [],
        createdAt: '2026-04-30T15:00:00.000Z',
        updatedAt: '2026-04-30T15:00:00.000Z',
        archived: false,
      },
      content: {
        schemaVersion: 1,
        title: 'Sequential deck',
        sections: [
          { id: 'first', blocks: [{ type: 'markdown', content: 'First voice section' }] },
          {
            id: 'second',
            blocks: [
              { type: 'markdown', content: 'Second voice section' },
              { type: 'html', content: '<div style="height: 720px">Auto-sized dashboard</div>' },
            ],
          },
        ],
      },
    })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('First voice section')
    expect(html).toContain('Second voice section')
    expect(html).toContain('Auto-sized dashboard')
    expect(html).toContain('ficus:presentation-html-height')
    expect(html).toContain('<div class="w-full" data-artifact-type="presentation"')
    expect(html).not.toContain('data-artifact-type="presentation"><article class="h-full')
    expect(html).not.toContain('<section class="h-full min-h-0">')
    expect(html).not.toContain('min-h-[360px]')
  })

  test('renders sandbox_app entries even though they do not include file content', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.artifacts.list({ includeArchived: false }), [
      {
        agentId: 'agent-3',
        artifactId: 'artifact-3',
        title: 'Interactive Sandbox',
        status: 'ready',
        entry: { type: 'sandbox_app', path: 'app' },
        updatedAt: '2026-04-30T14:00:00.000Z',
      },
    ])
    queryClient.setQueryData(queryKeys.artifacts.context('agent-3', 'artifact-3'), {
      agentId: 'agent-3',
      artifactId: 'artifact-3',
      manifest: {
        id: 'artifact-3',
        title: 'Interactive Sandbox',
        status: 'ready',
        entry: { type: 'sandbox_app', path: 'app' },
        requests: [],
        createdAt: '2026-04-30T14:00:00.000Z',
        updatedAt: '2026-04-30T14:00:00.000Z',
        archived: false,
      },
    })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).not.toContain('Interactive Sandbox')
    expect(html).toContain('Sandbox apps are not available yet.')
    expect(html).not.toContain('The preview is being prepared.')
  })

  test('uses the orb itself, not status dots, to show listening', () => {
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('voice-orb--listening .voice-orb__glow')
    expect(html).toContain('voice-orb-listening-glow')
    expect(html).toContain('.voice-orb-status {')
    expect(html).toContain('display: none;')
  })

  test('uses a stronger faster red orb for active user speech', () => {
    mockVoiceStatus = 'user-speaking'
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('voice-orb--user-speaking')
    expect(html).toContain('voice-orb-user-speaking-glow')
    expect(html).toContain('aria-label="End and submit speech"')
    expect(html).not.toContain('disabled=""')
  })

  test('uses a gray orb glow for paused microphone state', () => {
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('voice-orb--muted .voice-orb__glow')
    expect(html).toContain('voice-orb-muted-glow')
    expect(html).toContain('var(--voice-muted-primary)')
  })

  test('makes the orb clickable to interrupt while the assistant is speaking', () => {
    mockVoiceStatus = 'speaking'
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('aria-label="Interrupt assistant"')
    expect(html).not.toContain('disabled=""')
  })

  test('manual hold mode offers hold-to-speak while the assistant is speaking', () => {
    mockVoiceStatus = 'speaking'
    storedVoiceInputMode = 'manual'

    const html = renderWorkspacePage(new QueryClient())

    expect(html).toContain('aria-label="Hold to speak; release to submit"')
    expect(html).not.toContain('disabled=""')
  })

  test('feeds microphone input level into the orb style', () => {
    mockVoiceStatus = 'user-speaking'
    mockInputLevel = 0.42
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('--voice-input-level:0.42')
  })

  test('uses orb glows instead of dots for processing and speaking states', () => {
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('voice-orb--processing .voice-orb__glow')
    expect(html).toContain('voice-orb--speaking .voice-orb__glow')
    expect(html).toContain('.voice-orb-status {')
    expect(html).toContain('display: none;')
  })

  test('uses orange orb glow for rate limits and errors', () => {
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('voice-orb--warning .voice-orb__glow')
    expect(html).toContain('voice-orb--error .voice-orb__glow')
    expect(html).toContain('voice-orb-warning-glow')
    expect(html).toContain('.voice-orb-status {')
    expect(html).toContain('display: none;')
  })

  test('renders the voice orb as status-only because the workspace auto-connects', () => {
    const queryClient = new QueryClient()

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('<button')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-label="Voice workspace status: Starting voice workspace"')
    expect(html).not.toContain('Start voice workspace')
    expect(html).not.toContain('Disconnect voice')
  })

  test('shows a friendly in-progress placeholder when an artifact has no published entry yet', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.artifacts.list({ includeArchived: false }), [
      {
        agentId: 'agent-2',
        artifactId: 'artifact-2',
        title: 'Launch Storyboard',
        status: 'working',
        updatedAt: '2026-04-30T13:00:00.000Z',
      },
    ])
    queryClient.setQueryData(queryKeys.artifacts.context('agent-2', 'artifact-2'), {
      agentId: 'agent-2',
      artifactId: 'artifact-2',
      manifest: {
        id: 'artifact-2',
        title: 'Launch Storyboard',
        status: 'working',
        requests: [
          {
            at: '2026-04-30T13:00:00.000Z',
            from: 'voice',
            action: 'create',
            brief: 'Draft a launch storyboard.',
          },
        ],
        createdAt: '2026-04-30T13:00:00.000Z',
        updatedAt: '2026-04-30T13:00:00.000Z',
        archived: false,
      },
    })

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <VoiceWorkspacePage
          environment={voiceEnvironment}
          useRealtimeVoiceAssistant={useFixtureRealtimeVoiceAssistant}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('data-status="idle"')
    expect(html).not.toContain('Launch Storyboard')
    expect(html).not.toContain('In progress')
    expect(html).not.toContain('The assistant has asked a builder to create this')
    expect(html).not.toContain('Draft a launch storyboard.')
  })
})
