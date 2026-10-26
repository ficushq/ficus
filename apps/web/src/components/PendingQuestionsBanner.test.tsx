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
  test('one question: a single row with icon, count, a one-line plain-text preview, and an Answer affordance', async () => {
    const dom = await installDom()
    root = dom.createRoot().root
    const text = 'Should I reserve ports   20000–29999 for <b>boxes</b>?\n\nThey **collide** with the dev server.'
    const question = {
      ...questions[0],
      questionData: { questions: [{ id: 'item-0', type: 'text', question: text }] },
    } as AgentQuestion
    await dom.act(async () => root?.render(<PendingQuestionsBanner questions={[question]} />))

    const buttons = dom.window.document.querySelectorAll('button')
    // One full-width click target: no collapse control.
    expect(buttons).toHaveLength(1)
    const button = buttons[0]
    const label =
      '1 pending question: Should I reserve ports 20000–29999 for <b>boxes</b>? They **collide** with the dev server. Open to answer'
    expect(button.getAttribute('aria-label')).toBe(label)
    expect(button.getAttribute('title')).toBe(label)
    expect(button.classList.contains('w-full')).toBe(true)

    const [icon, count, preview, affordance] = [...button.children]
    expect(icon.tagName.toLowerCase()).toBe('svg')
    expect(icon.getAttribute('stroke')).toBe('currentColor')
    expect(icon.classList.contains('shrink-0')).toBe(true)
    expect(count.textContent).toBe('1 pending question')
    expect(count.classList.contains('shrink-0')).toBe(true)
    // Only the preview shrinks; it is the first line as plain text, never rendered markup.
    expect(preview.textContent).toBe('· Should I reserve ports 20000–29999 for <b>boxes</b>?')
    expect(preview.querySelector('b')).toBeNull()
    expect(preview.classList.contains('truncate')).toBe(true)
    expect(preview.classList.contains('min-w-0')).toBe(true)
    expect(affordance.textContent).toBe('Answer')
    expect(affordance.querySelector('svg')).not.toBeNull()
    expect(affordance.classList.contains('shrink-0')).toBe(true)
  })

  test('stands out in the attention color while staying an opaque floating card', async () => {
    const dom = await installDom()
    root = dom.createRoot().root
    await dom.act(async () => root?.render(<PendingQuestionsBanner questions={[questions[0]]} />))

    const button = dom.window.document.querySelector('button')!
    // Opaque base surface with the attention tint layered over it (the tint alone is translucent in dark themes).
    for (const name of [
      'bg-surface',
      'bg-gradient-to-r',
      'from-status-attention-surface',
      'to-status-attention-surface',
      'border-status-attention-border',
      'hover:bg-gradient-to-r',
    ]) {
      expect(button.classList.contains(name)).toBe(true)
    }
    expect(button.classList.contains('border-th-border')).toBe(false)
    const [icon, count, , affordance] = [...button.children]
    expect(icon.classList.contains('text-status-attention-fg')).toBe(true)
    expect(count.classList.contains('text-status-attention-fg')).toBe(true)
    expect(affordance.classList.contains('text-status-attention-fg')).toBe(true)
  })

  test('several questions: just the count, no preview', async () => {
    const dom = await installDom()
    root = dom.createRoot().root
    await dom.act(async () => root?.render(<PendingQuestionsBanner questions={questions} />))

    const button = dom.window.document.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('2 pending questions. Open to answer')
    expect(button.textContent).toBe('2 pending questionsAnswer')
    expect(button.textContent).not.toContain('Question 1?')
  })

  test('opens live question details once per ID, including a new ID at the same count', async () => {
    const dom = await installDom()
    const { window } = dom
    root = dom.createRoot().root
    const QuestionCard = ({ question }: { question: AgentQuestion }) => <div>{question.id}</div>
    const render = async (items: AgentQuestion[]) => {
      await dom.act(async () =>
        root?.render(
          <PendingQuestionsBanner questions={items} dependencies={{ QuestionCardComponent: QuestionCard }} />
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
    await render([{ ...questions[0] }])
    expect(dialog()).toBeNull()

    // New IDs, not counts, reopen the details.
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
                <PendingQuestionsBanner questions={items} />
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
        <PendingQuestionsBanner questions={questions} dependencies={{ QuestionCardComponent: TestQuestionCard }} />
      )
    )

    const banner = window.document.querySelector('button')
    await domHarness!.act(async () => banner?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    const first = window.document.querySelector('[data-question-id="question-1"]')
    await domHarness!.act(async () => first?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(submitted).toHaveBeenCalledWith('question-1', 'answer-question-1')
    expect(
      window.document.querySelector('button[aria-label="1 pending question: Question 2? Open to answer"]')
    ).not.toBeNull()
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
