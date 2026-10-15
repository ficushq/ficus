import {
  MAX_SLOT_CAPACITY,
  MAX_SLOT_CLAIM_TIMEOUT_MS,
  MAX_SLOT_USAGE_LENGTH,
  MIN_SLOT_CLAIM_TIMEOUT_MS,
  SLOT_KEY_PATTERN,
} from '../../api/slots'

const DURATION = /^(\d+)\s*(s|m|h|d)?$/i
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Compact duration matching the CLI and server messages: `45m`, `1h`, `90s`. */
export function formatSlotTimeout(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1_000)}s`
}

/** Short age for queue waits: `45s`, `12m`, `3h`. */
export function formatSlotAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

/** Keys are normalized like the server: trimmed and lowercased. */
export function normalizeSlotKey(raw: string): string {
  return raw.trim().toLowerCase()
}

export function slotKeyError(raw: string): string | null {
  const key = normalizeSlotKey(raw)
  if (!key) return 'Key is required.'
  return SLOT_KEY_PATTERN.test(key)
    ? null
    : 'Start with a letter; use lowercase letters, digits, dots, dashes or underscores (64 max).'
}

export function parseSlotCapacity(raw: string): number | null {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) return null
  const capacity = Number(value)
  return capacity >= 1 && capacity <= MAX_SLOT_CAPACITY ? capacity : null
}

export function slotCapacityError(raw: string): string | null {
  return parseSlotCapacity(raw) === null ? `Capacity must be a whole number from 1 to ${MAX_SLOT_CAPACITY}.` : null
}

/** A bare number is minutes; otherwise `<n>s|m|h|d`. Returns null outside 1m-24h. */
export function parseSlotTimeout(raw: string): number | null {
  const match = DURATION.exec(raw.trim())
  if (!match) return null
  const ms = Number(match[1]) * UNIT_MS[(match[2] ?? 'm').toLowerCase()]!
  return Number.isSafeInteger(ms) && ms >= MIN_SLOT_CLAIM_TIMEOUT_MS && ms <= MAX_SLOT_CLAIM_TIMEOUT_MS ? ms : null
}

export function slotTimeoutError(raw: string): string | null {
  return parseSlotTimeout(raw) === null ? 'Use a duration such as 45m or 2h, from 1m to 24h.' : null
}

export function slotUsageError(raw: string): string | null {
  return raw.trim().length > MAX_SLOT_USAGE_LENGTH
    ? `Guidance must be at most ${MAX_SLOT_USAGE_LENGTH} characters.`
    : null
}

/** Trimmed guidance for the API; blank means "no guidance" (null). */
export function normalizeSlotUsage(raw: string): string | null {
  return raw.trim() || null
}
