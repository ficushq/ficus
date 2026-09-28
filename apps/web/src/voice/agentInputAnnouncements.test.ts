import { describe, expect, mock, test } from 'bun:test'
import type { Agent } from '@ficus/shared'
import { createHandleAgentWaitingInputEvent } from './agentInputAnnouncements'
import type { VoiceAssistantRuntime } from './useRealtimeVoiceAssistant'

type TestState = { spokenWaitingInputAgentIds: string[] }

function waitingAgent(id: string): Agent {
  return {
    id,
    agentTypeId: 'engineer',
    squadId: 'squad-1',
    status: 'waiting-input',
    metadata: { name: `Engineer ${id}` },
    questionData: { questions: [{ id: 'q1', type: 'text', question: `Question for ${id}?` }] },
  } as Agent
}

function createRuntime(initialIds: string[] = []) {
  let state: TestState = { spokenWaitingInputAgentIds: initialIds }
  const announcements: string[] = []
  const runtime: VoiceAssistantRuntime<TestState> = {
    getState: () => state,
    setState: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
    updateInstructions: mock(() => {}),
    sendUserText: mock((text: string) => announcements.push(text)),
    requestResponse: mock(() => {}),
    enqueueMessage: mock((message) => {
      message.onStart?.(runtime)
      runtime.sendUserText(message.text)
    }),
    flushPendingMessages: mock(() => {}),
    setMicEnabled: mock(() => {}),
    isResponseActive: mock(() => false),
    markResponseActive: mock(() => {}),
  }
  return { runtime, announcements, getState: () => state }
}

describe('createHandleAgentWaitingInputEvent', () => {
  test('suppresses an identical event replay already spoken in this execution', async () => {
    const getAgent = mock(async (id: string) => waitingAgent(id))
    const handle = createHandleAgentWaitingInputEvent(getAgent as never)
    const { runtime, announcements, getState } = createRuntime()

    await handle(runtime, 'agent-1')
    expect(getState().spokenWaitingInputAgentIds).toEqual(['agent-1'])
    await handle(runtime, 'agent-1')

    expect(announcements).toHaveLength(1)
    expect(announcements[0]).toContain('Question for agent-1?')
  })

  test('suppresses concurrent identical events after fetching but announces distinct executions', async () => {
    let releaseFetch: ((agent: Agent) => void) | undefined
    const firstFetch = new Promise<Agent>((resolve) => {
      releaseFetch = resolve
    })
    const getAgent = mock((id: string) => (id === 'agent-1' ? firstFetch : Promise.resolve(waitingAgent(id))))
    const handle = createHandleAgentWaitingInputEvent(getAgent as never)
    const { runtime, announcements, getState } = createRuntime()

    const first = handle(runtime, 'agent-1')
    const replay = handle(runtime, 'agent-1')
    expect(getAgent).toHaveBeenCalledTimes(2)
    expect(getState().spokenWaitingInputAgentIds).toEqual([])
    releaseFetch?.(waitingAgent('agent-1'))
    await Promise.all([first, replay])
    await handle(runtime, 'agent-2')

    expect(announcements).toHaveLength(2)
    expect(announcements[0]).toContain('Question for agent-1?')
    expect(announcements[1]).toContain('Question for agent-2?')
    expect(getState().spokenWaitingInputAgentIds).toEqual(['agent-1', 'agent-2'])
  })

  test('announces the first eligible transition, suppresses its replay, and resets with new assistant state', async () => {
    let current = { ...waitingAgent('agent-1'), status: 'running' as const }
    const getAgent = mock(async () => current)
    const handle = createHandleAgentWaitingInputEvent(getAgent as never)
    const connected = createRuntime()

    await handle(connected.runtime, 'agent-1')
    expect(connected.announcements).toHaveLength(0)
    expect(connected.getState().spokenWaitingInputAgentIds).toEqual([])

    current = waitingAgent('agent-1')
    await handle(connected.runtime, 'agent-1')
    expect(connected.announcements).toHaveLength(1)
    expect(connected.getState().spokenWaitingInputAgentIds).toEqual(['agent-1'])

    current = { ...current, status: 'running' }
    await handle(connected.runtime, 'agent-1')
    current = waitingAgent('agent-1')
    await handle(connected.runtime, 'agent-1')
    expect(connected.announcements).toHaveLength(1)

    const reconnected = createRuntime()
    await handle(reconnected.runtime, 'agent-1')
    expect(reconnected.announcements).toHaveLength(1)
  })

  test('does not consume dedupe state for inactive or ineligible events', async () => {
    let current = { ...waitingAgent('agent-1'), status: 'running' as const }
    const getAgent = mock(async () => current)
    const handle = createHandleAgentWaitingInputEvent(getAgent as never)
    const { runtime, announcements, getState } = createRuntime()

    await handle(runtime, 'agent-1')
    // The agent must be fully ELIGIBLE here, otherwise "inactive" is
    // indistinguishable from "ineligible" and this case proves nothing about
    // the isActive guard — the status check would suppress it either way.
    current = waitingAgent('agent-1')
    const fetchesBefore = getAgent.mock.calls.length
    await handle(runtime, 'agent-1', () => false)
    expect(announcements).toHaveLength(0)
    // Suppressed before the fetch, not after it.
    expect(getAgent.mock.calls.length).toBe(fetchesBefore)
    expect(getState().spokenWaitingInputAgentIds).toEqual([])
    await handle(runtime, 'agent-1')

    expect(announcements).toHaveLength(1)
    expect(getState().spokenWaitingInputAgentIds).toEqual(['agent-1'])
  })

  test('abandons an eligible announcement when the assistant disconnects mid-fetch', async () => {
    let releaseFetch: ((agent: Agent) => void) | undefined
    const pending = new Promise<Agent>((resolve) => {
      releaseFetch = resolve
    })
    const getAgent = mock(() => pending)
    const handle = createHandleAgentWaitingInputEvent(getAgent as never)
    const { runtime, announcements, getState } = createRuntime()

    let active = true
    const inFlight = handle(runtime, 'agent-1', () => active)
    // Disconnect only AFTER the fetch is under way, so the pre-fetch guard
    // cannot be what suppresses this — only the post-fetch one can.
    active = false
    releaseFetch?.(waitingAgent('agent-1'))
    await inFlight

    expect(announcements).toHaveLength(0)
    expect(getState().spokenWaitingInputAgentIds).toEqual([])
  })

  test('does not announce a waiting agent that carries no questions', async () => {
    const getAgent = mock(async () => ({ ...waitingAgent('agent-1'), questionData: { questions: [] } }) as Agent)
    const handle = createHandleAgentWaitingInputEvent(getAgent as never)
    const { runtime, announcements, getState } = createRuntime()

    await handle(runtime, 'agent-1')

    expect(announcements).toHaveLength(0)
    expect(getState().spokenWaitingInputAgentIds).toEqual([])
  })
})

test('spoken waiting-input prompts include each question’s context', async () => {
  const { buildAgentWaitingInputPrompt } = await import('./agentInputAnnouncements')
  const agent = waitingAgent('a1')
  agent.questionData = {
    questions: [{ id: 'q1', type: 'text', question: 'Deploy now?', context: 'Tests passed on main.' }],
  }
  expect(buildAgentWaitingInputPrompt(agent)).toContain('1. Deploy now? Context: Tests passed on main.')
})
