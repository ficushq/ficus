/**
 * The operator override for every machine host's slot budget.
 *
 * Deliberately pure, like `execution/max-concurrent.ts`: `settings/store.ts`
 * imports it for its `KNOWN_SETTINGS` entry, and `host-budget.ts` (which reads
 * the store) imports it too, so it must import neither.
 *
 * Precedence: stored setting > `FICUS_HOST_SLOT_CAPACITY` > derived from each
 * machine's size. The stored setting wins so the Settings control is never a
 * silent no-op on an instance that also sets the variable; clearing it falls
 * back to the variable, then to the derived budget.
 */

/** Settings key holding the operator-editable override. */
export const HOST_SLOT_CAPACITY_SETTING_KEY = 'HOST_SLOT_CAPACITY'
export const HOST_SLOT_CAPACITY_ENV = 'FICUS_HOST_SLOT_CAPACITY'
/** What the setting reads as while nothing overrides the derived budget. */
export const HOST_SLOT_CAPACITY_AUTO = 'auto'
/** The same ceiling as a slot pool's capacity (MAX_SLOT_CAPACITY in types.ts). */
export const MAX_HOST_SLOT_CAPACITY = 1_000

/**
 * - `'auto'`: no override, derive the budget from each machine's size.
 * - `'off'`: host budgets are off (an override of 0).
 * - a number: that many units on every machine.
 */
export type HostSlotCapacityOverride = number | 'off' | 'auto'

/** A whole number from 0 to {@link MAX_HOST_SLOT_CAPACITY}, or null. */
function parseOverride(raw: string | null | undefined): number | null {
  const text = raw?.trim()
  if (!text || !/^\d+$/.test(text)) return null
  const value = Number(text)
  return value <= MAX_HOST_SLOT_CAPACITY ? value : null
}

/** Human-readable rejection reason for a stored value, or null when it is acceptable. */
export function hostSlotCapacityError(value: string): string | null {
  if (parseOverride(value) !== null) return null
  return `${HOST_SLOT_CAPACITY_SETTING_KEY} must be a whole number from 0 to ${MAX_HOST_SLOT_CAPACITY}, where 0 turns host budgets off (got '${value}')`
}

/** Resolve the override: stored > env > auto. An invalid source is skipped, never read as 0. */
export function resolveHostSlotCapacityOverride(
  stored: string | null | undefined,
  envValue: string | undefined = process.env[HOST_SLOT_CAPACITY_ENV]
): HostSlotCapacityOverride {
  const value = parseOverride(stored) ?? parseOverride(envValue)
  return value === null ? HOST_SLOT_CAPACITY_AUTO : value === 0 ? 'off' : value
}

/** What applies with nothing stored: the value Settings shows as this instance's default. */
export function envHostSlotCapacityDefault(): string {
  const value = parseOverride(process.env[HOST_SLOT_CAPACITY_ENV])
  return value === null ? HOST_SLOT_CAPACITY_AUTO : String(value)
}
