/**
 * Work stream summaries: a one-line, model-written "what is happening now" for each active stream
 * (docs/wiki/work-stream-summaries.md).
 *
 * The status chips (step, waits, PR and CI) come from the database; this sentence only adds the
 * gist of the participants' latest messages. It is a convenience: any error, timeout or invalid
 * answer leaves the previous summary in place. This file is pure (its I/O is injected);
 * `runtime.ts` wires the database, events and models.
 */
import type { StoredWorkStreamSummary, WorkStreamStatus } from '@ficus/shared'
import type { LightCompletionRequest, LightCompletionResult } from '../model-tiers/light-completion'
import { parseStreamSummary } from './parse'
import { buildStreamSummaryPrompt, STREAM_SUMMARY_MAX_TOKENS, STREAM_SUMMARY_SYSTEM } from './prompt'

export const STREAM_SUMMARY_TIER = 'lite'
/** Cost ledger purpose: shows in Settings → Spend as `lite:stream-summary`. */
export const STREAM_SUMMARY_PURPOSE = 'stream-summary'
/** Settings key for the instance-wide switch. */
export const STREAM_SUMMARIES_SETTING = 'STREAM_SUMMARIES_ENABLED'
/** At most one generation per stream in this window. */
export const STREAM_SUMMARY_MIN_INTERVAL_MS = 5 * 60_000
/** New participant messages that make a refresh due (a step change makes it due on its own). */
export const STREAM_SUMMARY_ROW_TRIGGER = 3
/** Rows the model reads at most, newest kept. */
export const STREAM_SUMMARY_MAX_ROWS = 18
/** Generations running at once, instance-wide; more wait for a slot. */
export const MAX_STREAM_SUMMARIES_IN_FLIGHT = 2
/** How long a due stream waits for a free slot before trying again. */
export const STREAM_SUMMARY_BUSY_RETRY_MS = 30_000
export const STREAM_SUMMARY_TIMEOUT_MS = 8_000
export const STREAM_SUMMARY_TOTAL_TIMEOUT_MS = 15_000

/** The Activity lane of an agent's own chat messages: the only rows that count as "sent". */
export const PARTICIPANT_MESSAGE_LANE = 10
/**
 * Agent types that are never stream participants even if bound by mistake: the manager coordinates
 * every stream and consultants talk with people. The stream owner is excluded by id.
 */
export const NON_PARTICIPANT_AGENT_TYPES: ReadonlySet<string> = new Set(['manager', 'consultant'])

export interface SummaryStream {
  id: string
  squadId: string
  title: string
  status: WorkStreamStatus
  ownerAgentId: string | null
  stored: StoredWorkStreamSummary | null
}

/** One Activity row of a participant (`squad_activity`). */
export interface SummaryActivityRow {
  agentId: string
  agentTypeId: string | null
  lane: number
  text: string
  at: Date
}

/**
 * The rows the model may read: only messages the stream's participants sent themselves (their chat
 * rows), never received-message relays, system notices, subagent reports or rows of the owner, the
 * manager or a consultant. Oldest first, at most `limit` (the newest are kept).
 */
export function selectSummaryInputRows(
  rows: readonly SummaryActivityRow[],
  stream: Pick<SummaryStream, 'ownerAgentId'>,
  limit = STREAM_SUMMARY_MAX_ROWS
): SummaryActivityRow[] {
  return rows
    .filter(
      (row) =>
        row.lane === PARTICIPANT_MESSAGE_LANE &&
        row.agentId !== stream.ownerAgentId &&
        !(row.agentTypeId && NON_PARTICIPANT_AGENT_TYPES.has(row.agentTypeId)) &&
        /\S/.test(row.text)
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-limit)
}

export type SummaryRefreshDecision = 'throttled' | 'not-due' | 'no-input' | 'refresh'

/**
 * Whether a stream's summary should be regenerated now.
 * - At most once per {@link STREAM_SUMMARY_MIN_INTERVAL_MS} (from the stored `generatedAt`).
 * - Due when the step changed since the stored summary (or there is none yet), or when at least
 *   {@link STREAM_SUMMARY_ROW_TRIGGER} new participant messages arrived.
 * - Needs input: new rows, or for a step change, a previous summary to update.
 *
 * `pendingMessages` is the number of participant messages seen live since the last attempt. A
 * chat row is updated in place for each new message of the same run, so the stored rows alone
 * undercount messages; the larger of the two counts.
 */
export function decideSummaryRefresh(input: {
  stored: StoredWorkStreamSummary | null
  step: string | null
  newRows: number
  pendingMessages: number
  now: Date
  minIntervalMs?: number
}): SummaryRefreshDecision {
  const { stored, step, newRows, now } = input
  const minIntervalMs = input.minIntervalMs ?? STREAM_SUMMARY_MIN_INTERVAL_MS
  if (stored && now.getTime() - new Date(stored.generatedAt).getTime() < minIntervalMs) return 'throttled'
  const stepChanged = !stored || (stored.step ?? null) !== (step ?? null)
  if (stepChanged) return newRows > 0 || stored ? 'refresh' : 'no-input'
  if (Math.max(newRows, input.pendingMessages) < STREAM_SUMMARY_ROW_TRIGGER) return 'not-due'
  return newRows > 0 ? 'refresh' : 'no-input'
}

export interface StreamSummaryDeps {
  /** The Settings switch, read before anything else and again before saving. */
  isEnabled: () => boolean
  loadStream: (streamId: string) => Promise<SummaryStream | null>
  /** The stream's current step label (`WorkStream.step`). */
  loadStep: (stream: SummaryStream) => Promise<string | null>
  /**
   * Participant chat rows newer than `since` (all when null), newest first, at most `limit`.
   * Implementations should already filter; the service filters again.
   */
  loadParticipantRows: (stream: SummaryStream, since: Date | null, limit: number) => Promise<SummaryActivityRow[]>
  complete: (request: LightCompletionRequest) => Promise<LightCompletionResult | null>
  /**
   * Store the summary and notify clients, only while the stream is active and its stored
   * `generatedAt` is still `previousGeneratedAt` (no concurrent save); resolves whether it saved.
   */
  save: (
    stream: SummaryStream,
    summary: StoredWorkStreamSummary,
    previousGeneratedAt: string | null
  ) => Promise<boolean>
  now?: () => Date
  onError?: (error: unknown) => void
}

export type StreamSummaryOutcome =
  | 'disabled'
  | 'not-active'
  | 'throttled'
  | 'not-due'
  | 'no-input'
  | 'no-answer'
  | 'invalid'
  | 'stale'
  | 'saved'
  | 'error'

export interface StreamSummaryResult {
  outcome: StreamSummaryOutcome
  /** For `throttled`: when the stored summary allows the next generation. */
  retryAt?: Date
}

/** Regenerate one stream's summary if it is due. Never throws, and does nothing while the switch is off. */
export async function refreshStreamSummary(
  streamId: string,
  pendingMessages: number,
  deps: StreamSummaryDeps
): Promise<StreamSummaryResult> {
  try {
    if (!deps.isEnabled()) return { outcome: 'disabled' }
    const now = deps.now ?? (() => new Date())
    const stream = await deps.loadStream(streamId)
    if (!stream || stream.status !== 'active') return { outcome: 'not-active' }
    const stored = stream.stored
    if (stored && now().getTime() - new Date(stored.generatedAt).getTime() < STREAM_SUMMARY_MIN_INTERVAL_MS)
      return {
        outcome: 'throttled',
        retryAt: new Date(new Date(stored.generatedAt).getTime() + STREAM_SUMMARY_MIN_INTERVAL_MS),
      }
    const [step, loaded] = await Promise.all([
      deps.loadStep(stream),
      deps.loadParticipantRows(stream, stored?.through ? new Date(stored.through) : null, STREAM_SUMMARY_MAX_ROWS),
    ])
    const since = stored?.through ? new Date(stored.through).getTime() : -Infinity
    const rows = selectSummaryInputRows(
      loaded.filter((row) => row.at.getTime() > since),
      stream
    )
    const decision = decideSummaryRefresh({ stored, step, newRows: rows.length, pendingMessages, now: now() })
    if (decision !== 'refresh') return { outcome: decision }
    const answer = await deps.complete({
      tier: STREAM_SUMMARY_TIER,
      system: STREAM_SUMMARY_SYSTEM,
      prompt: buildStreamSummaryPrompt({
        title: stream.title,
        step,
        previous: stored?.text ?? null,
        rows: rows.map((row) => ({ agentTypeId: row.agentTypeId, text: row.text })),
      }),
      maxTokens: STREAM_SUMMARY_MAX_TOKENS,
      timeoutMs: STREAM_SUMMARY_TIMEOUT_MS,
      totalTimeoutMs: STREAM_SUMMARY_TOTAL_TIMEOUT_MS,
      purpose: STREAM_SUMMARY_PURPOSE,
      source: { workStreamId: stream.id, squadId: stream.squadId },
    })
    if (!answer) return { outcome: 'no-answer' }
    const text = parseStreamSummary(answer.text)
    if (!text) return { outcome: 'invalid' }
    // Switched off while the model was answering: drop the answer.
    if (!deps.isEnabled()) return { outcome: 'disabled' }
    const newest = rows.at(-1)?.at
    const summary: StoredWorkStreamSummary = {
      text,
      generatedAt: now().toISOString(),
      step,
      through: newest ? newest.toISOString() : (stored?.through ?? null),
    }
    return { outcome: (await deps.save(stream, summary, stored?.generatedAt ?? null)) ? 'saved' : 'stale' }
  } catch (error) {
    deps.onError?.(error)
    return { outcome: 'error' }
  }
}

interface ScheduledStream {
  /** Participant messages seen live since the last attempt. */
  messages: number
  /** Something about the stream changed (maybe its step) since the last attempt. */
  changed: boolean
  lastAttemptAt?: number
  /** Earliest time the next attempt may start (throttle or busy retry). */
  notBefore?: number
  cancelTimer?: () => void
}

export interface StreamSummarySchedulerOptions {
  run: (streamId: string, pendingMessages: number) => Promise<StreamSummaryResult>
  minIntervalMs?: number
  rowTrigger?: number
  maxInFlight?: number
  busyRetryMs?: number
  now?: () => number
  setTimer?: (fire: () => void, ms: number) => () => void
}

const defaultSetTimer = (fire: () => void, ms: number) => {
  const handle = setTimeout(fire, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

/**
 * Decides when to look at a stream. Live hints (a participant message, a stream change) mark a stream;
 * it is attempted when a step may have changed or enough messages arrived, at most once per
 * `minIntervalMs` per stream, with at most `maxInFlight` attempts at once. Idle streams get no
 * timers and no work. All state is in memory: after a restart the next hint starts it again, and the
 * stored `generatedAt` still enforces the interval.
 */
export class StreamSummaryScheduler {
  private readonly streams = new Map<string, ScheduledStream>()
  private inFlight = 0
  private readonly minIntervalMs: number
  private readonly rowTrigger: number
  private readonly maxInFlight: number
  private readonly busyRetryMs: number
  private readonly now: () => number
  private readonly setTimer: (fire: () => void, ms: number) => () => void

  constructor(private readonly options: StreamSummarySchedulerOptions) {
    this.minIntervalMs = options.minIntervalMs ?? STREAM_SUMMARY_MIN_INTERVAL_MS
    this.rowTrigger = options.rowTrigger ?? STREAM_SUMMARY_ROW_TRIGGER
    this.maxInFlight = options.maxInFlight ?? MAX_STREAM_SUMMARIES_IN_FLIGHT
    this.busyRetryMs = options.busyRetryMs ?? STREAM_SUMMARY_BUSY_RETRY_MS
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? defaultSetTimer
  }

  /** A participant of the stream sent a message. */
  noteMessage(streamId: string): void {
    const entry = this.entry(streamId)
    entry.messages += 1
    this.consider(streamId)
  }

  /** The stream changed (its step may have moved). */
  noteStreamChanged(streamId: string): void {
    this.entry(streamId).changed = true
    this.consider(streamId)
  }

  /** The stream finished or was deleted: drop its state and timer. */
  forget(streamId: string): void {
    this.streams.get(streamId)?.cancelTimer?.()
    this.streams.delete(streamId)
  }

  /** Drop everything (the switch was turned off, or shutdown). */
  clear(): void {
    for (const entry of this.streams.values()) entry.cancelTimer?.()
    this.streams.clear()
  }

  /** Streams with state, for tests and diagnostics. */
  get size(): number {
    return this.streams.size
  }

  private entry(streamId: string): ScheduledStream {
    let entry = this.streams.get(streamId)
    if (!entry) {
      entry = { messages: 0, changed: false }
      this.streams.set(streamId, entry)
    }
    return entry
  }

  private consider(streamId: string): void {
    const entry = this.streams.get(streamId)
    if (!entry || entry.cancelTimer) return
    const due = entry.changed || entry.messages >= this.rowTrigger
    if (!due) return
    const now = this.now()
    const earliest = Math.max(
      entry.lastAttemptAt !== undefined ? entry.lastAttemptAt + this.minIntervalMs : 0,
      entry.notBefore ?? 0
    )
    if (earliest > now) return this.wake(streamId, entry, earliest - now)
    if (this.inFlight >= this.maxInFlight) return this.wake(streamId, entry, this.busyRetryMs)
    this.start(streamId, entry, now)
  }

  private wake(streamId: string, entry: ScheduledStream, ms: number): void {
    entry.cancelTimer = this.setTimer(() => {
      entry.cancelTimer = undefined
      this.consider(streamId)
    }, ms)
  }

  private start(streamId: string, entry: ScheduledStream, now: number): void {
    const messages = entry.messages
    const previousAttemptAt = entry.lastAttemptAt
    entry.messages = 0
    entry.changed = false
    entry.lastAttemptAt = now
    entry.notBefore = undefined
    this.inFlight += 1
    void this.options
      .run(streamId, messages)
      .catch((): StreamSummaryResult => ({ outcome: 'error' }))
      .then((result) => {
        if (this.streams.get(streamId) !== entry) return
        if (result.outcome === 'not-active' || result.outcome === 'disabled') return this.forget(streamId)
        if (!MODEL_OUTCOMES.has(result.outcome)) {
          // No model call happened: it does not use up the interval, but the next look waits a little.
          entry.lastAttemptAt = previousAttemptAt
          entry.notBefore = Math.max(this.now() + this.busyRetryMs, result.retryAt?.getTime() ?? 0)
          entry.messages += messages
          // Throttled by the stored summary: still due once the interval has passed.
          if (result.outcome === 'throttled') entry.changed = true
        }
      })
      .finally(() => {
        this.inFlight -= 1
        if (this.streams.get(streamId) === entry) this.consider(streamId)
      })
  }
}

/** Outcomes after which the model was asked (or could have been): these use up the interval. */
const MODEL_OUTCOMES: ReadonlySet<StreamSummaryOutcome> = new Set(['no-answer', 'invalid', 'stale', 'saved', 'error'])
