import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DELIVERY_SUGGESTION_MAX_DRAFT_LENGTH, type DeliveryMode, type DeliverySuggestion } from '@ficus/shared'
import { queries } from '../queryOptions'
import { useStableRef } from './useStableRef'

/** How long typing must pause before the draft is judged. */
export const DELIVERY_SUGGESTION_DEBOUNCE_MS = 400
/** Drafts shorter than this are too thin to judge (Core agrees and answers null). */
export const DELIVERY_SUGGESTION_MIN_WORDS = 3
/** A suggestion applies only when it is this sure: related at or above 0.7 interrupts… */
export const DELIVERY_STEER_CONFIDENCE = 0.7
/** …and related at or below 0.3 follows up. In between the current mode stays. */
export const DELIVERY_FOLLOW_UP_CONFIDENCE = 0.3

const DEFAULT_MODE: DeliveryMode = 'steer'

/** The mode the composer picked on its own, and why. */
export interface SuggestedDelivery {
  mode: DeliveryMode
  /** The draft looks related to what the agent is doing (Interrupt), or not (Follow up). */
  related: boolean
}

/** The draft as judged: whitespace runs collapsed, so spacing edits don't ask again. */
export function normalizeDraft(draft: string): string {
  return draft.replace(/\s+/g, ' ').trim().slice(0, DELIVERY_SUGGESTION_MAX_DRAFT_LENGTH)
}

/** The mode a suggestion is sure enough to pick, if any. */
export function confidentSuggestion(result: DeliverySuggestion | undefined): SuggestedDelivery | null {
  if (!result || result.suggestion === null) return null
  if (result.probability >= DELIVERY_STEER_CONFIDENCE) return { mode: 'steer', related: true }
  if (result.probability <= DELIVERY_FOLLOW_UP_CONFIDENCE) return { mode: 'follow-up', related: false }
  return null
}

function wordCount(text: string): number {
  return text ? text.split(' ').length : 0
}

interface UseDeliverySuggestionOptions {
  agentId?: string
  /** The agent has a turn in progress to interrupt or queue behind. Idle agents are never asked. */
  busy: boolean
  fetchSuggestion: (agentId: string, draft: string, signal?: AbortSignal) => Promise<DeliverySuggestion>
  /** Runs `callback` after `ms` and returns its cancel. Tests inject a clock they advance. */
  schedule?: (callback: () => void, ms: number) => () => void
}

const scheduleTimeout = (callback: () => void, ms: number) => {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

/**
 * The composer's Interrupt / Follow up choice. While the agent works, a paused draft is judged for
 * whether it is about the current work; a confident answer pre-selects Interrupt (related) or
 * Follow up (unrelated). A manual choice wins for the rest of that draft; clearing or sending the
 * draft returns to Interrupt and lets the next suggestion apply. Sending is never blocked on it.
 */
export function useDeliverySuggestion({
  agentId,
  busy,
  fetchSuggestion,
  schedule = scheduleTimeout,
}: UseDeliverySuggestionOptions) {
  const [draft, setDraft] = useState('')
  const [settledDraft, setSettledDraft] = useState('')
  const [manualMode, setManualMode] = useState<DeliveryMode | null>(null)
  const [suggested, setSuggested] = useState<SuggestedDelivery | null>(null)
  // Another conversation starts from the default again.
  const [modeAgentId, setModeAgentId] = useState(agentId)
  if (modeAgentId !== agentId) {
    setModeAgentId(agentId)
    setManualMode(null)
    setSuggested(null)
  }

  const scheduleRef = useStableRef(schedule)
  useEffect(() => {
    // A cleared draft settles at once (in onDraftChange); there is nothing to wait for.
    if (!draft) return
    return scheduleRef.current(() => setSettledDraft(draft), DELIVERY_SUGGESTION_DEBOUNCE_MS)
  }, [draft, scheduleRef])

  // A new key for each settled draft; the previous draft's request loses its observer and is
  // cancelled through the query's abort signal.
  const { data } = useQuery({
    ...queries.composer.deliverySuggestion(agentId ?? '', settledDraft),
    queryFn: ({ signal }) => fetchSuggestion(agentId ?? '', settledDraft, signal),
    enabled: !!agentId && busy && manualMode === null && wordCount(settledDraft) >= DELIVERY_SUGGESTION_MIN_WORDS,
  })

  // Apply an answer only for the draft as it stands now, and only when it is sure; otherwise keep
  // the current mode. Derived while rendering, so a suggestion never lags a render behind.
  const next = manualMode === null && settledDraft === draft ? confidentSuggestion(data) : null
  if (next && (next.mode !== suggested?.mode || next.related !== suggested.related)) setSuggested(next)

  const reset = useCallback(() => {
    setManualMode(null)
    setSuggested(null)
  }, [])

  const onDraftChange = useCallback(
    (value: string) => {
      const normalized = normalizeDraft(value)
      if (!normalized) {
        reset()
        setSettledDraft('')
      }
      setDraft(normalized)
    },
    [reset]
  )

  const chooseMode = useCallback((mode: DeliveryMode) => setManualMode(mode), [])

  return {
    deliveryMode: manualMode ?? suggested?.mode ?? DEFAULT_MODE,
    /** Set when the shown mode is the composer's own pick (for the "Auto" indicator). */
    suggested: manualMode === null ? suggested : null,
    onDraftChange,
    chooseMode,
    reset,
  }
}
