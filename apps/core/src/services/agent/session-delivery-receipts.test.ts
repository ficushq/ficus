import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { readSessionDeliveryReceipts } from './session-delivery-receipts'

it('retains only requested durable user receipts across compaction, UTF-8 chunks and an incomplete tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-receipts-'))
  try {
    const manager = SessionManager.create(root, root)
    const user = (content: string) => ({ role: 'user' as const, content, timestamp: Date.now() })
    const first = manager.appendMessage(user('😀'.repeat(100_000)), 'wanted')
    manager.appendMessage(user('unrelated'), 'unrelated')
    manager.appendCompaction('summary', first, 100)
    manager.appendMessage(user('incomplete'), 'tail')
    const file = manager.getSessionFile()!
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, -1))
    const before = readFileSync(file, 'utf8')
    expect(await readSessionDeliveryReceipts(file, new Set(['wanted', 'tail']))).toEqual([
      { type: 'message', id: first, deliveryId: 'wanted', message: { role: 'user' } },
    ])
    expect(readFileSync(file, 'utf8')).toBe(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('requires a valid header and a user entry, and ignores malformed lines without repairing them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-receipts-'))
  const file = join(root, 'session.jsonl')
  const receipt = { type: 'message', id: 'entry', deliveryId: 'wanted', message: { role: 'user' } }
  try {
    writeFileSync(file, `${JSON.stringify(receipt)}\n`)
    expect(await readSessionDeliveryReceipts(file, new Set(['wanted']))).toEqual([])
    writeFileSync(
      file,
      [
        'null',
        JSON.stringify({ type: 'session', id: 'session' }),
        '{broken',
        JSON.stringify({ ...receipt, message: { role: 'assistant' } }),
        JSON.stringify(receipt),
        '',
      ].join('\n')
    )
    expect(await readSessionDeliveryReceipts(file, new Set(['wanted']))).toEqual([receipt])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('distinguishes absent or in-memory receipts from inaccessible storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-receipts-'))
  const file = join(root, 'session.jsonl')
  const ids = new Set(['wanted'])
  try {
    expect(await readSessionDeliveryReceipts(undefined, ids)).toEqual([])
    expect(await readSessionDeliveryReceipts(file, ids)).toEqual([])
    expect(await readSessionDeliveryReceipts(root, ids)).toEqual([])
    symlinkSync(file, file)
    expect(await readSessionDeliveryReceipts(file, new Set())).toEqual([])
    await expect(readSessionDeliveryReceipts(file, ids)).rejects.toThrow('ELOOP')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
