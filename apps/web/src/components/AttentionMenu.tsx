import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { usePopupDismiss } from '../hooks/usePopupDismiss'
import { Panel } from './popover'
import {
  ATTENTION_KIND_COPY,
  ATTENTION_LEVELS,
  DEFAULT_ATTENTION,
  describeAttentionLevel,
  summarizeAttention,
  type Attention,
  type AttentionKind,
  type AttentionLevel,
} from '@ficus/shared'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import {
  subscribeSquad,
  subscribeWorkStream,
  unsubscribeSquad,
  unsubscribeWorkStream,
  type SquadSubscription,
  type WorkStreamSubscription,
} from '../api/squads'
import { BellCheckIcon, BellIcon, SpeakerOffIcon } from './icons'

export type AttentionTarget = { kind: 'squad'; id: string } | { kind: 'workStream'; id: string }

type PreviewOption = { kind: AttentionKind; level: AttentionLevel } | null

const LEVEL_LABEL: Record<AttentionLevel, string> = { mute: 'Mute', show: 'Show', notify: 'Notify' }

// The radio itself is `sr-only`, and `clip: rect(0,0,0,0)` would clip its focus outline away, so
// the visible label wears the ring while the hidden input holds the keyboard focus.
const LABEL_FOCUS_RING =
  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus'

const SUMMARY_LABEL: Record<AttentionLevel | 'custom', string> = {
  notify: 'Notify',
  show: 'Show',
  mute: 'Muted',
  custom: 'Custom',
}

function SummaryIcon({ summary }: { summary: AttentionLevel | 'custom' }) {
  if (summary === 'mute') return <SpeakerOffIcon className="h-4 w-4" />
  if (summary === 'notify') return <BellCheckIcon className="h-4 w-4" />
  return <BellIcon className="h-4 w-4" />
}

/**
 * Per-squad and per-work-stream attention. Two independent kinds, one three-point scale each:
 * Mute (not even listed), Show (listed, never interrupts), Notify (inbox message + push). A work
 * stream with no row of its own inherits the squad's levels; "Reset to squad" deletes the row.
 */
export function AttentionMenu({
  target,
  className,
  align = 'left',
  inline = false,
}: {
  target: AttentionTarget
  /** Expand inside a secondary-actions disclosure instead of floating another popover. */
  inline?: boolean
  className?: string
  /**
   * Which edge of the trigger the panel hangs from. Defaults to `left`, because most triggers sit
   * at the LEFT of their header: a right-anchored 16rem panel on a left-hand trigger runs off the
   * left edge of a phone screen. Pass `right` when the trigger is in a right-hand cluster.
   */
  align?: 'left' | 'right'
}) {
  const queryClient = useQueryClient()
  // `<details>` owns its own openness, so the state mirrors the element (via onToggle) rather
  // than driving it; closing writes the DOM property back, which re-fires onToggle.
  const [open, setOpen] = useState(false)
  const [hoveredOption, setHoveredOption] = useState<PreviewOption>(null)
  const [focusedOption, setFocusedOption] = useState<PreviewOption>(null)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const close = useCallback(() => {
    if (detailsRef.current) detailsRef.current.open = false
    setOpen(false)
  }, [])
  // Inline, it is an expander inside another popup (not a floating surface), which owns keyboard
  // focus-out. Floating, the Panel below owns dismissal.
  usePopupDismiss({ open: inline && open, popup: detailsRef, trigger: summaryRef, onDismiss: close, focusOut: false })
  const isSquad = target.kind === 'squad'
  // Two typed queries with a constant hook order, rather than one query whose options type would
  // be a union: only the one matching this target is enabled, so only it ever fetches.
  const squadQuery = useQuery({ ...queries.squadSubscription.detail(target.id), enabled: isSquad })
  const streamQuery = useQuery({ ...queries.workStreamSubscription.detail(target.id), enabled: !isSquad })
  const data: SquadSubscription | WorkStreamSubscription | undefined = isSquad ? squadQuery.data : streamQuery.data
  const attention: Attention = data?.attention ?? DEFAULT_ATTENTION
  // Until the stream's own row loads, claim neither inheritance nor an override: guessing one
  // flashes "Inherits from squad" on a stream that in fact has its own levels.
  const inheritance = isSquad || !streamQuery.data ? null : streamQuery.data.inherited ? 'squad' : 'own'
  const summary = summarizeAttention(attention)

  // One id per menu instance; each kind's description hangs off it. Several menus render on one
  // page (a squad header and every stream row), so a constant id would collide.
  const descriptionId = useId()

  const detailKey = isSquad
    ? queryKeys.squadSubscription.detail(target.id)
    : queryKeys.workStreamSubscription.detail(target.id)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: detailKey })
    queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreamsPrefix() })
    // Attention decides what the feed's presence/active-work surface carries, so it goes stale
    // with every level change.
    queryClient.invalidateQueries({ queryKey: queryKeys.activity.presence() })
    // A squad-level change moves every stream that inherits from it. Those menus are open in
    // other rows with their own cached rows, so refresh the whole family rather than one id.
    if (isSquad) queryClient.invalidateQueries({ queryKey: queryKeys.workStreamSubscription.all })
  }

  const mutation = useMutation({
    mutationFn: (next: Attention | null) => {
      if (next === null) return isSquad ? unsubscribeSquad(target.id) : unsubscribeWorkStream(target.id)
      return isSquad ? subscribeSquad(target.id, next) : subscribeWorkStream(target.id, next)
    },
    // Seed this target's row from the response BEFORE invalidating: the refetch it triggers leaves
    // the query pending for a beat, and without the seed the radios snap back to the pre-change
    // levels until it lands.
    onSuccess: (updated) => {
      queryClient.setQueryData(detailKey, updated)
      invalidate()
    },
  })

  const setLevel = (kind: AttentionKind, level: AttentionLevel) => mutation.mutate({ ...attention, [kind]: level })

  const panel = (
    <>
      {(Object.keys(ATTENTION_KIND_COPY) as AttentionKind[]).map((kind) => (
        <div key={kind} className="mb-3 last:mb-0">
          <p className="text-xs font-medium text-primary">{ATTENTION_KIND_COPY[kind].label}</p>
          <p className="mb-1 text-xs text-muted">{ATTENTION_KIND_COPY[kind].helper}</p>
          <div
            role="radiogroup"
            aria-label={ATTENTION_KIND_COPY[kind].label}
            aria-busy={mutation.isPending}
            aria-describedby={`${descriptionId}-${kind}`}
            className={clsx('flex gap-1', mutation.isPending && 'opacity-60')}
          >
            {ATTENTION_LEVELS.map((level) => (
              <label
                key={level}
                onMouseEnter={() => setHoveredOption({ kind, level })}
                onMouseLeave={() => setHoveredOption(null)}
                className={clsx(
                  'flex-1 cursor-pointer rounded border border-th-border px-2 py-1 text-center text-xs',
                  LABEL_FOCUS_RING,
                  attention[kind] === level ? 'bg-accent text-on-accent' : 'text-secondary hover:bg-surface-hover'
                )}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={`${target.kind}-${target.id}-${kind}`}
                  aria-label={`${ATTENTION_KIND_COPY[kind].label}: ${LEVEL_LABEL[level]}`}
                  checked={attention[kind] === level}
                  onChange={() => setLevel(kind, level)}
                  onFocus={() => setFocusedOption({ kind, level })}
                  onBlur={() => setFocusedOption(null)}
                />
                {LEVEL_LABEL[level]}
              </label>
            ))}
          </div>
          {/* Preview an option without changing the saved level. Restore the selected
                description when neither the pointer nor keyboard focus is on an option. */}
          <p id={`${descriptionId}-${kind}`} className="mt-1 min-h-8 text-[11px] leading-4 text-muted opacity-80">
            {describeAttentionLevel(
              kind,
              hoveredOption?.kind === kind
                ? hoveredOption.level
                : focusedOption?.kind === kind
                  ? focusedOption.level
                  : attention[kind]
            )}
          </p>
        </div>
      ))}
      {inheritance === 'squad' && <p className="text-xs text-muted">Inherits from squad</p>}
      {inheritance === 'own' && (
        <button
          type="button"
          onClick={() => mutation.mutate(null)}
          disabled={mutation.isPending}
          className="ficus-button ficus-button-link text-xs"
        >
          Reset to squad
        </button>
      )}
      {mutation.isError && (
        <p role="alert" className="mt-2 text-xs text-status-danger-600 dark:text-status-danger-400">
          Could not update attention. Try again.
        </p>
      )}
    </>
  )

  return (
    <details
      ref={detailsRef}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        if (!event.currentTarget.open) {
          setHoveredOption(null)
          setFocusedOption(null)
        }
      }}
      className={clsx('attention-menu relative', className)}
    >
      <summary
        ref={summaryRef}
        title="Choose what this notifies you about"
        className={clsx(
          'ficus-button ficus-button-ghost cursor-pointer list-none items-center gap-1.5 rounded-md',
          inline ? 'flex w-full px-3 py-2 text-sm' : 'inline-flex px-2 py-0.5 text-xs font-medium'
        )}
      >
        {inline ? <span>Notifications…</span> : <SummaryIcon summary={summary} />}
        {!inline && <span>{SUMMARY_LABEL[summary]}</span>}
      </summary>
      {inline ? (
        <div className="p-3">{panel}</div>
      ) : (
        // `ficus-overlay` + `bg-surface` is the repo's popover surface. (`bg-surface-primary` is not a defined
        // token — there is no `surface.primary` in tailwind.config.js — and once left the panel transparent.)
        <Panel
          open={open}
          onDismiss={close}
          trigger={summaryRef}
          inside={[detailsRef]}
          role="group"
          label="Notifications"
          initialFocus="none"
          gap={4}
          // Most triggers sit at the LEFT of their header, so the panel hangs from their left edge.
          align={align === 'right' ? 'end' : 'start'}
          className="ficus-overlay w-64 rounded-lg border border-th-border bg-surface p-3 shadow-theme-lg"
        >
          {panel}
        </Panel>
      )}
    </details>
  )
}
