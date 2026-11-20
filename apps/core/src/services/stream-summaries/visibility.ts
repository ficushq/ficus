import {
  parseStoredWorkStreamSummary,
  visibleWorkStreamSummary,
  type WorkStreamStatus,
  type WorkStreamSummary,
} from '@ficus/shared'
import { getSettingsStore } from '../settings'

/** Settings key for the instance-wide switch (kept here too so reading it needs no service import). */
const SETTING = 'STREAM_SUMMARIES_ENABLED'

/** Whether the instance switch for work stream summaries is on. */
export function streamSummariesEnabled(): boolean {
  return getSettingsStore().getTyped(SETTING) === true
}

/**
 * The summary a client may see for one stream: none while the switch is off, for streams that are
 * not active, or when it was generated for another step than `step` (the stream's current step).
 * The stored value keeps its `through` cursor out of the response.
 */
export function presentWorkStreamSummary(
  metadata: unknown,
  stream: { status: WorkStreamStatus; step: string | null },
  enabled: boolean
): WorkStreamSummary | undefined {
  if (!enabled || stream.status !== 'active') return undefined
  const stored = parseStoredWorkStreamSummary(metadata)
  if (!stored) return undefined
  const visible = visibleWorkStreamSummary(stored, stream)
  return visible ? { text: visible.text, generatedAt: visible.generatedAt, step: visible.step } : undefined
}
