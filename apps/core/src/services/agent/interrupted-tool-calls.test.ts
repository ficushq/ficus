import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { convertToLlm, SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import {
  answerInterruptedToolCalls,
  createInterruptedToolCallsExtension,
  findTrailingOrphanedToolCalls,
  interruptedToolCalls,
  interruptedToolResultText,
  interruptionNoticePending,
  recordInterruptedToolCalls,
  type HardInterruption,
} from './interrupted-tool-calls'

const model = anthropicProvider()
  .getModels()
  .find((candidate) => candidate.id === 'claude-opus-5-5')!

const T0 = Date.parse('2026-11-27T08:00:00.000Z')
const RECOVERED_AT = '2026-11-27T08:05:00.000Z'

function interruption(overrides: Partial<HardInterruption> = {}): HardInterruption {
  return {
    noticeId: 'notice-1',
    executionId: 'execution-1',
    cause: 'core_restart',
    recoveredAt: RECOVERED_AT,
    executionStartedAt: new Date(T0).toISOString(),
    ...overrides,
  }
}

const user = (text: string, timestamp = T0 + 1000): Message => ({ role: 'user', content: text, timestamp })

function callsMessage(
  calls: { id: string; name: string }[],
  options: { timestamp?: number; stopReason?: AssistantMessage['stopReason'] } = {}
): AssistantMessage {
  return {
    role: 'assistant',
    content: calls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: {} })),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? 'toolUse',
    timestamp: options.timestamp ?? T0 + 2000,
  }
}

const result = (toolCallId: string, toolName: string, text: string): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: T0 + 3000,
})

/** A session as a worker leaves it when Core dies mid tool call: the calls are saved, their results are not. */
function crashedSession(calls = [{ id: 'call-read', name: 'read' }]) {
  const session = SessionManager.inMemory()
  session.appendMessage(user('fix the build'))
  session.appendMessage(callsMessage(calls))
  return session
}

/** What the model receives: Ficus's context hook, then pi's conversion and pi-ai's transform. */
async function modelContext(session: SessionManager): Promise<Message[]> {
  const extension = createInterruptedToolCallsExtension()
  const [handler] = extension.handlers.get('context')!
  const messages = session.buildSessionContext().messages
  const hooked = (await handler!({ type: 'context', messages }, {
    sessionManager: session,
  } as unknown as ExtensionContext)) as { messages: AgentMessage[] } | undefined
  return transformMessages(convertToLlm(hooked?.messages ?? messages), model)
}

function resultTexts(messages: Message[]): Record<string, string> {
  return Object.fromEntries(
    messages
      .filter((message): message is ToolResultMessage => message.role === 'toolResult')
      .map((message) => [
        message.toolCallId,
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      ])
  )
}

describe('the message per class', () => {
  const recovered = { cause: 'core_restart' as const, recoveredAt: RECOVERED_AT }
  test('a safe tool is safe to run again', () => {
    expect(interruptedToolResultText({ toolName: 'read', replay: 'safe' }, recovered)).toBe(
      `The read call was interrupted by an unexpected Core restart before it returned a result (recovered at ${RECOVERED_AT}). No output was kept. read only reads, so it is safe to run again.`
    )
  })

  test('an idempotent tool is safe to repeat with the same arguments', () => {
    const text = interruptedToolResultText({ toolName: 'write', replay: 'idempotent' }, recovered)
    expect(text).toContain('interrupted by an unexpected Core restart')
    expect(text).toContain('Running it again with the same arguments leaves the same final state')
  })

  test('an unsafe tool may have partially run and needs inspection before a retry', () => {
    const text = interruptedToolResultText({ toolName: 'bash', replay: 'unsafe' }, recovered)
    expect(text).toContain('interrupted by an unexpected Core restart')
    expect(text).toContain('It may have partially run or completed. Inspect the current state before retrying')
    expect(text).not.toContain('safe to')
  })

  test('a lapsed lease does not claim a Core restart', () => {
    const text = interruptedToolResultText(
      { toolName: 'bash', replay: 'unsafe' },
      { cause: 'lease_lapsed', recoveredAt: RECOVERED_AT }
    )
    expect(text).toContain('interrupted by an unexpected stop of the Ficus worker running it')
    expect(text).not.toContain('Core restart')
  })
})

describe('orphan detection', () => {
  const window = { since: T0, until: Date.parse(RECOVERED_AT) }

  test('finds only the calls of the last assistant message that have no result', () => {
    const session = crashedSession([
      { id: 'call-done', name: 'read' },
      { id: 'call-cut', name: 'bash' },
    ])
    session.appendMessage(result('call-done', 'read', 'file contents'))
    expect(findTrailingOrphanedToolCalls(session.getBranch(), window)).toEqual([
      { toolCallId: 'call-cut', toolName: 'bash' },
    ])
  })

  test('an answered turn, a later user message, or a dropped turn has no orphans', () => {
    const answered = crashedSession()
    answered.appendMessage(result('call-read', 'read', 'ok'))
    expect(findTrailingOrphanedToolCalls(answered.getBranch(), window)).toEqual([])

    const continued = crashedSession()
    continued.appendMessage(user('something else', T0 + 4000))
    expect(findTrailingOrphanedToolCalls(continued.getBranch(), window)).toEqual([])

    for (const stopReason of ['aborted', 'error'] as const) {
      const dropped = SessionManager.inMemory()
      dropped.appendMessage(user('go'))
      dropped.appendMessage(callsMessage([{ id: 'call-read', name: 'read' }], { stopReason }))
      expect(findTrailingOrphanedToolCalls(dropped.getBranch(), window)).toEqual([])
    }
  })

  test('a call outside the interrupted run is not the interruption’s', () => {
    const earlier = SessionManager.inMemory()
    earlier.appendMessage(user('go', T0 - 60_000))
    earlier.appendMessage(callsMessage([{ id: 'call-old', name: 'read' }], { timestamp: T0 - 30_000 }))
    expect(findTrailingOrphanedToolCalls(earlier.getBranch(), window)).toEqual([])

    const later = SessionManager.inMemory()
    later.appendMessage(user('go'))
    later.appendMessage(callsMessage([{ id: 'call-new', name: 'read' }], { timestamp: window.until + 1000 }))
    expect(findTrailingOrphanedToolCalls(later.getBranch(), window)).toEqual([])
  })
})

describe('recording and answering cut-off calls', () => {
  test('records each cut-off call once per recovery notice, with its class', () => {
    const session = crashedSession([
      { id: 'call-read', name: 'read' },
      { id: 'call-write', name: 'write' },
      { id: 'call-bash', name: 'bash' },
      { id: 'call-extension', name: 'some_extension_tool' },
    ])
    const record = recordInterruptedToolCalls(session, interruption())
    expect(record.calls).toEqual([
      { toolCallId: 'call-read', toolName: 'read', replay: 'safe' },
      { toolCallId: 'call-write', toolName: 'write', replay: 'idempotent' },
      { toolCallId: 'call-bash', toolName: 'bash', replay: 'unsafe' },
      { toolCallId: 'call-extension', toolName: 'some_extension_tool', replay: 'unsafe' },
    ])
    const entries = session.getBranch().length
    expect(recordInterruptedToolCalls(session, interruption())).toEqual(record)
    expect(session.getBranch()).toHaveLength(entries)
    // A second interruption of the same run does not record the same call again.
    expect(recordInterruptedToolCalls(session, interruption({ noticeId: 'notice-2' })).calls).toEqual([])
  })

  test('the model sees the restart-aware result for each class, not "No result provided"', async () => {
    const session = crashedSession([
      { id: 'call-read', name: 'read' },
      { id: 'call-write', name: 'write' },
      { id: 'call-bash', name: 'bash' },
    ])
    recordInterruptedToolCalls(session, interruption())
    session.appendMessage(user('Continue.', T0 + 400_000))
    const context = await modelContext(session)
    const texts = resultTexts(context)
    expect(JSON.stringify(context)).not.toContain('No result provided')
    expect(texts['call-read']).toContain('read only reads, so it is safe to run again')
    expect(texts['call-write']).toContain('safe to repeat')
    expect(texts['call-bash']).toContain('It may have partially run or completed')
    // Results stay with their call: assistant, its three results, then the resumed prompt.
    expect(context.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'toolResult',
      'toolResult',
      'user',
    ])
    expect(context.filter((message) => message.role === 'toolResult').every((message) => message.isError)).toBe(true)
  })

  test('ordinary results and ordinary missing results are left alone', async () => {
    // Not recorded: pi-ai's own placeholder still applies.
    const unrecorded = crashedSession()
    unrecorded.appendMessage(user('Continue.', T0 + 400_000))
    expect(resultTexts(await modelContext(unrecorded))).toEqual({ 'call-read': 'No result provided' })

    // A real result that arrived wins over the record.
    const answered = crashedSession([
      { id: 'call-read', name: 'read' },
      { id: 'call-bash', name: 'bash' },
    ])
    answered.appendMessage(result('call-read', 'read', 'file contents'))
    recordInterruptedToolCalls(answered, interruption())
    answered.appendMessage(user('Continue.', T0 + 400_000))
    const texts = resultTexts(await modelContext(answered))
    expect(texts['call-read']).toBe('file contents')
    expect(texts['call-bash']).toContain('interrupted by an unexpected Core restart')
  })

  test('answering returns the same array when nothing is recorded', () => {
    const messages = crashedSession().buildSessionContext().messages
    expect(answerInterruptedToolCalls(messages, interruptedToolCalls([]))).toBe(messages)
  })

  test('the resumed prompt carries the notice until a prompt has been sent', () => {
    const session = crashedSession()
    expect(interruptionNoticePending(session, 'notice-1')).toBe(false)
    recordInterruptedToolCalls(session, interruption())
    expect(interruptionNoticePending(session, 'notice-1')).toBe(true)
    session.appendMessage(user('Continue.', T0 + 400_000))
    expect(interruptionNoticePending(session, 'notice-1')).toBe(false)
  })
})
