import { afterEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, getByRole, getByText, queryByRole, queryByText, waitFor, within } from '@testing-library/dom'
import type { Agent, AgentQuestion, Squad, WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { WorkStreamDetailModal } from './WorkStreamDetailModal'

const now = new Date('2026-01-01T00:00:00Z')
const squad: Squad = {
  id: 'squad-1',
  name: 'Ops',
  purpose: 'Run things',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  createdAt: now,
  updatedAt: now,
}

const question: AgentQuestion = {
  id: 'q-1',
  agentId: 'agent-1',
  squadId: squad.id,
  ownerUserId: null,
  executionId: null,
  audienceResolution: 'unroutable',
  questionData: {
    questions: [
      {
        id: 'rpc',
        type: 'select',
        question: 'Switch the testnet RPC?',
        options: [{ value: 'wait' }, { value: 'switch' }],
      },
    ],
  },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: now.toISOString(),
  answeredAt: null,
}

function questionWorkStream(): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Health check',
    description: '',
    status: 'active',
    derivedState: 'waiting_on_answer',
    openWaits: [
      {
        id: 'wait-q',
        workStreamId: 'ws-1',
        type: 'question',
        referenceId: 'q-1',
        message: 'Switch the testnet RPC?',
        createdBy: 'agent',
        createdByAgentId: 'agent-1',
        createdByUserId: null,
        completesOnApproval: false,
        openedAt: now.toISOString(),
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
    ],
    assigneeAgentId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'deliverable',
    createdAt: now,
    updatedAt: now,
  }
}

describe('WorkStreamDetailModal question waits', () => {
  let cleanup: (() => Promise<void>) | undefined
  const realFetch = globalThis.fetch
  afterEach(async () => {
    globalThis.fetch = realFetch
    await cleanup?.()
    cleanup = undefined
  })

  async function render(
    seedQuestions: AgentQuestion[] | 'forbidden' | 'loading' | 'error' | 'answered',
    options: {
      workStream?: WorkStream
      metrics?: 'present' | 'loading'
      focusWaitId?: string
    } = {}
  ) {
    const posts: Array<{ url: string; body: string }> = []
    // Keep unrelated modal queries disabled; exercise the real question and metrics queries.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false }, mutations: { retry: false } },
    })
    queryClient.setQueryDefaults(queryKeys.squads.workStreamMetrics('ws-1'), { enabled: true })
    queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['workstreams:read', 'agents:read'] })
    const pendingResponses: Array<() => void> = []
    const dom = await acquireDomHarness({
      url: 'http://localhost/work-streams/ws-1',
      beforeUnmount: async () => {
        await queryClient.cancelQueries()
        pendingResponses.forEach((resolve) => resolve())
      },
      afterUnmount: () => queryClient.clear(),
    })
    cleanup = () => dom.cleanup()
    const json = (body: unknown, status = 200) =>
      new dom.window.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'object' && 'url' in input ? input.url : String(input)
      if (init?.method === 'POST') {
        posts.push({ url, body: String(init.body) })
        return json({ ...question, status: 'answered', answer: 'switch' })
      }
      if (
        (url.includes('?metrics=true') && options.metrics === 'loading') ||
        (url.includes('/agent-questions/by-agent/') && seedQuestions === 'loading')
      ) {
        return new Promise<Response>((resolve) => {
          pendingResponses.push(() => resolve(json(null)))
        })
      }
      if (url.includes('/agent-questions/by-agent/')) {
        if (seedQuestions === 'forbidden') return json({ error: 'Forbidden' }, 403)
        if (seedQuestions === 'error') return json({ error: 'Unavailable' }, 500)
        return json(posts.length || seedQuestions === 'answered' ? [] : seedQuestions)
      }
      if (url.includes('?metrics=true')) return json({ metrics: null })
      // Unexpected requests fail cleanly without reaching a real backend.
      return json({ error: 'not mocked' }, 404)
    }) as unknown as typeof fetch
    if (options.metrics === 'present') {
      queryClient.setQueryData(queryKeys.squads.workStreamMetrics('ws-1'), {
        cost: 0.25,
        tokens: { input: 100, output: 200, total: 300, cacheRead: 0, cacheWrite: 0 },
        executions: { completed: 1, total: 2 },
        byAgent: {},
      })
    }
    const rendered = dom.createRoot()
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WorkStreamDetailModal
              workStream={options.workStream ?? questionWorkStream()}
              focusWaitId={options.focusWaitId}
              squadMap={new Map([[squad.id, squad]])}
              agentMap={new Map<string, Agent>()}
              onClose={() => undefined}
            />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    // Deliberately loading responses are released during cleanup.
    await dom.act(async () => {
      await waitFor(() =>
        expect(queryClient.isFetching()).toBe(
          Number(options.metrics === 'loading') + Number(seedQuestions === 'loading')
        )
      )
    })
    return { body: dom.window.document.body, posts, dom, queryClient }
  }

  test('renders the open question with its answer form and posts the answer', async () => {
    const { body, posts, dom, queryClient } = await render([question])
    // The wait's own message renders immediately; the answer form arrives once the
    // agent's question list loads, so wait for the form itself.
    const findSubmit = () => [...body.querySelectorAll('button')].find((b) => /Submit Answer/.test(b.textContent ?? ''))
    await dom.act(async () => {
      await waitFor(() => expect(findSubmit()).toBeDefined(), { timeout: 2000 })
    })
    const submit = findSubmit()
    expect(submit?.disabled).toBe(true)
    queryClient.setQueryData(queryKeys.squads.workStreamDetail('ws-1'), questionWorkStream())
    expect(body.textContent).toContain('Switch the testnet RPC?')
    const link = [...body.querySelectorAll('a')].find((a) => a.textContent === 'Open agent thread')
    expect(link?.getAttribute('href')).toContain('agent=agent-1')
    const option = body.querySelector('input[type="radio"][value="switch"]') as HTMLInputElement | null
    expect(option).not.toBeNull()
    await dom.act(async () => {
      fireEvent.click(option!)
    })
    await dom.act(async () => {
      fireEvent.click(submit!)
    })
    await dom.act(async () => {
      await waitFor(() => expect(posts.some((p) => p.url.includes('/agent-questions/q-1/answer'))).toBe(true), {
        timeout: 2000,
      })
    })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]!.body)).toEqual({ answer: 'switch' })
    await dom.act(async () => {
      await waitFor(() => {
        expect(body.textContent).toContain('This question has been answered')
        expect(queryClient.getQueryState(queryKeys.squads.workStreamDetail('ws-1'))?.isInvalidated).toBe(true)
      })
    })
    expect(findSubmit()).toBeUndefined()
  })

  test('explains when the question is not visible to this user', async () => {
    const { body, dom } = await render('forbidden')
    await dom.act(async () => {
      await waitFor(() => expect(body.textContent).toContain("You can't view this agent's questions"), {
        timeout: 2000,
      })
    })
    expect([...body.querySelectorAll('button')].some((b) => /Submit Answer/.test(b.textContent ?? ''))).toBe(false)
  })

  test('places the question section immediately after top details and before metrics and other waits', async () => {
    const workStream = questionWorkStream()
    const questionWait = { ...workStream.openWaits![0]!, flowAttemptId: 2 }
    workStream.openWaits = [
      questionWait,
      { ...questionWait, id: 'dependency-wait', type: 'dependency', message: 'Waiting for prerequisite' },
    ]
    const { body, dom } = await render([question], { workStream, metrics: 'present' })
    await dom.act(async () => {
      await waitFor(() => expect(queryByRole(body, 'button', { name: 'Submit Answer' })).not.toBeNull())
    })
    const section = getByRole(body, 'region', { name: 'Pending questions' })
    const topDetails = getByText(body, 'Completion').parentElement!.parentElement!
    expect(topDetails.nextElementSibling).toBe(section)
    expect(section.nextElementSibling?.contains(getByText(body, 'Cost:'))).toBe(true)
    expect(
      section.compareDocumentPosition(getByText(body, 'Open Waits')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(section).getAllByRole('button', { name: 'Submit Answer' })).toHaveLength(1)
    expect(within(body).getAllByRole('button', { name: 'Submit Answer' })).toHaveLength(1)
    expect(within(section).getByText('Attempt 2')).toBeTruthy()
    expect(within(section).getByText(now.toLocaleString())).toBeTruthy()
    const otherWaits = getByText(body, 'Open Waits').parentElement!
    expect(within(otherWaits).getByText('Waiting for prerequisite')).toBeTruthy()
    expect(otherWaits.querySelector('input')).toBeNull()
    expect(otherWaits.textContent).not.toContain('Switch the testnet RPC?')
  })

  test.each(['absent', 'loading'] as const)('keeps questions above the body when metrics are %s', async (metrics) => {
    const { body, dom } = await render([question], { metrics: metrics === 'loading' ? metrics : undefined })
    await dom.act(async () => {
      await waitFor(() => expect(queryByRole(body, 'button', { name: 'Submit Answer' })).not.toBeNull())
    })
    const section = getByRole(body, 'region', { name: 'Pending questions' })
    const topDetails = getByText(body, 'Completion').parentElement!.parentElement!
    expect(topDetails.nextElementSibling).toBe(section)
    expect(queryByText(body, 'Cost:')).toBeNull()
    expect(queryByText(body, 'Open Waits')).toBeNull()
    if (metrics === 'loading') {
      expect(section.nextElementSibling?.getAttribute('aria-label')).toBe('Loading work stream metrics')
    }
  })

  test('omits the question section when only other waits and question history remain', async () => {
    const workStream = questionWorkStream()
    const questionWait = workStream.openWaits![0]!
    workStream.openWaits = [{ ...questionWait, id: 'dependency-wait', type: 'dependency', message: 'Prerequisite' }]
    workStream.waitHistory = [{ ...questionWait, closedAt: now.toISOString(), resolution: 'answered' }]
    const { body } = await render([], { workStream, metrics: 'present' })
    expect(queryByRole(body, 'region', { name: 'Pending questions' })).toBeNull()
    expect(queryByRole(body, 'button', { name: 'Submit Answer' })).toBeNull()
    const topDetails = getByText(body, 'Completion').parentElement!.parentElement!
    expect(topDetails.nextElementSibling?.contains(getByText(body, 'Cost:'))).toBe(true)
    expect(getByText(body, 'Open Waits').parentElement!.textContent).toContain('Prerequisite')
    expect(getByText(body, 'Wait history (1)').parentElement!.textContent).toContain('Answered')
  })

  test('renders multiple question cards once and preserves question focus without selecting another wait', async () => {
    const workStream = questionWorkStream()
    const questionWait = workStream.openWaits![0]!
    workStream.openWaits = [
      { ...questionWait, id: 'review-wait', type: 'review', message: 'Review separately' },
      questionWait,
      { ...questionWait, id: 'wait-q-2', referenceId: 'q-2', message: 'Choose a region' },
    ]
    const secondQuestion: AgentQuestion = {
      ...question,
      id: 'q-2',
      questionData: { questions: [{ id: 'region', type: 'text', question: 'Which region?' }] },
    }
    const { body, dom } = await render([question, secondQuestion], { workStream, focusWaitId: 'wait-q-2' })
    await dom.act(async () => {
      await waitFor(() => expect(within(body).queryAllByRole('button', { name: 'Submit Answer' })).toHaveLength(2))
    })
    const section = getByRole(body, 'region', { name: 'Pending questions' })
    expect(section.querySelectorAll('li')).toHaveLength(2)
    expect(within(section).getAllByRole('button', { name: 'Submit Answer' })).toHaveLength(2)
    expect(within(section).getAllByRole('link', { name: 'Open agent thread' })).toHaveLength(2)
    expect(dom.window.document.activeElement).toBe(within(section).getByRole('textbox'))
    expect(queryByText(body, 'This focused action is no longer pending.')).toBeNull()
    expect(queryByRole(body, 'button', { name: 'Approve checkpoint' })).toBeNull()
    expect(getByText(body, 'Open Waits').parentElement!.textContent).toContain('Review separately')
  })

  test.each([
    ['loading', 'Loading question…'],
    ['error', 'Unable to load this question.'],
    ['forbidden', "You can't view this agent's questions."],
    ['answered', 'This question has been answered; the wait clears once the agent resumes.'],
  ] as const)('keeps the %j question state in the top section', async (seed, message) => {
    const { body, dom } = await render(seed)
    await dom.act(async () => {
      await waitFor(() => expect(body.textContent).toContain(message))
    })
    const section = getByRole(body, 'region', { name: 'Pending questions' })
    expect(section.textContent).toContain(message)
    expect(within(section).queryByRole('button', { name: 'Submit Answer' })).toBeNull()
    expect(queryByText(body, 'Open Waits')).toBeNull()
  })
})
