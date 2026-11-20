import { afterEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import { db } from '../db'
import { squads } from '../db/schema'
import { ManagedToolchainLockPin } from './ManagedToolchainLockPin'
import { Squad } from './Squad'

describe('ManagedToolchainLockPin', () => {
  const prefix = `lockpin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  afterEach(async () => {
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
  })

  it('keeps the first pin per squad and fingerprint, isolated between squads', async () => {
    const one = await Squad.create({ name: `${prefix} one`, purpose: 'pin' })
    const two = await Squad.create({ name: `${prefix} two`, purpose: 'pin' })

    await ManagedToolchainLockPin.store(one.id, 'fp', 'first')
    await ManagedToolchainLockPin.store(one.id, 'fp', 'second')

    expect(await ManagedToolchainLockPin.get(one.id, 'fp')).toBe('first')
    expect(await ManagedToolchainLockPin.get(one.id, 'other')).toBeNull()
    expect(await ManagedToolchainLockPin.get(two.id, 'fp')).toBeNull()
  })

  it('replaces a pin only while it still holds the failed value', async () => {
    const squad = await Squad.create({ name: `${prefix} replace`, purpose: 'pin' })
    await ManagedToolchainLockPin.store(squad.id, 'fp', 'broken')

    await ManagedToolchainLockPin.store(squad.id, 'fp', 'repaired', 'broken')
    expect(await ManagedToolchainLockPin.get(squad.id, 'fp')).toBe('repaired')

    // A second box that also saw the broken pin must not move the repaired one.
    await ManagedToolchainLockPin.store(squad.id, 'fp', 'late', 'broken')
    expect(await ManagedToolchainLockPin.get(squad.id, 'fp')).toBe('repaired')
  })

  it('is removed with its squad', async () => {
    const squad = await Squad.create({ name: `${prefix} cascade`, purpose: 'pin' })
    await ManagedToolchainLockPin.store(squad.id, 'fp', 'lock')
    await db.delete(squads).where(like(squads.name, `${prefix} cascade`))
    expect(await ManagedToolchainLockPin.get(squad.id, 'fp')).toBeNull()
  })
})
