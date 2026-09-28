import { describe, test, expect, afterEach } from 'bun:test'
import {
  billedSeats,
  getSeatPricingConfig,
  summarizeSeatPricing,
  SEAT_PRICE_ENV,
  INCLUDED_SEATS_ENV,
} from './seat-pricing'

const original = {
  managed: process.env.FICUS_MANAGED,
  price: process.env[SEAT_PRICE_ENV],
  included: process.env[INCLUDED_SEATS_ENV],
}

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** Put the process on a managed instance with the given (possibly bogus) pricing vars. */
function managedWith(price: string | undefined, included: string | undefined) {
  process.env.FICUS_MANAGED = '1'
  setEnv(SEAT_PRICE_ENV, price)
  setEnv(INCLUDED_SEATS_ENV, included)
}

afterEach(() => {
  setEnv('FICUS_MANAGED', original.managed)
  setEnv(SEAT_PRICE_ENV, original.price)
  setEnv(INCLUDED_SEATS_ENV, original.included)
})

describe('getSeatPricingConfig', () => {
  test('a managed instance with both vars reports them', () => {
    managedWith('1000', '1')
    expect(getSeatPricingConfig()).toEqual({ seatPriceCents: 1000, includedSeats: 1, currency: 'USD' })
  })

  test('self-hosted has no pricing even if the vars somehow exist', () => {
    delete process.env.FICUS_MANAGED
    setEnv(SEAT_PRICE_ENV, '1000')
    setEnv(INCLUDED_SEATS_ENV, '1')
    expect(getSeatPricingConfig()).toBeUndefined()
  })

  test('a managed instance with neither var reports nothing (no default price)', () => {
    managedWith(undefined, undefined)
    expect(getSeatPricingConfig()).toBeUndefined()
  })

  test('one var without the other is not enough to do seat maths', () => {
    managedWith('1000', undefined)
    expect(getSeatPricingConfig()).toBeUndefined()
    managedWith(undefined, '1')
    expect(getSeatPricingConfig()).toBeUndefined()
  })

  test.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['fractional', '10.5'],
    ['negative', '-100'],
    ['exponent', '1e3'],
    ['words', 'ten dollars'],
    ['trailing junk', '1000cents'],
  ])('a %s price shows no price rather than a wrong one', (_label, price) => {
    managedWith(price, '1')
    expect(getSeatPricingConfig()).toBeUndefined()
  })

  test('zero is a legitimate value for both (a free promo plan is not a misconfiguration)', () => {
    managedWith('0', '0')
    expect(getSeatPricingConfig()).toEqual({ seatPriceCents: 0, includedSeats: 0, currency: 'USD' })
  })

  test('surrounding whitespace is tolerated the way FICUS_MANAGED_SECRET_KEYS tolerates it', () => {
    managedWith(' 1000 ', ' 1 ')
    expect(getSeatPricingConfig()).toEqual({ seatPriceCents: 1000, includedSeats: 1, currency: 'USD' })
  })
})

describe('billedSeats', () => {
  test('matches the platform rule max(0, users - included) at the boundaries', () => {
    expect(billedSeats(0, 1)).toBe(0)
    expect(billedSeats(1, 1)).toBe(0)
    expect(billedSeats(2, 1)).toBe(1)
    expect(billedSeats(3, 1)).toBe(2)
    expect(billedSeats(17, 1)).toBe(16)
  })

  test('never goes negative, whatever the included-seat count', () => {
    expect(billedSeats(1, 5)).toBe(0)
    expect(billedSeats(-3, 1)).toBe(0)
  })

  test('an included-seat count of zero bills every user', () => {
    expect(billedSeats(1, 0)).toBe(1)
    expect(billedSeats(4, 0)).toBe(4)
  })
})

describe('summarizeSeatPricing', () => {
  test('carries the head count and the seats it bills', () => {
    managedWith('1000', '1')
    expect(summarizeSeatPricing(3)).toEqual({
      seatPriceCents: 1000,
      includedSeats: 1,
      currency: 'USD',
      userCount: 3,
      billedSeats: 2,
    })
  })

  test('is undefined whenever there is no pricing to show', () => {
    delete process.env.FICUS_MANAGED
    expect(summarizeSeatPricing(3)).toBeUndefined()
  })

  test('an explicitly passed config wins over the environment', () => {
    delete process.env.FICUS_MANAGED
    expect(summarizeSeatPricing(2, { seatPriceCents: 500, includedSeats: 0, currency: 'USD' })).toEqual({
      seatPriceCents: 500,
      includedSeats: 0,
      currency: 'USD',
      userCount: 2,
      billedSeats: 2,
    })
  })
})
