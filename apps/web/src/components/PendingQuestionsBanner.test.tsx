import { queryKeys } from '../queryKeys'
import { acquireDomHarness } from '../test/domHarness'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import type { AgentQuestion } from '@ficus/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PendingQuestionsBanner } from './PendingQuestionsBanner'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

const questions = ['question-1', 'question-2'].map(
  (id, index) =>
    ({
      id,
      agentId: 'agent-1',
      squadId: 'squad-1',
      ownerUserId: 'user-1',
      status: 'open',
      answer: null,
      answeredByUserId: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
      questionData: { questions: [{ id: `item-${index}`, type: 'text', question: `Question ${index + 1}?` }] },
    }) as AgentQuestion
)

let root: Root | undefined

afterEach(async () => {
  if (root) await domHarness!.act(async () => root?.unmount())
  root = undefined
})

async function installDom() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/' }))
}

describe('PendingQuestionsBanner', () => {
  test('collapses to a persistent count pill that still opens details', async () => {
    const dom = await installDom()
    const { window } = dom
    const container = window.document.createElement('div')
    window.document.body.appendChild(container)
    root = domHarness!.createRoot().root

    const InertQuestionCard = ({ question }: { question: AgentQuestion }) => <div>{question.id}</div>
    await domHarness!.act(async () =>
      root?.render(
        <PendingQuestionsBanner
          questions={questions}
          agentName="Pearl"
          dependencies={{ QuestionCardComponent: InertQuestionCard }}
        />
      )
    )
    const collapse = window.document.querySelector('[aria-label="Collapse pending questions"]')
    await domHarness!.act(async () => collapse?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))

    expect(window.document.body.textContent).not.toContain('2 pending questions from Pearl')
    const pill = window.document.querySelector('[aria-label="2 pending questions from Pearl; open details"]')
    expect(pill?.textContent).toContain('2')

    await domHarness!.act(async () => pill?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(window.document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  test('the production question card calls onAnswering and removes the banner before the answer resolves', async () => {
    const dom = await installDom()
    const { window } = dom
    let resolveAnswer!: () => void
    let resolveFetchSettled!: () => void
    const answerRequested = new Promise<void>((resolve) => {
      resolveAnswer = resolve
    })
    const fetchSettled = new Promise<void>((resolve) => {
      resolveFetchSettled = resolve
    })
    const oldFetch = globalThis.fetch
    const fetchMock = mock(async () => {
      try {
        await answerRequested
        return new window.Response(JSON.stringify({ ...questions[0], status: 'answered', answer: 'Ship it' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response
      } finally {
        resolveFetchSettled()
      }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
      })
      queryClient.setQueryData(queryKeys.voice.status(), { enabled: false, transcriptionEnabled: false })
      const withDefault = {
        ...questions[0],
        questionData: {
          questions: [{ ...questions[0].questionData.questions[0], default: 'Ship it' }],
        },
      }
      const container = window.document.createElement('div')
      window.document.body.appendChild(container)
      root = domHarness!.createRoot().root
      await domHarness!.act(async () =>
        root?.render(
          <QueryClientProvider client={queryClient}>
            <PendingQuestionsBanner questions={[withDefault]} agentName="Pearl" />
          </QueryClientProvider>
        )
      )

      await domHarness!.act(async () =>
        window.document.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      )
      const confirm = [...window.document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Submit Answer'
      )
      await domHarness!.act(async () => confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/agent-questions/${questions[0].id}/answer`)
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ answer: 'Ship it' })
      expect(window.document.querySelector('[role="dialog"]')).toBeNull()
      expect(window.document.body.textContent).not.toContain('pending question')
    } finally {
      resolveAnswer()
      if (fetchMock.mock.calls.length > 0) {
        await domHarness!.act(async () => {
          await fetchSettled
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      }
      globalThis.fetch = oldFetch
    }
  })

  test('optimistically removes answered cards and closes after the last answer', async () => {
    const dom = await installDom()
    const { window } = dom
    const submitted = mock((_id: string, _answer: string) => {})
    function TestQuestionCard({
      question,
      onAnswering,
    }: {
      question: AgentQuestion
      onAnswering?: (answer: string) => void
    }) {
      return (
        <button
          type="button"
          data-question-id={question.id}
          onClick={() => {
            const answer = `answer-${question.id}`
            submitted(question.id, answer)
            onAnswering?.(answer)
          }}
        >
          {question.id}
        </button>
      )
    }

    const container = window.document.createElement('div')
    window.document.body.appendChild(container)
    root = domHarness!.createRoot().root
    await domHarness!.act(async () =>
      root?.render(
        <PendingQuestionsBanner
          questions={questions}
          agentName="Pearl"
          dependencies={{ QuestionCardComponent: TestQuestionCard }}
        />
      )
    )

    const banner = window.document.querySelector('button')
    await domHarness!.act(async () => banner?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    const first = window.document.querySelector('[data-question-id="question-1"]')
    await domHarness!.act(async () => first?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(submitted).toHaveBeenCalledWith('question-1', 'answer-question-1')
    expect(window.document.body.textContent).toContain('1 pending question from Pearl')
    expect(window.document.querySelector('[data-question-id="question-1"]')).toBeNull()

    const last = window.document.querySelector('[data-question-id="question-2"]')
    await domHarness!.act(async () => last?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(submitted).toHaveBeenCalledWith('question-2', 'answer-question-2')
    expect(window.document.querySelector('[role="dialog"]')).toBeNull()
    expect(window.document.body.textContent).not.toContain('pending question')
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
