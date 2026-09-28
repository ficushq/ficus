import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, outbox } from '../db'
import { Outbox, OUTBOX_CLAIM_STALE_MS } from './Outbox'
import type { AmtpEnvelope } from '@ficus/shared'

const ownedRowIds = new Set<string>()
const createdRowIds = new Set<string>()

async function cleanupOwnedRows(): Promise<void> {
  if (ownedRowIds.size === 0) return
  await db.delete(outbox).where(inArray(outbox.id, [...ownedRowIds]))
  ownedRowIds.clear()
}

beforeEach(cleanupOwnedRows)
afterAll(cleanupOwnedRows)
afterAll(async () => {
  const leakedRows = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(inArray(outbox.id, [...createdRowIds]))
  expect(leakedRows.map((row) => row.id)).toEqual([])
})

async function enqueueOwned(input: Parameters<typeof Outbox.enqueue>[0]): Promise<Outbox> {
  const row = await Outbox.enqueue(input)
  ownedRowIds.add(row.id)
  createdRowIds.add(row.id)
  return row
}

function envelope(overrides: Partial<AmtpEnvelope> = {}): AmtpEnvelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: 'amtp://sender-instance/alice',
    to: 'amtp://peer-instance/bob',
    content: 'hello',
    ...overrides,
  }
}

async function enqueueOne(): Promise<Outbox> {
  const env = envelope()
  return enqueueOwned({
    peerInstanceId: 'peer-instance',
    toAddress: env.to,
    envelope: env,
    idempotencyKey: env.id,
  })
}

describe('Outbox', () => {
  test('OUTBOX_CLAIM_STALE_MS is five minutes', () => {
    expect(OUTBOX_CLAIM_STALE_MS).toBe(5 * 60 * 1000)
  })

  test('enqueue is idempotent on idempotencyKey (same row, one DB row)', async () => {
    const env = envelope()
    const a = await enqueueOwned({
      peerInstanceId: 'peer-instance',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: env.id,
    })
    const b = await enqueueOwned({
      peerInstanceId: 'peer-instance',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: env.id,
    })
    expect(b.id).toBe(a.id)
    expect(a.status).toBe('pending')
    expect(a.attempts).toBe(0)
    expect(a.envelopeJson.content).toBe('hello')
    const rows = await db.select().from(outbox)
    expect(rows.length).toBe(1)
  })

  test('claimBatch returns a pending row; a concurrent claim does not re-grab it', async () => {
    const env = envelope()
    await enqueueOwned({
      peerInstanceId: 'peer-instance',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: env.id,
    })

    // Two concurrent claimers race on separate pool connections.
    const [first, second] = await Promise.all([
      Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS),
      Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS),
    ])

    const totalClaimed = first.length + second.length
    expect(totalClaimed).toBe(1)
    const claimed = [...first, ...second][0]
    expect(claimed.status).toBe('delivering')
    expect(claimed.claimToken).toBeTruthy()
    expect(claimed.claimedAt).toBeInstanceOf(Date)

    // A subsequent claim finds nothing (row is fresh-delivering, not stale).
    const again = await Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS)
    expect(again.length).toBe(0)
  })

  test('markRetry increments attempts and sets a future nextAttemptAt with backoff', async () => {
    await enqueueOne()
    const [claimed] = await Outbox.claimBatch(1, OUTBOX_CLAIM_STALE_MS)
    expect(claimed).toBeDefined()

    const before = Date.now()
    const ok = await Outbox.markRetry(claimed.id, claimed.claimToken!, 'boom')
    expect(ok).toBe(true)

    const [updated] = await db.select().from(outbox).where(eq(outbox.id, claimed.id)).limit(1)
    expect(updated.attempts).toBe(1)
    expect(updated.status).toBe('pending')
    expect(updated.claimToken).toBeNull()
    expect(updated.lastError).toBe('boom')
    // attempts=1 -> backoff = min(5000 * 2^1, 300000) = 10000ms.
    expect(updated.nextAttemptAt.getTime()).toBeGreaterThan(before + 5000)
  })

  test('a stale delivering row is reclaimable after staleMs', async () => {
    const row = await enqueueOne()

    // Simulate a worker that claimed the row but died long ago.
    const staleMs = 1000
    await db
      .update(outbox)
      .set({
        status: 'delivering',
        claimToken: 'dead-worker-token',
        claimedAt: new Date(Date.now() - (staleMs + 5000)),
      })
      .where(eq(outbox.id, row.id))

    const reclaimed = await Outbox.claimBatch(10, staleMs)
    expect(reclaimed.length).toBe(1)
    expect(reclaimed[0].id).toBe(row.id)
    expect(reclaimed[0].claimToken).not.toBe('dead-worker-token')
    expect(reclaimed[0].status).toBe('delivering')

    const token = reclaimed[0].claimToken!

    // markDelivered / markFailedTerminal terminal transitions (now token-gated).
    const deliveredResult = await Outbox.markDelivered(row.id, token)
    expect(deliveredResult).toBe(true)
    const [deliveredRow] = await db.select().from(outbox).where(eq(outbox.id, row.id)).limit(1)
    expect(deliveredRow.status).toBe('delivered')

    const failedResult = await Outbox.markFailedTerminal(row.id, token, 'forbidden')
    expect(failedResult).toBe(true)
    const [failedRow] = await db.select().from(outbox).where(eq(outbox.id, row.id)).limit(1)
    expect(failedRow.status).toBe('failed')
    expect(failedRow.lastError).toBe('forbidden')
  })

  test('markDelivered with wrong claim token returns false and leaves row as delivering', async () => {
    await enqueueOne()
    const [claimed] = await Outbox.claimBatch(1, OUTBOX_CLAIM_STALE_MS)
    expect(claimed).toBeDefined()

    const result = await Outbox.markDelivered(claimed.id, 'some-other-token')
    expect(result).toBe(false)

    const [row] = await db.select().from(outbox).where(eq(outbox.id, claimed.id)).limit(1)
    expect(row.status).toBe('delivering')
  })

  test('markRetry grows backoff across two consecutive retries', async () => {
    await enqueueOne()

    // First retry
    const [claimed1] = await Outbox.claimBatch(1, OUTBOX_CLAIM_STALE_MS)
    const before1 = Date.now()
    await Outbox.markRetry(claimed1.id, claimed1.claimToken!, 'err1')
    const [row1] = await db.select().from(outbox).where(eq(outbox.id, claimed1.id)).limit(1)
    expect(row1.attempts).toBe(1)
    const delay1 = row1.nextAttemptAt.getTime() - before1
    // attempts=1 -> 5000 * 2^1 = 10000ms
    expect(delay1).toBeGreaterThan(5000)

    // Move nextAttemptAt to past so the row can be claimed again (use 5s margin to avoid
    // clock-skew between JS and Postgres causing a flaky claim miss).
    await db
      .update(outbox)
      .set({ nextAttemptAt: new Date(Date.now() - 5000) })
      .where(eq(outbox.id, claimed1.id))

    // Second retry
    const [claimed2] = await Outbox.claimBatch(1, OUTBOX_CLAIM_STALE_MS)
    const before2 = Date.now()
    await Outbox.markRetry(claimed2.id, claimed2.claimToken!, 'err2')
    const [row2] = await db.select().from(outbox).where(eq(outbox.id, claimed2.id)).limit(1)
    expect(row2.attempts).toBe(2)
    const delay2 = row2.nextAttemptAt.getTime() - before2
    // attempts=2 -> 5000 * 2^2 = 20000ms; assert meaningful window
    expect(delay2).toBeGreaterThan(15000)
    expect(delay2).toBeLessThan(40000)
  })

  test('predicate safety: future-pending not claimable; delivered and failed rows never returned by claimBatch', async () => {
    // 1. pending with future nextAttemptAt should not be claimed
    const row1 = await enqueueOne()
    await db
      .update(outbox)
      .set({ nextAttemptAt: new Date(Date.now() + 60000) })
      .where(eq(outbox.id, row1.id))
    expect((await Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS)).length).toBe(0)

    // 2. delivered row should not be claimed
    const row2 = await enqueueOne()
    const [c2] = await Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS)
    expect(c2.id).toBe(row2.id)
    await Outbox.markDelivered(c2.id, c2.claimToken!)
    expect((await Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS)).length).toBe(0)

    // 3. failed row should not be claimed
    const row3 = await enqueueOne()
    const [c3] = await Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS)
    expect(c3.id).toBe(row3.id)
    await Outbox.markFailedTerminal(c3.id, c3.claimToken!, 'hard fail')
    expect((await Outbox.claimBatch(10, OUTBOX_CLAIM_STALE_MS)).length).toBe(0)
  })

  test('leaves the final owned pending fixture for failure-safe suite cleanup', async () => {
    const row = await enqueueOne()

    expect(row.status).toBe('pending')
    expect(ownedRowIds.has(row.id)).toBe(true)
  })
})
