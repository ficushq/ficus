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
  test('opens live question details once per ID, including a new ID at the same count', async () => {
    const dom = await installDom()
    const { window } = dom
    root = dom.createRoot().root
    const QuestionCard = ({ question }: { question: AgentQuestion }) => <div>{question.id}</div>
    const render = async (items: AgentQuestion[]) => {
      await dom.act(async () =>
        root?.render(
          <PendingQuestionsBanner
            questions={items}
            agentName="Pearl"
            dependencies={{ QuestionCardComponent: QuestionCard }}
          />
        )
      )
    }
    const dialog = () => window.document.querySelector('[role="dialog"][data-state="open"]')
    const click = async (selector: string) => {
      const button = window.document.querySelector(selector)
      expect(button).not.toBeNull()
      await dom.act(async () => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    }

    await render([])
    await render([questions[0]])
    expect(dialog()?.textContent).toContain('question-1')
    expect(dialog()?.getAttribute('aria-modal')).toBe('true')
    await click('[aria-label="Close"]')
    await click('[aria-label="Collapse pending questions"]')
    await render([{ ...questions[0] }])
    expect(dialog()).toBeNull()

    // New IDs, not counts, reopen the details even while the banner is collapsed.
    await render([questions[1]])
    expect(dialog()?.textContent).toContain('question-2')
    await click('[aria-label="Close"]')
    await render(questions)
    expect(dialog()).toBeNull()
    await render([...questions].reverse().map((question) => ({ ...question, answer: 'unrelated update' })))
    expect(dialog()).toBeNull()
    await render([])
    await render(questions)
    expect(dialog()).toBeNull()
  })

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

  for (const fails of [false, true]) {
    test(`a live question is optimistically hidden on answer and ${fails ? 'restored on error without reopening' : 'stays hidden on success'}`, async () => {
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
          return new window.Response(
            JSON.stringify(fails ? { error: 'Offline' } : { ...questions[0], status: 'answered', answer: 'Ship it' }),
            {
              status: fails ? 500 : 200,
              headers: { 'content-type': 'application/json' },
            }
          ) as unknown as Response
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
        const render = async (items: AgentQuestion[]) => {
          await domHarness!.act(async () =>
            root?.render(
              <QueryClientProvider client={queryClient}>
                <PendingQuestionsBanner questions={items} agentName="Pearl" />
              </QueryClientProvider>
            )
          )
        }
        await render([])
        await render([withDefault])
        expect(window.document.querySelector('[role="dialog"]')).not.toBeNull()
        const confirm = [...window.document.querySelectorAll('button')].find(
          (button) => button.textContent === 'Submit Answer'
        )
        await domHarness!.act(async () => confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/agent-questions/${questions[0].id}/answer`)
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ answer: 'Ship it' })
        expect(window.document.querySelector('[role="dialog"]')).toBeNull()
        expect(window.document.body.textContent).not.toContain('pending question')
        resolveAnswer()
        await domHarness!.act(async () => {
          await fetchSettled
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        if (fails) {
          expect(window.document.body.textContent).toContain('1 pending question')
          expect(window.document.querySelector('[role="dialog"][data-state="open"]')).toBeNull()
          // Restoring an optimistic answer is not a new ID, but a later question is.
          await render([withDefault, questions[1]])
          expect(window.document.querySelector('[role="dialog"]')?.textContent).toContain('Question 2?')
        } else {
          expect(window.document.body.textContent).not.toContain('pending question')
        }
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
  }

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
