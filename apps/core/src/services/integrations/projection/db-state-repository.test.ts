import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, integrationProjectionStates, squads } from '../../../db'
import { DbIntegrationProjectionStateRepository } from './db-state-repository'

test('projection generations and leases are token fenced with expired lease recovery', async () => {
  const repository = new DbIntegrationProjectionStateRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Projection ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const now = new Date('2026-08-29T03:00:00.000Z')
  try {
    const first = await repository.invalidate({ squadId: squad.id, providerKey: 'notion', credentialRevision: 1n, now })
    expect(first.generation).toBe(1n)
    const claim = await repository.claim(now, new Date(now.getTime() + 60_000), crypto.randomUUID())
    expect(claim).toMatchObject({ squadId: squad.id, providerKey: 'notion', generation: 1n })
    expect(
      await repository.complete({
        squadId: squad.id,
        providerKey: 'notion',
        generation: 1n,
        leaseToken: crypto.randomUUID(),
        fingerprint: 'a'.repeat(64),
        credentialRevision: 1n,
        now,
      })
    ).toBe(false)

    const newer = await repository.invalidate({
      squadId: squad.id,
      providerKey: 'notion',
      credentialRevision: 2n,
      now: new Date(now.getTime() + 1),
    })
    expect(newer.generation).toBe(2n)
    expect(
      await repository.complete({
        squadId: squad.id,
        providerKey: 'notion',
        generation: 1n,
        leaseToken: claim!.leaseToken,
        fingerprint: 'a'.repeat(64),
        credentialRevision: 1n,
        now,
      })
    ).toBe(false)

    const recovered = await repository.claim(
      new Date(now.getTime() + 60_001),
      new Date(now.getTime() + 120_000),
      crypto.randomUUID()
    )
    expect(recovered?.generation).toBe(2n)
    expect(
      await repository.complete({
        squadId: squad.id,
        providerKey: 'notion',
        generation: 2n,
        leaseToken: recovered!.leaseToken,
        fingerprint: 'b'.repeat(64),
        credentialRevision: 2n,
        now: new Date(now.getTime() + 60_002),
      })
    ).toBe(true)
    const status = await repository.get(squad.id, 'notion')
    expect(status).toMatchObject({ status: 'ready', generation: 2n, appliedCredentialRevision: 2n })
    expect(await repository.listReady(1)).toHaveLength(1)
    let cursor: { squadId: string; providerKey: string } | null = null
    let ownedRowFound = false
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await repository.listReady(100, cursor)
      ownedRowFound ||= page.some((row) => row.squadId === squad.id && row.providerKey === 'notion')
      if (ownedRowFound || page.length < 100) break
      const last = page.at(-1)!
      cursor = { squadId: last.squadId, providerKey: last.providerKey }
    }
    expect(ownedRowFound).toBe(true)
    expect(await repository.listReady(100, { squadId: squad.id, providerKey: 'notion' })).not.toContainEqual(
      expect.objectContaining({ squadId: squad.id, providerKey: 'notion' })
    )
    expect(
      await repository.claim(new Date(now.getTime() + 300_000), new Date(now.getTime() + 360_000), crypto.randomUUID())
    ).toBeNull()
    await repository.invalidate({
      squadId: squad.id,
      providerKey: 'notion',
      credentialRevision: 3n,
      now: new Date(now.getTime() + 300_001),
    })
    expect(
      await repository.claim(new Date(now.getTime() + 300_001), new Date(now.getTime() + 360_001), crypto.randomUUID())
    ).toMatchObject({ generation: 3n, status: 'installing' })
    expect(
      JSON.stringify(status, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
    ).not.toContain('credential-ref')
  } finally {
    await db.delete(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, squad.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  }
})

test('a held projection lease can be renewed only by its own token and generation', async () => {
  const repository = new DbIntegrationProjectionStateRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Projection renew ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const now = new Date('2026-08-29T03:00:00.000Z')
  try {
    await repository.invalidate({ squadId: squad.id, providerKey: 'linear', now })
    const token = crypto.randomUUID()
    const claim = await repository.claim(now, new Date(now.getTime() + 60_000), token)
    expect(claim).toMatchObject({ squadId: squad.id, providerKey: 'linear', leaseToken: token })
    const key = { squadId: squad.id, providerKey: 'linear', generation: claim!.generation }
    const renewedUntil = new Date(now.getTime() + 180_000)

    expect(await repository.renew({ ...key, leaseToken: crypto.randomUUID(), leaseExpiresAt: renewedUntil, now })).toBe(
      false
    )
    expect(await repository.renew({ ...key, leaseToken: token, leaseExpiresAt: renewedUntil, now })).toBe(true)
    expect((await repository.get(squad.id, 'linear'))?.leaseExpiresAt?.getTime()).toBe(renewedUntil.getTime())

    // Past the original lease but within the renewed one, nobody else can take it.
    const later = new Date(now.getTime() + 120_000)
    const competing = await repository.claim(later, new Date(later.getTime() + 60_000), crypto.randomUUID())
    expect(competing?.squadId).not.toBe(squad.id)

    // A newer generation supersedes the claim; renewal then reports it lost.
    await repository.invalidate({ squadId: squad.id, providerKey: 'linear', now: later })
    expect(await repository.renew({ ...key, leaseToken: token, leaseExpiresAt: renewedUntil, now: later })).toBe(false)
  } finally {
    await db.delete(integrationProjectionStates).where(eq(integrationProjectionStates.squadId, squad.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  }
})
