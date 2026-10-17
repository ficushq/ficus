import { and, asc, count, desc, eq, gt, inArray, lt, lte, notInArray } from 'drizzle-orm'
import { db } from '../../db'
import { storageHomeResults, storageScanItems, storageScanPasses, storageUsageSamples } from '../../db/schema'
import type { Machine } from '../machines/queries'
import type { SshRunner } from '../machines/ssh'
import { SshTimeoutError } from '../machines/ssh'
import { buildFolderTree } from './accounting'
import {
  CHUNK_SSH_TIMEOUT_MS,
  chunkInput,
  DETAIL_SEGMENTS,
  detailDepth,
  isScanPath,
  LIST_COMMAND,
  measureCommand,
  parseChunkOutput,
  parseDuRecords,
  parseListRecords,
  segments,
  type PathOutput,
} from './chunk'

/**
 * Continuous, restartable storage scanning.
 *
 * Each machine has at most one running pass. A pass queues every box home in
 * storage_scan_items and measures the queue in short chunks (see chunk.ts).
 * Every state change is committed with the chunk's results, so a Core restart,
 * SSH drop or machine outage resumes from the queue; at most the one chunk in
 * flight is repeated.
 *
 * A chunk that hits its time limit never fails the pass. Item states only move
 * forward, which bounds the work and guarantees termination:
 *   pending --(timed out behind other paths)--> solo   (retried alone, full time)
 *   pending/solo --(timed out with the full time)--> split_pending
 *   split_pending --(listed)--> split, with its subdirectories queued as pending
 *                 --(no subdirectories)--> done (the listing measured everything)
 *                 --(listing timed out, too deep, or pass too large)--> failed
 * Children are strictly deeper, depth is capped, and a pass has at most
 * MAX_ITEMS_PER_PASS items, so splitting cannot loop.
 *
 * When every item of a home is resolved its tree is materialized into
 * storage_home_results (the latest value, kept across passes) and a growth
 * sample. When the pass has nothing left it completes and its queue is deleted.
 *
 * No unchanged-subtree shortcut: a directory's mtime/link count changes only
 * when its own entries change, not when files below it grow, so every pass
 * re-measures everything.
 *
 * Hardlinks: du runs once per queued path, so a file is counted once within a
 * measured path (a whole box home unless it had to be split). A file hardlinked
 * into two homes, or into two split subtrees, counts in each. The previous single
 * whole-machine du counted it once, in whichever home it visited first.
 */

export const SCAN_BATCH = 8
export const MAX_ITEMS_PER_PASS = 20_000
export const MAX_SPLIT_SEGMENTS = 32
export const RETAIN_PASSES = 20
export const RETENTION_DAYS = 8
/** Paused at least this long, and at least as long as the chunk took, between chunks. */
export const MIN_PAUSE_MS = 2_000
const ERROR_BACKOFF_MS = 2 * 60_000
const HOST_SAMPLE_INTERVAL_MS = 10 * 60_000

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type ScanPass = typeof storageScanPasses.$inferSelect
type Item = typeof storageScanItems.$inferSelect
const UNRESOLVED = ['pending', 'solo', 'split_pending'] as const
const STOPPED_EXIT_CODES = new Set([124, 125, 137])

export interface ScanContext {
  runner: SshRunner
  /** No chunk starts after this time (ms). */
  deadline: number
  /** Minimum time between pass starts; 0 starts passes only on request. */
  intervalMs: number
  /** Latest manual refresh request. */
  requestedAt: Date | null
  /** Checked inside each write transaction: false when this worker lost the scan lease. */
  holdsLease: (tx: Tx) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

type Work = { kind: 'measure' | 'list'; items: Item[] }

interface ChunkOutcome {
  disk: { usedBytes: number; totalBytes: number } | null
  paths: PathOutput[]
  /** The remote time limit (or the SSH limit) ended the chunk. */
  timedOut: boolean
  /** The chunk could not run at all; nothing is learned and the machine backs off. */
  failure: 'ssh_failed' | 'scan_failed' | null
}

/** The running pass, or a new one when one is due. */
export async function ensurePass(machineId: string, homes: string[], ctx: ScanContext): Promise<ScanPass | null> {
  const [running] = await db
    .select()
    .from(storageScanPasses)
    .where(and(eq(storageScanPasses.machineId, machineId), eq(storageScanPasses.status, 'running')))
  if (running) return running
  const [latest] = await db
    .select()
    .from(storageScanPasses)
    .where(eq(storageScanPasses.machineId, machineId))
    .orderBy(desc(storageScanPasses.generation))
    .limit(1)
  const due =
    (ctx.intervalMs > 0 && (!latest || latest.startedAt.getTime() <= Date.now() - ctx.intervalMs)) ||
    Boolean(ctx.requestedAt && (!latest || ctx.requestedAt > latest.startedAt))
  if (!due) return null
  const queued = [...new Set(homes)].filter((home) => isScanPath(home) && segments(home) === 2).sort()
  return db.transaction(async (tx) => {
    const [pass] = await tx
      .insert(storageScanPasses)
      .values({ machineId, generation: (latest?.generation ?? 0) + 1, homes: queued.length })
      .onConflictDoNothing()
      .returning()
    if (!pass) return null // Another worker started it.
    if (queued.length)
      await tx.insert(storageScanItems).values(queued.map((home) => ({ passId: pass.id, home, path: home })))
    return pass
  })
}

/** Listings first, then a lone retry, then a batch of same-depth paths; nothing left means df only. */
export async function nextWork(passId: string): Promise<Work> {
  const byState = (state: Item['state'], limit: number) =>
    db
      .select()
      .from(storageScanItems)
      .where(and(eq(storageScanItems.passId, passId), eq(storageScanItems.state, state)))
      .orderBy(asc(storageScanItems.path))
      .limit(limit)
  const splits = await byState('split_pending', SCAN_BATCH)
  if (splits.length) return { kind: 'list', items: splits }
  const solo = await byState('solo', 1)
  if (solo.length) return { kind: 'measure', items: solo }
  const pending = await byState('pending', SCAN_BATCH * 8)
  const depth = pending[0] ? detailDepth(pending[0].path) : 0
  return {
    kind: 'measure',
    items: pending.filter((item) => detailDepth(item.path) === depth).slice(0, SCAN_BATCH),
  }
}

export async function runChunk(machine: Machine, work: Work, runner: SshRunner): Promise<ChunkOutcome> {
  const paths = work.items.map((item) => item.path)
  const command = work.kind === 'list' ? LIST_COMMAND : measureCommand(paths[0] ? detailDepth(paths[0]) : 0)
  const empty = parseChunkOutput('', paths.length)
  try {
    const result = await runner.run(machine, command, { stdin: chunkInput(paths), timeoutMs: CHUNK_SSH_TIMEOUT_MS })
    const output = parseChunkOutput(result.stdout, paths.length)
    const finished = output.paths.every((path) => path.complete)
    // 124: `timeout` stopped the chunk; 137: it had to SIGKILL a hung command; 125: xargs saw the
    // command killed by a signal (e.g. out of memory). All are caused by the path being measured, so
    // they advance it like a timeout. 255: ssh itself failed; anything else (e.g. sudo refused) is
    // not path-specific and is retried after a backoff.
    const timedOut = !finished && STOPPED_EXIT_CODES.has(result.exitCode)
    const failure = finished || timedOut ? null : result.exitCode === 255 ? 'ssh_failed' : 'scan_failed'
    return { ...output, timedOut, failure }
  } catch (error) {
    if (error instanceof SshTimeoutError) return { ...empty, timedOut: true, failure: null }
    return { ...empty, timedOut: false, failure: 'ssh_failed' }
  }
}

const descendants = (details: Record<string, number> | null | undefined, root: string) =>
  Object.fromEntries(Object.entries(details ?? {}).filter(([path]) => path.startsWith(`${root}/`)))
const orNull = (record: Record<string, number>) => (Object.keys(record).length ? record : null)

async function setItem(tx: Tx, id: string, values: Partial<Item>) {
  await tx
    .update(storageScanItems)
    .set({ details: null, error: null, ...values, updatedAt: new Date() })
    .where(eq(storageScanItems.id, id))
}

export async function applyChunk(tx: Tx, pass: ScanPass, work: Work, outcome: ChunkOutcome): Promise<void> {
  const firstIncomplete = outcome.paths.findIndex((path) => !path.complete)
  let itemCount: number | null = null
  for (const [index, item] of work.items.entries()) {
    const output = outcome.paths[index]!
    const isHome = item.path === item.home
    if (!output.complete) {
      if (!outcome.timedOut || index !== firstIncomplete) continue // Not reached: unchanged.
      if (work.kind === 'list') await setItem(tx, item.id, { state: 'failed', error: 'scan_timeout' })
      else if (index > 0) await setItem(tx, item.id, { state: 'solo' })
      else {
        // Keep subdirectory totals du finished before the limit; the split reuses them.
        const partial = parseDuRecords(output.records, item.path)
        partial.delete(item.path)
        await setItem(tx, item.id, { state: 'split_pending', details: orNull(Object.fromEntries(partial)) })
      }
      continue
    }
    const error = output.exitCode === 0 ? null : 'permission_denied'
    if (work.kind === 'measure') {
      const entries = parseDuRecords(output.records, item.path)
      const total = entries.get(item.path)
      entries.delete(item.path)
      if (total === undefined)
        // Gone since it was queued: a removed subdirectory holds nothing; a missing home keeps its last value.
        await setItem(tx, item.id, isHome ? { state: 'failed', error: 'missing' } : { state: 'done', bytes: 0 })
      else
        await setItem(tx, item.id, { state: 'done', bytes: total, error, details: orNull(Object.fromEntries(entries)) })
      continue
    }
    const listing = parseListRecords(output.records, item.path)
    if (!listing) {
      await setItem(tx, item.id, isHome ? { state: 'failed', error: 'missing' } : { state: 'done', bytes: 0 })
      continue
    }
    if (!listing.subdirectories.length) {
      await setItem(tx, item.id, { state: 'done', bytes: listing.directBytes, error })
      continue
    }
    itemCount ??= (
      await tx.select({ value: count() }).from(storageScanItems).where(eq(storageScanItems.passId, pass.id))
    )[0]!.value
    if (segments(item.path) >= MAX_SPLIT_SEGMENTS || itemCount + listing.subdirectories.length > MAX_ITEMS_PER_PASS) {
      await setItem(tx, item.id, { state: 'failed', error: 'scan_timeout' })
      continue
    }
    const children = listing.subdirectories.map((path) => {
      const known = item.details?.[path]
      return known === undefined
        ? { passId: pass.id, home: item.home, path }
        : {
            passId: pass.id,
            home: item.home,
            path,
            state: 'done' as const,
            bytes: known,
            details: orNull(descendants(item.details, path)),
          }
    })
    const inserted = await tx
      .insert(storageScanItems)
      .values(children)
      .onConflictDoNothing()
      .returning({ id: storageScanItems.id })
    itemCount += inserted.length
    await setItem(tx, item.id, { state: 'split', bytes: listing.directBytes, error })
  }

  const now = new Date()
  await tx
    .update(storageScanPasses)
    .set({
      ...(outcome.disk
        ? { usedBytes: outcome.disk.usedBytes, totalBytes: outcome.disk.totalBytes, diskMeasuredAt: now }
        : {}),
      ...(outcome.failure
        ? { lastError: outcome.failure, lastErrorAt: now }
        : outcome.timedOut && !outcome.disk
          ? { lastError: 'ssh_timeout' as const, lastErrorAt: now }
          : { lastError: null }),
    })
    .where(eq(storageScanPasses.id, pass.id))
  if (outcome.disk) await recordHostSample(tx, pass.machineId, outcome.disk.usedBytes, now)
  for (const home of new Set(work.items.map((item) => item.home))) await resolveHome(tx, pass, home, now)
  if (!outcome.failure) await completeIfDone(tx, pass, now)
}

async function recordHostSample(tx: Tx, machineId: string, usedBytes: number, now: Date) {
  const [recent] = await tx
    .select({ id: storageUsageSamples.id })
    .from(storageUsageSamples)
    .where(
      and(
        eq(storageUsageSamples.machineId, machineId),
        eq(storageUsageSamples.subject, 'host'),
        gt(storageUsageSamples.measuredAt, new Date(now.getTime() - HOST_SAMPLE_INTERVAL_MS))
      )
    )
    .limit(1)
  if (!recent)
    await tx.insert(storageUsageSamples).values({ machineId, subject: 'host', bytes: usedBytes, measuredAt: now })
}

type ResolvedItem = Pick<Item, 'path' | 'state' | 'bytes' | 'details' | 'error'>

/** The deepest displayed ancestor of a path (deeper folders are not shown individually). */
const displayed = (path: string) =>
  path
    .split('/')
    .slice(0, DETAIL_SEGMENTS + 1)
    .join('/')

/**
 * Inclusive totals for a fully resolved home. A split directory is its own
 * entries plus its children's totals; an unmeasured child makes it (and its
 * ancestors) partial instead of silently smaller.
 */
export function assembleHome(home: string, rows: ResolvedItem[]) {
  const byPath = new Map(rows.map((row) => [row.path, row]))
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (row.path === home) continue
    const parent = row.path.slice(0, row.path.lastIndexOf('/'))
    children.set(parent, [...(children.get(parent) ?? []), row.path])
  }
  const entries = new Map<string, number>()
  const partial = new Set<string>()
  const errors = new Set<'scan_timeout' | 'permission_denied'>()
  const total = (path: string): { value: number | null; incomplete: boolean } => {
    const row = byPath.get(path)
    if (!row) return { value: null, incomplete: true }
    let value: number | null = null
    let incomplete = row.error === 'permission_denied'
    if (row.error === 'permission_denied' || row.error === 'scan_timeout') errors.add(row.error)
    if (row.state === 'done') {
      value = row.bytes ?? 0
      for (const [child, bytes] of Object.entries(row.details ?? {}))
        if (segments(child) <= DETAIL_SEGMENTS) entries.set(child, bytes)
    } else if (row.state === 'split') {
      value = row.bytes ?? 0
      for (const child of children.get(path) ?? []) {
        const measured = total(child)
        if (measured.incomplete) incomplete = true
        if (measured.value !== null) value += measured.value
      }
    } else {
      incomplete = true
      errors.add('scan_timeout')
    }
    if (incomplete) partial.add(displayed(path))
    if (value !== null && segments(path) <= DETAIL_SEGMENTS) entries.set(path, value)
    return { value, incomplete }
  }
  const bytes = total(home).value
  return { bytes, entries, partial, errors: [...errors].sort() }
}

async function resolveHome(tx: Tx, pass: ScanPass, home: string, now: Date) {
  const rows = await tx
    .select({
      path: storageScanItems.path,
      state: storageScanItems.state,
      bytes: storageScanItems.bytes,
      details: storageScanItems.details,
      error: storageScanItems.error,
    })
    .from(storageScanItems)
    .where(and(eq(storageScanItems.passId, pass.id), eq(storageScanItems.home, home)))
  if (rows.some((row) => (UNRESOLVED as readonly string[]).includes(row.state))) return
  const root = rows.find((row) => row.path === home)
  if (!root || root.error === 'missing') return
  const assembled = assembleHome(home, rows)
  // An entirely unmeasured home keeps its previous value instead of erasing it.
  if (assembled.bytes === null) return
  const status = assembled.errors.length ? 'partial' : 'available'
  const values = {
    machineId: pass.machineId,
    home,
    generation: pass.generation,
    bytes: assembled.bytes,
    status,
    errors: assembled.errors,
    folder: buildFolderTree(home, assembled.entries, assembled.partial),
    measuredAt: now,
  } as const
  await tx
    .insert(storageHomeResults)
    .values(values)
    .onConflictDoUpdate({ target: [storageHomeResults.machineId, storageHomeResults.home], set: values })
  // Growth compares complete measurements only.
  if (status === 'available')
    await tx
      .insert(storageUsageSamples)
      .values({ machineId: pass.machineId, subject: home, bytes: assembled.bytes, measuredAt: now })
}

async function completeIfDone(tx: Tx, pass: ScanPass, now: Date) {
  const [open] = await tx
    .select({ id: storageScanItems.id })
    .from(storageScanItems)
    .where(and(eq(storageScanItems.passId, pass.id), inArray(storageScanItems.state, [...UNRESOLVED])))
    .limit(1)
  if (open) return
  await tx
    .update(storageScanPasses)
    .set({ status: 'completed', completedAt: now })
    .where(eq(storageScanPasses.id, pass.id))
  // Results are materialized; the queue is no longer needed.
  await tx.delete(storageScanItems).where(eq(storageScanItems.passId, pass.id))
  await tx
    .delete(storageScanPasses)
    .where(
      and(
        eq(storageScanPasses.machineId, pass.machineId),
        lte(storageScanPasses.generation, pass.generation - RETAIN_PASSES)
      )
    )
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000)
  await tx
    .delete(storageUsageSamples)
    .where(and(eq(storageUsageSamples.machineId, pass.machineId), lt(storageUsageSamples.measuredAt, cutoff)))
  // Homes not measured for the retention period (removed boxes).
  await tx
    .delete(storageHomeResults)
    .where(and(eq(storageHomeResults.machineId, pass.machineId), lt(storageHomeResults.measuredAt, cutoff)))
}

/** Remove all scan state for machines that no longer exist (or were terminated). */
export async function pruneRemovedMachines(activeMachineIds: string[]) {
  const keep = activeMachineIds.length ? activeMachineIds : ['00000000-0000-0000-0000-000000000000']
  await db.delete(storageScanPasses).where(notInArray(storageScanPasses.machineId, keep))
  await db.delete(storageHomeResults).where(notInArray(storageHomeResults.machineId, keep))
  await db.delete(storageUsageSamples).where(notInArray(storageUsageSamples.machineId, keep))
}

export interface MachineScanTarget {
  machine: Machine
  homes: string[]
}

/**
 * Run chunks for one machine until its deadline, pacing so the remote side is
 * idle at least as long as it was busy. Returns the latest df reading taken.
 */
export async function scanMachine(
  target: MachineScanTarget,
  ctx: ScanContext
): Promise<{ usedBytes: number; totalBytes: number } | null> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let disk: { usedBytes: number; totalBytes: number } | null = null
  while (Date.now() < ctx.deadline) {
    const pass = await ensurePass(target.machine.id, target.homes, ctx)
    if (!pass) break
    if (
      (pass.lastError === 'ssh_failed' || pass.lastError === 'scan_failed') &&
      pass.lastErrorAt &&
      pass.lastErrorAt.getTime() > Date.now() - ERROR_BACKOFF_MS
    )
      break
    const work = await nextWork(pass.id)
    const started = Date.now()
    const outcome = await runChunk(target.machine, work, ctx.runner)
    const applied = await db.transaction(async (tx) => {
      if (!(await ctx.holdsLease(tx))) return false
      await applyChunk(tx, pass, work, outcome)
      return true
    })
    if (!applied || outcome.failure) break
    if (outcome.disk) disk = outcome.disk
    const pause = Math.max(MIN_PAUSE_MS, Date.now() - started)
    if (Date.now() + pause >= ctx.deadline) break
    await sleep(pause)
  }
  return disk
}
