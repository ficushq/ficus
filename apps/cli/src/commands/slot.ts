import { Command } from 'commander'
import {
  apiDelete as defaultApiDelete,
  apiGet as defaultApiGet,
  apiPatch as defaultApiPatch,
  apiPost as defaultApiPost,
} from '../client'
import { output as defaultOutput, outputError } from '../output'

const MAX_CAPACITY = 1_000
const DEFAULT_HISTORY_LIMIT = 50
const MAX_HISTORY_LIMIT = 100
const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 86_400_000
const DURATION = /^(\d+)(ms|s|m|h|d)$/

type SlotOptions = { squad?: string }
export interface SlotCommandDependencies {
  apiGet: typeof defaultApiGet
  apiPost: typeof defaultApiPost
  apiPatch: typeof defaultApiPatch
  apiDelete: typeof defaultApiDelete
  output: typeof defaultOutput
}

const defaultDependencies: SlotCommandDependencies = {
  apiGet: defaultApiGet,
  apiPost: defaultApiPost,
  apiPatch: defaultApiPatch,
  apiDelete: defaultApiDelete,
  output: defaultOutput,
}
type SlotPoolProjection = {
  key: string
  capacity: number
  activeCount: number
  availableCount: number
  queuedCount: number
  oldestWaiterAgeMs?: number | null
  callerClaim?: { id?: string; expiresAt: string }
  callerWaiter?: { id?: string; queuedAt?: string }
}
type SlotPoolMutationResponse = {
  outcome: 'registered' | 'updated' | 'unregistered'
  message: string
  pool: Record<string, unknown>
}
export type SlotHistoryPage = {
  items: Array<{
    kind: 'claim' | 'waiter'
    id: string
    ownerAgentId: string
    ownerShortId: string
    status: string
    reason: string | null
    endedAt: string | null
  }>
  hasMore: boolean
  nextCursor: string | null
}
type SlotAcquireResponse = {
  outcome: 'granted' | 'queued' | 'unavailable'
  message: string
  pool: { key: string }
  claim?: { id: string; expiresAt: string }
  waiter?: { id: string }
}
type SlotRenewResponse = {
  outcome: 'renewed' | 'expired' | 'already_released'
  message: string
  claimId: string
  expiresAt: string
}
type SlotReleaseResponse = {
  outcome: 'released' | 'expired' | 'already_released'
  message: string
  claimId: string
}
type SlotUnsubscribeResponse =
  | { outcome: 'canceled'; message: string; waiterId: string }
  | {
      outcome: 'already_granted'
      message: string
      waiterId: string
      claimId: string
      claimStatus?: 'active' | 'released' | 'expired'
    }

export function resolveSlotSquadId(explicit?: string, environment = process.env.FICUS_SQUAD_ID): string {
  const squadId = explicit ?? environment
  if (!squadId) {
    throw new Error('No squad context: pass --squad <id> or run in a squad agent box with FICUS_SQUAD_ID.')
  }
  return squadId
}

export function parseSlotDuration(value: string): number {
  const match = DURATION.exec(value)
  if (!match) throw new Error('Timeout must be a duration such as 60s, 15m, or 1h.')
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const result = Number(match[1]) * units[match[2]!]!
  if (!Number.isSafeInteger(result) || result < MIN_TIMEOUT_MS || result > MAX_TIMEOUT_MS) {
    throw new Error('Timeout must be between 60s and 24h.')
  }
  return result
}

export function parseSlotHistoryLimit(value: string): number {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new Error(`History limit must be between 1 and ${MAX_HISTORY_LIMIT}.`)
  }
  return limit
}

export function parseSlotCapacity(value: string): number {
  const capacity = Number(value)
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new Error(`Capacity must be between 1 and ${MAX_CAPACITY}.`)
  }
  return capacity
}

function path(squadId: string, suffix = ''): string {
  return `/api/squads/${encodeURIComponent(squadId)}/slots${suffix}`
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

/** Claim and waiter ids are globally unique, so these need no squad or pool key. */
function resourcePath(suffix: string): string {
  return `/api/slots${suffix}`
}

function withSquad(command: Command): Command {
  return command.option('--squad <id>', 'Squad ID (defaults to FICUS_SQUAD_ID)')
}

export function renderSlotPools(result: SlotPoolProjection | SlotPoolProjection[], _squadId: string): string {
  const pools = Array.isArray(result) ? result : [result]
  if (pools.length === 0) return 'No slot pools registered.'
  const summary = (pool: SlotPoolProjection) =>
    `${pool.key}: ${pool.activeCount}/${pool.capacity} active, ${pool.availableCount} available, ${pool.queuedCount} queued`
  if (Array.isArray(result)) {
    // Each pool carries its own caller recovery state so a held claim or
    // queued wait is actionable straight from the list output.
    return pools
      .map((pool) => [summary(pool), ...callerStateLines(pool).map((line) => `  ${line}`)])
      .flat()
      .join('\n')
  }
  const lines = [summary(result)]
  if (result.oldestWaiterAgeMs != null) lines.push(`Oldest wait: ${result.oldestWaiterAgeMs}ms`)
  lines.push(...callerStateLines(result))
  return lines.join('\n')
}

function callerStateLines(pool: SlotPoolProjection): string[] {
  const lines: string[] = []
  if (pool.callerClaim?.id) {
    lines.push(
      `Your claim: ${pool.callerClaim.id}`,
      `Expires: ${pool.callerClaim.expiresAt}`,
      `Release: ficus slot release ${pool.callerClaim.id}`,
      `Renew: ficus slot renew ${pool.callerClaim.id}`
    )
  }
  if (pool.callerWaiter?.id) {
    lines.push(
      `Your waiter: ${pool.callerWaiter.id}`,
      ...(pool.callerWaiter.queuedAt ? [`Queued: ${pool.callerWaiter.queuedAt}`] : []),
      `Unsubscribe: ficus slot unsubscribe ${pool.callerWaiter.id}`
    )
  }
  return lines
}

export function renderSlotHistory(page: SlotHistoryPage, key: string, squadId: string, limit: number): string {
  if (page.items.length === 0) return 'No terminal slot history.'
  const lines = page.items.map(
    (item) =>
      `${item.kind} ${item.id}: ${item.status}, owner ${item.ownerShortId}, ended ${item.endedAt ?? 'unknown'}${
        item.reason ? `, reason ${item.reason}` : ''
      }`
  )
  if (page.hasMore && page.nextCursor) {
    lines.push(`More: ficus slot history ${key} --squad ${squadId} --limit ${limit} --cursor ${page.nextCursor}`)
  }
  return lines.join('\n')
}

export function renderSlotAcquire(result: SlotAcquireResponse, squadId: string): string {
  if (result.outcome === 'unavailable') {
    return `${result.message}\nSubscribe: ficus slot subscribe ${result.pool.key} --squad ${squadId}`
  }
  if (result.outcome === 'queued') {
    return [
      result.message,
      'YOU DO NOT OWN CAPACITY YET. Wait for the grant before starting protected work.',
      `Waiter ID: ${result.waiter!.id}`,
      `Unsubscribe: ficus slot unsubscribe ${result.waiter!.id}`,
    ].join('\n')
  }
  return [
    result.message,
    'YOU MUST RELEASE THIS CLAIM AS SOON AS YOU ARE DONE.',
    `Claim ID: ${result.claim!.id}`,
    `Expires: ${result.claim!.expiresAt}`,
    `Release: ficus slot release ${result.claim!.id}`,
    `Renew: ficus slot renew ${result.claim!.id}`,
  ].join('\n')
}

export function renderSlotRelease(result: SlotReleaseResponse): string {
  if (result.outcome === 'released') return result.message
  return `${result.message}\nYOU NO LONGER OWN THIS SLOT CAPACITY.`
}

export function renderSlotRenew(result: SlotRenewResponse): string {
  if (result.outcome !== 'renewed') {
    return `${result.message}\nYOU NO LONGER OWN THIS SLOT CAPACITY. Do not continue protected work without a new claim.`
  }
  return [
    `Renewed claim ${result.claimId}.`,
    `Expires: ${result.expiresAt}`,
    `Release: ficus slot release ${result.claimId}`,
  ].join('\n')
}

export function renderSlotUnsubscribe(result: SlotUnsubscribeResponse): string {
  if (result.outcome === 'canceled') return result.message
  // Only warn about outstanding ownership when the granted claim is still
  // active. A released or expired claim owes nothing, and the old unconditional
  // banner sent callers to release a claim that no longer existed. An older
  // server omits claimStatus; treat that as active so the warning is never lost.
  if ((result.claimStatus ?? 'active') !== 'active') {
    return `${result.message}\nYOU NO LONGER OWN THIS SLOT CAPACITY.`
  }
  return [
    result.message,
    'YOU OWN A LIVE CLAIM AND MUST RELEASE IT AS SOON AS YOU ARE DONE.',
    `Claim ID: ${result.claimId}`,
    `Release: ficus slot release ${result.claimId}`,
  ].join('\n')
}

/**
 * Administration mutations return an explicit outcome/message envelope. Never
 * infer success from HTTP 2xx or a bare pool object shape.
 */
function requireSlotMutationResponse(result: SlotPoolMutationResponse): SlotPoolMutationResponse {
  if (!result || typeof result !== 'object' || typeof (result as SlotPoolMutationResponse).outcome !== 'string') {
    throw new Error('Slot administration response is missing its outcome contract.')
  }
  return result
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    outputError(error as Error)
  }
}

export function registerSlotCommands(program: Command, dependencies = defaultDependencies): void {
  const { apiDelete, apiGet, apiPatch, apiPost, output } = dependencies
  const slot = program.command('slot').description('Coordinate squad-scoped capacity slots')

  withSquad(slot.command('list [key]').description('List slot pools or show one pool')).action(
    (key: string | undefined, options: SlotOptions) =>
      run(async () => {
        const squadId = resolveSlotSquadId(options.squad)
        const result = await apiGet<SlotPoolProjection | SlotPoolProjection[]>(
          path(squadId, key ? `/${segment(key)}` : '')
        )
        output(result, renderSlotPools(result, squadId))
      })
  )

  withSquad(slot.command('history <key>').description('Show paginated terminal slot history'))
    .option('--limit <n>', 'History page size (1-100)')
    .option('--cursor <opaque>', 'Continue from an earlier history page')
    .action((key: string, options: SlotOptions & { limit?: string; cursor?: string }) =>
      run(async () => {
        const squadId = resolveSlotSquadId(options.squad)
        const limit = options.limit ? parseSlotHistoryLimit(options.limit) : DEFAULT_HISTORY_LIMIT
        const query = new URLSearchParams()
        if (options.limit) query.set('limit', String(limit))
        if (options.cursor) query.set('cursor', options.cursor)
        const suffix = query.size > 0 ? `?${query.toString()}` : ''
        const result = await apiGet<SlotHistoryPage>(path(squadId, `/${segment(key)}/history${suffix}`))
        output(result, renderSlotHistory(result, key, squadId, limit))
      })
    )

  withSquad(slot.command('register <key>').description('Register a slot pool'))
    .option('--capacity <n>', 'Pool capacity')
    .option('--timeout <duration>', 'Claim timeout')
    .action((key: string, options: SlotOptions & { capacity?: string; timeout?: string }) =>
      run(async () => {
        const squadId = resolveSlotSquadId(options.squad)
        const result = requireSlotMutationResponse(
          await apiPost<SlotPoolMutationResponse>(path(squadId), {
            key,
            ...(options.capacity ? { capacity: parseSlotCapacity(options.capacity) } : {}),
            ...(options.timeout ? { claimTimeoutMs: parseSlotDuration(options.timeout) } : {}),
          })
        )
        output(result, result.message)
      })
    )

  withSquad(slot.command('update <key>').description('Update a slot pool'))
    .option('--capacity <n>', 'Pool capacity')
    .option('--timeout <duration>', 'Claim timeout')
    .action((key: string, options: SlotOptions & { capacity?: string; timeout?: string }) =>
      run(async () => {
        if (!options.capacity && !options.timeout) throw new Error('Pass --capacity or --timeout.')
        const squadId = resolveSlotSquadId(options.squad)
        const result = requireSlotMutationResponse(
          await apiPatch<SlotPoolMutationResponse>(path(squadId, `/${segment(key)}`), {
            ...(options.capacity ? { capacity: parseSlotCapacity(options.capacity) } : {}),
            ...(options.timeout ? { claimTimeoutMs: parseSlotDuration(options.timeout) } : {}),
          })
        )
        output(result, result.message)
      })
    )

  withSquad(slot.command('unregister <key>').description('Unregister an empty slot pool')).action(
    (key: string, options: SlotOptions) =>
      run(async () => {
        const squadId = resolveSlotSquadId(options.squad)
        const result = requireSlotMutationResponse(
          await apiDelete<SlotPoolMutationResponse>(path(squadId, `/${segment(key)}`))
        )
        output(result, result.message)
      })
  )

  withSquad(
    slot
      .command('claim <key>')
      .description('Claim capacity, queueing when none is free')
      .option('--no-subscribe', 'Fail immediately instead of queueing when no capacity is available')
  ).action((key: string, options: SlotOptions & { subscribe?: boolean }) =>
    run(async () => {
      const squadId = resolveSlotSquadId(options.squad)
      // commander sets subscribe=false for --no-subscribe; the flag is only sent
      // when opting out, so older servers keep their queueing default.
      const query = options.subscribe === false ? '?subscribe=false' : ''
      const result = await apiPost<SlotAcquireResponse>(path(squadId, `/${segment(key)}/claims${query}`), {})
      output(result, renderSlotAcquire(result, squadId))
    })
  )

  slot
    .command('renew <claim-id>')
    .description('Renew an active claim')
    .action((claimId: string) =>
      run(async () => {
        const result = await apiPost<SlotRenewResponse>(resourcePath(`/claims/${segment(claimId)}/renew`), {})
        output(result, renderSlotRenew(result))
      })
    )

  slot
    .command('release <claim-id>')
    .description('Release a claim')
    .action((claimId: string) =>
      run(async () => {
        const result = await apiDelete<SlotReleaseResponse>(resourcePath(`/claims/${segment(claimId)}`))
        output(result, renderSlotRelease(result))
      })
    )

  withSquad(slot.command('subscribe <key>').description('Join the durable FIFO wait queue')).action(
    (key: string, options: SlotOptions) =>
      run(async () => {
        const squadId = resolveSlotSquadId(options.squad)
        const result = await apiPost<SlotAcquireResponse>(path(squadId, `/${segment(key)}/waiters`), {})
        output(result, renderSlotAcquire(result, squadId))
      })
  )

  slot
    .command('unsubscribe <waiter-id>')
    .description('Cancel a queued waiter')
    .action((waiterId: string) =>
      run(async () => {
        const result = await apiDelete<SlotUnsubscribeResponse>(resourcePath(`/waiters/${segment(waiterId)}`))
        output(result, renderSlotUnsubscribe(result))
      })
    )
}
