/**
 * Seat-pricing facts for a platform-managed instance.
 *
 * The hosted platform bills a tenant per user seat, but the PRICE and the
 * number of seats the base plan already covers live on the platform, not here.
 * An instance that guessed either number could tell an admin their next invite
 * costs $10/month while the subscription actually moved by something else — so
 * the two facts are DELIVERED to the instance the same way every other
 * platform-owned value is: as environment variables in /etc/tau/managed.env
 * (see ../secrets/managed.ts).
 *
 *   FICUS_MANAGED_SEAT_PRICE_USD_CENTS=1000   — USD minor units per billed seat / month
 *   FICUS_MANAGED_INCLUDED_SEATS=1            — seats the base plan already covers
 *
 * Both are OPTIONAL. A self-hosted install sets neither and gets `undefined`
 * here, which every consumer renders as "no pricing UI at all". There is
 * deliberately NO default price and NO default included-seat count: a wrong
 * number shown confidently is worse than no number, so anything missing,
 * non-numeric, negative or fractional yields `undefined` rather than a guess.
 *
 * Read from process.env at call time (not cached at import) for the same reason
 * ../secrets/managed.ts does: a managed.env rewrite plus restart, and tests,
 * both take effect with no special handling.
 */
import { isPlatformManaged } from '../secrets/managed'

/** Currency of FICUS_MANAGED_SEAT_PRICE_USD_CENTS — encoded in the var name, not configurable. */
export const SEAT_PRICE_CURRENCY = 'USD'

export const SEAT_PRICE_ENV = 'FICUS_MANAGED_SEAT_PRICE_USD_CENTS'
export const INCLUDED_SEATS_ENV = 'FICUS_MANAGED_INCLUDED_SEATS'

/** The delivered pricing facts, once both vars parsed cleanly. */
export interface SeatPricingConfig {
  /** Price per BILLED seat per month, in USD minor units (1000 = $10.00). */
  seatPriceCents: number
  /** Seats the base plan already covers — the platform bills max(0, users - this). */
  includedSeats: number
  currency: typeof SEAT_PRICE_CURRENCY
}

/** What the Users page needs to state the cost of one more invite. */
export interface SeatPricingSummary extends SeatPricingConfig {
  /**
   * Enabled human accounts — the exact population the platform bills on (see
   * User.countActive, which is what services/machines/usage-reporter.ts reports
   * and what the platform's billedSeats() is applied to). A disabled account is
   * not billed, so it must not be counted here either.
   */
  userCount: number
  /** max(0, userCount - includedSeats) — the platform's rule, with its own parameters. */
  billedSeats: number
}

/**
 * Parse a non-negative integer env var. Anything else — empty, whitespace,
 * '10.5', '-1', 'ten', '1e3' — is a misconfiguration, and the honest response
 * to a misconfigured price is to show no price.
 */
function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * The instance's seat pricing, or `undefined` when it has none to show:
 * not platform-managed, or either var absent/unparseable. Both vars are
 * required together — a price with no included-seat count cannot produce
 * correct seat maths, and vice versa.
 */
export function getSeatPricingConfig(): SeatPricingConfig | undefined {
  if (!isPlatformManaged()) return undefined
  const seatPriceCents = parseNonNegativeInt(process.env[SEAT_PRICE_ENV])
  const includedSeats = parseNonNegativeInt(process.env[INCLUDED_SEATS_ENV])
  if (seatPriceCents === undefined || includedSeats === undefined) return undefined
  return { seatPriceCents, includedSeats, currency: SEAT_PRICE_CURRENCY }
}

/**
 * Billed seats for a head count under this instance's configured plan —
 * `max(0, userCount - includedSeats)`, the platform's own rule (its
 * `billedSeats()` hardcodes the included seat that arrives here as config).
 * Clamps a negative head count to 0 so a caller can never produce a negative
 * seat quantity.
 */
export function billedSeats(userCount: number, includedSeats: number): number {
  return Math.max(0, Math.floor(userCount) - includedSeats)
}

/** Pricing plus the live head count, or `undefined` when there is no pricing to show. */
export function summarizeSeatPricing(
  userCount: number,
  config: SeatPricingConfig | undefined = getSeatPricingConfig()
): SeatPricingSummary | undefined {
  if (!config) return undefined
  return { ...config, userCount, billedSeats: billedSeats(userCount, config.includedSeats) }
}
