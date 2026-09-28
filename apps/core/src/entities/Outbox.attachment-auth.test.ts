import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db, outbox } from '../db'
import { Outbox } from './Outbox'
import type { AmtpEnvelope, AmtpAttachmentRef } from '@ficus/shared'

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

const attachmentA1: AmtpAttachmentRef = {
  id: 'a1',
  filename: 'file.txt',
  contentType: 'text/plain',
  byteSize: 42,
  sha256: 'deadbeef',
}

describe('Outbox.hasOutboundAttachmentForPeer', () => {
  test('returns true when peer B has an outbox row advertising attachment a1', async () => {
    const env = envelope({ attachments: [attachmentA1] })
    await enqueueOwned({
      peerInstanceId: 'B',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: 'ik-b-a1',
    })
    expect(await Outbox.hasOutboundAttachmentForPeer('B', 'a1')).toBe(true)
  })

  test('returns false when attachment id is not advertised for peer B', async () => {
    const env = envelope({ attachments: [attachmentA1] })
    await enqueueOwned({
      peerInstanceId: 'B',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: 'ik-b-a1-nope',
    })
    expect(await Outbox.hasOutboundAttachmentForPeer('B', 'nope')).toBe(false)
  })

  test('returns false when peer C did not receive an envelope with attachment a1 (wrong peer)', async () => {
    const env = envelope({ attachments: [attachmentA1] })
    await enqueueOwned({
      peerInstanceId: 'B',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: 'ik-b-a1-wrongpeer',
    })
    expect(await Outbox.hasOutboundAttachmentForPeer('C', 'a1')).toBe(false)
  })

  test('returns false when outbox row has no attachments field', async () => {
    const env = envelope()
    await enqueueOwned({
      peerInstanceId: 'B',
      toAddress: env.to,
      envelope: env,
      idempotencyKey: 'ik-b-no-attachments',
    })
    expect(await Outbox.hasOutboundAttachmentForPeer('B', 'a1')).toBe(false)
  })
})
