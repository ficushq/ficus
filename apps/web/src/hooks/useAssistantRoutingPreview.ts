import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ASSISTANT_ROUTING_PREVIEW_MAX_DRAFT,
  type AssistantRoutingHint,
  type AssistantRoutingPreview,
  type AssistantRoutingSend,
  type AssistantRoutingTarget,
} from '@ficus/shared'
import { composerQueryKeys } from '../queryKeys'
import { useStableRef } from './useStableRef'

/** How long typing must pause before the draft's routing is asked. */
export const ASSISTANT_ROUTING_PREVIEW_DEBOUNCE_MS = 800
/** Drafts shorter than this are too thin to route (Core agrees and answers null). */
export const ASSISTANT_ROUTING_PREVIEW_MIN_WORDS = 3

/** The draft as routed: whitespace runs collapsed, so spacing edits don't ask again. */
export function normalizeRoutingDraft(draft: string): string {
  return draft.replace(/\s+/g, ' ').trim().slice(0, ASSISTANT_ROUTING_PREVIEW_MAX_DRAFT)
}

const words = (text: string) => (text ? text.split(' ').length : 0)

const scheduleTimeout = (callback: () => void, ms: number) => {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

interface Options {
  conversationId: string
  /** Off for page editors and while the conversation loads. */
  enabled: boolean
  fetchPreview: (conversationId: string, draft: string, signal?: AbortSignal) => Promise<AssistantRoutingPreview>
  /** Runs `callback` after `ms` and returns its cancel. Tests inject a clock they advance. */
  schedule?: (callback: () => void, ms: number) => () => void
}

/**
 * Where an Assistant draft would go, while it is still being written: a paused draft is routed like
 * a sent message would be, so the user can see the squad and change it before sending. The pick and
 * the preview for exactly the sent text go with the message (`routingFor`), so the turn need not ask
 * again. Sending never waits for it; a message sent before an answer is routed as usual.
 */
export function useAssistantRoutingPreview({
  conversationId,
  enabled,
  fetchPreview,
  schedule = scheduleTimeout,
}: Options) {
  const [draft, setDraft] = useState('')
  const [settledDraft, setSettledDraft] = useState('')
  const [pick, setPick] = useState<AssistantRoutingTarget | null>(null)

  const scheduleRef = useStableRef(schedule)
  useEffect(() => {
    if (!draft) return
    return scheduleRef.current(() => setSettledDraft(draft), ASSISTANT_ROUTING_PREVIEW_DEBOUNCE_MS)
  }, [draft, scheduleRef])

  const { data } = useQuery({
    queryKey: composerQueryKeys.assistantRouting(conversationId, settledDraft),
    queryFn: ({ signal }) => fetchPreview(conversationId, settledDraft, signal),
    enabled: enabled && words(settledDraft) >= ASSISTANT_ROUTING_PREVIEW_MIN_WORDS,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  // The last answer stays up while the user keeps typing, so the pill doesn't flicker; a cleared
  // draft clears it.
  const hint: AssistantRoutingHint | null = draft && enabled ? (data?.hint ?? null) : null

  const onDraftChange = useCallback((value: string) => {
    const normalized = normalizeRoutingDraft(value)
    if (!normalized) {
      setSettledDraft('')
      setPick(null)
    }
    setDraft(normalized)
  }, [])

  const dataRef = useStableRef({ data, settledDraft, pick, enabled })
  /** The routing to send with `text`: the preview only if it was for exactly this text, and the pick. */
  const routingFor = useCallback(
    (text: string): AssistantRoutingSend | undefined => {
      const current = dataRef.current
      if (!current.enabled) return undefined
      const preview =
        current.data?.hint && normalizeRoutingDraft(text) === current.settledDraft ? current.data.hint : null
      const routing: AssistantRoutingSend = {
        ...(preview
          ? {
              hint: {
                scope: preview.scope === 'none' ? 'general' : preview.scope,
                ...(preview.squadId ? { squadId: preview.squadId } : {}),
                confidence: preview.confidence,
              },
            }
          : {}),
        ...(current.pick
          ? {
              pick:
                current.pick.scope === 'squad' && current.pick.squadId
                  ? { scope: 'squad', squadId: current.pick.squadId }
                  : { scope: 'none' },
            }
          : {}),
      }
      return routing.hint || routing.pick ? routing : undefined
    },
    [dataRef]
  )

  return { hint, pick, setPick, onDraftChange, routingFor }
}
