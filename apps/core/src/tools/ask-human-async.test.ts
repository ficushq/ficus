import { describe, expect, mock, test } from 'bun:test'
import type { AgentQuestion } from '@ficus/shared'
import { createAsyncAskHumanTool } from './ask-human-async'

const record: AgentQuestion = {
  id: 'question-12345678',
  agentId: 'agent-1',
  squadId: 'squad-1',
  ownerUserId: null,
  executionId: null,
  audienceResolution: null,
  questionData: { questions: [] },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: new Date(0).toISOString(),
  answeredAt: null,
}

async function executeWith(openedWaitWorkStreamIds: string[]) {
  const createQuestion = mock(async () => ({ ...record, openedWaitWorkStreamIds }))
  const tool = createAsyncAskHumanTool(
    { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
    { createQuestion }
  )
  const result = await tool.execute(
    'call-1',
    {
      blocking: true,
      questions: [{ id: 'ship', question: 'Ship it?' }],
    },
    undefined,
    undefined,
    {} as any
  )
  return { result, createQuestion }
}

describe('async ask_human trusted origin', () => {
  test('flushes persistence before creating with runner-owned identity', async () => {
    const order: string[] = []
    const createQuestion = mock(async () => {
      order.push('create')
      return { ...record, openedWaitWorkStreamIds: [] }
    })
    const tool = createAsyncAskHumanTool(
      {
        agentId: 'agent-1',
        executionId: 'execution-1',
        flushPersistence: async () => {
          order.push('flush')
        },
      },
      { createQuestion }
    )

    await tool.execute('call-1', { questions: [{ id: 'ship', question: 'Ship it?' }] }, undefined, undefined, {} as any)

    expect(order).toEqual(['flush', 'create'])
    expect(createQuestion).toHaveBeenCalledWith({ agentId: 'agent-1', executionId: 'execution-1' }, expect.anything(), {
      blocking: false,
    })
    expect(JSON.stringify(tool.parameters)).not.toMatch(/agentId|executionId|recipient|workStreamId/)
  })
})

describe('async ask_human unroutable audience', () => {
  test('records the question and never claims a system-inbox alert', async () => {
    const createQuestion = mock(async () => ({
      ...record,
      audienceResolution: 'unroutable' as const,
      openedWaitWorkStreamIds: [],
    }))
    const tool = createAsyncAskHumanTool(
      { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
      { createQuestion }
    )

    const result = await tool.execute(
      'call-1',
      { questions: [{ id: 'ship', question: 'Ship it?' }] },
      undefined,
      undefined,
      {} as any
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).not.toStartWith('Error:')
    expect(text).toContain('no direct Action Center recipient was found')
    expect(text).toContain('still visible and answerable')
    expect(text).not.toContain('system inbox')
    expect(result.details).toMatchObject({ questionId: record.id, async: true })
  })
})

describe('async ask_human blocking reply', () => {
  test('never claims a wait opened when zero streams were affected', async () => {
    const { result } = await executeWith([])
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('No work-stream waits were opened')
    expect(result.details).toMatchObject({ blocking: true, openedWaitCount: 0, openedWaitWorkStreamIds: [] })
  })

  test('reports the exact single affected stream', async () => {
    const { result } = await executeWith(['ws-one'])
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'Opened a wait on 1 work stream: ws-one'
    )
    expect(result.details).toMatchObject({ openedWaitCount: 1, openedWaitWorkStreamIds: ['ws-one'] })
  })

  test('reports the exact count and IDs for multiple affected streams', async () => {
    const { result } = await executeWith(['ws-one', 'ws-two'])
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'Opened waits on 2 work streams: ws-one, ws-two'
    )
    expect(result.details).toMatchObject({ openedWaitCount: 2, openedWaitWorkStreamIds: ['ws-one', 'ws-two'] })
  })
})

describe('async ask_human without blocking (managers and assistants)', () => {
  test('omits the blocking and waitScope parameters and never opens waits', async () => {
    const createQuestion = mock(async () => ({ ...record, openedWaitWorkStreamIds: [] }))
    const tool = createAsyncAskHumanTool(
      { agentId: 'manager-1', executionId: 'execution-1', flushPersistence: async () => {} },
      { createQuestion },
      { allowBlocking: false }
    )

    expect(JSON.stringify(tool.parameters)).not.toMatch(/blocking|waitScope/)
    expect(tool.description).toContain('keep working')
    expect(tool.description).not.toContain('Set blocking true')

    const result = await tool.execute(
      'call-1',
      { blocking: true, waitScope: 'stream', questions: [{ id: 'ship', question: 'Ship it?' }] },
      undefined,
      undefined,
      {} as any
    )

    expect(createQuestion).toHaveBeenCalledWith(
      { agentId: 'manager-1', executionId: 'execution-1' },
      expect.anything(),
      {
        blocking: false,
      }
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('You can continue other work in the meantime')
    expect(text).toContain('cannot block')
    expect(result.details).toMatchObject({ blocking: false, openedWaitCount: 0 })
  })

  test('keeps blocking available by default for work-stream agents', () => {
    const tool = createAsyncAskHumanTool({
      agentId: 'worker-1',
      executionId: 'execution-1',
      flushPersistence: async () => {},
    })
    expect(JSON.stringify(tool.parameters)).toMatch(/blocking/)
    expect(tool.description).toContain('Set blocking true')
  })
  test('records trimmed context and text suggestions, and asks agents to give context', async () => {
    const createQuestion = mock(async (_origin: unknown, _data: unknown, _options: unknown) => ({
      ...record,
      openedWaitWorkStreamIds: [],
    }))
    const tool = createAsyncAskHumanTool(
      { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
      { createQuestion }
    )
    await tool.execute(
      'call-1',
      {
        questions: [
          {
            id: 'branch',
            question: 'Which branch should I deploy?',
            context: '  The release build passed on both branches.  ',
            options: [{ value: 'main' }, { value: 'release/1.4', label: 'Release 1.4' }],
          },
          { id: 'notes', question: 'Anything else?', context: '   ' },
        ],
      },
      undefined,
      undefined,
      {} as any
    )
    expect(createQuestion.mock.calls[0]?.[1]).toEqual({
      questions: [
        {
          id: 'branch',
          type: 'text',
          question: 'Which branch should I deploy?',
          context: 'The release build passed on both branches.',
          options: [{ value: 'main' }, { value: 'release/1.4', label: 'Release 1.4' }],
          default: undefined,
          optional: undefined,
        },
        {
          id: 'notes',
          type: 'text',
          question: 'Anything else?',
          options: undefined,
          default: undefined,
          optional: undefined,
        },
      ],
    })
    expect(tool.description).toContain('give it context')
    expect(JSON.stringify(tool.parameters)).toContain('suggested answers the human can pick and edit')
  })

  test('rejects context longer than the display limit', async () => {
    const createQuestion = mock(async () => ({ ...record, openedWaitWorkStreamIds: [] }))
    const tool = createAsyncAskHumanTool(
      { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
      { createQuestion }
    )
    const result = await tool.execute(
      'call-1',
      { questions: [{ id: 'long', question: 'Proceed?', context: 'x'.repeat(2001) }] },
      undefined,
      undefined,
      {} as any
    )
    expect(result.details).toEqual({ error: "Question 'long': context must be at most 2000 characters" })
    expect(createQuestion).not.toHaveBeenCalled()
  })
})
