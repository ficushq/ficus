import { expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
