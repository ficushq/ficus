import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../../db'
import { agents, agentTypes, messages } from '../../db/schema'
import { Agent } from '../Agent'
import { AgentType } from '../AgentType'
import { AgentSession } from '../AgentSession'
import { SessionMessagePersistence } from './session-message-persistence'
import { AgentRunner } from './base'
import { StreamBuffer } from '../../services/streaming/buffer'
import { StreamEventCollector } from '../../services/streaming/events'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { controlledPiSession } from '../../test-utils/controlled-pi-session'
import { registerSession, removeSession } from '../../services/execution/session-state'
import type { SessionUsage } from '@ficus/shared'

class DeliveryRunner extends AgentRunner {
  constructor(
    agent: Agent,
    private readonly fixture: Awaited<ReturnType<typeof controlledPiSession>>
  ) {
    super(
      {
        id: crypto.randomUUID(),
        message: 'initial',
        stop: async () => {},
        complete: async () => {},
        toJson: () => ({}),
      } as any,
      agent,
      {} as any
    )
    this.session = new AgentSession(fixture.session)
    this.buffer = new StreamBuffer()
    this.collector = new StreamEventCollector(this.buffer, () => this.persistence.currentStreamGroupId)
    this.persistence.attach({
      collector: this.collector,
      buffer: this.buffer,
      captureUsage: () => this.session.captureUsage(),
    })
    fixture.session.subscribe((event) => {
      if (event.type === 'session_message_persisted') this.persistence.enqueuePersistedEvent(event)
    })
    registerSession(agent.id, {
      session: this.session,
      buffer: this.buffer,
      collector: this.collector,
      agentId: agent.id,
      executionId: this.execution.id,
    })
  }
  protected async createSession() {
    return this.session
  }
  protected async onComplete() {}
  get owner() {
    return this.deliveryOwner
  }
  start() {
    return this.sendPrompt()
  }
  waitForPersistence() {
    return this.persistence.waitForAll()
  }
  finishNormally() {
    return this.completeNormally('', undefined, {} as SessionUsage)
  }
  async stopQuietly() {
    await this.fixture.session.abort()
    await this.persistence.waitForAll()
    await this.handleStop('', undefined, {} as SessionUsage)
  }
}

let agent: Agent
let typeId: string
let root: string
let fixture: Awaited<ReturnType<typeof controlledPiSession>>
beforeEach(async () => {
  typeId = `recovery-${crypto.randomUUID()}`
  await AgentType.create({ id: typeId, name: 'Recovery', model: 'test:model', systemPrompt: 'test' })
  agent = await Agent.create({ agentTypeId: typeId })
  root = mkdtempSync(join(tmpdir(), 'queue-recovery-'))
  fixture = await controlledPiSession(root)
})
afterEach(async () => {
  await fixture.session.abort()
  fixture.session.dispose()
  removeSession(agent.id)
  await db.delete(messages).where(eq(messages.agentId, agent.id))
  await db.delete(agents).where(eq(agents.id, agent.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  rmSync(root, { recursive: true, force: true })
})

it('quiet stop releases an accepted but unpersisted follow-up for a fresh session, without waking', async () => {
  const runner = new DeliveryRunner(agent, fixture)
  const running = runner.start()
  await fixture.waitForRequest(1)
  const u = await agent.recordMessage({
    role: 'human',
    content: 'U',
    pending: true,
    metadata: { deliveryMode: 'follow-up' },
  })
  await fixture.waitForQueue(1)
  const claim = await Agent.findMessage(u.id)
  expect(claim!.injectedAt).not.toBeNull()
  expect(
    fixture.session.sessionManager
      .getEntries()
      .some((e) => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message.content).includes('U'))
  ).toBe(false)
  await runner.stopQuietly()
  await running
  const [stored] = await db.select().from(messages).where(eq(messages.id, u!.id))
  expect(stored!.pending).toBe(true)
  expect(stored!.injectedAt).toBeNull()
  expect((await agent.claimInitialPendingMessagesForSessionDelivery()).map((m) => m.id)).toEqual([u!.id])
})

it('fresh B never lets inbox F1 consume stranded U; U/S recover only on the authorized wake', async () => {
  const a = new DeliveryRunner(agent, fixture)
  const runningA = a.start()
  await fixture.waitForRequest(1)
  const u = await agent.recordMessage({
    role: 'human',
    content: 'U',
    pending: true,
    metadata: { deliveryMode: 'follow-up' },
  })
  await fixture.waitForQueue(1)
  const s = await agent.recordMessage({
    role: 'human',
    content: 'S',
    pending: true,
    metadata: { deliveryMode: 'steer' },
  })
  await fixture.waitForQueue(2)
  const oldClaims = [await Agent.findMessage(u.id), await Agent.findMessage(s.id)]
  await a.stopQuietly()
  await runningA
  expect((await agent.listPendingHumanMessages()).map((m) => m.id)).toEqual([u.id, s.id])
  expect((await agent.listPendingInterventionsForSessionDelivery()).map((m) => m.id)).toEqual([s.id, u.id])
  const file = fixture.session.sessionManager.getSessionFile()!
  fixture.session.dispose()
  fixture = await controlledPiSession(root, SessionManager.open(file))
  // New immediate input and inbox notices are a new authorized wake, not stop-side retries.
  const initial = await agent.recordMessage({ role: 'human', content: 'new input', pending: true })
  const f1 = await agent.recordMessage({
    role: 'human',
    content: 'F1',
    pending: true,
    metadata: { source: 'inbox', inboxMessageIds: [crypto.randomUUID()], deliveryMode: 'follow-up' },
  })
  const f2 = await agent.recordMessage({
    role: 'human',
    content: 'F2',
    pending: true,
    metadata: { source: 'inbox', inboxMessageIds: [crypto.randomUUID()], deliveryMode: 'follow-up' },
  })
  const b = new DeliveryRunner(agent, fixture)
  const runningB = b.start()
  try {
    await fixture.waitForRequest(1)
    await fixture.waitForQueue(3)
    await b.waitForPersistence()
    expect((await Agent.findMessage(initial.id))!.pending).toBe(false)
    expect((await Agent.findMessage(s.id))!.pending).toBe(false)
    expect((await Agent.findMessage(u.id))!.pending).toBe(true)
    const claimU = (await Agent.findMessage(u.id))!.metadata!.sessionDelivery!
    // A late event cannot consume the successor's U, nor reset its new claim.
    await agent.confirmSessionDelivery(oldClaims[0]!.metadata!.sessionDelivery!.id, a.owner, 'late-A', {
      executionId: a.owner.executionId,
      streamGroupId: 'late-group',
    })
    await agent.resetPendingInterventionSessionDelivery(u.id, oldClaims[0]!.metadata!.sessionDelivery)
    expect((await Agent.findMessage(u.id))!.metadata!.sessionDelivery).toEqual(claimU)
    expect((await Agent.findMessage(u.id))!.injectedAt).not.toBeNull()
    fixture.reply(0)
    await fixture.waitForRequest(2)
    await b.waitForPersistence()
    const consumedU = await Agent.findMessage(u.id)
    expect(consumedU!.pending).toBe(false)
    expect((await Agent.findMessage(f1.id))!.pending).toBe(true)
    const uEntry = fixture.session.sessionManager
      .getEntries()
      .find((e) => e.type === 'message' && e.deliveryId === claimU.id)!
    expect(consumedU!.metadata!.sessionEntryId).toBe(uEntry.id)
    expect(
      fixture.requests[1]!.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('U'))
    ).toBe(true)
    fixture.reply(1)
    await fixture.waitForRequest(3)
    await b.waitForPersistence()
    expect((await Agent.findMessage(f1.id))!.pending).toBe(false)
    expect((await Agent.findMessage(u.id))!.metadata!.streamGroupId).toBe(consumedU!.metadata!.streamGroupId)
    expect((await Agent.findMessage(f2.id))!.pending).toBe(true)
    fixture.reply(2)
    await fixture.waitForRequest(4)
    await b.waitForPersistence()
    fixture.reply(3)
    await runningB
    await b.waitForPersistence()
    expect(await agent.listPendingHumanMessages()).toEqual([])
    await agent.reconcileSessionDeliveries(fixture.session.sessionManager.getPersistedEntries())
    expect(await agent.listPendingInterventionsForSessionDelivery()).toEqual([])
    const consumed = [await Agent.findMessage(u.id), await Agent.findMessage(f1.id), await Agent.findMessage(f2.id)]
    expect(new Set(consumed.map((m) => m!.metadata!.sessionEntryId)).size).toBe(3)
    expect(consumed.every((m) => m!.metadata!.executionId === b.owner.executionId)).toBe(true)
  } finally {
    await fixture.session.abort()
    await runningB.catch(() => {})
  }
})

it('restart after compaction reconciles append-before-ack idempotently and releases only unpersisted claims', async () => {
  const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const p = await agent.recordMessage({ role: 'human', content: 'same', pending: true })
  const q = await agent.recordMessage({ role: 'human', content: 'same', pending: true })
  const persisted = await agent.claimPendingInterventionForSessionDelivery(p.id, owner)
  await agent.claimPendingInterventionForSessionDelivery(q.id, owner)
  const run = fixture.session.prompt('decorated same', { deliveryId: persisted!.metadata!.sessionDelivery!.id })
  await fixture.waitForRequest(1)
  // No Core persistence subscriber: the SDK append commits but its DB ack never runs.
  await fixture.session.abort()
  await run
  const file = fixture.session.sessionManager.getSessionFile()!
  const assistant = fixture.session.sessionManager
    .getEntries()
    .find((e) => e.type === 'message' && e.message.role === 'assistant')!
  fixture.session.sessionManager.appendCompaction('fixture summary', assistant.id, 100)
  expect(fixture.session.sessionManager.buildSessionContext().messages.some((m) => m.role === 'user')).toBe(false)
  fixture.session.dispose()
  fixture = await controlledPiSession(root, SessionManager.open(file))
  const entries = fixture.session.sessionManager.getPersistedEntries()
  await agent.reconcileSessionDeliveries(entries)
  await agent.reconcileSessionDeliveries(entries)
  expect((await Agent.findMessage(p.id))!.pending).toBe(false)
  expect((await Agent.findMessage(p.id))!.metadata!.sessionEntryId).toBe(
    entries.find((e) => e.type === 'message' && e.deliveryId)!.id
  )
  expect((await Agent.findMessage(q.id))!.pending).toBe(true)
  expect((await Agent.findMessage(q.id))!.injectedAt).toBeNull()
})

it('a cancelled queue cannot be resurrected by reconciliation or a late acknowledgment', async () => {
  const p = await agent.recordMessage({ role: 'human', content: 'cancel', pending: true })
  const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const claim = await agent.claimPendingInterventionForSessionDelivery(p.id, owner)
  await agent.deletePendingMessages()
  await agent.reconcileSessionDeliveries([
    {
      type: 'message',
      id: 'entry-cancel',
      deliveryId: claim!.metadata!.sessionDelivery!.id,
      message: { role: 'user' },
    },
  ])
  expect(
    await agent.confirmSessionDelivery(claim!.metadata!.sessionDelivery!.id, owner, 'entry-cancel', {
      executionId: owner.executionId,
      streamGroupId: 'cancel-group',
    })
  ).toEqual([])
  expect(await Agent.findMessage(p.id)).toBeNull()
})

it('persisting real SDK inbox F1 cannot falsely acknowledge an older same-text claim U in another generation', async () => {
  const ownerA = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const ownerB = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const u = await agent.recordMessage({
    role: 'human',
    content: 'identical',
    pending: true,
    metadata: { deliveryMode: 'follow-up' },
  })
  const f1 = await agent.recordMessage({
    role: 'human',
    content: 'identical',
    pending: true,
    metadata: { deliveryMode: 'follow-up', source: 'inbox', inboxMessageIds: [crypto.randomUUID()] },
  })
  await agent.claimPendingInterventionForSessionDelivery(u.id, ownerA)
  const claimF1 = await agent.claimPendingInterventionForSessionDelivery(f1.id, ownerB)
  const p = new SessionMessagePersistence({ agent, executionId: ownerB.executionId, deliveryOwner: ownerB })
  const buffer = new StreamBuffer()
  p.attach({
    buffer,
    collector: new StreamEventCollector(buffer, () => p.currentStreamGroupId),
    captureUsage: () => fixture.session.getSessionStats() as any,
  })
  fixture.session.subscribe((event) => {
    if (event.type === 'session_message_persisted') p.enqueuePersistedEvent(event)
  })
  const run = fixture.session.prompt('identical', { deliveryId: claimF1!.metadata!.sessionDelivery!.id })
  try {
    await fixture.waitForRequest(1)
    await p.waitForAll()
    expect((await Agent.findMessage(u.id))!.pending).toBe(true)
    const confirmedF1 = await Agent.findMessage(f1.id)
    expect(confirmedF1!.pending).toBe(false)
    expect(confirmedF1!.metadata!.inboxMessageIds).toEqual(f1.metadata!.inboxMessageIds)
    expect(confirmedF1!.metadata!.streamGroupId).toBe(p.currentStreamGroupId)
    // Repeated wakes / duplicate events cannot replay consumed F1.
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        agent.confirmSessionDelivery(
          claimF1!.metadata!.sessionDelivery!.id,
          ownerB,
          confirmedF1!.metadata!.sessionEntryId!,
          { executionId: ownerB.executionId, streamGroupId: p.currentStreamGroupId }
        )
      )
    )
    expect(concurrent.flat()).toEqual([])
    await agent.reconcileSessionDeliveries(fixture.session.sessionManager.getPersistedEntries())
    expect((await agent.listPendingInterventionsForSessionDelivery()).map((m) => m.id)).toEqual([u.id])
    fixture.reply(0)
    await run
    await p.waitForAll()
  } finally {
    await fixture.session.abort()
    await run.catch(() => {})
    await p.waitForAll()
  }
})

it('only one concurrent identity acknowledgment wins and an unowned claim cannot confirm', async () => {
  const m = await agent.recordMessage({ role: 'human', content: 'race', pending: true })
  const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const claim = await agent.claimPendingInterventionForSessionDelivery(m.id, owner)
  const id = claim!.metadata!.sessionDelivery!.id
  expect(
    await agent.confirmSessionDelivery(id, { ...owner, generation: 'wrong' }, 'entry-race', {
      executionId: owner.executionId,
      streamGroupId: 'group',
    })
  ).toEqual([])
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      agent.confirmSessionDelivery(id, owner, 'entry-race', { executionId: owner.executionId, streamGroupId: 'group' })
    )
  )
  expect(results.flat().map((m) => m.id)).toEqual([m.id])
})

it('normal settlement reconciles an append whose DB acknowledgment failed instead of replaying the input', async () => {
  const u = await agent.recordMessage({
    role: 'human',
    content: 'inbox notice',
    pending: true,
    metadata: { deliveryMode: 'follow-up', source: 'inbox' },
  })
  const originalConfirm = agent.confirmSessionDelivery.bind(agent)
  const acknowledge = spyOn(agent, 'confirmSessionDelivery')
    .mockRejectedValueOnce(new Error('fixture DB ack outage'))
    .mockImplementation(originalConfirm)
  const requeue = spyOn(agent, 'queueExecution').mockResolvedValue({} as any)
  const runner = new DeliveryRunner(agent, fixture)
  const run = runner.start()
  try {
    await fixture.waitForRequest(1)
    await runner.waitForPersistence()
    expect((await Agent.findMessage(u.id))!.pending).toBe(true)
    fixture.reply(0)
    await run
    await runner.waitForPersistence()
    await runner.finishNormally()
    expect((await Agent.findMessage(u.id))!.pending).toBe(false)
    expect((await Agent.findMessage(u.id))!.metadata!.strandedPendingRetryCount).toBeUndefined()
    expect(requeue).not.toHaveBeenCalled()
  } finally {
    await fixture.session.abort()
    await run.catch(() => {})
    await runner.waitForPersistence()
    acknowledge.mockRestore()
    requeue.mockRestore()
  }
})

it('restart recovers a persisted identity even when a later SDK rejection already released its claim', async () => {
  const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
  const u = await agent.recordMessage({ role: 'human', content: 'persist then reject', pending: true })
  const claim = await agent.claimPendingInterventionForSessionDelivery(u.id, owner)
  const run = fixture.session.prompt(u.content, { deliveryId: claim!.metadata!.sessionDelivery!.id })
  await fixture.waitForRequest(1)
  await fixture.session.abort()
  await run
  await agent.resetPendingInterventionSessionDelivery(u.id, claim!.metadata!.sessionDelivery)
  expect((await Agent.findMessage(u.id))!.injectedAt).toBeNull()
  expect(
    await agent.confirmSessionDelivery(claim!.metadata!.sessionDelivery!.id, owner, 'late-untrusted-entry', {
      executionId: owner.executionId,
      streamGroupId: 'late-group',
    })
  ).toEqual([])
  await agent.reconcileSessionDeliveries(
    SessionManager.open(fixture.session.sessionManager.getSessionFile()!).getPersistedEntries()
  )
  expect((await Agent.findMessage(u.id))!.pending).toBe(false)
})

for (const legacy of [false, true]) {
  it(`releases an abandoned ${legacy ? 'legacy' : 'modern initial'} claim with a microsecond timestamp`, async () => {
    const u = await agent.recordMessage({ role: 'human', content: 'before enqueue', pending: true })
    const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    expect(
      (await agent.claimInitialPendingMessagesForSessionDelivery(legacy ? undefined : owner)).map((m) => m.id)
    ).toEqual([u.id])
    await db.execute(
      sql`UPDATE ${messages} SET injected_at = date_trunc('second', clock_timestamp()) + interval '1.123456 seconds' WHERE id = ${u.id}`
    )
    const [premise] = await db.execute<{ micros: string }>(
      sql`SELECT to_char(injected_at, 'US') AS micros FROM ${messages} WHERE id = ${u.id}`
    )
    expect(premise!.micros).toBe('123456')
    await agent.reconcileSessionDeliveries([], legacy ? undefined : owner.generation)
    expect((await Agent.findMessage(u.id))!.injectedAt).toBeNull()
    expect(
      (await agent.claimInitialPendingMessagesForSessionDelivery({ ...owner, generation: crypto.randomUUID() })).map(
        (m) => m.id
      )
    ).toEqual([u.id])
  })
}

it('quiet termination never acknowledges an SDK memory entry whose real filesystem append failed, and fresh B recovers it', async () => {
  const a = new DeliveryRunner(agent, fixture)
  const u = await agent.recordMessage({ role: 'human', content: 'failed filesystem append', pending: true })
  const claim = await agent.claimPendingInterventionForSessionDelivery(u.id, a.owner)
  const manager = fixture.session.sessionManager
  const file = manager.getSessionFile()!
  mkdirSync(file) // Real SDK initial open(wx) must fail with EEXIST, not a mocked receipt.
  try {
    expect(() =>
      manager.appendMessage(
        { role: 'user', content: [{ type: 'text', text: u.content }], timestamp: Date.now() },
        claim!.metadata!.sessionDelivery!.id
      )
    ).toThrow('EEXIST')
  } finally {
    rmSync(file, { recursive: true, force: true })
  }
  expect(existsSync(file)).toBe(false)
  expect(
    manager.getEntries().some((e) => e.type === 'message' && e.deliveryId === claim!.metadata!.sessionDelivery!.id)
  ).toBe(true)
  await a.stopQuietly()
  const afterStop = await Agent.findMessage(u.id)
  expect(afterStop!.pending).toBe(true)
  expect(afterStop!.injectedAt).toBeNull()
  fixture.session.dispose()
  fixture = await controlledPiSession(root)
  const b = new DeliveryRunner(agent, fixture)
  const run = b.start()
  try {
    await fixture.waitForRequest(1)
    await b.waitForPersistence()
    const delivered = await Agent.findMessage(u.id)
    expect(delivered!.pending).toBe(false)
    expect(delivered!.metadata!.executionId).toBe(b.owner.executionId)
    expect(fixture.requestDeliveryIds[0]).toContain(delivered!.metadata!.sessionDelivery!.id)
    fixture.reply(0)
    await run
    await b.waitForPersistence()
  } finally {
    await fixture.session.abort()
    await run.catch(() => {})
    await b.waitForPersistence()
  }
})

it('termination requires a complete durable JSONL receipt rather than a partial initial write', async () => {
  const runner = new DeliveryRunner(agent, fixture)
  const u = await agent.recordMessage({ role: 'human', content: 'partial initial write', pending: true })
  const claim = await agent.claimPendingInterventionForSessionDelivery(u.id, runner.owner)
  const manager = fixture.session.sessionManager
  const file = manager.getSessionFile()!
  mkdirSync(file)
  try {
    expect(() =>
      manager.appendMessage(
        { role: 'user', content: [{ type: 'text', text: u.content }], timestamp: Date.now() },
        claim!.metadata!.sessionDelivery!.id
      )
    ).toThrow('EEXIST')
  } finally {
    rmSync(file, { recursive: true, force: true })
  }
  const memoryEntry = manager
    .getEntries()
    .find((e) => e.type === 'message' && e.deliveryId === claim!.metadata!.sessionDelivery!.id)!
  // A failed initial flush can leave a valid prefix and an incomplete final write.
  // Even parseable JSON at EOF is not a complete SDK newline-terminated append.
  writeFileSync(file, `${JSON.stringify(manager.getHeader())}\n${JSON.stringify(memoryEntry)}`)
  await runner.stopQuietly()
  expect((await Agent.findMessage(u.id))!.pending).toBe(true)
  expect((await Agent.findMessage(u.id))!.injectedAt).toBeNull()
  expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(false) // Verification is read-only.
  fixture.session.dispose()
  fixture = await controlledPiSession(root, SessionManager.open(file))
  await agent.reconcileSessionDeliveries(fixture.session.sessionManager.getPersistedEntries())
  expect((await Agent.findMessage(u.id))!.pending).toBe(true)
  expect(
    fixture.session.sessionManager
      .getEntries()
      .some((e) => e.type === 'message' && e.deliveryId === claim!.metadata!.sessionDelivery!.id)
  ).toBe(false)
})

for (const legacy of [false, true]) {
  it(`reconciliation cannot release a concurrent ${legacy ? 'legacy' : 'identity-owned'} successor claim`, async () => {
    const u = await agent.recordMessage({ role: 'human', content: 'claim race', pending: true })
    const ownerA = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    const ownerB = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    await agent.claimInitialPendingMessagesForSessionDelivery(legacy ? undefined : ownerA)
    await db.execute(
      sql`UPDATE ${messages} SET injected_at = date_trunc('second', clock_timestamp()) + interval '1.123456 seconds' WHERE id = ${u.id}`
    )
    const successor = { id: crypto.randomUUID(), ...ownerB }
    let markHeld!: () => void
    let release!: () => void
    let holderPid = 0
    const held = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = db.transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      holderPid = pid!.pid
      // Uncommitted successor state holds the row lock. Reconciliation reads the
      // old MVCC snapshot, then its CAS must wait and recheck after we commit.
      await tx
        .update(messages)
        .set({
          metadata: legacy ? null : { sessionDelivery: successor },
          injectedAt: legacy ? sql`${messages.injectedAt} + interval '1 microsecond'` : sql`${messages.injectedAt}`,
        })
        .where(eq(messages.id, u.id))
      markHeld()
      await gate
    })
    await held
    let settled = false
    const reconciliation = agent.reconcileSessionDeliveries([], legacy ? undefined : ownerA.generation).finally(() => {
      settled = true
    })
    let blocked = false
    try {
      // A database lock barrier, not a timing sleep. All connections and the
      // blocker are owned by this fixture; abort/release in finally even on failure.
      for (let attempt = 0; attempt < 500 && !settled; attempt++) {
        const [state] = await db.execute<{ blocked: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))
        ) AS blocked`)
        if (state!.blocked) {
          blocked = true
          break
        }
      }
      expect(blocked).toBe(true)
    } finally {
      release()
      await writer
      await reconciliation
    }
    const after = await Agent.findMessage(u.id)
    expect(after!.pending).toBe(true)
    expect(after!.injectedAt).not.toBeNull()
    if (!legacy) expect(after!.metadata!.sessionDelivery).toEqual(successor)
    const [precision] = await db.execute<{ micros: string }>(
      sql`SELECT to_char(injected_at, 'US') AS micros FROM ${messages} WHERE id = ${u.id}`
    )
    expect(precision!.micros).toBe(legacy ? '123457' : '123456')
  })
}
