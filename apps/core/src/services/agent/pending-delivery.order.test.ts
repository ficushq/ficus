import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, messages, chatSendReceipts } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { PENDING_CLAIM_LOCK_NAMESPACE } from './pending-delivery'

const tiedAt = new Date('2026-08-10T12:00:00.000Z')
let ids: { first: string; second: string }

describe('pending delivery FIFO', () => {
  let typeId: string
  let agent: Agent

  beforeEach(async () => {
    typeId = `pending-order-${crypto.randomUUID()}`
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    ids = { first: `ffffffff-ffff-4fff-8fff-${suffix}`, second: `00000000-0000-4000-8000-${suffix}` }
    await AgentType.create({ id: typeId, name: 'Pending order', model: 'test:model', systemPrompt: 'test' })
    agent = await Agent.create({ agentTypeId: typeId })
  })

  afterEach(async () => {
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(agents).where(eq(agents.agentTypeId, typeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  async function insertTiedSteers() {
    const inserted = []
    for (const [id, content] of [
      [ids.first, 'first'],
      [ids.second, 'second'],
    ] as const) {
      const [row] = await db
        .insert(messages)
        .values({
          id,
          agentId: agent.id,
          role: 'human',
          content,
          pending: true,
          metadata: { deliveryMode: 'steer' },
          createdAt: tiedAt,
        })
        .returning()
      inserted.push(row!)
    }
    expect(new Set(inserted.map((row) => row.createdAt.toISOString()))).toEqual(new Set([tiedAt.toISOString()]))
    expect(inserted.map((row) => row.id)).not.toEqual(inserted.map((row) => row.id).sort())
    expect(inserted.every((row) => row.enqueueOrder !== null)).toBe(true)
    expect(inserted[0]!.enqueueOrder! < inserted[1]!.enqueueOrder!).toBe(true)
    return inserted
  }

  it('lists and claims tied immediate messages in enqueue order', async () => {
    const inserted = await insertTiedSteers()
    expect((await agent.listPendingHumanMessages()).map((row) => row.id)).toEqual(inserted.map((row) => row.id))
    expect((await agent.listPendingInterventionsForSessionDelivery()).map((row) => row.id)).toEqual(
      inserted.map((row) => row.id)
    )
    expect((await agent.claimInitialPendingMessagesForSessionDelivery()).map((row) => row.id)).toEqual(
      inserted.map((row) => row.id)
    )
  })

  it('prioritizes tied immediate rows and preserves FIFO within follow-ups', async () => {
    const [followUpFirst, followUpSecond] = await Promise.all([
      db
        .insert(messages)
        .values({
          id: ids.first,
          agentId: agent.id,
          role: 'human',
          content: 'follow-up first',
          pending: true,
          metadata: { deliveryMode: 'follow-up' },
          createdAt: tiedAt,
        })
        .returning()
        .then((rows) => rows[0]!),
      db
        .insert(messages)
        .values({
          agentId: agent.id,
          role: 'human',
          content: 'follow-up second',
          pending: true,
          metadata: { deliveryMode: 'follow-up' },
          createdAt: tiedAt,
        })
        .returning()
        .then((rows) => rows[0]!),
    ])
    const [steer] = await db
      .insert(messages)
      .values({
        id: ids.second,
        agentId: agent.id,
        role: 'human',
        content: 'steer',
        pending: true,
        metadata: { deliveryMode: 'steer' },
        createdAt: tiedAt,
      })
      .returning()
    const rows = [followUpFirst, followUpSecond, steer!]
    expect(new Set(rows.map((row) => row.createdAt.toISOString()))).toEqual(new Set([tiedAt.toISOString()]))
    expect([followUpFirst.id, steer!.id]).not.toEqual([followUpFirst.id, steer!.id].sort())
    const expectedFollowUps = [followUpFirst, followUpSecond].sort((a, b) => Number(a.enqueueOrder! - b.enqueueOrder!))
    expect((await agent.listPendingInterventionsForSessionDelivery()).map((row) => row.id)).toEqual([
      steer!.id,
      ...expectedFollowUps.map((row) => row.id),
    ])
    await agent.claimInitialPendingMessagesForSessionDelivery()
    expect((await agent.claimInitialPendingMessagesForSessionDelivery()).map((row) => row.id)).toEqual([
      expectedFollowUps[0]!.id,
    ])
  })

  it('never acknowledges claimed work from content or an identity-free SDK event', async () => {
    const [row] = await insertTiedSteers()
    await agent.claimPendingInterventionForSessionDelivery(row!.id)
    expect(await agent.tryConfirmPendingMessage()).toBeNull()
    expect(await agent.tryConfirmPendingMessage(row!.content)).toBeNull()
  })

  it('confirms tied claimed rows by source identity, never by their order', async () => {
    const inserted = await insertTiedSteers()
    const owner = { generation: crypto.randomUUID(), executionId: crypto.randomUUID() }
    const claims = []
    for (const row of inserted) claims.push(await agent.claimPendingInterventionForSessionDelivery(row.id, owner))
    const drained = []
    for (const claim of claims.toReversed())
      drained.push(
        ...(await agent.confirmSessionDelivery(claim!.metadata!.sessionDelivery!.id, owner, `entry-${claim!.id}`, {
          executionId: owner.executionId,
          streamGroupId: `group-${claim!.id}`,
        }))
      )
    expect(drained.map((row) => row.id)).toEqual(inserted.toReversed().map((row) => row.id))
  })

  it('serializes concurrent initial claims without duplicate delivery', async () => {
    const steers = await insertTiedSteers()
    const [followUp] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'human',
        content: 'follow-up',
        pending: true,
        metadata: { deliveryMode: 'follow-up' },
        createdAt: tiedAt,
      })
      .returning()
    const claims = await Promise.all([
      agent.claimInitialPendingMessagesForSessionDelivery(),
      agent.claimInitialPendingMessagesForSessionDelivery(),
    ])
    const idsClaimed = claims.flat().map((row) => row.id)
    expect(new Set(idsClaimed).size).toBe(idsClaimed.length)
    expect(claims.some((claim) => claim.map((row) => row.id).join(',') === steers.map((row) => row.id).join(','))).toBe(
      true
    )
    expect(claims.some((claim) => claim.length === 1 && claim[0]!.id === followUp!.id)).toBe(true)
  })

  it('serializes same-agent claims so a follow-up cannot overtake an in-flight steer claim', async () => {
    const [steer] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'human',
        content: 'steer',
        pending: true,
        metadata: { deliveryMode: 'steer' },
        createdAt: tiedAt,
      })
      .returning()
    const [followUp] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'human',
        content: 'follow-up',
        pending: true,
        metadata: { deliveryMode: 'follow-up' },
        createdAt: tiedAt,
      })
      .returning()

    let markGateHeld!: () => void
    let releaseGate!: () => void
    const gateHeld = new Promise<void>((resolve) => (markGateHeld = resolve))
    const gateReleased = new Promise<void>((resolve) => (releaseGate = resolve))
    // Hold exactly what an in-flight claim holds: the per-agent advisory lock
    // plus a row lock on the steer. FOR UPDATE SKIP LOCKED means a racer that
    // does NOT take the advisory lock will skip this steer, conclude no
    // immediate rows exist, and promote the follow-up past it.
    const gate = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PENDING_CLAIM_LOCK_NAMESPACE}, hashtext(${agent.id}))`)
      await tx.execute(sql`SELECT id FROM ${messages} WHERE ${messages.id} = ${steer!.id} FOR UPDATE`)
      markGateHeld()
      await gateReleased
    })
    await gateHeld

    let settled = false
    const racing = agent.claimInitialPendingMessagesForSessionDelivery().finally(() => {
      settled = true
    })
    // Poll to a condition, never a fixed sleep: proceed as soon as the racer is
    // observably parked on the advisory lock, or as soon as it has finished
    // (which only happens when the lock is missing).
    for (let attempt = 0; attempt < 400 && !settled; attempt += 1) {
      const [waiters] = await db.execute<{ waiting: number }>(
        sql`SELECT count(*)::int AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND classid = ${PENDING_CLAIM_LOCK_NAMESPACE}`
      )
      if (waiters!.waiting > 0) break
      await Bun.sleep(5)
    }

    releaseGate()
    await gate
    // The steer was never consumed, so the claim must still deliver it.
    expect((await racing).map((row) => row.id)).toEqual([steer!.id])
    expect(
      (await db.select({ injectedAt: messages.injectedAt }).from(messages).where(eq(messages.id, followUp!.id)))[0]
        ?.injectedAt
    ).toBeNull()
  })

  it('never changes enqueue order across claim reset stranded retry and confirmation', async () => {
    const [row] = await insertTiedSteers()
    const original = row!.enqueueOrder
    await agent.claimPendingInterventionForSessionDelivery(row!.id)
    await agent.resetPendingInterventionSessionDelivery(row!.id)
    await agent.markPendingHumanMessagesStrandedRetry([row!.id])
    await agent.claimPendingInterventionForSessionDelivery(row!.id)
    await agent.confirmPendingMessage(row!.id)
    const [stored] = await db
      .select({ enqueueOrder: messages.enqueueOrder })
      .from(messages)
      .where(eq(messages.id, row!.id))
    expect(stored!.enqueueOrder).toBe(original)
  })

  it('allocates unique orders concurrently and lists by database allocation order', async () => {
    const inserted = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        db
          .insert(messages)
          .values({
            agentId: agent.id,
            role: 'human',
            content: String(index),
            pending: true,
            metadata: { deliveryMode: 'steer' },
            createdAt: tiedAt,
          })
          .returning()
          .then((rows) => rows[0]!)
      )
    )
    expect(new Set(inserted.map((row) => row.createdAt.toISOString()))).toEqual(new Set([tiedAt.toISOString()]))
    expect(inserted.map((row) => row.id)).not.toEqual(inserted.map((row) => row.id).sort())
    expect(new Set(inserted.map((row) => row.enqueueOrder)).size).toBe(inserted.length)
    const expected = [...inserted].sort((a, b) => Number(a.enqueueOrder! - b.enqueueOrder!)).map((row) => row.id)
    expect((await agent.listPendingHumanMessages()).map((row) => row.id)).toEqual(expected)

    // Rewrite the earliest-enqueued rows so MVCC relocates their tuples to the
    // end of the heap. Physical order now disagrees with enqueue order, so a
    // query that omits the enqueue_order tiebreak cannot fall back on
    // insertion order and accidentally look FIFO. Two tied rows never expose
    // this — the heap already hands those back in the "right" order.
    for (const id of expected.slice(0, 5))
      await db
        .update(messages)
        .set({ content: `rewritten-${id}` })
        .where(eq(messages.id, id))
    expect((await agent.listPendingHumanMessages()).map((row) => row.id)).toEqual(expected)
    expect((await agent.listPendingInterventionsForSessionDelivery()).map((row) => row.id)).toEqual(expected)
    // Claim last: it stamps injectedAt and removes the rows from the queue.
    expect((await agent.claimInitialPendingMessagesForSessionDelivery()).map((row) => row.id)).toEqual(expected)
  })

  it('keeps the original enqueue order for an ordinary clientId resend', async () => {
    const clientId = crypto.randomUUID()
    await agent.sendMessage('idempotent', { metadata: { clientId } })
    const [before] = await db
      .select({ id: messages.id, enqueueOrder: messages.enqueueOrder })
      .from(messages)
      .where(eq(messages.agentId, agent.id))
    await agent.sendMessage('idempotent', { metadata: { clientId } })
    const after = await db
      .select({ id: messages.id, enqueueOrder: messages.enqueueOrder })
      .from(messages)
      .where(eq(messages.agentId, agent.id))
    expect(after).toEqual([before!])
  })

  it('orders tied queues independently for different agents', async () => {
    const other = await Agent.create({ agentTypeId: typeId })
    const firstQueue = await insertTiedSteers()
    const otherRows = []
    for (const [id, content] of [
      [crypto.randomUUID(), 'other first'],
      [crypto.randomUUID(), 'other second'],
    ] as const) {
      const [row] = await db
        .insert(messages)
        .values({
          id,
          agentId: other.id,
          role: 'human',
          content,
          pending: true,
          metadata: { deliveryMode: 'steer' },
          createdAt: tiedAt,
        })
        .returning()
      otherRows.push(row!)
    }
    expect(new Set(otherRows.map((row) => row.createdAt.toISOString()))).toEqual(new Set([tiedAt.toISOString()]))
    expect((await agent.listPendingHumanMessages()).map((row) => row.id)).toEqual(firstQueue.map((row) => row.id))
    expect((await other.listPendingHumanMessages()).map((row) => row.id)).toEqual(otherRows.map((row) => row.id))
    await db.delete(messages).where(eq(messages.agentId, other.id))
  })

  it('allows only one concurrent confirmer to win', async () => {
    const [row] = await insertTiedSteers()
    await agent.claimPendingInterventionForSessionDelivery(row!.id)
    const results = await Promise.all([agent.confirmPendingMessage(row!.id), agent.confirmPendingMessage(row!.id)])
    expect(results.filter(Boolean).map((message) => message!.id)).toEqual([row!.id])
  })
})

describe('confirmPendingMessage with scalar metadata (22023 regression)', () => {
  // A row whose metadata is JSON null (NOT SQL NULL) made jsonb_set throw
  // `cannot set path in scalar` forever — persisted-session message handling
  // retry-looped on the same row (live incident 2026-08-26). COALESCE only
  // guards SQL NULL; the jsonbObjectOrEmpty CASE guards scalars too.
  let typeId: string
  let agent: Agent

  beforeEach(async () => {
    typeId = `scalar-meta-${crypto.randomUUID()}`
    await AgentType.create({ id: typeId, name: 'Scalar metadata', model: 'test:model', systemPrompt: 'test' })
    agent = await Agent.create({ agentTypeId: typeId })
  })

  afterEach(async () => {
    await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(agents).where(eq(agents.agentTypeId, typeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  it('confirms a message whose metadata is JSON null and stamps consumedAt', async () => {
    const [row] = await db
      .insert(messages)
      .values({ agentId: agent.id, role: 'human', content: 'poisoned', pending: true })
      .returning()
    await db.execute(sql`UPDATE messages SET metadata = 'null'::jsonb WHERE id = ${row!.id}`)

    const confirmed = await agent.confirmPendingMessage(row!.id)
    expect(confirmed).not.toBeNull()
    expect(confirmed!.pending).toBe(false)
    expect((confirmed!.metadata as Record<string, unknown>).consumedAt).toBeDefined()
  })

  it('confirms a message whose metadata is a JSON string scalar, with identity stamps', async () => {
    const [row] = await db
      .insert(messages)
      .values({ agentId: agent.id, role: 'human', content: 'poisoned-2', pending: true })
      .returning()
    await db.execute(sql`UPDATE messages SET metadata = '"oops"'::jsonb WHERE id = ${row!.id}`)

    const confirmed = await agent.confirmPendingMessage(row!.id, {
      executionId: '11111111-1111-4111-8111-111111111111',
      streamGroupId: '22222222-2222-4222-8222-222222222222',
    })
    expect(confirmed).not.toBeNull()
    const metadata = confirmed!.metadata as Record<string, unknown>
    expect(metadata.consumedAt).toBeDefined()
    expect(metadata.executionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(metadata.streamGroupId).toBe('22222222-2222-4222-8222-222222222222')
  })

  // The noah 2026-08-29 incident: the driver wrote whole metadata OBJECTS double-encoded
  // (a jsonb string holding the JSON text). Confirmation used to reset any non-object to
  // '{}', so every inbox delivery lost `source: 'inbox'` and its summaries the moment it
  // was accepted — the chat clients then rendered raw text instead of an inbox card.
  // Confirmation must RECOVER the object, not discard it.
  it('recovers a double-encoded metadata object instead of erasing it', async () => {
    const original = {
      source: 'inbox',
      deliveryMode: 'steer',
      inboxMessageIds: ['00b50eb9-d169-4e45-b6fd-c7b6efbef566'],
      inboxMessageSummaries: [{ id: '00b50eb9-d169-4e45-b6fd-c7b6efbef566', subject: 'Test inbox message' }],
    }
    const [row] = await db
      .insert(messages)
      .values({ agentId: agent.id, role: 'human', content: 'double-encoded', pending: true })
      .returning()
    // to_jsonb(text) stores the JSON *text* as a jsonb string — exactly what the driver produced.
    await db.execute(
      sql`UPDATE messages SET metadata = to_jsonb(${JSON.stringify(original)}::text) WHERE id = ${row!.id}`
    )
    const [poisoned] = await db.execute<{ t: string }>(
      sql`SELECT jsonb_typeof(metadata) AS t FROM messages WHERE id = ${row!.id}`
    )
    expect(poisoned!.t).toBe('string') // the row really is corrupted before we confirm it

    const confirmed = await agent.confirmPendingMessage(row!.id, {
      executionId: '11111111-1111-4111-8111-111111111111',
      streamGroupId: '22222222-2222-4222-8222-222222222222',
    })
    const metadata = confirmed!.metadata as Record<string, unknown>
    expect(metadata.source).toBe('inbox')
    expect(metadata.inboxMessageIds).toEqual(original.inboxMessageIds)
    expect(metadata.inboxMessageSummaries).toEqual(original.inboxMessageSummaries)
    // ...and the identity stamps still land on the recovered object.
    expect(metadata.consumedAt).toBeDefined()
    expect(metadata.executionId).toBe('11111111-1111-4111-8111-111111111111')
  })
})
