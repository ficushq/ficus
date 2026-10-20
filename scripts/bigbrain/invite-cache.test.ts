import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedOwnerAppLink, ownerInviteCacheSchema } from './invite-cache'
import { writePrivateJson, readPrivateJson } from './secure-files'
const id = '11111111-1111-4111-8111-111111111111'
const issued = Date.parse('2026-10-20T00:00:00Z')
const request = (time = issued) => ({
  contractVersion: 1,
  requestId: randomUUID(),
  tenantId: id,
  physicalHostBinding: id,
  hostEpoch: 1,
  action: 'owner-invite',
  vaultId: id,
  expectedGeneration: 1,
  actorUserId: id,
  issuedAt: new Date(time).toISOString(),
  expiresAt: new Date(time + 3600000).toISOString(),
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bigbrain-invite-cache-'))
  const uid = process.getuid!()
  await writePrivateJson(directory, 'owner-invites.json', { schema: 1, invites: [] }, ownerInviteCacheSchema, { uid })
  return { directory, uid, now: () => issued + 500, authorize: async () => {} }
}
test('64 unexpired slots are retained; full means busy, replay never mints and expired replay never renews', async () => {
  const f = await fixture()
  let calls = 0
  const issue = async (input: ReturnType<typeof request>) => {
    calls++
    return { secret: 'a'.repeat(43), expiresAt: input.expiresAt }
  }
  try {
    const requests = Array.from({ length: 64 }, () => request())
    for (const input of requests) await cachedOwnerAppLink({ ...f, input, issue: () => issue(input) })
    const before = await readFile(join(f.directory, 'owner-invites.json'), 'utf8')
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(16384)
    const extra = request()
    await expect(cachedOwnerAppLink({ ...f, input: extra, issue: () => issue(extra) })).rejects.toThrow('busy')
    expect(await readFile(join(f.directory, 'owner-invites.json'), 'utf8')).toBe(before)
    expect((await cachedOwnerAppLink({ ...f, input: requests[0], issue: () => issue(requests[0]!) })).expiresAt).toBe(
      requests[0]!.expiresAt
    )
    expect(calls).toBe(64)
    await expect(
      cachedOwnerAppLink({ ...f, input: requests[0], now: () => issued + 3600000, issue: () => issue(requests[0]!) })
    ).rejects.toThrow('invite_expired')
    const fresh = request(issued + 3600000)
    await cachedOwnerAppLink({ ...f, input: fresh, now: () => issued + 3600001, issue: () => issue(fresh) })
    expect(
      (await readPrivateJson(f.directory, 'owner-invites.json', ownerInviteCacheSchema, { uid: f.uid })).invites
    ).toHaveLength(1)
    expect(calls).toBe(65)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
test('persisted uncertainty never permits re-mint; recipe changes conflict; current authorization is mandatory', async () => {
  const f = await fixture()
  const input = request()
  let calls = 0
  const issue = async () => {
    calls++
    throw new Error('PRIVATE upstream detail')
  }
  try {
    await expect(cachedOwnerAppLink({ ...f, input, issue })).rejects.toThrow('operation_failed')
    await expect(cachedOwnerAppLink({ ...f, input, issue })).rejects.toThrow('operation_failed')
    expect(calls).toBe(1)
    await expect(cachedOwnerAppLink({ ...f, input: { ...input, hostEpoch: 2 }, issue })).rejects.toThrow(
      'request_conflict'
    )
    await expect(
      cachedOwnerAppLink({
        ...f,
        input: request(),
        authorize: async () => {
          throw new Error('forbidden')
        },
        issue,
      })
    ).rejects.toThrow('forbidden')
    expect(calls).toBe(1)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
