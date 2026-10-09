import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RenderItem } from '@ficus/client-core'
import {
  assistantRoutingExcerpt,
  assistantRoutingLabel,
  effectiveAssistantRouting,
  type AssistantRoutingHint,
  type AssistantRoutingTarget,
} from '@ficus/shared'
import { assistantApi } from '../api/assistant'
import { queries } from '../queryOptions'
import { SelectionPopup, type PopupOption } from './ThemedPopup'
import { GlobeIcon, SettingsIcon, SquadIcon } from './icons'

const NO_SQUAD = 'none'
type Choice = typeof NO_SQUAD | `squad:${string}`
export type AssistantRoutingPick = { scope: 'squad'; squadId: string } | { scope: 'none' }

export interface RoutingChipSquad {
  id: string
  name: string
  purpose?: string | null
}

function TargetIcon({ target }: { target: AssistantRoutingTarget }) {
  const className = 'h-3.5 w-3.5 shrink-0'
  if (target.scope === 'squad') return <SquadIcon className={className} />
  if (target.scope === 'instance') return <SettingsIcon className={className} />
  return <GlobeIcon className={className} />
}

const choiceFor = (target: AssistantRoutingTarget): Choice =>
  target.scope === 'squad' && target.squadId ? `squad:${target.squadId}` : NO_SQUAD

/**
 * Where the Assistant's routing decision sent a user message ("Chlea", "Not about a squad",
 * "General"). On the latest message, picking another squad, or No squad, tells the Assistant at once
 * (`onCorrect`). On older messages the work has already gone somewhere, so picking one only puts a
 * request to move it in the composer (`onAskToMove`), which the user can edit and send.
 */
export function AssistantRoutingChip({
  hint,
  squads,
  onCorrect,
  onAskToMove,
}: {
  hint: AssistantRoutingHint
  squads: readonly RoutingChipSquad[]
} & (
  | { onCorrect: (pick: AssistantRoutingPick) => Promise<unknown>; onAskToMove?: never }
  | { onAskToMove: (target: AssistantRoutingTarget) => void; onCorrect?: never }
)) {
  const [pending, setPending] = useState<AssistantRoutingTarget | null>(null)
  const [error, setError] = useState<string>()
  const shown = pending ?? effectiveAssistantRouting(hint)
  const byUser = Boolean(pending ?? hint.correction)
  const label = assistantRoutingLabel(shown)
  const listed = squads.some((squad) => squad.id === shown.squadId)
  const options: PopupOption<Choice>[] = [
    {
      value: NO_SQUAD,
      label: 'No squad',
      description: 'Ficus itself or general work',
      icon: <GlobeIcon className="h-4 w-4" />,
    },
    ...(shown.scope === 'squad' && shown.squadId && !listed
      ? [{ value: choiceFor(shown), label, icon: <SquadIcon className="h-4 w-4" /> }]
      : []),
    ...squads.map((squad) => ({
      value: `squad:${squad.id}` as Choice,
      label: squad.name,
      ...(squad.purpose?.trim() ? { description: squad.purpose.trim() } : {}),
      icon: <SquadIcon className="h-4 w-4" />,
    })),
  ]
  const choose = (choice: Choice) => {
    if (choice === choiceFor(shown)) return
    const squad = squads.find((entry) => `squad:${entry.id}` === choice)
    const target: AssistantRoutingTarget =
      choice === NO_SQUAD || !squad ? { scope: 'none' } : { scope: 'squad', squadId: squad.id, squadName: squad.name }
    if (onAskToMove) return onAskToMove(target)
    setError(undefined)
    setPending(target)
    void onCorrect(target.scope === 'squad' ? { scope: 'squad', squadId: target.squadId! } : { scope: 'none' }).then(
      () => setPending(null),
      (cause) => {
        setPending(null)
        setError(cause instanceof Error ? cause.message : 'Could not change the squad')
      }
    )
  }
  const action = onAskToMove ? 'Ask the Assistant to move it' : 'Change squad'
  return (
    <div className="mt-1 flex flex-col items-end gap-0.5 pr-1" data-assistant-routing>
      <SelectionPopup
        label={`Routing: ${label}${byUser ? ', set by you' : ''}. ${action}`}
        heading={onAskToMove ? 'Ask the Assistant to move this to' : 'Send this to'}
        title={
          onAskToMove
            ? 'Its work has already gone somewhere. Picking a squad writes a request you can edit and send.'
            : byUser
              ? 'You chose where this goes'
              : 'Where the decision model thinks this goes'
        }
        value={choiceFor(shown)}
        options={options}
        onChange={choose}
        width={280}
        className="ficus-button ficus-button-secondary inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted"
      >
        <TargetIcon target={shown} />
        <span className="truncate">{label}</span>
        {byUser && (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">you</span>
          </>
        )}
      </SelectionPopup>
      {error && (
        <span role="alert" className="text-[11px] text-status-danger-600 dark:text-status-danger-400">
          {error}
        </span>
      )}
    </div>
  )
}

/** The request the composer gets when the user asks to move an older message's work. */
export function assistantMoveRequest(
  content: string,
  from: AssistantRoutingTarget,
  to: AssistantRoutingTarget
): string {
  const quote = JSON.stringify(assistantRoutingExcerpt(content))
  return to.scope === 'squad'
    ? `Please move ${quote} to ${assistantRoutingLabel(to)}.`
    : `Please move ${quote} out of ${assistantRoutingLabel(from)}: it isn't for a squad.`
}

/**
 * The user message whose routing can still be corrected in place: the newest one the user sent.
 * Null while a newer send is still on its way.
 */
export function latestAssistantUserMessageId(items: readonly RenderItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.kind === 'pending') {
      if (item.status !== 'failed' && (!item.metadata?.source || item.metadata.source === 'user_chat')) return null
    } else if (item.kind === 'persisted' && item.message.role === 'human') {
      if (item.message.metadata?.source === 'user_chat') return item.message.id
    }
  }
  return null
}

/** The chip for one saved user message in an Assistant conversation. */
export function AssistantMessageRouting({
  conversationId,
  messageId,
  content,
  hint,
  latest,
  onDraft,
  api = assistantApi,
}: {
  conversationId: string
  messageId: string
  content: string
  hint: AssistantRoutingHint
  /** The newest message the user sent: only it can be corrected in place. */
  latest: boolean
  /** Puts text in the conversation's composer. */
  onDraft: (text: string) => void
  api?: Pick<typeof assistantApi, 'correctRouting'>
}) {
  const squads = useQuery(queries.squads.list('active'))
  // "General" is a hint for the model, not news for the user: only a squad, Ficus itself, or a correction shows.
  if (effectiveAssistantRouting(hint).scope === 'general' && !hint.correction) return null
  const listed = (squads.data ?? []).filter((squad) => !squad.isAnonymous)
  return latest ? (
    <AssistantRoutingChip
      key="latest"
      hint={hint}
      squads={listed}
      onCorrect={(pick) => api.correctRouting(conversationId, { messageId, clientId: crypto.randomUUID(), ...pick })}
    />
  ) : (
    <AssistantRoutingChip
      key="older"
      hint={hint}
      squads={listed}
      onAskToMove={(target) => onDraft(assistantMoveRequest(content, effectiveAssistantRouting(hint), target))}
    />
  )
}
