import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { AgentQuestion } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queries } from '../queryOptions'
import type { ToolInlineAction } from '../lib/tool-inline-actions'
import { ToolInlineActionModal } from './ToolInlineActionModal'

const question: AgentQuestion = {
  id: 'question-1',
  agentId: 'agent-1',
  squadId: 'squad-1',
  ownerUserId: 'user-1',
  executionId: 'execution-1',
  audienceResolution: 'resolved',
  questionData: { questions: [{ id: 'q', type: 'text', question: 'Ship the release today?' }] },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: '2026-10-27T00:00:00.000Z',
  answeredAt: null,
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

async function render(action: ToolInlineAction, seed: (client: QueryClient) => void, onClose = () => {}) {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/agent-1' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seed(client)
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/chat/agent-1']}>
          <ToolInlineActionModal action={action} scope={{ agentId: 'agent-1', squadId: 'squad-1' }} onClose={onClose} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  return { document: dom.window.document, cleanup: () => dom.cleanup() }
}

const hasButton = (document: Document, label: string) =>
  [...document.querySelectorAll('button')].some((button) => button.textContent?.includes(label))

const questionAction: ToolInlineAction = {
  kind: 'question',
  key: 'question:question-1',
  label: 'View question',
  questionId: 'question-1',
}

test('a question opens answerable in place while it is open', async () => {
  const { document, cleanup } = await render(questionAction, (client) =>
    client.setQueryData(queries.agentQuestions.byAgent('agent-1').queryKey, [question])
  )
  try {
    expect(document.body.textContent).toContain('Agent question')
    expect(document.body.textContent).toContain('Ship the release today?')
    expect(hasButton(document, 'Submit Answer')).toBe(true)
  } finally {
    await cleanup()
  }
})

test('an answered question opens read-only', async () => {
  const answered: AgentQuestion = {
    ...question,
    status: 'answered',
    answer: JSON.stringify({ q: 'Yes' }),
    answeredByUserId: 'user-1',
    answeredAt: '2026-10-27T01:00:00.000Z',
  }
  const { document, cleanup } = await render(questionAction, (client) =>
    client.setQueryData(queries.agentQuestions.byAgent('agent-1').queryKey, [answered])
  )
  try {
    expect(document.body.textContent).toContain('Ship the release today?')
    expect(hasButton(document, 'Submit Answer')).toBe(false)
  } finally {
    await cleanup()
  }
})

test('a question that is gone says so', async () => {
  const { document, cleanup } = await render(questionAction, (client) =>
    client.setQueryData(queries.agentQuestions.byAgent('agent-1').queryKey, [])
  )
  try {
    expect(document.body.textContent).toContain('This question is no longer available.')
  } finally {
    await cleanup()
  }
})

test('a work stream navigates to its page in its own squad and closes', async () => {
  let closed = 0
  const { document, cleanup } = await render(
    { kind: 'work_stream', key: 'work_stream:829', label: 'Open work stream #829', workStreamRef: '829' },
    (client) => {
      client.setQueryData(queries.squads.workStreamDetail('829').queryKey, {
        id: 'ws-uuid',
        number: 829,
        squadId: 'squad-2',
      } as never)
      client.setQueryData(queries.squads.list().queryKey, [{ id: 'squad-2', name: 'Ficus', slug: 'ficus' }] as never)
    },
    () => closed++
  )
  try {
    expect(document.querySelector('[data-testid="location"]')!.textContent).toBe('/squads/ficus/work?ws=829')
    expect(closed).toBe(1)
  } finally {
    await cleanup()
  }
})
