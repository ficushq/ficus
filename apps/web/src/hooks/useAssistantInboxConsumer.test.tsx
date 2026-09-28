import { expect, mock, test } from 'bun:test'
import type { AssistantEntry, AssistantMailbox, AssistantMailboxUpdate } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import type { AssistantCatchUpBatch } from '../voice/assistantCatchUp'
import { useAssistantInboxConsumer, type AssistantInboxScheduler } from './useAssistantInboxConsumer'

const conversationId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
const update = (index: number): AssistantMailboxUpdate => ({
  messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  taskId: '10000000-0000-4000-8000-000000000001',
  requestId: '20000000-0000-4000-8000-000000000001',
  sequence: index,
  reportedStatus: index === 3 ? 'completed' : null,
  content: `Update ${index}`,
  subject: null,
  senderId: 'agent-1',
  senderName: 'Assistant task',
  processedAt: null,
  seenAt: null,
  createdAt: '2026-09-15T00:00:00.000Z',
})

function fakeScheduler() {
  const queue: Array<{ callback: () => void; handle: number }> = []
  let next = 1
  const scheduler: AssistantInboxScheduler = {
    setTimeout: (callback) => {
      const handle = next++
      queue.push({ callback, handle })
      return handle
    },
    clearTimeout: (handle) => {
      const index = queue.findIndex((entry) => entry.handle === handle)
      if (index >= 0) queue.splice(index, 1)
    },
  }
  return {
    scheduler,
    pending: () => queue.length,
    tick: () => {
      const entry = queue.shift()
      entry?.callback()
    },
  }
}

async function fixture(options: { realtime?: boolean; enabled?: boolean } = {}) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const clock = fakeScheduler()
  let mailbox: AssistantMailbox = { acquired: true, messages: [], pending: 0, unavailable: false }
  const api = {
    inbox: mock(async () => mailbox),
    acknowledge: mock(async (_id: string, _consumer: string, _ids: string[], _entry: string) => ({})),
    release: mock(async () => ({})),
  }
  const appended: AssistantEntry[] = []
  const append = mock(async (entries: AssistantEntry[]) => {
    appended.push(...entries)
  })
  const presentations: Array<{ batch: AssistantCatchUpBatch; entry: AssistantEntry; finish: () => void }> = []
  const present = mock(
    (batch: AssistantCatchUpBatch, entry: AssistantEntry) =>
      new Promise<void>((resolve) => presentations.push({ batch, entry, finish: resolve }))
  )
  const mailboxes: Array<{ pending: number; unavailable: boolean }> = []
  const errors: boolean[] = []
  let enabled = options.enabled ?? true
  function Probe() {
    useAssistantInboxConsumer({
      conversationId,
      enabled,
      realtime: options.realtime ?? true,
      api,
      append,
      present,
      onMailbox: (state) => mailboxes.push(state),
      onError: (failed) => errors.push(failed),
      scheduler: clock.scheduler,
    })
    return null
  }
  const { root } = dom.createRoot()
  const render = () => root.render(<Probe />)
  await dom.act(async () => render())
  const flush = () => dom.act(async () => {})
  return {
    dom,
    api,
    append,
    appended,
    present,
    presentations,
    mailboxes,
    errors,
    clock,
    flush,
    setMailbox: (next: Partial<AssistantMailbox>) => {
      mailbox = { ...mailbox, ...next }
    },
    setEnabled: async (value: boolean) => {
      enabled = value
      await dom.act(async () => render())
    },
    poll: () =>
      dom.act(async () => {
        clock.tick()
        await Promise.resolve()
      }),
    cleanup: async () => {
      await dom.act(async () => root.unmount())
      await dom.cleanup()
    },
  }
}

test('a disabled surface never leases the mailbox', async () => {
  const f = await fixture({ enabled: false })
  try {
    await f.flush()
    expect(f.api.inbox).not.toHaveBeenCalled()
    expect(f.clock.pending()).toBe(0)
  } finally {
    await f.cleanup()
    expect(f.api.release).not.toHaveBeenCalled()
  }
})

test('catch-up saves one final entry naming the batch, presents once, then acknowledges exactly those IDs', async () => {
  const f = await fixture()
  try {
    f.setMailbox({ messages: [update(1), update(2), update(3)], pending: 1 })
    await f.poll()
    await f.flush()
    expect(f.mailboxes.at(-1)).toEqual({ pending: 1, unavailable: false })
    expect(f.appended).toHaveLength(1)
    const entry = f.appended[0]
    expect(entry).toMatchObject({
      id: `inbox:${update(1).messageId}`,
      role: 'tool',
      final: true,
      toolName: 'assistant_inbox',
      assistantUpdateIds: [update(1).messageId, update(2).messageId, update(3).messageId],
    })
    expect(JSON.parse(entry.toolResult!).updates).toHaveLength(3)
    expect(f.present).toHaveBeenCalledTimes(1)
    expect(f.api.acknowledge).not.toHaveBeenCalled()
    // Further polls while the batch is in flight neither re-present nor acknowledge.
    await f.poll()
    await f.flush()
    expect(f.present).toHaveBeenCalledTimes(1)
    expect(f.api.acknowledge).not.toHaveBeenCalled()
    await f.dom.act(async () => f.presentations[0].finish())
    await f.flush()
    expect(f.api.acknowledge).toHaveBeenCalledTimes(1)
    const [id, consumer, ids, responseEntryId] = f.api.acknowledge.mock.calls[0]
    expect(id).toBe(conversationId)
    expect(typeof consumer).toBe('string')
    expect(ids).toEqual(entry.assistantUpdateIds)
    expect(responseEntryId).toBe(entry.id)
    // A later update starts a new batch only after the first finished; already-presented IDs are skipped.
    f.setMailbox({ messages: [update(3), update(4)] })
    await f.poll()
    await f.flush()
    expect(f.present).toHaveBeenCalledTimes(2)
    expect(f.presentations[1].batch.messageIds).toEqual([update(4).messageId])
  } finally {
    await f.cleanup()
    expect(f.api.release).toHaveBeenCalledTimes(1)
  }
})

test('a failed save prevents presentation and acknowledgment; the updates are retried later', async () => {
  const f = await fixture()
  try {
    f.append.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    f.setMailbox({ messages: [update(1)] })
    await f.poll()
    await f.flush()
    expect(f.present).not.toHaveBeenCalled()
    expect(f.api.acknowledge).not.toHaveBeenCalled()
    expect(f.errors.at(-1)).toBe(true)
    await f.poll()
    await f.flush()
    expect(f.appended).toHaveLength(1)
    expect(f.present).toHaveBeenCalledTimes(1)
  } finally {
    await f.cleanup()
  }
})

test('a failed acknowledgment retries on the next poll without presenting a second response', async () => {
  const f = await fixture()
  try {
    f.api.acknowledge.mockImplementationOnce(async () => {
      throw new Error('409')
    })
    f.setMailbox({ messages: [update(1)] })
    await f.poll()
    await f.flush()
    await f.dom.act(async () => f.presentations[0].finish())
    await f.flush()
    expect(f.api.acknowledge).toHaveBeenCalledTimes(1)
    expect(f.errors.at(-1)).toBe(true)
    await f.poll()
    await f.flush()
    expect(f.api.acknowledge).toHaveBeenCalledTimes(2)
    expect(f.api.acknowledge.mock.calls[1][2]).toEqual([update(1).messageId])
    expect(f.present).toHaveBeenCalledTimes(1)
    expect(f.errors.at(-1)).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('losing the lease stops new presentation and keeps the first progress reply from clearing task state', async () => {
  const f = await fixture()
  try {
    f.setMailbox({ acquired: false, messages: [update(1)], pending: 2 })
    await f.poll()
    await f.flush()
    expect(f.present).not.toHaveBeenCalled()
    expect(f.mailboxes.at(-1)).toEqual({ pending: 2, unavailable: false })
    f.setMailbox({ acquired: true, pending: 2, unavailable: true })
    await f.poll()
    await f.flush()
    expect(f.present).toHaveBeenCalledTimes(1)
    expect(f.mailboxes.at(-1)).toEqual({ pending: 2, unavailable: true })
  } finally {
    await f.cleanup()
  }
})

test('the text assistant appends each update as its own reply before acknowledging it', async () => {
  const f = await fixture({ realtime: false })
  try {
    f.setMailbox({ messages: [update(1), update(2)] })
    await f.poll()
    await f.flush()
    expect(f.present).not.toHaveBeenCalled()
    expect(f.appended.map((entry) => [entry.role, entry.text, entry.assistantUpdateIds])).toEqual([
      ['assistant', 'Update 1', [update(1).messageId]],
      ['assistant', 'Update 2', [update(2).messageId]],
    ])
    expect(f.api.acknowledge.mock.calls.map((call) => call[2])).toEqual([[update(1).messageId], [update(2).messageId]])
  } finally {
    await f.cleanup()
  }
})

test('disabling releases only this consumer and re-enabling resumes with the same identity', async () => {
  const f = await fixture()
  try {
    await f.poll()
    const consumer = f.api.inbox.mock.calls[0][1]
    await f.setEnabled(false)
    expect(f.api.release).toHaveBeenCalledWith(conversationId, consumer)
    expect(f.clock.pending()).toBe(0)
    await f.setEnabled(true)
    await f.flush()
    expect(f.api.inbox.mock.calls.at(-1)?.[1]).toBe(consumer)
  } finally {
    await f.cleanup()
  }
})
