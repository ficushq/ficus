import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
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
 * Where the Assistant's routing decision sent a user message ("Chlea · 91%", "Not about a squad",
 * "General"). Picking another squad, or No squad, tells the Assistant.
 */
export function AssistantRoutingChip({
  hint,
  squads,
  onCorrect,
}: {
  hint: AssistantRoutingHint
  squads: readonly RoutingChipSquad[]
  onCorrect: (pick: AssistantRoutingPick) => Promise<unknown>
}) {
  const [pending, setPending] = useState<AssistantRoutingTarget | null>(null)
  const [error, setError] = useState<string>()
  const shown = pending ?? effectiveAssistantRouting(hint)
  const byUser = Boolean(pending ?? hint.correction)
  const label = assistantRoutingLabel(shown)
  const detail = byUser ? 'you' : `${Math.round(hint.confidence * 100)}%`
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
    const pick: AssistantRoutingPick =
      choice === NO_SQUAD || !squad ? { scope: 'none' } : { scope: 'squad', squadId: squad.id }
    setError(undefined)
    setPending(pick.scope === 'squad' ? { scope: 'squad', squadId: squad!.id, squadName: squad!.name } : pick)
    void onCorrect(pick).then(
      () => setPending(null),
      (cause) => {
        setPending(null)
        setError(cause instanceof Error ? cause.message : 'Could not change the squad')
      }
    )
  }
  return (
    <div className="mt-1 flex flex-col items-end gap-0.5 pr-1" data-assistant-routing>
      <SelectionPopup
        label={`Routing: ${label}, ${byUser ? 'set by you' : `${detail} likely`}. Change squad`}
        heading="Send this to"
        title={byUser ? 'You chose where this goes' : 'Where the decision model thinks this goes'}
        value={choiceFor(shown)}
        options={options}
        onChange={choose}
        width={280}
        className="ficus-button ficus-button-secondary inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted"
      >
        <TargetIcon target={shown} />
        <span className="truncate">{label}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{detail}</span>
      </SelectionPopup>
      {error && (
        <span role="alert" className="text-[11px] text-status-danger-600 dark:text-status-danger-400">
          {error}
        </span>
      )}
    </div>
  )
}

/** The chip for one saved user message in an Assistant conversation. */
export function AssistantMessageRouting({
  conversationId,
  messageId,
  hint,
  api = assistantApi,
}: {
  conversationId: string
  messageId: string
  hint: AssistantRoutingHint
  api?: Pick<typeof assistantApi, 'correctRouting'>
}) {
  const squads = useQuery(queries.squads.list('active'))
  // "General" is a hint for the model, not news for the user: only a squad, Ficus itself, or a correction shows.
  if (effectiveAssistantRouting(hint).scope === 'general' && !hint.correction) return null
  return (
    <AssistantRoutingChip
      hint={hint}
      squads={(squads.data ?? []).filter((squad) => !squad.isAnonymous)}
      onCorrect={(pick) => api.correctRouting(conversationId, { messageId, clientId: crypto.randomUUID(), ...pick })}
    />
  )
}
