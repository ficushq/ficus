import {
  getLatestCompactionEntry,
  type CompactionResult,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { earlyThresholdReached } from './config'
import {
  compactionResultDebug,
  type PrecompactionLifecycleEvent,
  type PrecompactionLifecycleStats,
  type PrecompactionRejectReason,
} from './debug'
import { computePrefixFingerprint, matchesPrefixFingerprint, type PrefixFingerprint } from './prefix'

// Background summaries of large contexts may take minutes; the foreground hook
// still waits only PRECOMPACTION_AWAIT_MS before falling back.
export const BAKE_TIMEOUT_MS = 180_000
export const BAKE_RETRY_COOLDOWN_MS = 60_000
export const PRECOMPACTION_AWAIT_MS = 10_000

export interface BranchSnapshot {
  entries: SessionEntry[]
  latestCompactionEntryId: string | null
}

export interface PrecompactionBakeSuccess {
  compaction: CompactionResult
  /** Model key the compaction result was produced under; defaults to the pre-bake key. */
  modelKey?: string | undefined
}

export type PrecompactionBakeOutput = CompactionResult | PrecompactionBakeSuccess

export interface PrecompactionDeps {
  /** Current context usage, or undefined if unavailable. */
  getContextUsage: () => { tokens: number; contextWindow: number } | undefined
  /** Pi compaction settings (enabled, reserveTokens, keepRecentTokens). */
  getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  /** Whether pi is currently compacting. */
  isCompacting: () => boolean
  /** Snapshot the current branch entries + latest compaction entry id. */
  snapshot: () => BranchSnapshot
  /** Stable key identifying the active model (provider/id/contextWindow). */
  getModelKey: () => string | undefined
  /** Run the actual bake; resolves to a compaction result (optionally with metadata) or null on failure/abort. */
  bake: (entries: SessionEntry[], signal: AbortSignal) => Promise<PrecompactionBakeOutput | null>
  /** Effective early margin in tokens (already resolved; <=0 disables). */
  marginTokens: number
  /** Effective in-flight (mid-turn) margin in tokens (already resolved; <=0 disables). */
  inFlightMarginTokens: number
}

interface Cached {
  result: CompactionResult
  modelKey: string | undefined
  reserveTokens: number
  keepRecentTokens: number
  latestCompactionEntryIdAtSnapshot: string | null
  prefixFingerprint: PrefixFingerprint | null
  readyAt: number
}

interface InFlight {
  abort: AbortController
  startedAt: number
  stats: PrecompactionLifecycleStats
  timer: ReturnType<typeof setTimeout>
  timedOut: boolean
  promise: Promise<void>
}

type State = 'idle' | 'precomputing' | 'ready'

/**
 * State machine that bakes a context-compaction summary in the background
 * (at an early token threshold) and serves it to pi's `session_before_compact`
 * hook so the synchronous LLM-compaction stall is skipped.
 *
 * Lifecycle: idle → precomputing → ready → (consumed) idle, with abort on
 * invalidate/dispose. At most one bake per session; failures degrade silently
 * to pi's synchronous fallback. Pure: the real bake is injected, so this module
 * has no direct pi imports beyond types and `getLatestCompactionEntry`.
 */
export class PrecompactionController {
  private state: State = 'idle'
  private cache?: Cached
  private abort?: AbortController
  private inFlight?: InFlight
  private disposed = false
  private lastActivityAt: number
  private retryAfter = 0

  /** Best-effort observability hook for debug UI/logging; callback errors are swallowed. */
  onLifecycle?: (event: PrecompactionLifecycleEvent) => void

  constructor(
    private deps: PrecompactionDeps,
    private readonly now: () => number = Date.now
  ) {
    this.lastActivityAt = now()
  }

  /** Swap session-bound deps when a new session for this agent is created.
   * Pure assignment — must not touch abort/inFlight/state/cache. The in-flight
   * bake keeps the deps it captured at start; validation then runs against the
   * consuming session. */
  rebind(deps: PrecompactionDeps): void {
    this.deps = deps
    this.lastActivityAt = this.now()
  }

  isDisposed(): boolean {
    return this.disposed
  }

  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  /** Test-only: fire the in-flight wall-clock cap immediately. */
  forceTimeoutForTest(): void {
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer)
      this.inFlight.timedOut = true
      this.inFlight.abort.abort()
    }
  }

  /** Called after every settled turn. Starts a background bake if warranted. */
  onSettled(): void {
    this.lastActivityAt = this.now()
    if (this.disposed) return
    if (this.state !== 'idle') return
    this.tryStartBake(this.deps.marginTokens)
  }

  /**
   * Called mid-turn after context-growth points (for example persisted tool
   * results). Uses a tighter threshold closer to pi's normal compaction point.
   * The idle/precomputing/ready state machine dedupes in-flight and ready bakes.
   */
  onContextGrowth(): void {
    this.lastActivityAt = this.now()
    if (this.disposed) return
    if (this.state !== 'idle') return
    this.tryStartBake(this.deps.inFlightMarginTokens)
  }

  private tryStartBake(marginTokens: number): void {
    if (marginTokens <= 0 || this.now() < this.retryAfter) return
    if (this.deps.isCompacting()) return

    const settings = this.deps.getCompactionSettings()
    if (!settings.enabled) return

    const usage = this.deps.getContextUsage()
    if (!usage) return
    if (!earlyThresholdReached(usage.tokens, usage.contextWindow, settings.reserveTokens, marginTokens)) {
      return
    }

    const snap = this.deps.snapshot()
    const modelKey = this.deps.getModelKey()
    const reserveTokens = settings.reserveTokens
    const keepRecentTokens = settings.keepRecentTokens
    const abort = new AbortController()
    const stats: PrecompactionLifecycleStats = {
      contextTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      reserveTokens,
      earlyMarginTokens: marginTokens,
    }
    // Wall-clock cap: aborts the bake; the controller returns to idle only when the bake promise settles (relies on compact() honoring the AbortSignal).
    const timer = setTimeout(() => {
      if (this.inFlight?.abort === abort) this.inFlight.timedOut = true
      abort.abort()
    }, BAKE_TIMEOUT_MS)
    this.abort = abort
    // Reserve the slot before invoking injected code (which may re-enter or throw).
    this.state = 'precomputing'
    let bakePromise: Promise<PrecompactionBakeOutput | null>
    try {
      bakePromise = this.deps.bake(snap.entries, abort.signal)
    } catch (error) {
      bakePromise = Promise.reject(error)
    }
    const settledPromise = bakePromise.then(
      (result) => {
        clearTimeout(timer)
        if (this.disposed || this.abort !== abort) return
        const timedOut = this.inFlight?.timedOut ?? false
        // Some SDK/provider paths resolve partial text when their signal is aborted.
        // A timed-out result must never become the replacement session context.
        if (!result || abort.signal.aborted) {
          this.retryAfter = this.now() + BAKE_RETRY_COOLDOWN_MS
          this.emitLifecycle({
            kind: 'failed',
            ...stats,
            elapsedMs: this.elapsedMs(abort),
            error: timedOut ? 'timeout' : undefined,
          })
          this.resetToIdle()
          return
        }
        const baked = normalizeBakeOutput(result)
        const elapsedMs = this.elapsedMs(abort)
        this.abort = undefined
        this.inFlight = undefined
        this.cache = {
          result: baked.compaction,
          modelKey: baked.modelKey ?? modelKey,
          reserveTokens,
          keepRecentTokens,
          latestCompactionEntryIdAtSnapshot: snap.latestCompactionEntryId,
          prefixFingerprint: computePrefixFingerprint(snap.entries, baked.compaction.firstKeptEntryId),
          readyAt: this.now(),
        }
        this.retryAfter = 0
        this.state = 'ready'
        this.emitLifecycle({ kind: 'succeeded', ...stats, elapsedMs, result: compactionResultDebug(baked.compaction) })
      },
      (err) => {
        clearTimeout(timer)
        if (this.abort !== abort) return
        const timedOut = this.inFlight?.timedOut ?? false
        this.retryAfter = this.now() + BAKE_RETRY_COOLDOWN_MS
        this.emitLifecycle({
          kind: 'failed',
          ...stats,
          elapsedMs: this.elapsedMs(abort),
          error: timedOut ? 'timeout' : errorMessage(err),
        })
        this.resetToIdle()
      }
    )
    this.inFlight = { abort, startedAt: this.now(), stats, timer, timedOut: false, promise: settledPromise }
    this.state = 'precomputing'
    this.emitLifecycle({ kind: 'started', ...stats })
    void settledPromise
  }

  /** Called by the session_before_compact hook. Validates the cache. */
  getReadyResult(event: SessionBeforeCompactEvent): CompactionResult | undefined {
    this.lastActivityAt = this.now()
    if (this.disposed) return undefined

    // pi is compacting synchronously NOW. A still-running bake is summarizing a
    // branch state that is about to be superseded — cancel it so it cannot cache
    // a stale result, and fall back to sync compaction.
    if (this.state === 'precomputing') {
      this.invalidate('superseded')
      return undefined
    }

    const cached = this.cache
    if (this.state !== 'ready' || !cached) return undefined

    if (cached.modelKey !== this.deps.getModelKey()) return this.reject('model')

    const settings = this.deps.getCompactionSettings()
    if (
      !settings.enabled ||
      settings.reserveTokens !== cached.reserveTokens ||
      settings.keepRecentTokens !== cached.keepRecentTokens
    ) {
      return this.reject('settings')
    }

    const stillPresent = event.branchEntries.some((e) => (e as { id?: string }).id === cached.result.firstKeptEntryId)
    if (!stillPresent) return this.reject('cutpoint')

    const latest = getLatestCompactionEntry(event.branchEntries)
    const latestId = latest ? ((latest as { id?: string }).id ?? null) : null
    if (latestId !== cached.latestCompactionEntryIdAtSnapshot) return this.reject('latestCompaction')

    if (
      !cached.prefixFingerprint ||
      !matchesPrefixFingerprint(event.branchEntries, cached.prefixFingerprint, cached.result.firstKeptEntryId)
    ) {
      return this.reject('prefix')
    }

    const result = cached.result
    this.cache = undefined
    this.abort = undefined
    this.state = 'idle' // consumed
    this.emitLifecycle({ kind: 'consumed', firstKeptEntryId: result.firstKeptEntryId })
    return result
  }

  /**
   * Called by the session_before_compact hook. If a baked result is already
   * ready, validates and consumes it immediately. If a bake is in flight, waits
   * briefly for it to finish, then consumes a valid result or cancels the stale
   * bake and lets pi perform synchronous compaction.
   */
  async awaitReadyResult(
    event: SessionBeforeCompactEvent,
    waitMs: number = PRECOMPACTION_AWAIT_MS
  ): Promise<CompactionResult | undefined> {
    this.lastActivityAt = this.now()
    if (this.disposed) return undefined

    if (this.state === 'ready') {
      return this.getReadyResult(event)
    }

    if (this.state === 'precomputing' && this.inFlight && waitMs > 0) {
      try {
        await timeoutPromise(this.inFlight.promise, waitMs)
      } catch {
        // Timeout: correctness wins, so fall through to synchronous fallback.
      }

      const stateAfterWait = this.state as State
      if (stateAfterWait === 'ready') {
        return this.getReadyResult(event)
      }

      if (stateAfterWait === 'precomputing') {
        this.invalidate('superseded')
      }
      return undefined
    }

    if (this.state === 'precomputing') {
      this.invalidate('superseded')
    }
    return undefined
  }

  private reject(reason: PrecompactionRejectReason): undefined {
    this.emitLifecycle({ kind: 'rejected', reason })
    this.invalidate()
    return undefined
  }

  /** Drop a ready-but-unconsumed result older than `ttlMs` (idle reclamation). */
  reclaimIfStale(ttlMs: number): void {
    if (this.state === 'ready' && this.cache && this.now() - this.cache.readyAt >= ttlMs) {
      this.invalidate()
    }
  }

  /** Discard any cached result and abort any in-flight bake. */
  invalidate(abortKind: 'aborted' | 'superseded' = 'aborted'): void {
    this.retryAfter = 0
    const inFlight = this.inFlight
    if (inFlight) clearTimeout(inFlight.timer)
    if (this.state === 'precomputing' && inFlight) {
      this.emitLifecycle({ kind: abortKind, ...inFlight.stats, elapsedMs: this.now() - inFlight.startedAt })
    }
    this.abort?.abort()
    this.abort = undefined
    this.inFlight = undefined
    this.cache = undefined
    this.state = 'idle'
  }

  /** Tear down on session shutdown. */
  dispose(): void {
    this.disposed = true
    this.invalidate()
  }

  private resetToIdle(): void {
    if (this.inFlight) clearTimeout(this.inFlight.timer)
    this.abort = undefined
    this.inFlight = undefined
    this.cache = undefined
    this.state = 'idle'
  }

  private elapsedMs(abort: AbortController): number {
    return this.inFlight?.abort === abort ? this.now() - this.inFlight.startedAt : 0
  }

  private emitLifecycle(event: PrecompactionLifecycleEvent): void {
    try {
      this.onLifecycle?.(event)
    } catch {
      // Debug hooks are best-effort and must never corrupt controller state.
    }
  }
}

function normalizeBakeOutput(output: PrecompactionBakeOutput): PrecompactionBakeSuccess {
  if ('compaction' in output) return output
  return { compaction: output }
}

function timeoutPromise<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
