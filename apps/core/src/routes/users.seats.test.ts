import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { usersRouter } from './users'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { User } from '../entities/User'
import { SEAT_PRICE_ENV, INCLUDED_SEATS_ENV } from '../services/platform/seat-pricing'

// GET /api/users/seats is what tells an admin, BEFORE they send an invite, that
// the invite costs money. The three things that must hold: a self-hosted
// instance says nothing, a managed instance with no delivered pricing also says
// nothing (rather than a guessed price), and the seat maths a managed instance
// does report matches the platform's own max(0, users - included).

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/users', usersRouter)

const prefix = `seats-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let admin: TestUser
let plainUser: TestUser

const original = {
  managed: process.env.FICUS_MANAGED,
  price: process.env[SEAT_PRICE_ENV],
  included: process.env[INCLUDED_SEATS_ENV],
}

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  // A second account so the head count is provably >1 and the "billed seats"
  // arithmetic is exercised on a real population rather than an edge of one.
  plainUser = await createTestUser({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

afterEach(() => {
  setEnv('FICUS_MANAGED', original.managed)
  setEnv(SEAT_PRICE_ENV, original.price)
  setEnv(INCLUDED_SEATS_ENV, original.included)
})

interface SeatsResponse {
  pricing: {
    userCount: number
    includedSeats: number
    billedSeats: number
    seatPriceCents: number
    currency: string
  } | null
}

async function getSeats(token = admin.token) {
  const res = await app.request('/api/users/seats', { headers: authHeaders(token) })
  return { res, body: (await res.json()) as SeatsResponse }
}

describe('GET /api/users/seats', () => {
  it('says nothing on a self-hosted instance', async () => {
    delete process.env.FICUS_MANAGED
    setEnv(SEAT_PRICE_ENV, '1000')
    setEnv(INCLUDED_SEATS_ENV, '1')
    const { res, body } = await getSeats()
    expect(res.status).toBe(200)
    expect(body.pricing).toBeNull()
  })

  it('says nothing on a managed instance whose pricing has not been delivered', async () => {
    process.env.FICUS_MANAGED = '1'
    setEnv(SEAT_PRICE_ENV, undefined)
    setEnv(INCLUDED_SEATS_ENV, undefined)
    const { res, body } = await getSeats()
    expect(res.status).toBe(200)
    expect(body.pricing).toBeNull()
  })

  it('reports the delivered price and the platform seat rule on a managed instance', async () => {
    process.env.FICUS_MANAGED = '1'
    setEnv(SEAT_PRICE_ENV, '1000')
    setEnv(INCLUDED_SEATS_ENV, '1')
    const { res, body } = await getSeats()
    expect(res.status).toBe(200)
    const pricing = body.pricing!
    expect(pricing.seatPriceCents).toBe(1000)
    expect(pricing.includedSeats).toBe(1)
    expect(pricing.currency).toBe('USD')
    // The head count is the platform's own billing population, not a re-derivation.
    expect(pricing.userCount).toBe(await User.countActive())
    expect(pricing.userCount).toBeGreaterThanOrEqual(2)
    expect(pricing.billedSeats).toBe(Math.max(0, pricing.userCount - 1))
  })

  it('counts only enabled accounts — disabling a user drops a billed seat', async () => {
    process.env.FICUS_MANAGED = '1'
    setEnv(SEAT_PRICE_ENV, '1000')
    setEnv(INCLUDED_SEATS_ENV, '1')
    const before = (await getSeats()).body.pricing!
    const target = (await User.findById(plainUser.id))!
    await target.update({ disabledAt: new Date() })
    try {
      const after = (await getSeats()).body.pricing!
      expect(after.userCount).toBe(before.userCount - 1)
      expect(after.billedSeats).toBe(before.billedSeats - 1)
    } finally {
      await target.update({ disabledAt: null })
    }
  })

  it('requires users:read like the rest of the users resource', async () => {
    process.env.FICUS_MANAGED = '1'
    setEnv(SEAT_PRICE_ENV, '1000')
    setEnv(INCLUDED_SEATS_ENV, '1')
    const { res } = await getSeats(plainUser.token)
    expect(res.status).toBe(403)
  })

  it('does not shadow GET /api/users/:id', async () => {
    const res = await app.request(`/api/users/${plainUser.id}`, { headers: authHeaders(admin.token) })
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(plainUser.id)
  })
})
