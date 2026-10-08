import { describe, expect, it } from 'bun:test'
import { PendingInterventionQueue, type PendingInterventionQueueDeps } from './intervention-queue'

interface Recorded {
  steers: string[]
  followUps: string[]
  resets: string[]
}

function makeQueue(opts: {
  pending?: Array<{ id: string; content: string; metadata?: any }>
  claimReturns?: (id: string) => any
  active?: () => boolean
  onDelivered?: () => void
  steerError?: Error
  /** When set, steerError only throws for this content (later rows deliver). */
  steerErrorContent?: string
  prepare?: PendingInterventionQueueDeps['prepare']
}) {
  const recorded: Recorded = { steers: [], followUps: [], resets: [] }
  const pending = opts.pending ?? []
  const deps: PendingInterventionQueueDeps = {
    deliveryOwner: { generation: 'session-1', executionId: 'exec-1' },
    agentId: 'agent-1',
    agent: {
      listPendingInterventionsForSessionDelivery: async () => pending as any,
      claimPendingInterventionForSessionDelivery: async (id: string) =>
        (opts.claimReturns ?? ((x: string) => pending.find((p) => p.id === x)))(id) as any,
      resetPendingInterventionSessionDelivery: async (id: string) => {
        recorded.resets.push(id)
      },
    } as any,
    getSession: () =>
      ({
        pi: {
          steer: async (text: string) => {
            if (opts.steerError && (opts.steerErrorContent === undefined || text === opts.steerErrorContent)) {
              throw opts.steerError
            }
            recorded.steers.push(text)
            opts.onDelivered?.()
          },
          followUp: async (text: string) => {
            recorded.followUps.push(text)
            opts.onDelivered?.()
          },
        },
      }) as any,
    isActive: opts.active ?? (() => true),
    loadImages: async () => [],
    markImagesUsed: async () => 0,
    ...(opts.prepare ? { prepare: opts.prepare } : {}),
  }
  return { queue: new PendingInterventionQueue(deps), recorded }
}

describe('PendingInterventionQueue', () => {
  it('lets the runner add routing context to a claimed message before the model reads it', async () => {
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const prepared: string[] = []
    const { queue, recorded } = makeQueue({
      pending: [{ id: 'm1', content: 'Fix the crash', metadata: { source: 'user_chat' } }],
      onDelivered: () => finish(),
      prepare: async (message) => {
        prepared.push(message.id)
        return {
          ...message,
          metadata: { ...message.metadata, assistantRouting: { scope: 'general', confidence: 0.8 } },
        }
      },
    })
    queue.schedule()
    await completion
    expect(prepared).toEqual(['m1'])
    expect(recorded.steers[0]).toStartWith('Fix the crash')
    expect(recorded.steers[0]).toContain('Routing hint (decision model): general work')
  })

  it('drains claimed messages, routing steer vs follow-up by deliveryMode', async () => {
    const { queue, recorded } = makeQueue({
      pending: [
        { id: 'm1', content: 'steer me', metadata: {} },
        { id: 'm2', content: 'later', metadata: { deliveryMode: 'follow-up' } },
      ],
    })
    queue.schedule()
    await new Promise((r) => setTimeout(r, 20))
    expect(recorded.steers).toEqual(['steer me'])
    expect(recorded.followUps).toEqual(['later'])
    expect(recorded.resets).toEqual([])
  })

  it('delivers hidden page hints in user turns for steer and follow-up without editing stored text', async () => {
    let delivered = 0
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = [
      { id: 'm1', content: 'Where am I?', metadata: { pagePath: '/squads/tau' } },
      { id: 'm2', content: 'Now here', metadata: { pagePath: '/settings', deliveryMode: 'follow-up' } },
    ]
    const { queue, recorded } = makeQueue({
      pending,
      onDelivered: () => {
        if (++delivered === 2) finish()
      },
    })
    queue.schedule()
    await completion
    expect(recorded.steers[0]).toContain('"pagePath":"/squads/tau"')
    expect(recorded.followUps[0]).toContain('"pagePath":"/settings"')
    expect(pending.map((message) => message.content)).toEqual(['Where am I?', 'Now here'])
  })

  it('does nothing when the session is not active', async () => {
    const { queue, recorded } = makeQueue({
      pending: [{ id: 'm1', content: 'steer me', metadata: {} }],
      active: () => false,
    })
    queue.schedule()
    await new Promise((r) => setTimeout(r, 20))
    expect(recorded.steers).toEqual([])
  })

  it('skips rows another consumer already claimed', async () => {
    const { queue, recorded } = makeQueue({
      pending: [{ id: 'm1', content: 'raced', metadata: {} }],
      claimReturns: () => null,
    })
    queue.schedule()
    await new Promise((r) => setTimeout(r, 20))
    expect(recorded.steers).toEqual([])
    expect(recorded.resets).toEqual([])
  })

  it('resets the claim when delivery throws, and keeps draining later rows', async () => {
    const { queue, recorded } = makeQueue({
      pending: [
        { id: 'm1', content: 'boom', metadata: {} },
        { id: 'm2', content: 'still delivered', metadata: {} },
      ],
      steerError: new Error('sdk rejected'),
      steerErrorContent: 'boom',
    })
    queue.schedule()
    await new Promise((r) => setTimeout(r, 20))
    expect(recorded.resets).toEqual(['m1'])
    // The failed row must not stop the drain: the next row still delivers.
    expect(recorded.steers).toEqual(['still delivered'])
  })

  it('clear() unsubscribes so a later message.created does not drain', async () => {
    const { eventEmitter } = await import('../../lib/infra/event-emitter')
    const { queue, recorded } = makeQueue({ pending: [{ id: 'm1', content: 'steer me', metadata: {} }] })
    queue.start()
    await new Promise((r) => setTimeout(r, 20))
    const before = recorded.steers.length
    queue.clear()
    eventEmitter.emit('message.created', { agentId: 'agent-1' } as any)
    await new Promise((r) => setTimeout(r, 20))
    expect(recorded.steers.length).toBe(before)
  })
})

it('closing during claim prevents SDK enqueue and waits for the fenced claim reset', async () => {
  let started!: () => void
  let release!: () => void
  const claimed = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const resets: any[] = []
  const delivered: any[] = []
  const owner = { generation: 'A', executionId: 'exec-A' }
  const claim = { id: 'claim-A', ...owner }
  const queue = new PendingInterventionQueue({
    agentId: 'agent',
    deliveryOwner: owner,
    agent: {
      listPendingInterventionsForSessionDelivery: async () => [{ id: 'U' }] as any,
      claimPendingInterventionForSessionDelivery: async () => {
        started()
        await gate
        return { id: 'U', content: 'same', metadata: { sessionDelivery: claim } } as any
      },
      resetPendingInterventionSessionDelivery: async (
        ...args: Parameters<PendingInterventionQueueDeps['agent']['resetPendingInterventionSessionDelivery']>
      ) => {
        resets.push(args)
      },
    } as any,
    getSession: () =>
      ({
        pi: {
          steer: (...args: any[]) => {
            delivered.push(args)
          },
        },
      }) as any,
    isActive: () => true,
  })
  queue.start()
  await claimed
  const closed = queue.close()
  release()
  await closed
  expect(delivered).toEqual([])
  expect(resets).toEqual([['U', claim]])
})
