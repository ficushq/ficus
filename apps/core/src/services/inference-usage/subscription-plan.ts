/**
 * Subscription plans on provider accounts: which plan an account is on (detected from the provider
 * where it tells us, else chosen by an admin), what it costs a month, and its fee for a date range.
 * Pure: callers persist the account changes. See docs/wiki/inference-usage.md.
 */
import { subscriptionPlansFor, type SubscriptionPlanSource } from '@ficus/shared'

/** The subscription fields stored on a provider account. */
export interface AccountSubscription {
  /** Plan id from SUBSCRIPTION_PLANS (e.g. `max-20x`, `plus`), or a label for providers without a table. */
  plan?: string
  planSource?: SubscriptionPlanSource
  /** What the provider reported when it does not name one priced plan (Claude Code `max`). */
  detectedPlan?: string
  detectedAt?: number
  /** Admin override in dollars a month; unset uses the plan's default price. */
  monthlyPriceUsd?: number
}

type SubscribedAccount = {
  credential?: { type?: string; access?: unknown } | null
  kind?: string
  subscription?: AccountSubscription
}

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

/** The payload of a JWT, without verifying it (it is our own stored credential). */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json) as unknown
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The ChatGPT plan in a Codex access token (`chatgpt_plan_type`), mapped to a SUBSCRIPTION_PLANS id. */
export function detectCodexPlan(accessToken: unknown): string | undefined {
  if (typeof accessToken !== 'string') return undefined
  const claim = decodeJwtPayload(accessToken)?.[OPENAI_AUTH_CLAIM]
  const raw = claim && typeof claim === 'object' ? (claim as Record<string, unknown>).chatgpt_plan_type : undefined
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const plan = raw.trim().toLowerCase()
  return plan === 'team' ? 'business' : plan
}

/**
 * Claude Code's `subscriptionType`. `max` does not say 5x or 20x, so it is kept as `detectedPlan` and
 * the plan stays unset until an admin picks one.
 */
export function detectClaudeCodePlan(subscriptionType: unknown): { plan?: string; detectedPlan: string } | undefined {
  if (typeof subscriptionType !== 'string' || !subscriptionType.trim()) return undefined
  const value = subscriptionType.trim().toLowerCase()
  if (value === 'max') return { detectedPlan: 'max' }
  const known = subscriptionPlansFor('anthropic')?.[value]
  return known ? { plan: value, detectedPlan: value } : { detectedPlan: value }
}

/** What the provider says about an account's plan, if anything. */
export function detectedPlanFor(
  provider: string,
  account: SubscribedAccount,
  claudeCodeSubscriptionType?: string
): { plan?: string; detectedPlan: string } | undefined {
  if (account.kind === 'claude-code') return detectClaudeCodePlan(claudeCodeSubscriptionType)
  if (provider === 'openai-codex' && account.credential?.type === 'oauth') {
    const plan = detectCodexPlan(account.credential.access)
    return plan ? { plan, detectedPlan: plan } : undefined
  }
  return undefined
}

/**
 * Stores a detected plan on an account, unless an admin chose its plan. Returns whether anything
 * changed, so callers skip rewriting the account store when it did not.
 */
export function applyDetectedPlan(
  account: SubscribedAccount,
  detected: { plan?: string; detectedPlan: string } | undefined,
  now = Date.now()
): boolean {
  if (!detected) return false
  const current = account.subscription ?? {}
  const manual = current.planSource === 'manual'
  const nextPlan = manual ? current.plan : detected.plan
  const nextSource: SubscriptionPlanSource | undefined = manual ? 'manual' : detected.plan ? 'detected' : undefined
  if (current.detectedPlan === detected.detectedPlan && current.plan === nextPlan && current.planSource === nextSource)
    return false
  const next: AccountSubscription = { ...current, detectedPlan: detected.detectedPlan, detectedAt: now }
  if (nextPlan) next.plan = nextPlan
  else delete next.plan
  if (nextSource) next.planSource = nextSource
  else delete next.planSource
  account.subscription = next
  return true
}

/** The account's monthly price: the admin's override, else the plan's default; null when unknown. */
export function effectiveMonthlyPrice(
  provider: string,
  subscription: AccountSubscription | undefined
): { monthlyUsd: number | null; source: 'default' | 'custom' | null } {
  if (typeof subscription?.monthlyPriceUsd === 'number' && Number.isFinite(subscription.monthlyPriceUsd))
    return { monthlyUsd: subscription.monthlyPriceUsd, source: 'custom' }
  const plan = subscription?.plan ? subscriptionPlansFor(provider)?.[subscription.plan] : undefined
  if (plan && plan.monthlyUsd !== null) return { monthlyUsd: plan.monthlyUsd, source: 'default' }
  return { monthlyUsd: null, source: null }
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfUtcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS
}

/**
 * A subscription's fee for `[from, to)`: for every UTC calendar month the range touches, the monthly
 * price × the days the range and the account's active window share in that month ÷ the month's days.
 * A whole calendar month therefore counts the full fee; any other range is prorated by day. Days are
 * whole UTC days: a partial day at either end counts as a full day.
 */
export function subscriptionFee(input: {
  monthlyUsd: number | null
  from: Date
  to: Date
  activeFrom?: Date | null
  activeTo?: Date | null
}): number {
  if (input.monthlyUsd === null || !(input.monthlyUsd > 0)) return 0
  const start = startOfUtcDay(Math.max(input.from.getTime(), input.activeFrom?.getTime() ?? -Infinity))
  const endRaw = Math.min(input.to.getTime(), input.activeTo?.getTime() ?? Infinity)
  const end = startOfUtcDay(endRaw - 1) + DAY_MS
  if (!(end > start)) return 0
  let fee = 0
  let cursor = start
  while (cursor < end) {
    const date = new Date(cursor)
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    const daysInMonth = Math.round((monthEnd - monthStart) / DAY_MS)
    const overlapEnd = Math.min(end, monthEnd)
    const days = Math.round((overlapEnd - cursor) / DAY_MS)
    fee += (input.monthlyUsd * days) / daysInMonth
    cursor = overlapEnd
  }
  return Math.round(fee * 100) / 100
}
