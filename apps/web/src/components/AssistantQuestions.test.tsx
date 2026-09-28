import { expect, mock, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssistantActivityUpdate, AssistantTaskSummary } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { AssistantTaskQuestions, AssistantAgentQuestions } from './AssistantQuestions'

const task: AssistantTaskSummary = {
  id: 'task',
  currentRequestId: 'request',
  agentId: 'agent',
  kind: 'background',
  squadId: null,
  label: 'Inspect storage',
  status: 'needs-input',
  unavailable: false,
  createdAt: '',
  updatedAt: '',
}
const update: AssistantActivityUpdate = {
  messageId: 'question',
  taskId: task.id,
  requestId: task.currentRequestId,
  sequence: 1,
  reportedStatus: 'needs-input',
  content: 'Which directory can I inspect?',
  subject: null,
  senderName: 'Assistant task',
  processedAt: '2026-09-20',
  seenAt: '2026-09-20',
  createdAt: '2026-09-20',
}
async function fixture() {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.voice.status(), { enabled: false })
  const { root, container } = dom.createRoot()
  const reply = mock(async (_task: AssistantTaskSummary, _update: AssistantActivityUpdate, _answer: string) => {})
  const render = (overrides: Partial<Parameters<typeof AssistantTaskQuestions>[0]> = {}) =>
    root.render(
      <QueryClientProvider client={client}>
        <AssistantTaskQuestions tasks={[task]} updates={[update]} onReply={reply} {...overrides} />
      </QueryClientProvider>
    )
  const answer = async (text: string) => {
    await dom.act(async () => fireEvent.change(container.querySelector('textarea')!, { target: { value: text } }))
    await dom.act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit Answer')!.click()
    )
  }
  return {
    dom,
    client,
    container,
    root,
    reply,
    render,
    answer,
    cleanup: async () => {
      await dom.cleanup()
      client.clear()
    },
  }
}

test('a seen, processed task question stays answerable and replies to its exact update', async () => {
  const f = await fixture()
  try {
    await f.dom.act(async () => f.render({ focusTaskId: task.id }))
    expect(f.container.textContent).toContain(update.content)
    expect(document.activeElement).toBe(f.container.querySelector('textarea'))
    await f.answer('Inspect only the build cache')
    expect(f.reply.mock.calls).toEqual([[task, update, 'Inspect only the build cache']])
    expect(f.container.querySelector('textarea')).toBeNull()
    expect(f.container.textContent).toContain('Answer sent')
  } finally {
    await f.cleanup()
  }
})

test('failed task answers retain the form and answer for an explicit retry', async () => {
  const f = await fixture()
  try {
    f.reply.mockRejectedValueOnce(new Error('Temporarily unavailable'))
    await f.dom.act(async () => f.render())
    await f.answer('Keep the sources')
    expect(f.container.querySelector('[role="alert"]')?.textContent).toBe('Temporarily unavailable')
    expect(f.container.querySelector('textarea')?.value).toBe('Keep the sources')
    await f.answer('Keep the sources')
    expect(f.reply).toHaveBeenCalledTimes(2)
    expect(f.container.textContent).toContain('Answer sent')
  } finally {
    await f.cleanup()
  }
})

test('only the latest question for the current request is answerable; completed and unavailable tasks cannot send', async () => {
  const f = await fixture()
  try {
    const latest = { ...update, messageId: 'latest', sequence: 2, content: 'Latest question' }
    await f.dom.act(async () =>
      f.render({
        updates: [
          update,
          latest,
          { ...update, messageId: 'stale', requestId: 'older-request', sequence: 3, content: 'Stale question' },
        ],
      })
    )
    expect(f.container.textContent).toContain('Latest question')
    expect(f.container.textContent).not.toContain('Stale question')
    expect(f.container.textContent).not.toContain(update.content)
    await f.dom.act(async () => f.render({ tasks: [{ ...task, unavailable: true }] }))
    expect(f.container.querySelector('textarea')).toBeNull()
    expect(f.container.textContent).toContain('unavailable')
    await f.dom.act(async () => f.render({ tasks: [{ ...task, status: 'completed' }] }))
    expect(f.container.textContent).toBe('')
    expect(f.reply).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})

test('ordinary assistant-agent questions use the normal pending-question form', async () => {
  const f = await fixture()
  try {
    f.client.setQueryData(queryKeys.agentQuestions.byAgent('agent', 'open'), [
      {
        id: 'ordinary-question',
        agentId: 'agent',
        status: 'open',
        questionData: { questions: [{ id: 'choice', question: 'Which branch?', type: 'text' }] },
      },
    ])
    await f.dom.act(async () =>
      f.root.render(
        <QueryClientProvider client={f.client}>
          <AssistantAgentQuestions agentIds={['agent']} />
        </QueryClientProvider>
      )
    )
    const button = [...f.container.querySelectorAll('button')].find((row) =>
      row.textContent?.includes('1 pending question')
    )!
    await f.dom.act(async () => button.click())
    expect(document.body.textContent).toContain('Which branch?')
    expect(document.body.querySelector('textarea')).not.toBeNull()
  } finally {
    await f.cleanup()
  }
})
