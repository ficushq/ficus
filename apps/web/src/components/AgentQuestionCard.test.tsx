import { expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { flushSync } from 'react-dom'
import type { AgentQuestion } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { AgentQuestionCard } from './AgentQuestionCard'

const question: AgentQuestion = {
  id: 'question-1',
  agentId: 'agent-1',
  squadId: null,
  ownerUserId: 'user-1',
  executionId: 'execution-1',
  audienceResolution: 'resolved',
  questionData: {
    questions: [{ id: 'q', type: 'text', question: 'Proceed?', default: 'no' }],
  },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: '2026-08-28T00:00:00.000Z',
  answeredAt: null,
}

test('AgentQuestionCard dismisses an open question and invalidates authoritative caches', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () =>
      new dom.window.Response(JSON.stringify({ ...question, status: 'dismissed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidated: unknown[][] = []
  queryClient.invalidateQueries = mock(async ({ queryKey }: { queryKey?: readonly unknown[] }) => {
    if (queryKey) invalidated.push([...queryKey])
  }) as typeof queryClient.invalidateQueries

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <AgentQuestionCard question={question} />
        </QueryClientProvider>
      )
    )
    const dismiss = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Dismiss'
    )
    expect(dismiss).toBeTruthy()
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss without answering')
    await dom.act(async () => {
      dismiss?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(invalidated.some((key) => key[0] === 'agentQuestions')).toBe(true)
    expect(invalidated.some((key) => key[0] === 'actions')).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('AgentQuestionCard reconciles a stale dismissal conflict as no longer pending', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () =>
      new dom.window.Response(JSON.stringify({ error: 'Question is not open' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const pendingAction = { id: `agent-question:${question.id}` }
  queryClient.setQueryData(queryKeys.actions.pending(), [pendingAction])
  const invalidated: unknown[][] = []
  queryClient.invalidateQueries = mock(async ({ queryKey }: { queryKey?: readonly unknown[] }) => {
    if (queryKey) invalidated.push([...queryKey])
  }) as typeof queryClient.invalidateQueries

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <AgentQuestionCard question={question} />
        </QueryClientProvider>
      )
    )
    const dismiss = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Dismiss'
    )
    await dom.act(async () => {
      dismiss?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe('This action is no longer pending.')
    expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([pendingAction])
    expect(invalidated.some((key) => key[0] === 'agentQuestions')).toBe(true)
    expect(invalidated.some((key) => key[0] === 'actions')).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('AgentQuestionCard retains a genuine dismissal failure for retry', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () =>
      new dom.window.Response(JSON.stringify({ error: 'Temporarily unavailable' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidated: unknown[][] = []
  queryClient.invalidateQueries = mock(async ({ queryKey }: { queryKey?: readonly unknown[] }) => {
    if (queryKey) invalidated.push([...queryKey])
  }) as typeof queryClient.invalidateQueries

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <AgentQuestionCard question={question} />
        </QueryClientProvider>
      )
    )
    const dismiss = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Dismiss'
    )
    await dom.act(async () => {
      dismiss?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('Temporarily unavailable')
    expect([...dom.window.document.querySelectorAll('button')].some((button) => button.textContent === 'Dismiss')).toBe(
      true
    )
    expect(invalidated).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('AgentQuestionCard renders a dismissed question read-only with its reason', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentQuestionCard
            question={{ ...question, status: 'dismissed', dismissalReason: 'user-dismissed: stale' }}
          />
        </QueryClientProvider>
      )
    )
    expect(dom.window.document.body.textContent).toContain('Dismissed question')
    expect(dom.window.document.body.textContent).toContain('user-dismissed: stale')
    expect([...dom.window.document.querySelectorAll('button')]).toHaveLength(0)
  } finally {
    await dom.cleanup()
  }
})

test('AgentQuestionCard keeps a failed answer visible without invalidating successful caches', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () =>
      new dom.window.Response(JSON.stringify({ error: 'Answer denied' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidated: unknown[][] = []
  queryClient.invalidateQueries = mock(async ({ queryKey }: { queryKey?: readonly unknown[] }) => {
    if (queryKey) invalidated.push([...queryKey])
  }) as typeof queryClient.invalidateQueries
  const onAnswered = mock(() => {})
  const onAnswerError = mock(() => {})

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <AgentQuestionCard question={question} onAnswered={onAnswered} onAnswerError={onAnswerError} />
        </QueryClientProvider>
      )
    )
    const submit = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Submit Answer'
    )
    await dom.act(async () => {
      submit?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(dom.window.document.body.textContent).toContain('Answer denied')
    expect(dom.window.document.body.textContent).toContain('Proceed?')
    expect(onAnswerError).toHaveBeenCalledTimes(1)
    expect(onAnswered).not.toHaveBeenCalled()
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain('Answer denied')
    expect(invalidated).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('AgentQuestionCard sanitizes a non-Error answer rejection', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async () => Promise.reject({ secret: 'unsafe' })) as unknown as typeof fetch
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
          <AgentQuestionCard question={question} />
        </QueryClientProvider>
      )
    )
    const submit = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Submit Answer'
    )
    await dom.act(async () => {
      submit?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe('Action failed. Try again.')
    expect(dom.window.document.body.textContent).not.toContain('unsafe')
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('AgentQuestionCard runs the primary success effect from the hook pipeline', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () =>
      new dom.window.Response(JSON.stringify({ ...question, status: 'answered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  const onAnswered = mock(async () => {})
  const secondaryAnswered = mock(async () => {})
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentQuestionCard
            question={question}
            onAnswered={onAnswered}
            secondaryAction={{ label: 'Confirm secondary', onAnswered: secondaryAnswered }}
          />
        </QueryClientProvider>
      )
    )
    const primary = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Confirm'
    )
    await dom.act(async () => {
      primary?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(onAnswered).toHaveBeenCalledTimes(1)
    expect(secondaryAnswered).not.toHaveBeenCalled()
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})

test('AgentQuestionCard completes the selected secondary effect after pending-action invalidation unmounts it', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const rendered = dom.createRoot()
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(
    async () =>
      new dom.window.Response(JSON.stringify({ ...question, status: 'answered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.invalidateQueries = mock(async ({ queryKey }: { queryKey?: readonly unknown[] }) => {
    if (JSON.stringify(queryKey) === JSON.stringify(queryKeys.actions.pending())) {
      flushSync(() => rendered.root.render(<p>Action removed</p>))
    }
  }) as typeof queryClient.invalidateQueries
  const primary = mock(async () => {})
  const secondary = mock(async () => {})

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <AgentQuestionCard
            question={question}
            onAnswered={primary}
            secondaryAction={{ label: 'Confirm + go', onAnswered: secondary }}
          />
        </QueryClientProvider>
      )
    )
    const secondaryButton = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Confirm + go'
    )
    await dom.act(async () => {
      secondaryButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(dom.window.document.body.textContent).toContain('Action removed')
    expect(secondary).toHaveBeenCalledTimes(1)
    expect(primary).not.toHaveBeenCalled()
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
})
