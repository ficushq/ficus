import { afterEach, describe, expect, it, mock } from 'bun:test'
import { HttpResponseError, queryKeys } from '@ficus/client-core'
import type { AgentQuestion, PendingAction, QuestionData } from '@ficus/shared'
import { AgentPendingQuestions, StreamQuestionWait } from './AgentQuestions'
import { oneTextQuestion, wait } from './fixtures'
import { QuestionForm } from './QuestionForm'
import { button, byLabel, cleanup, click, fakeApi, hasKey, render, testQueryClient, typeInto } from './testing'

afterEach(cleanup)

const agentSource = {
  kind: 'agent-question' as const,
  questionId: 'q-1',
  agentId: 'agent-2',
  squadId: 'squad-1',
}

const threeQuestions: QuestionData = {
  questions: [
    { id: 'name', type: 'text', question: 'Name the crop' },
    {
      id: 'size',
      type: 'select',
      question: 'How big?',
      options: [{ value: 'small' }, { value: 'large', label: 'Large' }],
    },
    {
      id: 'extras',
      type: 'multi-select',
      question: 'Extras?',
      options: [{ value: 'basil' }, { value: 'mint' }, { value: 'thyme' }],
    },
  ],
}

function radio(container: HTMLElement, label: string) {
  const option = [...container.querySelectorAll('label.g-option')].find((el) => el.textContent?.trim() === label)
  if (!option) throw new Error(`No option ${label}`)
  return option.querySelector('input')!
}

describe('QuestionForm · agent question', () => {
  it('answers a single question with the raw value and settles the caches', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const queryClient = testQueryClient()
    queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), [
      { id: 'agent-question:q-1' } as PendingAction,
      { id: 'other' } as PendingAction,
    ])
    const onAnswered = mock(() => undefined)
    const { container, invalidated } = await render(
      <QuestionForm questionData={oneTextQuestion} source={agentSource} onAnswered={onAnswered} />,
      api,
      queryClient
    )

    expect(button(container, 'Answer').disabled).toBe(true)
    await typeInto(byLabel(container, 'Which color?'), '  Tomato red  ')
    expect(button(container, 'Answer').disabled).toBe(false)
    await click(button(container, 'Answer'))

    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-1', 'Tomato red')
    expect(onAnswered).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData<PendingAction[]>(queryKeys.actions.pending())?.map((a) => a.id)).toEqual(['other'])
    const keys = invalidated()
    for (const key of [
      queryKeys.actions.pending(),
      queryKeys.agentQuestions.all,
      queryKeys.agents.detail('agent-2'),
      queryKeys.agents.activeExecution('agent-2'),
      queryKeys.agents.listPrefix(),
      queryKeys.squads.agents('squad-1'),
    ]) {
      expect(hasKey(keys, key)).toBe(true)
    }
  })

  it('answers several questions as JSON keyed by question id', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const { container } = await render(<QuestionForm questionData={threeQuestions} source={agentSource} />, api)

    await typeInto(byLabel(container, 'Name the crop'), 'Tomato')
    await click(radio(container, 'Something else'))
    const [sizeOther] = container.querySelectorAll('.g-question-other')
    await typeInto(sizeOther!, 'Enormous')
    expect(button(container, 'Answer').disabled).toBe(true)
    await click(radio(container, 'mint'))
    await click(radio(container, 'basil'))
    await click(button(container, 'Answer'))

    expect(api.answerAgentQuestion).toHaveBeenCalledTimes(1)
    const [id, answer] = api.answerAgentQuestion.mock.calls[0]!
    expect(id).toBe('q-1')
    expect(answer).toBe(JSON.stringify({ name: 'Tomato', size: 'Enormous', extras: 'mint, basil' }, null, 2))
  })

  it('sends "(empty)" when the only question is optional and skipped', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const optional: QuestionData = { questions: [{ id: 'n', type: 'text', question: 'Notes?', optional: true }] }
    const { container } = await render(<QuestionForm questionData={optional} source={agentSource} />, api)
    await click(button(container, 'Answer'))
    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-1', '(empty)')
  })

  it('fills text answers from suggestions', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const suggested: QuestionData = {
      questions: [{ id: 't', type: 'text', question: 'Water when?', options: [{ value: 'dawn', label: 'At dawn' }] }],
    }
    const { container } = await render(<QuestionForm questionData={suggested} source={agentSource} />, api)
    await click(button(container, 'At dawn'))
    expect(button(container, 'At dawn').getAttribute('aria-pressed')).toBe('true')
    await click(button(container, 'Answer'))
    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-1', 'dawn')
  })

  it('answers then opens the robot with "Answer & visit"', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const onOpenAgent = mock((agentId: string) => agentId)
    const { container } = await render(
      <QuestionForm questionData={oneTextQuestion} source={agentSource} onOpenAgent={onOpenAgent} />,
      api
    )
    await typeInto(byLabel(container, 'Which color?'), 'Green')
    await click(button(container, 'Answer & visit'))
    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-1', 'Green')
    expect(onOpenAgent).toHaveBeenCalledWith('agent-2')
  })

  it('dismisses without answering', async () => {
    const api = fakeApi({ dismissAgentQuestion: () => Promise.resolve({} as AgentQuestion) })
    const { container, invalidated } = await render(
      <QuestionForm questionData={oneTextQuestion} source={agentSource} />,
      api
    )
    // It takes a confirming second click.
    await click(button(container, 'Dismiss'))
    expect(api.dismissAgentQuestion).not.toHaveBeenCalled()
    await click(button(container, 'Really dismiss?'))
    expect(api.dismissAgentQuestion).toHaveBeenCalledWith('q-1')
    expect(api.answerAgentQuestion).not.toHaveBeenCalled()
    expect(hasKey(invalidated(), queryKeys.agentQuestions.all)).toBe(true)
    expect(hasKey(invalidated(), queryKeys.actions.pending())).toBe(true)
  })

  it('explains a dismiss conflict and reconciles', async () => {
    const api = fakeApi({ dismissAgentQuestion: () => Promise.reject(new HttpResponseError(409, 'gone')) })
    const { container, invalidated } = await render(
      <QuestionForm questionData={oneTextQuestion} source={agentSource} />,
      api
    )
    // It takes a confirming second click.
    await click(button(container, 'Dismiss'))
    expect(api.dismissAgentQuestion).not.toHaveBeenCalled()
    await click(button(container, 'Really dismiss?'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This question is no longer waiting for you.')
    expect(hasKey(invalidated(), queryKeys.agentQuestions.all)).toBe(true)
  })

  it('announces answer failures', async () => {
    const api = fakeApi({ answerAgentQuestion: () => Promise.reject(new Error('Robot unplugged')) })
    const onAnswerError = mock(() => undefined)
    const { container } = await render(
      <QuestionForm questionData={oneTextQuestion} source={agentSource} onAnswerError={onAnswerError} />,
      api
    )
    await typeInto(byLabel(container, 'Which color?'), 'Blue')
    await click(button(container, 'Answer'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Robot unplugged')
    expect(onAnswerError).toHaveBeenCalledTimes(1)
    expect(button(container, 'Answer').disabled).toBe(false)
  })

  it('shows the busy state while answering', async () => {
    let finish!: () => void
    const api = fakeApi({
      answerAgentQuestion: () => new Promise<AgentQuestion>((resolve) => (finish = () => resolve({} as AgentQuestion))),
    })
    const { container } = await render(<QuestionForm questionData={oneTextQuestion} source={agentSource} />, api)
    await typeInto(byLabel(container, 'Which color?'), 'Blue')
    await click(button(container, 'Answer'))
    const busy = button(container, 'Answering…')
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(button(container, 'Dismiss').disabled).toBe(true)
    finish()
  })

  it('retries a failed delivery instead of asking again', async () => {
    const api = fakeApi({ retryAgentQuestionAnswerDelivery: () => Promise.resolve({} as AgentQuestion) })
    const { container, invalidated } = await render(
      <QuestionForm
        questionData={oneTextQuestion}
        source={{
          ...agentSource,
          answerDelivery: {
            status: 'failed',
            generation: 1,
            attemptCount: 3,
            nextAttemptAt: null,
            lastError: 'boom',
            deliveredAt: null,
            canRetry: true,
          },
        }}
      />,
      api
    )
    expect(container.querySelector('textarea')).toBeNull()
    await click(button(container, 'Send again'))
    expect(api.retryAgentQuestionAnswerDelivery).toHaveBeenCalledWith('q-1')
    expect(hasKey(invalidated(), queryKeys.agents.detail('agent-2'))).toBe(true)
    expect(hasKey(invalidated(), queryKeys.agentQuestions.all)).toBe(true)
  })
})

describe('QuestionForm · squad question', () => {
  it('sends the answer as a chat message, exactly like ActionItem', async () => {
    const api = fakeApi({
      sendAgentMessage: () => Promise.resolve({ success: true, status: 'running' as const }),
    })
    const queryClient = testQueryClient()
    queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), [
      { id: 'squad-question:agent-1' } as PendingAction,
    ])
    const onOpenAgent = mock((agentId: string) => agentId)
    const { container, invalidated } = await render(
      <QuestionForm
        questionData={oneTextQuestion}
        source={{ kind: 'squad-question', agentId: 'agent-1', squadId: 'squad-1' }}
        onOpenAgent={onOpenAgent}
      />,
      api,
      queryClient
    )
    await typeInto(byLabel(container, 'Which color?'), 'Purple')
    await click(button(container, 'Answer'))
    expect(api.sendAgentMessage).toHaveBeenCalledWith('agent-1', 'Purple', {
      imageIds: undefined,
      deliveryMode: undefined,
    })
    expect(queryClient.getQueryData<PendingAction[]>(queryKeys.actions.pending())).toEqual([])
    expect(hasKey(invalidated(), queryKeys.actions.pending())).toBe(true)
    await click(button(container, 'Visit robot'))
    expect(onOpenAgent).toHaveBeenCalledWith('agent-1')
  })
})

describe('QuestionForm · in-chat blocking question', () => {
  it('hands the answer string to the chat', async () => {
    const api = fakeApi()
    const onAnswer = mock((answer: string) => {
      void answer
    })
    const { container } = await render(
      <QuestionForm questionData={oneTextQuestion} source={{ kind: 'in-chat', onAnswer }} />,
      api
    )
    await typeInto(byLabel(container, 'Which color?'), 'Orange')
    await click(button(container, 'Answer'))
    expect(onAnswer).toHaveBeenCalledWith('Orange')
    expect(container.textContent).toContain('Answer sent')
    expect(api.answerAgentQuestion).not.toHaveBeenCalled()
    expect(api.sendAgentMessage).not.toHaveBeenCalled()
  })
})

const openQuestion = (id: string, extra: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id,
  agentId: 'agent-2',
  squadId: 'squad-1',
  ownerUserId: null,
  questionData: { questions: [{ id: 'x', type: 'text', question: `Question ${id}` }] },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: '2026-09-27T10:00:00.000Z',
  answeredAt: null,
  ...extra,
})

describe('StreamQuestionWait', () => {
  it("finds the wait's question in the asking robot's open questions and answers it", async () => {
    const api = fakeApi({
      getAgentQuestions: () => Promise.resolve([openQuestion('q-7'), openQuestion('q-8')]),
      answerAgentQuestion: () => Promise.resolve({} as AgentQuestion),
    })
    const { container, invalidated } = await render(
      <StreamQuestionWait wait={wait({ type: 'question', referenceId: 'q-8', createdByAgentId: 'agent-2' })} />,
      api
    )
    expect(api.getAgentQuestions).toHaveBeenCalledWith('agent-2', 'open')
    await typeInto(byLabel(container, 'Question q-8'), 'Yes')
    await click(button(container, 'Answer'))
    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-8', 'Yes')
    expect(hasKey(invalidated(), queryKeys.squads.all)).toBe(true)
  })

  it('says so when the question was already answered', async () => {
    const api = fakeApi({ getAgentQuestions: () => Promise.resolve([]) })
    const { container } = await render(
      <StreamQuestionWait wait={wait({ type: 'question', referenceId: 'q-8', createdByAgentId: 'agent-2' })} />,
      api
    )
    expect(container.textContent).toContain('Already answered')
  })
})

describe('AgentPendingQuestions', () => {
  it("lists a robot's open questions and hides one as it is answered", async () => {
    const api = fakeApi({
      getAgentQuestions: () => Promise.resolve([openQuestion('q-7'), openQuestion('q-8')]),
      answerAgentQuestion: () => new Promise<AgentQuestion>(() => undefined),
    })
    const { container } = await render(<AgentPendingQuestions agentId="agent-2" agentName="Bean" />, api)
    expect(container.textContent).toContain('2 questions from Bean')
    await typeInto(byLabel(container, 'Question q-7'), 'Now')
    await click(container.querySelectorAll('button.g-button-primary')[0]!)
    expect(api.answerAgentQuestion).toHaveBeenCalledWith('q-7', 'Now')
    expect(container.textContent).toContain('1 question from Bean')
    expect(container.textContent).not.toContain('Question q-7')
  })
})
