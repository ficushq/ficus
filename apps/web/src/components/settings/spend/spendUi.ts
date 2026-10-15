import type { SpendDimension } from '@ficus/shared'

export { formatSpend, formatUsd } from '../decisionUi'

export const SPEND_PERIODS = ['7d', '30d', 'month', 'last-month', '90d', 'custom'] as const
export type SpendPeriod = (typeof SPEND_PERIODS)[number]

export const SPEND_PERIOD_LABELS: Record<SpendPeriod, string> = {
  '7d': '7 days',
  '30d': '30 days',
  month: 'This month',
  'last-month': 'Last month',
  '90d': '90 days',
  custom: 'Custom',
}

const DAY_MS = 24 * 60 * 60 * 1000

/** YYYY-MM-DD for a UTC day. */
export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/**
 * A period as a `[from, to)` range of whole UTC days, including today. `custom` uses the given first and
 * last days (inclusive).
 */
export function periodRange(
  period: SpendPeriod,
  now: Date,
  custom?: { from: string; to: string }
): { from: string; to: string } {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const tomorrow = today + DAY_MS
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const iso = (time: number) => new Date(time).toISOString()
  switch (period) {
    case '7d':
      return { from: iso(today - 6 * DAY_MS), to: iso(tomorrow) }
    case '30d':
      return { from: iso(today - 29 * DAY_MS), to: iso(tomorrow) }
    case '90d':
      return { from: iso(today - 89 * DAY_MS), to: iso(tomorrow) }
    case 'month':
      return { from: iso(Date.UTC(year, month, 1)), to: iso(Date.UTC(year, month + 1, 1)) }
    case 'last-month':
      return { from: iso(Date.UTC(year, month - 1, 1)), to: iso(Date.UTC(year, month, 1)) }
    case 'custom': {
      const from = custom?.from ? Date.parse(`${custom.from}T00:00:00Z`) : today - 29 * DAY_MS
      const last = custom?.to ? Date.parse(`${custom.to}T00:00:00Z`) : today
      return { from: iso(from), to: iso(Math.max(last, from) + DAY_MS) }
    }
  }
}

/** Every UTC day in `[from, to)`, so a chart shows days without calls as empty. */
export function daysInRange(from: string, to: string): string[] {
  const days: string[] = []
  for (let time = Date.parse(from); time < Date.parse(to); time += DAY_MS) days.push(utcDay(time))
  return days
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)}B`
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`
  return String(tokens)
}

export const DIMENSION_LABELS: Record<SpendDimension, string> = {
  feature: 'Feature',
  provider: 'Provider',
  model: 'Model',
  account: 'Account',
  billing: 'Billing',
  squad: 'Squad',
  workStream: 'Work stream',
  agent: 'Agent',
  user: 'Person',
}

export const SPEND_APPROXIMATE_NOTE =
  "Some calls' costs are estimates: a provider didn't report its tokens, a price isn't known, or the call was recorded before costs were tracked by model."
