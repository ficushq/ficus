import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import {
  agentQuestions,
  agents,
  db,
  executions,
  inbox,
  messages,
  monitors,
  schedules,
  slotClaims,
  slotPools,
  slotWaiters,
  squads,
  workStreams,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import {
  IDLE_WORKER_GRACE_MS,
  dormantIfIdleWorker,
  findIdleWorkers,
  resetIdleWorkerBackoffForTest,
  runIdleWorkerDormancySweep,
} from './idle-workers'

const HOUR = 60 * 60 * 1000

describe('idle worker dormancy', () => {
  let squadIds: string[]
  let agentIds: string[]
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const cutoff = ago(IDLE_WORKER_GRACE_MS)
  const old = () => ({ lastMessageAt: ago(3 * HOUR), createdAt: ago(48 * HOUR) })

  beforeEach(() => {
    squadIds = []
    agentIds = []
    resetIdleWorkerBackoffForTest()
  })

  afterEach(async () => {
    // Own every fixture: never sweep another test's agents or squads.
    if (agentIds.length) {
      await db.delete(executions).where(inArray(executions.agentId, agentIds))
      await db.delete(messages).where(inArray(messages.agentId, agentIds))
      await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
      await db.delete(slotClaims).where(inArray(slotClaims.ownerAgentId, agentIds))
      await db.delete(slotWaiters).where(inArray(slotWaiters.ownerAgentId, agentIds))
    }
    if (squadIds.length) await db.delete(schedules).where(inArray(schedules.scopeId, [...squadIds, ...agentIds]))
    if (squadIds.length) await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
    if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  })

  async function squad() {
    const created = await Squad.create({ name: `idle-workers-${randomUUID()}`, purpose: 'idle worker fixture' })
    squadIds.push(created.id)
    return created
  }

  async function agent(
    squadId: string,
    fields: {
      lastMessageAt?: Date | null
      createdAt?: Date
      agentTypeId?: string
      status?: Agent['status']
      persist?: boolean
      parentAgentId?: string
    } = {}
  ) {
    const { agentTypeId = 'engineer', ...rest } = fields
    const created = await Agent.create({ agentTypeId, squadId, persist: false })
    agentIds.push(created.id)
    await db
      .update(agents)
      .set({ lastMessageAt: null, createdAt: now, ...rest })
      .where(eq(agents.id, created.id))
    return created
  }

  async function status(id: string) {
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, id))
    return row?.status
  }

  async function idleIds(squadId: string) {
    return (await findIdleWorkers({ now, squadIds: [squadId] })).map((row) => row.id).sort()
  }

  /** A stored stream, optionally moved straight to `status`. */
  async function stream(
    input: Parameters<typeof storedLegacyWorkStream>[0],
    status?: 'queued' | 'active' | 'done' | 'canceled'
  ) {
    const created = await storedLegacyWorkStream(input)
    if (status) await db.update(workStreams).set({ status }).where(eq(workStreams.id, created.id))
    return created
  }

  async function pool(squadId: string) {
    const [row] = await db
      .insert(slotPools)
      .values({ squadId, key: `idle-${randomUUID().slice(0, 8)}`, capacity: 1, createdBy: 'system' })
      .returning()
    return row!
  }

  /** Each kind of in-flight work a worker can have that the platform tracks. */
  const inFlight: Record<string, (squadId: string, agentId: string) => Promise<unknown>> = {
    'live subagent': async (squadId, agentId) => agent(squadId, { parentAgentId: agentId, ...old() }),
    'active monitor': (_squadId, agentId) =>
      db.insert(monitors).values({
        agentId,
        sandboxId: 's',
        label: 'watch',
        command: 'tail -F log',
        status: 'running',
        processId: 'p1',
        timeoutMs: 60_000,
        maxBatchLines: 1,
        maxBatchBytes: 256,
        batchDebounceMs: 100,
      }),
    'held slot claim': async (squadId, agentId) =>
      db
        .insert(slotClaims)
        .values({ poolId: (await pool(squadId)).id, ownerAgentId: agentId, expiresAt: new Date(now.getTime() + HOUR) }),
    'queued slot claim': async (squadId, agentId) =>
      db.insert(slotWaiters).values({ poolId: (await pool(squadId)).id, ownerAgentId: agentId }),
    'open question': (squadId, agentId) =>
      db.insert(agentQuestions).values({
        agentId,
        squadId,
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Ship it?' }] },
      }),
    'reminder it scheduled for itself': (_squadId, agentId) =>
      schedule(agentId, agentId, {
        scopeType: 'agent',
        schedule: { runAt: new Date(now.getTime() + HOUR).toISOString() },
      }),
    'recurring schedule assigned to it': (squadId, agentId) => schedule(squadId, agentId),
    'schedule listing it among its agents': (squadId, agentId) =>
      schedule(squadId, agentId, { action: { type: 'inbox_message', agentIds: [agentId], content: 'x' } }),
    'webhook-only schedule': (squadId, agentId) =>
      schedule(squadId, agentId, { schedule: {}, nextTriggerAt: null, webhookEnabled: true }),
    'answer still being delivered': (squadId, agentId) =>
      db.insert(agentQuestions).values({
        agentId,
        squadId,
        status: 'answered',
        answer: 'yes',
        answerDeliveryStatus: 'pending',
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Ship it?' }] },
      }),
  }

  /** A schedule aimed at the worker; `fields` override the defaults (an enabled hourly reminder). */
  function schedule(squadId: string, agentId: string, fields: Partial<typeof schedules.$inferInsert> = {}) {
    return db.insert(schedules).values({
      scopeType: 'squad',
      scopeId: squadId,
      name: 'reminder',
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId }, content: 'check CI' },
      nextTriggerAt: new Date(now.getTime() + HOUR),
      ...fields,
    })
  }

  it('selects idle workers past the grace, including ones never bound to a stream, and makes them dormant', async () => {
    const own = await squad()
    const finished = await agent(own.id, old())
    await stream({ squadId: own.id, title: 'done work', agentIds: [finished.id] }, 'done')
    const canceled = await agent(own.id, old())
    await stream({ squadId: own.id, title: 'canceled work', agentIds: [canceled.id] }, 'canceled')
    const adHoc = await agent(own.id, { agentTypeId: 'sysops', createdAt: ago(2 * HOUR) })
    const reviewer = await agent(own.id, { agentTypeId: 'reviewer', ...old() })

    expect(await idleIds(own.id)).toEqual([finished.id, canceled.id, adHoc.id, reviewer.id].sort())
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id] })).toBe(4)
    for (const worker of [finished, canceled, adHoc, reviewer]) expect(await status(worker.id)).toBe('dormant')
    // Dormant workers are no longer candidates.
    expect(await idleIds(own.id)).toEqual([])
  })

  it('leaves exempt types, persistent agents, subagents, non-idle agents and the grace period alone', async () => {
    const own = await squad()
    const kept = [
      ...(await Promise.all(
        ['manager', 'system-manager', 'assistant', 'assistant-worker', 'consultant'].map((agentTypeId) =>
          agent(own.id, { agentTypeId, ...old() })
        )
      )),
      await agent(own.id, { persist: true, ...old() }),
      await agent(own.id, { lastMessageAt: ago(30 * 60_000), createdAt: ago(48 * HOUR) }),
      await agent(own.id, { createdAt: ago(30 * 60_000) }),
      await agent(own.id, { status: 'active', ...old() }),
      await agent(own.id, { status: 'waiting-input', ...old() }),
    ]
    const parent = await agent(own.id, { status: 'dormant', ...old() })
    const subagent = await agent(own.id, { parentAgentId: parent.id, ...old() })

    expect(await idleIds(own.id)).toEqual([])
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id] })).toBe(0)
    for (const worker of kept) expect(await status(worker.id)).not.toBe('dormant')
    expect(await status(subagent.id)).toBe('idle')
  })

  it('keeps a worker on an open, reopened or reused stream live: crew, assignee or owner', async () => {
    const own = await squad()
    const crew = await agent(own.id, old())
    const assignee = await agent(own.id, old())
    const owner = await agent(own.id, old())
    const reopened = await agent(own.id, old())
    const reused = await agent(own.id, old())
    const queuedStream = await agent(own.id, old())
    await stream({ squadId: own.id, title: 'crew', agentIds: [crew.id] })
    await stream({ squadId: own.id, title: 'assigned', assigneeAgentId: assignee.id })
    await stream({ squadId: own.id, title: 'owned', ownerAgentId: owner.id })
    const wasDone = await stream({ squadId: own.id, title: 'reopen', agentIds: [reopened.id] }, 'done')
    await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, wasDone.id))
    await stream({ squadId: own.id, title: 'old', agentIds: [reused.id] }, 'done')
    await stream({ squadId: own.id, title: 'new', agentIds: [reused.id] })
    await stream({ squadId: own.id, title: 'parked', agentIds: [queuedStream.id] }, 'queued')

    expect(await idleIds(own.id)).toEqual([])
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id] })).toBe(0)
    for (const worker of [crew, assignee, owner, reopened, reused, queuedStream])
      expect(await status(worker.id)).toBe('idle')
  })

  it('never selects a worker with queued work, a pending message, undelivered mail, a wake or lifecycle request in progress', async () => {
    const own = await squad()
    const queued = await agent(own.id, old())
    const waitingSandbox = await agent(own.id, old())
    const pendingMessage = await agent(own.id, old())
    const undelivered = await agent(own.id, old())
    const waking = await agent(own.id, old())
    const pendingLifecycle = await agent(own.id, old())
    const plain = await agent(own.id, old())
    await db.insert(executions).values({ agentId: queued.id, status: 'queued' })
    await db.insert(executions).values({ agentId: waitingSandbox.id, status: 'waiting-sandbox' })
    await db.insert(messages).values({ agentId: pendingMessage.id, role: 'human', content: 'hello?', pending: true })
    await db
      .insert(inbox)
      .values({ recipientType: 'agent', recipientId: undelivered.id, senderType: 'system', content: 'new mail' })
    await db
      .update(agents)
      .set({ metadata: sql`coalesce(${agents.metadata}, '{}'::jsonb) || '{"wakeCompletionPending":true}'::jsonb` })
      .where(eq(agents.id, waking.id))
    await db
      .update(agents)
      .set({
        metadata: sql`coalesce(${agents.metadata}, '{}'::jsonb) || '{"pendingLifecycleTarget":"terminated"}'::jsonb`,
      })
      .where(eq(agents.id, pendingLifecycle.id))

    expect(await idleIds(own.id)).toEqual([plain.id])
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id] })).toBe(1)
    for (const busy of [queued, waitingSandbox, pendingMessage, undelivered, waking, pendingLifecycle])
      expect(await status(busy.id)).toBe('idle')
    expect(await status(plain.id)).toBe('dormant')
  })

  for (const [kind, start] of Object.entries(inFlight)) {
    it(`keeps a worker live while it has: ${kind}`, async () => {
      const own = await squad()
      const busy = await agent(own.id, old())
      await start(own.id, busy.id)

      expect(await idleIds(own.id)).not.toContain(busy.id)
      await runIdleWorkerDormancySweep({ now, squadIds: [own.id] })
      expect(await status(busy.id)).toBe('idle')
    })

    it(`re-checks under the agent lock after selection: ${kind}`, async () => {
      const own = await squad()
      const busy = await agent(own.id, old())
      await start(own.id, busy.id)

      expect(await dormantIfIdleWorker(busy.id, cutoff)).toEqual({
        outcome: 'skipped',
        reason: 'has live work in flight',
      })
      expect(await status(busy.id)).toBe('idle')
    })
  }

  it('ignores schedules that can no longer fire, system schedules and subagent watchdogs', async () => {
    const own = await squad()
    const worker = await agent(own.id, old())
    await schedule(own.id, worker.id, { enabled: false })
    // A one-shot that already fired keeps enabled=true but has no next trigger.
    await schedule(own.id, worker.id, {
      schedule: { runAt: ago(2 * HOUR).toISOString() },
      nextTriggerAt: null,
      lastTriggeredAt: ago(2 * HOUR),
    })
    await schedule(own.id, worker.id, { systemKey: `idle-worker-test:${randomUUID()}` })
    await schedule(worker.id, worker.id, { scopeType: 'agent', metadata: { kind: 'subagent-watchdog' } })
    // Aimed at someone else.
    await schedule(own.id, randomUUID())

    expect(await idleIds(own.id)).toEqual([worker.id])
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id] })).toBe(1)
    expect(await status(worker.id)).toBe('dormant')
  })

  it('re-checks under the agent lock and refuses, without stopping anything, once work has arrived', async () => {
    const own = await squad()
    // Each was selected while idle; then something arrived before the dormancy ran.
    const queued = await agent(own.id, old())
    const pendingMessage = await agent(own.id, old())
    const mail = await agent(own.id, old())
    const assigned = await agent(own.id, old())
    const reopened = await agent(own.id, old())
    const persisted = await agent(own.id, old())
    const messagedAgain = await agent(own.id, { lastMessageAt: ago(5 * 60_000), createdAt: ago(48 * HOUR) })
    await db.insert(executions).values({ agentId: queued.id, status: 'queued' })
    await db.insert(messages).values({ agentId: pendingMessage.id, role: 'human', content: 'one more?', pending: true })
    await db
      .insert(inbox)
      .values({ recipientType: 'agent', recipientId: mail.id, senderType: 'system', content: 'new mail' })
    await stream({ squadId: own.id, title: 'owned', ownerAgentId: assigned.id })
    await stream({ squadId: own.id, title: 'reopened', agentIds: [reopened.id] }, 'active')
    await db.update(agents).set({ persist: true }).where(eq(agents.id, persisted.id))

    expect(await dormantIfIdleWorker(queued.id, cutoff)).toEqual({ outcome: 'skipped', reason: 'became active' })
    expect(await dormantIfIdleWorker(pendingMessage.id, cutoff)).toEqual({
      outcome: 'skipped',
      reason: 'has a message waiting',
    })
    expect(await dormantIfIdleWorker(mail.id, cutoff)).toEqual({ outcome: 'skipped', reason: 'has a message waiting' })
    expect(await dormantIfIdleWorker(assigned.id, cutoff)).toEqual({
      outcome: 'skipped',
      reason: 'is on an open work stream',
    })
    // canTerminate already refuses crew on an open stream.
    expect((await dormantIfIdleWorker(reopened.id, cutoff)).outcome).toBe('skipped')
    expect((await dormantIfIdleWorker(persisted.id, cutoff)).outcome).toBe('skipped')
    expect(await dormantIfIdleWorker(messagedAgain.id, cutoff)).toEqual({
      outcome: 'skipped',
      reason: 'was active recently',
    })
    for (const busy of [queued, pendingMessage, mail, assigned, reopened, persisted, messagedAgain])
      expect(await status(busy.id)).toBe('idle')
    const [execution] = await db
      .select({ status: executions.status })
      .from(executions)
      .where(eq(executions.agentId, queued.id))
    expect(execution?.status).toBe('queued')
  })

  it('caps the agents one tick makes dormant', async () => {
    const own = await squad()
    for (let i = 0; i < 3; i++) await agent(own.id, old())
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id], maxAgents: 2 })).toBe(2)
    expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id], maxAgents: 2 })).toBe(1)
  })

  it('does not charge refusals to the budget and backs off a refused agent for an hour', async () => {
    const own = await squad()
    // Oldest first: the two refused agents are tried before the healthy ones.
    const bad1 = await agent(own.id, { lastMessageAt: ago(30 * HOUR), createdAt: ago(48 * HOUR) })
    const bad2 = await agent(own.id, { lastMessageAt: ago(29 * HOUR), createdAt: ago(48 * HOUR) })
    const good1 = await agent(own.id, old())
    const good2 = await agent(own.id, old())
    const tried: string[] = []
    const canTerminate = spyOn(Agent.prototype, 'canTerminate').mockImplementation(async function (this: Agent) {
      tried.push(this.id)
      return this.id === bad1.id || this.id === bad2.id
        ? { canTerminate: false as const, reason: 'stuck' }
        : { canTerminate: true as const }
    })
    try {
      expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id], maxAgents: 2 })).toBe(2)
      expect(await status(good1.id)).toBe('dormant')
      expect(await status(good2.id)).toBe('dormant')
      tried.length = 0
      await runIdleWorkerDormancySweep({ now: new Date(now.getTime() + 59 * 60_000), squadIds: [own.id] })
      expect(tried).toEqual([])
      await runIdleWorkerDormancySweep({ now: new Date(now.getTime() + 61 * 60_000), squadIds: [own.id] })
      expect(tried.sort()).toEqual([bad1.id, bad2.id].sort())
      expect(await status(bad1.id)).toBe('idle')
      expect(await status(bad2.id)).toBe('idle')
    } finally {
      canTerminate.mockRestore()
    }
  })

  it('bounds attempts per tick so a backlog of refusals cannot run unbounded', async () => {
    const own = await squad()
    for (let i = 0; i < 7; i++) await agent(own.id, old())
    const tried: string[] = []
    const canTerminate = spyOn(Agent.prototype, 'canTerminate').mockImplementation(async function (this: Agent) {
      tried.push(this.id)
      return { canTerminate: false as const, reason: 'stuck' }
    })
    try {
      // maxAgents 1 allows five attempts per tick; refused agents back off, so the next
      // tick tries only the remaining two and the one after tries none.
      expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id], maxAgents: 1 })).toBe(0)
      expect(tried).toHaveLength(5)
      const first = new Set(tried)
      tried.length = 0
      expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id], maxAgents: 1 })).toBe(0)
      expect(tried).toHaveLength(2)
      expect(tried.some((id) => first.has(id))).toBe(false)
      tried.length = 0
      expect(await runIdleWorkerDormancySweep({ now, squadIds: [own.id], maxAgents: 1 })).toBe(0)
      expect(tried).toEqual([])
    } finally {
      canTerminate.mockRestore()
    }
  })
})
