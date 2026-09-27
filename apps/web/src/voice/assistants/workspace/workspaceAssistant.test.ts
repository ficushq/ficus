import { describe, expect, mock, test } from 'bun:test'
import type { VoiceAssistantRuntime } from '../../useRealtimeVoiceAssistant'
import type { WorkspaceVoiceState } from './workspaceTypes'
import { createHandleAgentWaitingInputEvent } from '../../agentInputAnnouncements'
import { createWorkspaceAssistant } from './workspaceAssistant'
import { workspaceTools } from './workspaceTools'

let agentFixture: any = { id: 'agent-id', agentTypeId: 'manager', squadId: 'squad-1', status: 'idle' }
const getHumanInboxMock = mock(async () => [] as unknown[])
const getVoiceAssistantInboxMock = mock(async () => [] as unknown[])
const getAgentMock = mock(async () => agentFixture)
const markAsReadMock = mock(async () => {})
const listArtifactsMock = mock(async () => [] as unknown[])

const testWorkspaceTools = {
  ...workspaceTools,
  execute: (name: string, args: Record<string, unknown>, env: any) =>
    name === 'list_artifacts' ? listArtifactsMock(args) : workspaceTools.execute(name, args, env),
}
const { workspaceVoiceAssistant, __workspaceAssistantTest } = createWorkspaceAssistant({
  getMyInbox: getHumanInboxMock as any,
  getVoiceAssistantInbox: getVoiceAssistantInboxMock as any,
  markAsRead: markAsReadMock as any,
  prewarmArtifactBuilder: mock(async () => ({ agentId: 'agent-1', sandboxId: 'sandbox-1', reused: false })) as any,
  handleAgentWaitingInputEvent: createHandleAgentWaitingInputEvent(getAgentMock as any),
  tools: testWorkspaceTools as any,
  toolDefinitions: workspaceTools.definitions,
})

function createRuntime(stateOverrides: Partial<WorkspaceVoiceState> = {}) {
  let state: WorkspaceVoiceState = {
    canvases: [],
    activeCanvasId: null,
    displayedApps: [],
    spokenArtifactUpdateIds: [],
    spokenArtifactQuestionIds: [],
    spokenInboxIds: [],
    spokenWaitingInputAgentIds: [],
    activeArtifactDisplay: { mode: 'latest' },
    ...stateOverrides,
  }

  const queuedMessages: Array<Parameters<VoiceAssistantRuntime<WorkspaceVoiceState>['enqueueMessage']>[0]> = []

  const runtime: VoiceAssistantRuntime<WorkspaceVoiceState> = {
    getState: () => state,
    setState: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
    updateInstructions: mock(() => {}),
    sendUserText: mock(() => {}),
    requestResponse: mock(() => {}),
    enqueueMessage: mock((message) => {
      if (runtime.isResponseActive()) {
        queuedMessages.push(message)
        return
      }
      message.onStart?.(runtime)
      runtime.sendUserText(message.text)
      runtime.requestResponse()
    }),
    flushPendingMessages: mock(() => {
      if (runtime.isResponseActive()) return
      const message = queuedMessages.shift()
      if (!message) return
      message.onStart?.(runtime)
      runtime.sendUserText(message.text)
      runtime.requestResponse()
    }),
    setMicEnabled: mock(() => {}),
    isResponseActive: mock(() => false),
    markResponseActive: mock(() => {}),
  }

  return { runtime, getState: () => state }
}

function artifactQuestionMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    content: 'Artifact question',
    metadata: {
      requestType: 'artifact_question',
      artifactId: 'artifact-1',
      agentId: 'agent-1',
      questions: [
        {
          id: 'question-1',
          question: 'What tone should the launch page use?',
          responseMode: 'free_text',
        },
      ],
    },
    ...overrides,
  }
}

describe('workspaceVoiceAssistant', () => {
  test('uses workspace realtime defaults and tool registry without site context dependencies', async () => {
    const session = await workspaceVoiceAssistant.prepareSession({
      env: {
        getWorkspaceState: () => ({
          canvases: [],
          activeCanvasId: null,
          displayedApps: [],
          spokenArtifactUpdateIds: [],
          spokenArtifactQuestionIds: [],
          activeArtifactDisplay: { mode: 'latest' },
        }),
        setWorkspaceState: mock(() => {}),
        createId: () => 'test-id',
        now: () => '2026-04-30T00:00:00.000Z',
      },
      signal: new AbortController().signal,
    })

    expect(session.initialState).toEqual({
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
      spokenArtifactUpdateIds: [],
      spokenArtifactQuestionIds: [],
      spokenInboxIds: [],
      spokenWaitingInputAgentIds: [],
      activeArtifactDisplay: { mode: 'latest' },
    })
    expect(session.sessionConfig.model).toBe('gpt-realtime-2')
    expect(session.sessionConfig.audio?.output?.voice).toBe('cedar')
    expect(session.sessionConfig.audio?.input?.transcription?.model).toBe('gpt-realtime-whisper')
    expect(session.sessionConfig.audio?.input?.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'high',
      create_response: true,
      interrupt_response: true,
    })
    expect(session.sessionConfig.truncation).toEqual({ type: 'retention_ratio', retention_ratio: 0.8 })
    expect(session.sessionConfig.tools).toEqual(workspaceTools.definitions)
    expect(session.sessionConfig.instructions).toContain("Ficus's workspace voice assistant")
    expect(session.sessionConfig.instructions).toContain('Speak as Ficus, the whole workspace platform')
    expect(session.sessionConfig.instructions).toContain('say only “I’m working on it,”')
    expect(session.sessionConfig.instructions).toContain('request_artifact with action "ask"')
    expect(session.sessionConfig.instructions).toContain('Do not say you sent a request')
    expect(session.sessionConfig.instructions).toContain(
      'Do not expose artifact builders, squads, agents, inbox routing, queues, or tool mechanics'
    )
    expect(session.sessionConfig.instructions).toContain('Only respond to actual user requests')
    expect(session.sessionConfig.instructions).toContain('background noise')
  })

  test('announces readiness once when the workspace voice session connects', () => {
    const { runtime } = createRuntime()

    workspaceVoiceAssistant.onConnected?.(runtime, {} as any)
    workspaceVoiceAssistant.onConnected?.(runtime, {} as any)

    expect(runtime.markResponseActive).not.toHaveBeenCalled()
    expect(runtime.setMicEnabled).toHaveBeenCalledTimes(1)
    expect(runtime.setMicEnabled).toHaveBeenCalledWith(false)
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('How can I help?')
    expect(runtime.requestResponse).toHaveBeenCalledTimes(1)
  })

  test('executes artifact display tools against runtime-backed workspace state', async () => {
    let state: WorkspaceVoiceState = {
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
      spokenArtifactUpdateIds: [],
      spokenArtifactQuestionIds: [],
      activeArtifactDisplay: { mode: 'latest' },
    }

    const selectResult = await workspaceVoiceAssistant.executeTool({
      name: 'display_artifact',
      toolArgs: { agentId: 'agent-1', artifactId: 'artifact-1' },
      env: {
        getWorkspaceState: () => state,
        setWorkspaceState: (updater) => {
          state = typeof updater === 'function' ? updater(state) : updater
        },
      } as any,
      runtime: {
        getState: () => state,
        setState: (updater) => {
          state = typeof updater === 'function' ? updater(state) : updater
        },
        updateInstructions: mock(() => {}),
        sendUserText: mock(() => {}),
        requestResponse: mock(() => {}),
        setMicEnabled: mock(() => {}),
        isResponseActive: mock(() => false),
        markResponseActive: mock(() => {}),
      },
    })

    expect(selectResult.result).toEqual({
      ok: true,
      display: { mode: 'specific', agentId: 'agent-1', artifactId: 'artifact-1' },
    })
    expect(selectResult.followUp).toBe('auto')
    expect(state.activeArtifactDisplay).toEqual({ mode: 'specific', agentId: 'agent-1', artifactId: 'artifact-1' })

    const latestResult = await workspaceVoiceAssistant.executeTool({
      name: 'display_latest_artifact',
      toolArgs: {},
      env: {
        getWorkspaceState: () => state,
        setWorkspaceState: (updater) => {
          state = typeof updater === 'function' ? updater(state) : updater
        },
      } as any,
      runtime: {
        getState: () => state,
        setState: (updater) => {
          state = typeof updater === 'function' ? updater(state) : updater
        },
        updateInstructions: mock(() => {}),
        sendUserText: mock(() => {}),
        requestResponse: mock(() => {}),
        setMicEnabled: mock(() => {}),
        isResponseActive: mock(() => false),
        markResponseActive: mock(() => {}),
      },
    })

    expect(latestResult.result).toEqual({ ok: true, display: { mode: 'latest' } })
    expect(latestResult.followUp).toBe('auto')
    expect(state.activeArtifactDisplay).toEqual({ mode: 'latest' })
  })

  test('artifact display tools report when the requested display is already active', async () => {
    let state: WorkspaceVoiceState = {
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
      spokenArtifactUpdateIds: [],
      spokenArtifactQuestionIds: [],
      activeArtifactDisplay: { mode: 'specific', agentId: 'agent-1', artifactId: 'artifact-1' },
    }
    const env = {
      getWorkspaceState: () => state,
      setWorkspaceState: (updater: WorkspaceVoiceState | ((current: WorkspaceVoiceState) => WorkspaceVoiceState)) => {
        state = typeof updater === 'function' ? updater(state) : updater
      },
    } as any
    const runtime = {
      getState: () => state,
      setState: (updater: WorkspaceVoiceState | ((current: WorkspaceVoiceState) => WorkspaceVoiceState)) => {
        state = typeof updater === 'function' ? updater(state) : updater
      },
      updateInstructions: mock(() => {}),
      sendUserText: mock(() => {}),
      requestResponse: mock(() => {}),
      setMicEnabled: mock(() => {}),
      isResponseActive: mock(() => false),
      markResponseActive: mock(() => {}),
    }

    await expect(
      workspaceVoiceAssistant.executeTool({
        name: 'display_artifact',
        toolArgs: { agentId: 'agent-1', artifactId: 'artifact-1' },
        env,
        runtime,
      })
    ).rejects.toThrow('That artifact is already displayed.')
    expect(state.activeArtifactDisplay).toEqual({ mode: 'specific', agentId: 'agent-1', artifactId: 'artifact-1' })

    state = { ...state, activeArtifactDisplay: { mode: 'latest' } }
    await expect(
      workspaceVoiceAssistant.executeTool({
        name: 'display_latest_artifact',
        toolArgs: {},
        env,
        runtime,
      })
    ).rejects.toThrow('The latest artifact is already displayed.')
    expect(state.activeArtifactDisplay).toEqual({ mode: 'latest' })
  })

  test('workspace effects subscribe to inbox events and ask artifact questions aloud', async () => {
    const { runtime } = createRuntime()
    const handlers = new Map<string, (entry: any) => void>()
    const unsubscribeInbox = mock(() => {})
    const unsubscribeAgents = mock(() => {})
    const env = {
      getWorkspaceState: () => runtime.getState(),
      setWorkspaceState: mock(() => {}),
      subscribe: mock((topic: string, handler: (entry: any) => void) => {
        handlers.set(topic, handler)
        return topic === 'inbox' ? unsubscribeInbox : unsubscribeAgents
      }),
    }

    const cleanup = __workspaceAssistantTest.subscribeWorkspaceVoiceEvents(runtime, env as any)
    handlers.get('inbox')?.({
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
        message: artifactQuestionMessage(),
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(env.subscribe).toHaveBeenCalledWith('inbox', expect.any(Function))
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain(
      'What tone should the launch page use?'
    )

    cleanup()
    expect(unsubscribeInbox).toHaveBeenCalled()
    expect(unsubscribeAgents).toHaveBeenCalled()
  })

  test('artifact question inbox event with one free-text question sends a prompt asking it aloud', async () => {
    const { runtime, getState } = createRuntime()

    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
        message: artifactQuestionMessage(),
      },
    })

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect(runtime.requestResponse).toHaveBeenCalled()
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    const prompt = (runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string
    expect(prompt).toContain('artifact builder needs clarification')
    expect(prompt).toContain('ask these questions aloud')
    expect(prompt).toContain('What tone should the launch page use?')
    expect(prompt).toContain('agent_id: "agent-1"')
    expect(prompt).toContain('request_artifact')
    expect(prompt).toContain("action: 'continue'")
    expect(prompt).toContain('question-1')
    expect(getState().spokenArtifactQuestionIds).toEqual(['agent-1:artifact-1:question-1'])
  })

  test('batched artifact question event includes all questions, choices, and selection wording', async () => {
    const { runtime } = createRuntime()

    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-2',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
        message: artifactQuestionMessage({
          id: 'message-2',
          metadata: {
            requestType: 'artifact_question',
            artifactId: 'artifact-1',
            agentId: 'agent-1',
            questions: [
              {
                id: 'question-1',
                title: 'Audience',
                question: 'Who is the primary audience?',
                context: 'This changes examples and terminology.',
                responseMode: 'single_select',
                choices: ['Developers', 'Executives'],
              },
              {
                id: 'question-2',
                question: 'Which sections should be included?',
                responseMode: 'multi_select',
                choices: ['Pricing', 'FAQ', 'Security'],
              },
            ],
          },
        }),
      },
    })

    const prompt = (runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string
    expect(prompt).toContain('Audience')
    expect(prompt).toContain('Who is the primary audience?')
    expect(prompt).toContain('This changes examples and terminology.')
    expect(prompt).toContain('Developers')
    expect(prompt).toContain('Executives')
    expect(prompt).toContain('single-select means choose one')
    expect(prompt).toContain('Which sections should be included?')
    expect(prompt).toContain('Pricing')
    expect(prompt).toContain('FAQ')
    expect(prompt).toContain('Security')
    expect(prompt).toContain('multi-select means choose one or more')
  })

  test('duplicate artifact question batch is deduped via state', async () => {
    const { runtime, getState } = createRuntime()
    const entry = {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
        message: artifactQuestionMessage(),
      },
    }

    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, entry)
    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, entry)

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect(getState().spokenArtifactQuestionIds).toEqual(['agent-1:artifact-1:question-1'])
  })

  test('artifact question inbox event queues while response is active and asks after audio stops', async () => {
    const { runtime, getState } = createRuntime()
    let responseActive = true
    ;(runtime.isResponseActive as ReturnType<typeof mock>).mockImplementation(() => responseActive)

    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
        message: artifactQuestionMessage(),
      },
    })

    expect(runtime.sendUserText).not.toHaveBeenCalled()
    expect(runtime.requestResponse).not.toHaveBeenCalled()
    expect(runtime.markResponseActive).not.toHaveBeenCalled()
    expect(getState().spokenArtifactQuestionIds).toEqual([])

    responseActive = false
    workspaceVoiceAssistant.onOutputAudioStopped?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect(runtime.requestResponse).toHaveBeenCalledTimes(1)
    expect(getState().spokenArtifactQuestionIds).toEqual(['agent-1:artifact-1:question-1'])
  })

  test('artifact.updated events skip working publishes because they are incremental visual progress', async () => {
    const { runtime } = createRuntime()
    const handlers = new Map<string, (entry: any) => void>()
    const env = {
      getWorkspaceState: () => runtime.getState(),
      setWorkspaceState: mock(() => {}),
      subscribe: mock((topic: string, handler: (entry: any) => void) => {
        handlers.set(topic, handler)
        return mock(() => {})
      }),
    }

    __workspaceAssistantTest.subscribeWorkspaceVoiceEvents(runtime, env as any)
    handlers.get('agents')?.({
      event: 'artifact.updated',
      data: {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        title: 'Fresh dashboard',
        summary: 'The dashboard is being updated.',
        status: 'working',
        updatedAt: new Date().toISOString(),
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.sendUserText).not.toHaveBeenCalled()
    expect(runtime.requestResponse).not.toHaveBeenCalled()
  })

  test('artifact update announcements queue while response is active and announce after audio stops', async () => {
    const { runtime, getState } = createRuntime()
    let responseActive = true
    ;(runtime.isResponseActive as ReturnType<typeof mock>).mockImplementation(() => responseActive)
    const handlers = new Map<string, (entry: any) => void>()
    const env = {
      getWorkspaceState: () => runtime.getState(),
      setWorkspaceState: mock(() => {}),
      subscribe: mock((topic: string, handler: (entry: any) => void) => {
        handlers.set(topic, handler)
        return mock(() => {})
      }),
    }

    __workspaceAssistantTest.subscribeWorkspaceVoiceEvents(runtime, env as any)
    handlers.get('agents')?.({
      event: 'artifact.updated',
      data: {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        title: 'Fresh dashboard',
        summary: 'The dashboard is ready.',
        status: 'ready',
        updatedAt: new Date().toISOString(),
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listArtifactsMock).not.toHaveBeenCalled()
    expect(runtime.sendUserText).not.toHaveBeenCalled()

    responseActive = false
    workspaceVoiceAssistant.onOutputAudioStopped?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('Fresh dashboard')
    expect(getState().spokenArtifactUpdateIds).toHaveLength(1)
  })

  test('artifact.updated events announce directly without refetch timing heuristics', async () => {
    listArtifactsMock.mockClear()
    const { runtime, getState } = createRuntime()
    const handlers = new Map<string, (entry: any) => void>()
    const env = {
      getWorkspaceState: () => runtime.getState(),
      setWorkspaceState: mock(() => {}),
      subscribe: mock((topic: string, handler: (entry: any) => void) => {
        handlers.set(topic, handler)
        return mock(() => {})
      }),
    }

    __workspaceAssistantTest.subscribeWorkspaceVoiceEvents(runtime, env as any)
    handlers.get('agents')?.({
      event: 'artifact.updated',
      data: {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        title: 'Blue dashboard',
        summary: 'The dashboard background is now blue.',
        status: 'ready',
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listArtifactsMock).not.toHaveBeenCalled()
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('Blue dashboard')
    expect(getState().spokenArtifactUpdateIds).toEqual(['agent-1:artifact-1:2020-01-01T00:00:00.000Z'])
  })

  test('artifact update announcements do not repeat the same update even if state is overwritten', async () => {
    const updatedAt = new Date().toISOString()
    const { runtime, getState } = createRuntime()
    const handlers = new Map<string, (entry: any) => void>()
    const env = {
      getWorkspaceState: () => runtime.getState(),
      setWorkspaceState: mock(() => {}),
      subscribe: mock((topic: string, handler: (entry: any) => void) => {
        handlers.set(topic, handler)
        return mock(() => {})
      }),
    }

    const event = {
      event: 'artifact.updated',
      data: {
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        title: 'Fresh dashboard',
        summary: 'The dashboard is ready.',
        status: 'ready',
        updatedAt,
      },
    }

    __workspaceAssistantTest.subscribeWorkspaceVoiceEvents(runtime, env as any)
    handlers.get('agents')?.(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)

    runtime.setState({ ...getState(), spokenArtifactUpdateIds: [] })
    ;(runtime.isResponseActive as ReturnType<typeof mock>).mockImplementation(() => false)
    handlers.get('agents')?.(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
  })

  test('agent.updated events are ignored for artifact announcements', async () => {
    const { runtime } = createRuntime()
    const handlers = new Map<string, (entry: any) => void>()
    const env = {
      getWorkspaceState: () => runtime.getState(),
      setWorkspaceState: mock(() => {}),
      subscribe: mock((topic: string, handler: (entry: any) => void) => {
        handlers.set(topic, handler)
        return mock(() => {})
      }),
    }

    __workspaceAssistantTest.subscribeWorkspaceVoiceEvents(runtime, env as any)
    handlers.get('agents')?.({ event: 'agent.updated', data: { agentId: 'agent-1' } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.sendUserText).not.toHaveBeenCalled()
    expect(listArtifactsMock).not.toHaveBeenCalled()
  })

  test('waiting-input agent events enqueue a question announcement through the workspace runtime queue', async () => {
    agentFixture = {
      id: 'agent-1',
      agentTypeId: 'engineer',
      squadId: 'squad-1',
      status: 'waiting-input',
      metadata: { name: 'Engineer' },
      questionData: {
        questions: [{ id: 'q1', type: 'text', question: 'Which deployment target should I use?' }],
      },
    }
    const { runtime, getState } = createRuntime()

    await __workspaceAssistantTest.handleAgentWaitingInputEvent(runtime, 'agent-1')

    expect(runtime.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    const prompt = (runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]
    expect(prompt).toContain('Engineer needs your input')
    expect(prompt).toContain('Which deployment target should I use?')
    expect(prompt).toContain('message_agent')
    expect(getState().spokenWaitingInputAgentIds).toEqual(['agent-1'])
  })

  test('workspace voice startup drains unread voice inbox responses missed while disconnected', async () => {
    const message = {
      id: 'voice-inbox-missed',
      content: 'This response arrived while voice was reconnecting.',
      subject: 'Missed response',
      senderType: 'agent',
      senderId: 'agent-1',
      recipientType: 'voice_assistant',
      recipientId: 'workspace:voiceuser',
      readAt: null,
      createdAt: '2026-05-03T00:00:00.000Z',
      deliveredAt: null,
      metadata: { kind: 'voice_response' },
    }
    getVoiceAssistantInboxMock.mockImplementationOnce(async () => [message])
    const { runtime, getState } = createRuntime()

    await __workspaceAssistantTest.enqueueUnreadWorkspaceVoiceInboxResponses(runtime)

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('Missed response')
    expect(getState().spokenInboxIds).toEqual(['voice-inbox-missed'])
  })

  test('workspace voice inbox responses use the runtime queue and mark messages read after speaking', async () => {
    const message = {
      id: 'voice-inbox-1',
      content: 'The risk score combines launch impact and blocker severity.',
      subject: 'Risk score explanation',
      senderType: 'agent',
      senderId: 'agent-1',
      senderAgent: { id: 'agent-1', agentTypeId: 'artifact-builder-default' },
      recipientType: 'voice_assistant',
      recipientId: 'workspace:voiceuser',
      readAt: null,
      createdAt: '2026-05-03T00:00:00.000Z',
      deliveredAt: null,
      metadata: { kind: 'voice_response', artifactId: 'artifact-1' },
    }
    getVoiceAssistantInboxMock.mockImplementationOnce(async () => [message])
    const { runtime, getState } = createRuntime()

    await __workspaceAssistantTest.handleWorkspaceVoiceInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'voice-inbox-1',
        recipientType: 'voice_assistant',
        recipientId: 'workspace:voiceuser',
        senderAgentId: 'agent-1',
      },
    })

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('Risk score explanation')
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('blocker severity')
    expect(getState().spokenInboxIds).toEqual(['voice-inbox-1'])

    const queued = (runtime.enqueueMessage as ReturnType<typeof mock>).mock.calls[0]?.[0]
    queued?.onDone?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markAsReadMock).toHaveBeenCalledWith('voice-inbox-1')
  })

  test('workspace voice inbox responses mark messages read when interrupted', async () => {
    const message = {
      id: 'voice-inbox-interrupted',
      content: 'Interrupted response.',
      subject: 'Interrupted',
      senderType: 'agent',
      senderId: 'agent-1',
      recipientType: 'voice_assistant',
      recipientId: 'workspace:voiceuser',
      readAt: null,
      createdAt: '2026-05-03T00:00:00.000Z',
      deliveredAt: null,
      metadata: { kind: 'voice_response' },
    }
    getVoiceAssistantInboxMock.mockImplementationOnce(async () => [message])
    const { runtime } = createRuntime()

    await __workspaceAssistantTest.handleWorkspaceVoiceInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: { messageId: message.id, recipientType: 'voice_assistant', recipientId: 'workspace:voiceuser' },
    })

    const queued = (runtime.enqueueMessage as ReturnType<typeof mock>).mock.calls[0]?.[0]
    queued?.onCancel?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markAsReadMock).toHaveBeenCalledWith(message.id)
  })

  test('workspace inbox announcements use the runtime queue and mark messages read after speaking', async () => {
    const message = {
      id: 'inbox-1',
      content: 'The report is finished.',
      subject: 'Report finished',
      senderType: 'agent',
      senderId: 'agent-1',
      senderAgent: { id: 'agent-1', agentTypeId: 'artifact-builder-default' },
      recipientType: 'user',
      recipientId: 'user',
      readAt: null,
      createdAt: '2026-05-03T00:00:00.000Z',
      deliveredAt: null,
      metadata: {},
    }
    getHumanInboxMock.mockImplementationOnce(async () => [message])
    const { runtime, getState } = createRuntime()

    await __workspaceAssistantTest.handleWorkspaceInboxAnnouncementEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'inbox-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
      },
    })

    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect((runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain('The report is finished.')
    expect(getState().spokenInboxIds).toEqual(['inbox-1'])

    const queued = (runtime.enqueueMessage as ReturnType<typeof mock>).mock.calls[0]?.[0]
    queued?.onDone?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markAsReadMock).toHaveBeenCalledWith('inbox-1')
  })

  test('workspace inbox announcements mark messages read when interrupted', async () => {
    const message = {
      id: 'inbox-interrupted',
      content: 'Interrupted report.',
      subject: 'Interrupted report',
      senderType: 'agent',
      senderId: 'agent-1',
      recipientType: 'user',
      recipientId: 'user',
      readAt: null,
      createdAt: '2026-05-03T00:00:00.000Z',
      deliveredAt: null,
      metadata: {},
    }
    getHumanInboxMock.mockImplementationOnce(async () => [message])
    const { runtime } = createRuntime()

    await __workspaceAssistantTest.handleWorkspaceInboxAnnouncementEvent(runtime, {
      event: 'inbox.messageReceived',
      data: { messageId: message.id, recipientType: 'user', recipientId: 'user' },
    })

    const queued = (runtime.enqueueMessage as ReturnType<typeof mock>).mock.calls[0]?.[0]
    queued?.onCancel?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markAsReadMock).toHaveBeenCalledWith(message.id)
  })

  test('artifact question inbox event fetches message content when websocket only provides message id', async () => {
    getHumanInboxMock.mockImplementationOnce(async () => [artifactQuestionMessage()])
    const { runtime } = createRuntime()

    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
      },
    })

    expect(getHumanInboxMock).toHaveBeenCalledWith(true)
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
  })

  test('artifact question inbox event does not mark questions spoken after unsubscribe during inbox fetch', async () => {
    let resolveInbox: ((messages: unknown[]) => void) | undefined
    getHumanInboxMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInbox = resolve
        })
    )
    const { runtime, getState } = createRuntime()
    let active = true
    const pending = __workspaceAssistantTest.handleArtifactQuestionInboxEvent(
      runtime,
      {
        event: 'inbox.messageReceived',
        data: {
          messageId: 'message-1',
          recipientType: 'user',
          recipientId: 'user',
          senderAgentId: 'agent-1',
        },
      },
      () => active
    )

    active = false
    resolveInbox?.([artifactQuestionMessage()])
    await pending

    expect(runtime.sendUserText).not.toHaveBeenCalled()
    expect(runtime.markResponseActive).not.toHaveBeenCalled()
    expect(getState().spokenArtifactQuestionIds).toEqual([])
  })

  test('malformed artifact question batches are ignored rather than partially asked', async () => {
    const { runtime, getState } = createRuntime()
    await __workspaceAssistantTest.handleArtifactQuestionInboxEvent(runtime, {
      event: 'inbox.messageReceived',
      data: {
        messageId: 'message-1',
        recipientType: 'user',
        recipientId: 'user',
        senderAgentId: 'agent-1',
        message: artifactQuestionMessage({
          metadata: {
            requestType: 'artifact_question',
            artifactId: 'artifact-1',
            agentId: 'agent-1',
            questions: [
              { id: 'question-1', question: 'Valid?', responseMode: 'free_text' },
              { id: 'question-2', question: 'Missing response mode' },
            ],
          },
        }),
      },
    })

    expect(runtime.sendUserText).not.toHaveBeenCalled()
    expect(getState().spokenArtifactQuestionIds).toEqual([])
  })

  test('executes workspace tools against runtime-backed workspace state', async () => {
    let state: WorkspaceVoiceState = {
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
      spokenArtifactUpdateIds: [],
    }

    const result = await workspaceVoiceAssistant.executeTool({
      name: 'create_canvas',
      toolArgs: { title: 'Plan', kind: 'plan', content: 'First draft' },
      env: {
        getWorkspaceState: () => state,
        setWorkspaceState: (updater) => {
          state = typeof updater === 'function' ? updater(state) : updater
        },
        createId: () => 'canvas-1',
        now: () => '2026-04-30T00:00:00.000Z',
      },
      runtime: {
        getState: () => state,
        setState: (updater) => {
          state = typeof updater === 'function' ? updater(state) : updater
        },
        updateInstructions: mock(() => {}),
        sendUserText: mock(() => {}),
        requestResponse: mock(() => {}),
        setMicEnabled: mock(() => {}),
        isResponseActive: mock(() => false),
        markResponseActive: mock(() => {}),
      },
    })

    expect(result.result).toEqual({ ok: true, canvasId: 'canvas-1' })
    expect(state.activeCanvasId).toBe('canvas-1')
    expect(state.canvases).toEqual([
      { id: 'canvas-1', title: 'Plan', kind: 'plan', content: 'First draft', updatedAt: '2026-04-30T00:00:00.000Z' },
    ])
  })
})
