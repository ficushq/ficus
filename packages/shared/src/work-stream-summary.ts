/**
 * One-line work stream summaries (docs/wiki/work-stream-summaries.md): a short model-written
 * sentence about what is happening in an active stream right now. Core generates and stores it;
 * web and mobile only display it, with the rules below, so every client shows the same thing.
 */
import type { WorkStreamStatus } from './types'
import type { WorkStreamDeliveryPresentation } from './status-presentation'

/** Longest summary kept, in characters. Longer model answers are discarded, never cut. */
export const WORK_STREAM_SUMMARY_MAX_CHARS = 120

/** Where Core stores the summary on the stream (`work_streams.metadata`); never returned in `metadata`. */
export const WORK_STREAM_SUMMARY_METADATA_KEY = 'streamSummary'

/** The summary as clients receive it, on `WorkStream.summary`. */
export interface WorkStreamSummary {
  /** One plain-text line, at most {@link WORK_STREAM_SUMMARY_MAX_CHARS} characters, no links or Markdown. */
  text: string
  /** ISO time it was generated. */
  generatedAt: string
  /** The step label (`WorkStream.step`) it was generated for; a summary for another step is stale. */
  step: string | null
}

/** What Core stores: the visible summary plus the newest input row it has read. */
export interface StoredWorkStreamSummary extends WorkStreamSummary {
  /** ISO `at` of the newest activity row the summary covers; later rows are "new". */
  through: string | null
}

// Control, zero-width and bidirectional-override characters never belong in a summary.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return Number.isFinite(new Date(value).getTime()) ? value : null
}

/** Stream metadata as clients see it: the stored summary is served only as `WorkStream.summary`. */
export function withoutStoredWorkStreamSummary<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object' || !(WORK_STREAM_SUMMARY_METADATA_KEY in metadata)) return metadata
  const { [WORK_STREAM_SUMMARY_METADATA_KEY]: _hidden, ...rest } = metadata as Record<string, unknown>
  return rest as T
}

/** The stored summary in stream metadata, or null when absent or malformed. */
export function parseStoredWorkStreamSummary(metadata: unknown): StoredWorkStreamSummary | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = (metadata as Record<string, unknown>)[WORK_STREAM_SUMMARY_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  const generatedAt = isoOrNull(record.generatedAt)
  if (!text || !generatedAt || [...text].length > WORK_STREAM_SUMMARY_MAX_CHARS || INVISIBLE.test(text)) return null
  const step = typeof record.step === 'string' ? record.step : null
  return { text, generatedAt, step, through: isoOrNull(record.through) }
}

/**
 * The summary a client may show for a stream, or null. Only active streams show one, and only while
 * it was generated for the stream's current step: after the step changes it is hidden until a fresh
 * one arrives, so it never contradicts the status badges. Pass the current step when the client knows
 * it (a list row's `step`, an Active work card's `step`); the server applies the same rule.
 */
export function visibleWorkStreamSummary(
  summary: WorkStreamSummary | null | undefined,
  stream: { status: WorkStreamStatus; step?: string | null }
): WorkStreamSummary | null {
  if (!summary?.text || stream.status !== 'active') return null
  if (stream.step !== undefined && (summary.step ?? null) !== (stream.step ?? null)) return null
  return summary
}

export type WorkStreamCiState = 'passing' | 'failing' | 'pending' | null

/** Aggregate CI from delivery tracking only: an individual successful run is not proof the PR is green. */
export function workStreamDeliveryCiState(delivery: WorkStreamDeliveryPresentation | undefined): WorkStreamCiState {
  const checks = delivery?.explanation?.gates?.checksState
  if (checks === 'success') return 'passing'
  if (checks === 'failure') return 'failing'
  if (checks === 'pending') return 'pending'
  const reason = delivery?.explanation?.codeHostReason
  if (reason === 'ci-failed') return 'failing'
  if (reason === 'ci-pending') return 'pending'
  return null
}
