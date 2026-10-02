import { expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, renameSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { controlledPiSession } from '../../test-utils/controlled-pi-session'

it('persists out-of-band delivery identity on real SDK array-valued initial, steer and separate follow-ups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-delivery-'))
  const fixture = await controlledPiSession(root)
  const { session } = fixture
  const persisted: any[] = []
  session.subscribe((event) => {
    if (event.type === 'session_message_persisted' && event.message.role === 'user') persisted.push(event)
  })
  const run = session.prompt('identical', { deliveryId: 'initial' } as any)
  try {
    await fixture.waitForRequest(1)
    await session.steer('identical', undefined, { deliveryId: 'steer-1' } as any)
    await session.steer('identical', undefined, { deliveryId: 'steer-2' } as any)
    await session.followUp('identical', undefined, { deliveryId: 'follow-1' } as any)
    await session.followUp('identical', undefined, { deliveryId: 'follow-2' } as any)
    fixture.reply(0)
    await fixture.waitForRequest(2)
    fixture.reply(1)
    await fixture.waitForRequest(3)
    fixture.reply(2)
    await fixture.waitForRequest(4)
    fixture.reply(3)
    await run
    expect(persisted.map((e) => e.deliveryId)).toEqual(['initial', 'steer-1', 'steer-2', 'follow-1', 'follow-2'])
    expect(fixture.requestDeliveryIds).toEqual([
      ['initial'],
      ['initial', 'steer-1', 'steer-2'],
      ['initial', 'steer-1', 'steer-2', 'follow-1'],
      ['initial', 'steer-1', 'steer-2', 'follow-1', 'follow-2'],
    ])
    expect(persisted.every((e) => Array.isArray(e.message.content))).toBe(true)
    const disk = readFileSync(session.sessionManager.getSessionFile()!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(disk.filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => e.deliveryId)).toEqual(
      persisted.map((e) => e.deliveryId)
    )
    expect(fixture.requests.every((r) => r.messages.every((m) => !('deliveryId' in m)))).toBe(true)
  } finally {
    await session.abort()
    await run.catch(() => {})
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

it('retains only host identity through sanitizer replacement, multi-block content and attachments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sanitize-delivery-'))
  const fixture = await controlledPiSession(root)
  const { session } = fixture
  session.setEventSanitizer((event) => {
    if ((event.type === 'message_start' || event.type === 'message_end') && event.message.role === 'user') {
      return {
        ...event,
        message: {
          ...event.message,
          content: [
            { type: 'text', text: 'decorated' },
            { type: 'text', text: ' identical' },
            { type: 'image', mimeType: 'image/png', data: 'fixture' },
          ],
        },
      }
    }
    return event
  })
  const persisted: any[] = []
  session.subscribe((event) => {
    if (event.type === 'session_message_persisted' && event.message.role === 'user') persisted.push(event)
  })
  const run = session.prompt('identical', { deliveryId: 'trusted' })
  try {
    await fixture.waitForRequest(1)
    expect(persisted[0].deliveryId).toBe('trusted')
    expect(persisted[0].message.content).toHaveLength(3)
    expect(fixture.requests[0]!.messages.filter((m) => m.role === 'user')[0]!.content).toHaveLength(3)
    fixture.reply(0)
    await run
    const neutral = session.prompt('deliveryId=trusted')
    await fixture.waitForRequest(2)
    expect(persisted[1].deliveryId).toBeUndefined()
    fixture.reply(1)
    await neutral
  } finally {
    await session.abort()
    await run.catch(() => {})
    session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

it('verified receipts exclude a failed append to an already-flushed SDK session', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-failed-append-'))
  const manager = SessionManager.create(root, root)
  const file = manager.getSessionFile()!
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'identical' }], timestamp: Date.now() }
  try {
    const first = manager.appendMessage(user, 'successful')
    const backup = `${file}.backup`
    renameSync(file, backup)
    mkdirSync(file)
    try {
      expect(() => manager.appendMessage(user, 'failed')).toThrow('EISDIR')
    } finally {
      rmSync(file, { recursive: true, force: true })
      renameSync(backup, file)
    }
    expect(
      manager
        .getEntries()
        .filter((e) => e.type === 'message')
        .map((e) => e.deliveryId)
    ).toEqual(['successful', 'failed'])
    const receipts = manager.getPersistedEntries().filter((e) => e.type === 'message')
    expect(receipts.map((e) => e.deliveryId)).toEqual(['successful'])
    expect(receipts[0]!.id).toBe(first)
    expect(
      SessionManager.open(file)
        .getPersistedEntries()
        .filter((e) => e.type === 'message')
        .map((e) => e.deliveryId)
    ).toEqual(['successful'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('host EOF append receipts require a newline while legacy SDK EOF repair stays compatible', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-incomplete-append-'))
  try {
    for (const hostOwned of [false, true]) {
      const manager = SessionManager.create(root, root)
      const file = manager.getSessionFile()!
      manager.appendMessage(
        { role: 'user', content: [{ type: 'text', text: 'same' }], timestamp: Date.now() },
        hostOwned ? 'incomplete-host' : undefined
      )
      const original = readFileSync(file, 'utf8')
      writeFileSync(file, original.slice(0, -1))
      expect(manager.getPersistedEntries()).toEqual([])
      expect(readFileSync(file, 'utf8')).toBe(original.slice(0, -1))
      const reopened = SessionManager.open(file)
      expect(reopened.getEntries().filter((e) => e.type === 'message')).toHaveLength(hostOwned ? 0 : 1)
      expect(reopened.getPersistedEntries().filter((e) => e.type === 'message')).toHaveLength(hostOwned ? 0 : 1)
    }
    const memory = SessionManager.inMemory()
    memory.appendMessage({ role: 'user', content: 'not durable', timestamp: Date.now() }, 'memory-only')
    expect(memory.getEntries()).toHaveLength(1)
    expect(memory.getPersistedEntries()).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('an unavailable receipt path propagates a real filesystem read error instead of reporting an empty ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-unavailable-ledger-'))
  try {
    const manager = SessionManager.create(root, root)
    const file = manager.getSessionFile()!
    symlinkSync(file, file) // ELOOP is distinguishable from verified absence; no permission/root assumptions.
    expect(() => manager.getPersistedEntries()).toThrow('ELOOP')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('discarding a multi-buffer incomplete UTF-8 host tail preserves the complete durable prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-partial-utf8-'))
  try {
    const manager = SessionManager.create(root, root)
    const first = manager.appendMessage(
      { role: 'user', content: 'complete prefix', timestamp: Date.now() },
      'durable-prefix'
    )
    // More than the SDK reader's 1 MiB buffer; byte boundaries differ from JS character counts.
    manager.appendMessage({ role: 'user', content: '😀'.repeat(300_000), timestamp: Date.now() }, 'incomplete-tail')
    const file = manager.getSessionFile()!
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.slice(0, -1))
    expect(
      manager
        .getPersistedEntries()
        .filter((e) => e.type === 'message')
        .map((e) => e.id)
    ).toEqual([first])
    expect(readFileSync(file, 'utf8')).toBe(original.slice(0, -1))
    const reopened = SessionManager.open(file)
    expect(
      reopened
        .getPersistedEntries()
        .filter((e) => e.type === 'message')
        .map((e) => e.id)
    ).toEqual([first])
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
