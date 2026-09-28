import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { InboxMessageResponse } from '../../../api/inbox'
import type { VoiceAssistantRuntime } from '../../useRealtimeVoiceAssistant'
import type { SiteOperatorAssistantState } from './siteOperatorTypes'
import { createHandleAgentWaitingInputEvent } from '../../agentInputAnnouncements'
import { createSiteOperatorAssistant } from './siteOperatorAssistant'
import { siteOperatorTools } from './siteOperatorTools'

const listSquads = mock(async () => [{ id: 'squad-1', name: 'Engineering', purpose: 'Build things', status: 'active' }])
const listSquadAgents = mock(async () => [
  { id: 'manager-agent-id', squadId: 'squad-1', agentTypeId: 'manager', status: 'idle' },
])
let agentFixture: any = { id: 'agent-id', agentTypeId: 'manager', squadId: 'squad-1', status: 'idle' }
const getHumanInbox = mock(async () => [] as InboxMessageResponse[])
const getAgent = mock(async () => agentFixture)
const markAsRead = mock(async () => undefined)

function createInboxMessage(id: string): InboxMessageResponse {
  return {
    id,
    recipientType: 'user',
    recipientId: 'user',
    senderType: 'system',
    senderId: null,
    subject: `Subject ${id}`,
    content: `Content ${id}`,
    metadata: {},
    readAt: null,
    deliveredAt: null,
    deliveryMode: 'follow-up',
    createdAt: '2026-04-30T00:00:00.000Z',
  }
}

function createRuntime(initialState: SiteOperatorAssistantState): VoiceAssistantRuntime<SiteOperatorAssistantState> {
  let state = initialState
  const queuedMessages: Array<Parameters<VoiceAssistantRuntime<SiteOperatorAssistantState>['enqueueMessage']>[0]> = []
  const runtime: VoiceAssistantRuntime<SiteOperatorAssistantState> = {
    getState: () => state,
    setState: (next) => {
      state = typeof next === 'function' ? next(state) : next
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
  return runtime
}

const { __siteOperatorAssistantTest, siteOperatorVoiceAssistant } = createSiteOperatorAssistant({
  listSquads: listSquads as any,
  listSquadAgents: listSquadAgents as any,
  getMyInbox: getHumanInbox as any,
  markAsRead: markAsRead as any,
  handleAgentWaitingInputEvent: createHandleAgentWaitingInputEvent(getAgent as any),
})

describe('siteOperatorVoiceAssistant', () => {
  beforeEach(() => {
    listSquads.mockClear()
    listSquadAgents.mockClear()
    agentFixture = { id: 'agent-id', agentTypeId: 'manager', squadId: 'squad-1', status: 'idle' }
    getHumanInbox.mockClear()
    getAgent.mockClear()
    markAsRead.mockClear()
  })

  test('uses existing realtime session configuration and site operator tool registry', async () => {
    const session = await siteOperatorVoiceAssistant.prepareSession({
      env: {
        currentPath: '/squads/squad-1?tab=home',
        getCurrentPath: () => '/squads/squad-1?tab=home',
        navigate: () => {},
        subscribe: () => () => {},
      },
      signal: new AbortController().signal,
    })

    expect(listSquads).toHaveBeenCalledWith()
    expect(listSquadAgents).toHaveBeenCalledWith('squad-1')
    expect(session.sessionConfig.model).toBe('gpt-realtime-2.1')
    expect(session.sessionConfig.audio?.output?.voice).toBe('cedar')
    expect(session.sessionConfig.audio?.input?.transcription?.model).toBe('gpt-realtime-whisper')
    expect(session.sessionConfig.audio?.input?.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'high',
      create_response: true,
      interrupt_response: true,
    })
    expect(session.sessionConfig.truncation).toEqual({ type: 'retention_ratio', retention_ratio: 0.8 })
    expect(session.sessionConfig.tools).toEqual(siteOperatorTools.definitions)
    expect(session.sessionConfig.instructions).toContain('**Engineering** (id: squad-1, manager: manager-agent-id)')
    expect(session.sessionConfig.instructions).toContain('Current squad manager ID: manager-agent-id')
    expect(session.sessionConfig.instructions).not.toContain('Current primary visible agent ID: manager-agent-id')
  })

  test('clears active inbox announcement when interrupted', () => {
    const active = createInboxMessage('active-message')
    const runtime = createRuntime({
      sessionContext: null,
      pathHistory: [],
      inboxQueue: [],
      activeInboxAnnouncement: active,
      spokenInboxIds: new Set([active.id]),
      spokenWaitingInputAgentIds: new Set(),
    })

    siteOperatorVoiceAssistant.onInterrupt?.(runtime, {
      currentPath: '/',
      getCurrentPath: () => '/',
      navigate: () => {},
      subscribe: () => () => {},
    })

    expect(runtime.getState().activeInboxAnnouncement).toBeNull()
    expect(markAsRead).not.toHaveBeenCalled()
  })

  test('waiting-input agent events enqueue a question announcement through the runtime queue', async () => {
    agentFixture = {
      id: 'agent-1',
      agentTypeId: 'engineer',
      squadId: 'squad-1',
      status: 'waiting-input',
      metadata: { name: 'Engineer' },
      questionData: {
        questions: [
          { id: 'q1', type: 'text', question: 'Which deployment target should I use?' },
          {
            id: 'q2',
            type: 'select',
            question: 'Risk level?',
            options: [{ value: 'low' }, { value: 'high', label: 'High risk' }],
          },
        ],
      },
    }
    const runtime = createRuntime({
      sessionContext: null,
      pathHistory: [],
      inboxQueue: [],
      activeInboxAnnouncement: null,
      spokenInboxIds: new Set(),
      spokenWaitingInputAgentIds: new Set(),
    })

    await __siteOperatorAssistantTest.handleAgentWaitingInputEvent(runtime, 'agent-1')

    expect(runtime.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    const prompt = (runtime.sendUserText as ReturnType<typeof mock>).mock.calls[0]?.[0]
    expect(prompt).toContain('Engineer needs your input')
    expect(prompt).toContain('Which deployment target should I use?')
    expect(prompt).toContain('High risk')
    expect(prompt).toContain('message_agent')
    expect(runtime.getState().spokenWaitingInputAgentIds.has('agent-1')).toBe(true)
  })

  test('inbox announcements enqueue through the runtime queue and mark read after speaking', async () => {
    const message = createInboxMessage('message-1')
    getHumanInbox.mockImplementationOnce(async () => [message])
    const runtime = createRuntime({
      sessionContext: null,
      pathHistory: [],
      inboxQueue: [],
      activeInboxAnnouncement: null,
      spokenInboxIds: new Set(),
      spokenWaitingInputAgentIds: new Set(),
    })

    await __siteOperatorAssistantTest.enqueueUnreadInboxAnnouncements(runtime, message.id)

    expect(runtime.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(runtime.sendUserText).toHaveBeenCalledTimes(1)
    expect(runtime.getState().activeInboxAnnouncement).toEqual(message)
    expect(runtime.getState().spokenInboxIds.has(message.id)).toBe(true)
    expect(runtime.markResponseActive).not.toHaveBeenCalled()
    expect(runtime.setMicEnabled).not.toHaveBeenCalled()

    const queued = (runtime.enqueueMessage as ReturnType<typeof mock>).mock.calls[0]?.[0]
    queued?.onDone?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markAsRead).toHaveBeenCalledWith(message.id)
    expect(runtime.getState().activeInboxAnnouncement).toBeNull()
  })

  test('inbox announcements mark read when queued speech is interrupted', async () => {
    const message = createInboxMessage('message-interrupted')
    getHumanInbox.mockImplementationOnce(async () => [message])
    const runtime = createRuntime({
      sessionContext: null,
      pathHistory: [],
      inboxQueue: [],
      activeInboxAnnouncement: null,
      spokenInboxIds: new Set(),
      spokenWaitingInputAgentIds: new Set(),
    })

    await __siteOperatorAssistantTest.enqueueUnreadInboxAnnouncements(runtime, message.id)

    const queued = (runtime.enqueueMessage as ReturnType<typeof mock>).mock.calls[0]?.[0]
    queued?.onCancel?.(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(markAsRead).toHaveBeenCalledWith(message.id)
    expect(runtime.getState().activeInboxAnnouncement).toBeNull()
  })
})

test('page conversations expose only scoped editor tools and delegation, without loading unrelated squads', async () => {
  const { assistantEditorInstructions, assistantEditorToolDefinitions } = await import('@ficus/shared')
  const { siteOperatorVoiceAssistant: controller } = createSiteOperatorAssistant({
    listSquads: listSquads as any,
    listSquadAgents: listSquadAgents as any,
    getMyInbox: getHumanInbox,
    markAsRead,
    handleAgentWaitingInputEvent: async () => {},
  })
  const prepare = mock(async () => {})
  const execute = mock(async () => ({ result: { revision: 3 }, followUp: 'auto' as const }))
  const delegateTask = mock(async () => ({ accepted: true }))
  const env = {
    delegateTask,
    currentPath: '/settings/workflows',
    getCurrentPath: () => '/settings/workflows',
    navigate() {},
    subscribe: () => () => {},
    pageEditor: { prepare, execute, instructions: assistantEditorInstructions, tools: assistantEditorToolDefinitions },
  }
  const calls = listSquads.mock.calls.length
  const session = await controller.prepareSession({ env, signal: new AbortController().signal })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(listSquads.mock.calls.length).toBe(calls)
  expect(session.sessionConfig.tools.map((tool) => tool.name)).toEqual(['read', 'edit', 'delegate'])
  const delegate = session.sessionConfig.tools.find((tool) => tool.name === 'delegate')!
  // Page-editor delegation is always the conversation's general helper: no squad target.
  expect(Object.keys((delegate as any).parameters.properties)).not.toContain('squadId')
  expect(session.sessionConfig.model).toBe('gpt-realtime-2.1')
  expect(session.sessionConfig.instructions).toContain(assistantEditorInstructions)
  await controller.executeTool({ name: 'read', toolArgs: {}, env, runtime: {} as any })
  expect(execute.mock.calls).toEqual([['read', {}]])
  await controller.executeTool({ name: 'edit', toolArgs: { baseRevision: 3 }, env, runtime: {} as any })
  expect(execute.mock.calls.at(-1)).toEqual(['edit', { baseRevision: 3 }])
  await controller.executeTool({
    name: 'delegate',
    toolArgs: { label: 'Review flow design', request: 'Design an independent review flow' },
    env,
    runtime: {} as any,
  })
  expect(delegateTask).toHaveBeenCalledWith('Design an independent review flow', {
    label: 'Review flow design',
    squadId: undefined,
    mode: 'steer',
    inReplyTo: undefined,
  })
  // The schema omits squadId, so a squad the model emits anyway must be dropped, not honoured.
  await controller.executeTool({
    name: 'delegate',
    toolArgs: { label: 'Review flow design', request: 'Design an independent review flow', squadId: 'tau' },
    env,
    runtime: {} as any,
  })
  expect(delegateTask).toHaveBeenCalledTimes(2)
  const forwarded = (delegateTask.mock.calls.at(-1) as any)?.[1]
  expect(forwarded.label).toBe('Review flow design')
  expect(forwarded.squadId).toBeUndefined()
  expect(execute.mock.calls).toHaveLength(2)
})
