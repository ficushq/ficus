import { describe, expect, mock, test } from 'bun:test'
import { assertHumanAnswerableQuestions, type AgentQuestion } from '@ficus/shared'
import { toolCallIdempotencyKey } from '@ficus/shared/node'
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
      idempotencyKey: toolCallIdempotencyKey('agent-1', 'execution-1', 'call-1'),
    })
    expect(JSON.stringify(tool.parameters)).not.toMatch(/agentId|executionId|recipient|workStreamId/)
  })
})

describe('async ask_human tool call idempotency', () => {
  test('keys the question on the agent, execution and tool call', async () => {
    const createQuestion = mock(async () => ({ ...record, openedWaitWorkStreamIds: [] }))
    const tool = createAsyncAskHumanTool(
      { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
      { createQuestion }
    )
    const ask = (callId: string) =>
      tool.execute(callId, { questions: [{ id: 'ship', question: 'Ship it?' }] }, undefined, undefined, {} as any)
    await ask('call-1')
    await ask('call-1')
    await ask('call-2')
    const keys = createQuestion.mock.calls.map((call) => (call as unknown[])[2] as { idempotencyKey?: string })
    expect(keys[0]?.idempotencyKey).toBe(toolCallIdempotencyKey('agent-1', 'execution-1', 'call-1'))
    expect(keys[1]?.idempotencyKey).toBe(keys[0]!.idempotencyKey!)
    expect(keys[2]?.idempotencyKey).not.toBe(keys[0]!.idempotencyKey!)
  })

  test('says a reused question was not asked again and reports its existing waits', async () => {
    for (const [reused, reason] of [
      ['tool-call', 'This tool call was already recorded'],
      ['identical-open-question', 'You already asked exactly this question in this run'],
    ] as const) {
      const createQuestion = mock(async () => ({ ...record, openedWaitWorkStreamIds: ['ws-one'], reused }))
      const tool = createAsyncAskHumanTool(
        { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
        { createQuestion }
      )
      const result = await tool.execute(
        'call-1',
        { blocking: true, questions: [{ id: 'ship', question: 'Ship it?' }] },
        undefined,
        undefined,
        {} as any
      )
      const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
      expect(text).toContain(reason)
      expect(text).toContain('no new question was created: question question (open)')
      expect(text).toContain('It holds waits on 1 work stream: ws-one')
      expect(result.details).toMatchObject({
        questionId: record.id,
        reused,
        blocking: true,
        openedWaitWorkStreamIds: ['ws-one'],
      })
    }
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
        idempotencyKey: toolCallIdempotencyKey('manager-1', 'execution-1', 'call-1'),
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

describe('async ask_human recommended option', () => {
  function tool() {
    const createQuestion = mock(async (_origin: unknown, _data: unknown, _options: unknown) => ({
      ...record,
      openedWaitWorkStreamIds: [],
    }))
    return {
      createQuestion,
      tool: createAsyncAskHumanTool(
        { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
        { createQuestion }
      ),
    }
  }
  const ask = (t: ReturnType<typeof tool>['tool'], options: unknown[]) =>
    t.execute(
      'call-1',
      { questions: [{ id: 'env', type: 'select', question: 'Where should I deploy?', options }] },
      undefined,
      undefined,
      {} as any
    )

  test('offers the optional recommended flag and reason on every option', () => {
    const schema = JSON.stringify(tool().tool.parameters)
    expect(schema).toContain('"recommended"')
    expect(schema).toContain('"reason"')
    expect(schema).toContain('It is not preselected')
    expect(schema).toContain('One-line plain-text reason for your recommendation (no Markdown)')
    expect(schema).toContain('Expected whenever you recommend an option')
    expect(schema).toContain('"maxLength":200')
  })

  test('records one recommended option with its trimmed reason and leaves the others unmarked', async () => {
    const { tool: t, createQuestion } = tool()
    const result = await ask(t, [
      { value: 'staging', label: 'Staging', recommended: true, reason: '  The release build passed there.  ' },
      { value: 'prod', recommended: false },
      { value: 'skip' },
    ])
    expect(result.content[0]?.type === 'text' && result.content[0].text).toStartWith('Question recorded')
    const data = createQuestion.mock.calls[0]?.[1] as { questions: { options: unknown[] }[] }
    expect(data.questions[0]?.options).toEqual([
      { value: 'staging', label: 'Staging', recommended: true, reason: 'The release build passed there.' },
      { value: 'prod' },
      { value: 'skip' },
    ])
  })

  test('rejects more than one recommended option with a clear error', async () => {
    const { tool: t, createQuestion } = tool()
    const result = await ask(t, [
      { value: 'staging', recommended: true },
      { value: 'prod', recommended: true },
    ])
    expect(result.details).toEqual({
      error: "Question 'env': at most one option can be recommended, but 2 were ('staging', 'prod')",
    })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  test('rejects a reason on an option that is not recommended', async () => {
    const { tool: t, createQuestion } = tool()
    const result = await ask(t, [{ value: 'staging' }, { value: 'prod', reason: 'Faster.' }])
    expect(result.details).toEqual({
      error:
        "Question 'env': option 'prod' has a reason but is not recommended; a reason belongs only on the recommended option",
    })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  test('rejects a reason that is not one short line', async () => {
    const { tool: t } = tool()
    const multiline = await ask(t, [{ value: 'staging', recommended: true, reason: 'First.\nSecond.' }])
    expect(result(multiline)).toBe("Error: Question 'env': the reason for option 'staging' must be one line")
    const long = await ask(t, [{ value: 'staging', recommended: true, reason: 'x'.repeat(201) }])
    expect(result(long)).toBe("Error: Question 'env': the reason for option 'staging' must be at most 200 characters")
  })

  function result(r: Awaited<ReturnType<typeof ask>>) {
    return r.content[0]?.type === 'text' ? r.content[0].text : ''
  }
})

describe('async ask_human forensic guard', () => {
  function toolWithSharedGuard() {
    // Runs the same shared check createAgentQuestion applies before persisting.
    const createQuestion = mock(
      async (_origin: unknown, data: { questions: AgentQuestion['questionData']['questions'] }) => {
        assertHumanAnswerableQuestions(data.questions)
        return { ...record, openedWaitWorkStreamIds: [] }
      }
    )
    const tool = createAsyncAskHumanTool(
      { agentId: 'agent-1', executionId: 'execution-1', flushPersistence: async () => {} },
      { createQuestion: createQuestion as any }
    )
    return { tool, createQuestion }
  }

  test("describes the restriction and how to ask approval for the agent's own action", () => {
    const { tool } = toolWithSharedGuard()
    expect(tool.description).toContain('Never ask the person to run commands or to provide logs')
    expect(tool.description).toContain('describe that action in plain words')
  })

  test('records an approval request for a restart the agent will run itself', async () => {
    const { tool } = toolWithSharedGuard()
    const result = await tool.execute(
      'call-1',
      {
        questions: [
          {
            id: 'restart',
            type: 'select',
            question: 'May I gracefully restart xion.service once to recover it?',
            context:
              'Restart it once (recommended, about the same as the restart you already accepted): run `systemctl restart xion` once. ' +
              "I'll verify catch-up and stop it gracefully again if it panics.",
            options: [{ value: 'restart', label: 'Restart it once' }, { value: 'leave' }],
          },
        ],
      },
      undefined,
      undefined,
      {} as any
    )
    expect(result.content[0]?.type === 'text' && result.content[0].text).toStartWith('Question recorded')
  })

  test('checks the recommendation reason like the other human-facing text', async () => {
    const { tool } = toolWithSharedGuard()
    const result = await tool.execute(
      'call-1',
      {
        questions: [
          {
            id: 'node',
            type: 'select',
            question: 'How should I recover the node?',
            options: [
              {
                value: 'restart',
                recommended: true,
                reason: 'Can you run systemctl status xion and paste the output?',
              },
              { value: 'leave' },
            ],
          },
        ],
      },
      undefined,
      undefined,
      {} as any
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain("Rejected text: the recommendation reason of option 'restart' of question 'node'.")
  })

  test('names the rejected question field and suggests a rephrasing', async () => {
    const { tool } = toolWithSharedGuard()
    const result = await tool.execute(
      'call-1',
      {
        questions: [
          {
            id: 'status',
            question: 'Is the node healthy?',
            context: 'Can you run systemctl status xion and paste the output?',
          },
        ],
      },
      undefined,
      undefined,
      {} as any
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toStartWith('Error: Ask only for a task file')
    expect(text).toContain("Rejected text: the context of question 'status'.")
    expect(text).toContain('describe that action in plain words')
  })
})

// These procedures belong to the tool/result, rather than every static squad prompt.
test('question guidance arrives with the tool and the recorded question', async () => {
  const tool = createAsyncAskHumanTool({
    agentId: 'worker-1',
    executionId: 'execution-1',
    flushPersistence: async () => {},
  })
  expect(tool.description).toContain('set recommended true on that one option with a one-line plain-text reason')
  expect(tool.description).not.toContain('your recommendation, and name the evidence')
  expect(tool.description).toContain('not a manual wait or inbox message')
  expect(tool.description).toContain('Set blocking true when your current step needs the answer')
  expect(tool.description).toContain('independent branches can continue')
  expect(JSON.stringify(tool.parameters)).toContain('default is your active flow attempt')
  const { result } = await executeWith(['ws-one'])
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('Do not repeat the question in chat or infer an answer')
  expect(text).toContain('A human answer is not review approval')
})

test('question replies do not assume the caller has a shell', async () => {
  const tool = createAsyncAskHumanTool(
    { agentId: 'tool-only-1', executionId: 'execution-1', flushPersistence: async () => {} },
    { createQuestion: async () => ({ ...record, openedWaitWorkStreamIds: [] }) },
    { allowBlocking: false }
  )
  const result = await tool.execute(
    'call-1',
    { questions: [{ id: 'q', question: 'Which option?' }] },
    undefined,
    undefined,
    {} as any
  )
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('Do not repeat the question in chat')
  expect(text).not.toContain('ficus agent-question')
})

test('the shared result leaves Assistant pending labels and conversational answers intact', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const assistant = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../../../../config/agent-types/assistant.yaml'), 'utf8')
  ) as { systemPrompt: string }
  expect(assistant.systemPrompt).toContain('waiting in Needs you')
  expect(assistant.systemPrompt).toContain('When the user supplies an answer conversationally, continue')
  const tool = createAsyncAskHumanTool(
    { agentId: 'assistant-1', executionId: 'execution-1', flushPersistence: async () => {} },
    { createQuestion: async () => ({ ...record, openedWaitWorkStreamIds: [] }) },
    { allowBlocking: false }
  )
  const result = await tool.execute(
    'call-1',
    { questions: [{ id: 'q', question: 'Which option?' }] },
    undefined,
    undefined,
    {} as any
  )
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('Do not repeat the question in chat')
  expect(text).not.toContain('Action Center')
  expect(text).not.toContain('question id')
  expect(text).not.toContain('Record an answer received elsewhere')
  expect(text).not.toContain('ficus agent-question')
})
