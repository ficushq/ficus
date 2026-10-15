/**
 * Spend reads over the ledger. Per-call rows answer days inside the retention window; daily rollups
 * answer the days before it, so the two never overlap (see retention.ts).
 */
import { inArray, sql, type SQL } from 'drizzle-orm'
import {
  featureLabel,
  formatAgentLabel,
  planLabel,
  providerLabel,
  type InferenceBilling,
  type SpendBreakdown,
  type SpendBreakdownRow,
  type SpendDimension,
  type SpendFilters,
  type SpendSubscriptionLine,
  type SpendSummary,
} from '@ficus/shared'
import { agents, db, squads, users, workStreams } from '../../db'
import { readAccountStore, type Account, type AccountStoreV1 } from '../agent/account-store'
import { getSettingsStore } from '../settings'
import { isSubscriptionAccount } from './billing'
import { effectiveMonthlyPrice, subscriptionFee } from './subscription-plan'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SpendRange {
  /** Inclusive. */
  from: Date
  /** Exclusive. */
  to: Date
}

export interface SpendQueryOptions {
  now?: Date
  retentionDays?: number
  store?: AccountStoreV1
}

function startOfUtcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

export function inferenceRetentionDays(): number {
  const days = Number(getSettingsStore().getTyped('INFERENCE_USAGE_RETENTION_DAYS'))
  return Number.isFinite(days) && days >= 1 ? Math.min(Math.round(days), 365) : 180
}

/** The first UTC day whose per-call rows are still kept; days before it are read from the rollups. */
export function detailCutoff(now: Date, retentionDays: number): Date {
  return new Date(startOfUtcDay(now.getTime() - retentionDays * DAY_MS))
}

const DIMENSION_SQL: Record<SpendDimension, SQL> = {
  feature: sql`feature`,
  provider: sql`provider`,
  model: sql`model`,
  // Account ids are only unique within a provider.
  account: sql`CASE WHEN account_id IS NULL THEN NULL ELSE coalesce(provider, '') || '/' || account_id END`,
  billing: sql`billing`,
  squad: sql`squad_id::text`,
  workStream: sql`work_stream_id::text`,
  agent: sql`agent_id::text`,
  user: sql`user_id::text`,
}

/** Filters as SQL over either source (both tables share the dimension column names). */
function filterSql(filters: SpendFilters): SQL {
  const parts: SQL[] = [sql`true`]
  const uuidFilter = (column: string, value: string | undefined) => {
    if (value === undefined) return
    if (value === '') parts.push(sql`${sql.raw(column)} IS NULL`)
    else parts.push(sql`${sql.raw(column)}::text = ${value}`)
  }
  const textFilter = (column: string, value: string | undefined) => {
    if (value === undefined) return
    if (value === '') parts.push(sql`${sql.raw(column)} IS NULL`)
    else parts.push(sql`${sql.raw(column)} = ${value}`)
  }
  uuidFilter('squad_id', filters.squadId)
  uuidFilter('work_stream_id', filters.workStreamId)
  uuidFilter('agent_id', filters.agentId)
  uuidFilter('user_id', filters.userId)
  textFilter('feature', filters.feature)
  textFilter('provider', filters.provider)
  textFilter('model', filters.model)
  textFilter('billing', filters.billing)
  if (filters.accountId !== undefined) {
    const separator = filters.accountId.indexOf('/')
    if (filters.accountId === '') parts.push(sql`account_id IS NULL`)
    else if (separator >= 0) {
      parts.push(sql`coalesce(provider, '') = ${filters.accountId.slice(0, separator)}`)
      parts.push(sql`account_id = ${filters.accountId.slice(separator + 1)}`)
    } else parts.push(sql`account_id = ${filters.accountId}`)
  }
  return sql.join(parts, sql` AND `)
}

/** Every call in the range, one row per call (detail) or per rolled-up group (rollups), same shape. */
function sourceSql(range: SpendRange, filters: SpendFilters, cutoff: Date): SQL {
  const where = filterSql(filters)
  const detailFrom = new Date(Math.max(range.from.getTime(), cutoff.getTime())).toISOString()
  const rollupFrom = isoDay(range.from.getTime())
  const rollupTo = isoDay(Math.min(range.to.getTime(), cutoff.getTime()))
  return sql`
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, feature, provider, model, account_id, billing,
      squad_id, work_stream_id, agent_id, user_id, 1 AS calls,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nanodollars,
      coalesce(list_cost_nanodollars, 0) AS list_cost, (list_cost_nanodollars IS NULL)::int AS list_unknown,
      cost_estimated::int AS estimated
    FROM inference_usage
    WHERE occurred_at >= ${detailFrom}::timestamptz AND occurred_at < ${range.to.toISOString()}::timestamptz
      AND ${where}
    UNION ALL
    SELECT day, feature, provider, model, account_id, billing,
      squad_id, work_stream_id, agent_id, user_id, calls,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nanodollars,
      list_cost_nanodollars, list_unknown_calls, estimated_calls
    FROM inference_usage_daily
    WHERE day >= ${rollupFrom}::date AND day < ${rollupTo}::date AND ${where}
  `
}

const MEASURES = sql`
  coalesce(sum(calls), 0)::bigint AS calls,
  coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
  coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
  coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
  coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens,
  coalesce(sum(cost_nanodollars), 0)::bigint AS cost,
  coalesce(sum(list_cost), 0)::bigint AS list_cost,
  coalesce(sum(list_unknown), 0)::bigint AS list_unknown,
  coalesce(sum(estimated), 0)::bigint AS estimated
`

type MeasureRow = {
  calls: string | number
  input_tokens: string | number
  output_tokens: string | number
  cache_read_tokens: string | number
  cache_write_tokens: string | number
  cost: string | number
  list_cost: string | number
  list_unknown: string | number
  estimated: string | number
}

function measures(row: MeasureRow | undefined) {
  const n = (value: string | number | undefined) => Number(value ?? 0)
  const input = n(row?.input_tokens)
  const output = n(row?.output_tokens)
  const cacheRead = n(row?.cache_read_tokens)
  const cacheWrite = n(row?.cache_write_tokens)
  return {
    calls: n(row?.calls),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    tokens: input + output + cacheRead + cacheWrite,
    billedUsd: n(row?.cost) / 1e9,
    listUsd: n(row?.list_cost) / 1e9,
    approximate: n(row?.list_unknown) > 0 || n(row?.estimated) > 0,
  }
}

/** Subscription fees apply only when the view is not narrowed to a slice of the calls they pay for. */
function feesApply(filters: SpendFilters): boolean {
  const narrowing: Array<keyof SpendFilters> = ['squadId', 'workStreamId', 'agentId', 'userId', 'feature', 'model']
  if (narrowing.some((key) => filters[key] !== undefined)) return false
  return filters.billing === undefined || filters.billing === 'subscription'
}

function subscriptionAccounts(
  store: AccountStoreV1,
  filters: SpendFilters
): Array<{ provider: string; account: Account }> {
  const accounts: Array<{ provider: string; account: Account }> = []
  for (const [provider, list] of Object.entries(store.accounts)) {
    if (filters.provider !== undefined && filters.provider !== provider) continue
    for (const account of list) {
      if (!isSubscriptionAccount(account)) continue
      if (filters.accountId !== undefined) {
        const key = filters.accountId.includes('/') ? `${provider}/${account.id}` : account.id
        if (key !== filters.accountId) continue
      }
      accounts.push({ provider, account })
    }
  }
  return accounts
}

async function firstUseByAccount(): Promise<Map<string, number>> {
  const rows = await db.execute<{ key: string; first: string }>(sql`
    SELECT coalesce(provider, '') || '/' || account_id AS key, min(first) AS first FROM (
      SELECT provider, account_id, min(occurred_at) AS first FROM inference_usage
        WHERE account_id IS NOT NULL AND billing = 'subscription' GROUP BY 1, 2
      UNION ALL
      SELECT provider, account_id, min(day)::timestamptz AS first FROM inference_usage_daily
        WHERE account_id IS NOT NULL AND billing = 'subscription' GROUP BY 1, 2
    ) firsts GROUP BY 1
  `)
  return new Map([...rows].map((row) => [row.key, new Date(row.first).getTime()]))
}

/** When a subscription started counting: when it was added, else its first call, else the range start. */
function activeFrom(provider: string, account: Account, firstUse: Map<string, number>): Date | null {
  if (account.createdAt) return new Date(account.createdAt)
  const first = firstUse.get(`${provider}/${account.id}`)
  return first !== undefined ? new Date(first) : null
}

function accountLabel(provider: string, account: Account): string {
  return `${providerLabel(provider)} · ${account.label ?? account.id}`
}

/** Totals, a daily series, subscription line items and a month projection for a range. */
export async function spendSummary(
  range: SpendRange,
  filters: SpendFilters = {},
  options: SpendQueryOptions = {}
): Promise<SpendSummary> {
  const now = options.now ?? new Date()
  const retentionDays = options.retentionDays ?? inferenceRetentionDays()
  const cutoff = detailCutoff(now, retentionDays)
  const store = options.store ?? readAccountStore()
  const source = sourceSql(range, filters, cutoff)
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  const monthSource = sourceSql({ from: new Date(monthStart), to: now }, filters, cutoff)

  const [totalsRows, seriesRows, accountRows, monthRows, firstUse] = await Promise.all([
    db.execute<MeasureRow>(sql`SELECT ${MEASURES} FROM (${source}) src`),
    db.execute<MeasureRow & { day: string }>(
      sql`SELECT day::text AS day, ${MEASURES} FROM (${source}) src GROUP BY day ORDER BY day`
    ),
    db.execute<MeasureRow & { key: string }>(
      sql`SELECT coalesce(provider, '') || '/' || account_id AS key, ${MEASURES} FROM (${source}) src
          WHERE account_id IS NOT NULL GROUP BY 1`
    ),
    db.execute<MeasureRow>(sql`SELECT ${MEASURES} FROM (${monthSource}) src`),
    firstUseByAccount(),
  ])
  const totals = measures([...totalsRows][0])
  const byAccount = new Map([...accountRows].map((row) => [row.key, measures(row)]))

  const includeFees = feesApply(filters)
  const subscriptions: SpendSubscriptionLine[] = includeFees
    ? subscriptionAccounts(store, filters).map(({ provider, account }) => {
        const price = effectiveMonthlyPrice(provider, account.subscription)
        const usage = byAccount.get(`${provider}/${account.id}`)
        const plan = account.subscription?.plan ?? null
        return {
          provider,
          accountId: account.id,
          label: accountLabel(provider, account),
          plan,
          planLabel: plan ? planLabel(provider, plan) : null,
          planSource: account.subscription?.planSource ?? null,
          detectedPlan: account.subscription?.detectedPlan ?? null,
          monthlyPriceUsd: price.monthlyUsd,
          priceSource: price.source,
          needsChoice: price.monthlyUsd === null,
          feeUsd: subscriptionFee({
            monthlyUsd: price.monthlyUsd,
            from: range.from,
            to: new Date(Math.min(range.to.getTime(), now.getTime())),
            activeFrom: activeFrom(provider, account, firstUse),
            activeTo: now,
          }),
          calls: usage?.calls ?? 0,
          listUsd: usage?.listUsd ?? 0,
        }
      })
    : []
  const subscriptionFeesUsd = subscriptions.reduce((sum, line) => sum + line.feeUsd, 0)

  const month = measures([...monthRows][0])
  const elapsed = (now.getTime() - monthStart) / (monthEnd - monthStart)
  const monthlyFees = subscriptions.reduce((sum, line) => sum + (line.monthlyPriceUsd ?? 0), 0)
  const projection = elapsed > 0 ? month.billedUsd / elapsed + monthlyFees : null

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    totals: {
      calls: totals.calls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      billedUsd: totals.billedUsd,
      subscriptionFeesUsd,
      totalUsd: totals.billedUsd + subscriptionFeesUsd,
      listUsd: totals.listUsd,
      approximate: totals.approximate,
    },
    series: [...seriesRows].map((row) => {
      const point = measures(row)
      return {
        day: row.day,
        billedUsd: point.billedUsd,
        listUsd: point.listUsd,
        calls: point.calls,
        tokens: point.tokens,
      }
    }),
    subscriptions,
    projection: { monthUsd: projection },
    meta: { retentionDays, detailFrom: cutoff.toISOString(), feesIncluded: includeFees },
  }
}

const BILLING_LABELS: Record<InferenceBilling, string> = {
  api: 'API key',
  subscription: 'Subscription',
  'self-hosted': 'Self-hosted',
  unknown: 'Unknown (before tracking)',
}

const UNATTRIBUTED: Record<SpendDimension, string> = {
  feature: 'Unknown feature',
  provider: 'Unknown provider',
  model: 'Unknown model',
  account: 'No stored account',
  billing: 'Unknown',
  squad: 'No squad',
  workStream: 'No work stream',
  agent: 'No agent',
  user: 'No person',
}

/** Display labels for one dimension's keys, looked up in one query per dimension. */
async function labelsFor(
  dimension: SpendDimension,
  keys: string[],
  store: AccountStoreV1
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  if (keys.length === 0) return labels
  switch (dimension) {
    case 'feature':
      for (const key of keys) labels.set(key, featureLabel(key))
      break
    case 'provider':
      for (const key of keys) labels.set(key, providerLabel(key))
      break
    case 'model':
      for (const key of keys) labels.set(key, key)
      break
    case 'billing':
      for (const key of keys) labels.set(key, BILLING_LABELS[key as InferenceBilling] ?? key)
      break
    case 'account':
      for (const key of keys) {
        const separator = key.indexOf('/')
        const provider = key.slice(0, separator)
        const id = key.slice(separator + 1)
        const account = store.accounts[provider]?.find((candidate) => candidate.id === id)
        labels.set(
          key,
          account
            ? accountLabel(provider, account)
            : id === 'openai-services'
              ? 'OpenAI API services'
              : id === 'google-cloud'
                ? 'Google Cloud'
                : `${provider ? `${providerLabel(provider)} · ` : ''}${id}`
        )
      }
      break
    case 'squad': {
      const rows = await db.select({ id: squads.id, name: squads.name }).from(squads).where(inArray(squads.id, keys))
      for (const row of rows) labels.set(row.id, row.name)
      break
    }
    case 'workStream': {
      const rows = await db
        .select({ id: workStreams.id, title: workStreams.title, number: workStreams.number })
        .from(workStreams)
        .where(inArray(workStreams.id, keys))
      for (const row of rows) labels.set(row.id, row.number ? `#${row.number} ${row.title}` : row.title)
      break
    }
    case 'agent': {
      const rows = await db
        .select({
          id: agents.id,
          agentTypeId: agents.agentTypeId,
          name: sql<string | null>`${agents.metadata}->>'name'`,
          purpose: sql<string | null>`${agents.metadata}->>'purpose'`,
        })
        .from(agents)
        .where(inArray(agents.id, keys))
      for (const row of rows) labels.set(row.id, formatAgentLabel(row))
      break
    }
    case 'user': {
      const rows = await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, keys))
      for (const row of rows) labels.set(row.id, row.displayName || row.email)
      break
    }
  }
  return labels
}

function labelOf(dimension: SpendDimension, key: string | null, labels: Map<string, string>): string {
  if (key === null) return UNATTRIBUTED[dimension]
  // Deleted squads, agents and work streams keep their spend under their id.
  return (
    labels.get(key) ??
    (['squad', 'workStream', 'agent', 'user'].includes(dimension) ? `Deleted (${key.slice(0, 8)})` : key)
  )
}

/** Spend grouped by one dimension, or two, largest first. */
export async function spendBreakdown(
  range: SpendRange,
  filters: SpendFilters,
  by: SpendDimension,
  by2?: SpendDimension,
  limit = 50,
  options: SpendQueryOptions = {}
): Promise<SpendBreakdown> {
  const now = options.now ?? new Date()
  const cutoff = detailCutoff(now, options.retentionDays ?? inferenceRetentionDays())
  const store = options.store ?? readAccountStore()
  const source = sourceSql(range, filters, cutoff)
  const second = by2 && by2 !== by ? by2 : undefined
  const keys = second
    ? sql`${DIMENSION_SQL[by]} AS key, ${DIMENSION_SQL[second]} AS key2`
    : sql`${DIMENSION_SQL[by]} AS key, NULL::text AS key2`
  const rows = [
    ...(await db.execute<MeasureRow & { key: string | null; key2: string | null }>(sql`
      SELECT ${keys}, ${MEASURES} FROM (${source}) src
      GROUP BY 1, 2
      ORDER BY coalesce(sum(cost_nanodollars), 0) DESC, coalesce(sum(list_cost), 0) DESC, coalesce(sum(calls), 0) DESC
      LIMIT ${limit + 1}
    `)),
  ]
  const truncated = rows.length > limit
  const kept = rows.slice(0, limit)
  const distinct = (values: Array<string | null>) => [...new Set(values.filter((value): value is string => !!value))]
  const [labels, labels2] = await Promise.all([
    labelsFor(by, distinct(kept.map((row) => row.key)), store),
    second ? labelsFor(second, distinct(kept.map((row) => row.key2)), store) : Promise.resolve(new Map()),
  ])
  return {
    by,
    ...(second ? { by2: second } : {}),
    rows: kept.map((row): SpendBreakdownRow => {
      const measured = measures(row)
      return {
        key: row.key,
        label: labelOf(by, row.key, labels),
        ...(second ? { key2: row.key2, label2: labelOf(second, row.key2, labels2) } : {}),
        calls: measured.calls,
        tokens: measured.tokens,
        billedUsd: measured.billedUsd,
        listUsd: measured.listUsd,
        approximate: measured.approximate,
      }
    }),
    truncated,
  }
}
