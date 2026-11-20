import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  matchLinearTeamValue,
  type LinearTeamDirectory,
  type LinearTeamListingError,
  type LinearTeamSummary,
} from '@ficus/shared'
import { integrationQueries } from '../../queryOptions'
import { Picker, usePopover, type PickerOption } from '../popover'
import { ChevronDownIcon, CloseIcon } from '../icons'

const LISTING_ERRORS: Record<LinearTeamListingError, string> = {
  connection_unusable: 'the connection needs attention in Settings → Integrations',
  insufficient_scope:
    'the Ficus app is missing a Linear permission Ficus now needs; Reconnect it on the Linear card in Settings → Integrations',
  reconnect_required: 'it needs Reconnect on the Linear card in Settings → Integrations',
  invalid_auth: 'Linear refused its credential; reconnect it in Settings → Integrations',
  rate_limited: 'Linear is rate-limiting requests; try again in a minute',
  provider_unavailable: 'Linear could not be reached; try again shortly',
}

const TEAM_SEARCH = { label: 'Search Linear teams', placeholder: 'Search by name or key…', empty: 'No teams match' }

function useLinearTeams(squadId: string) {
  const query = useQuery(integrationQueries.squadLinearTeams(squadId))
  const directory: LinearTeamDirectory = query.data ?? { teams: [], connections: [] }
  return { query, directory, teams: directory.teams }
}

function teamDescription(team: LinearTeamSummary, directory: LinearTeamDirectory) {
  const parts = [team.key]
  // With several workspaces attached, say which one a team comes from.
  if (directory.connections.length > 1)
    parts.push(
      team.connectionIds
        .map((id) => directory.connections.find((connection) => connection.id === id)?.displayName)
        .filter(Boolean)
        .join(', ')
    )
  return parts.filter(Boolean).join(' · ')
}

function teamOption(team: LinearTeamSummary, directory: LinearTeamDirectory): PickerOption<string> {
  return {
    value: team.id,
    label: team.name,
    description: teamDescription(team, directory),
    keywords: `${team.key} ${team.id}`,
  }
}

/** A saved value that is not a listed team ID keeps its own option, so it is shown and can be cleared. */
/** Why a saved team is not listed. With a connection that failed to list, the team may belong to it. */
function unknownTeamText(directory: LinearTeamDirectory) {
  return directory.connections.some((connection) => connection.status === 'error')
    ? 'Unknown team: not among the teams Ficus could list (a connection that failed to list may have it)'
    : 'Unknown team: not found in this squad’s Linear connections'
}

function savedOption(value: string, directory: LinearTeamDirectory): PickerOption<string> {
  const teams = directory.teams
  const match = matchLinearTeamValue(value, teams)
  return match.kind === 'key'
    ? { value, label: `${match.team.name} (saved by key ${value})`, description: 'Routing matches team IDs only' }
    : { value, label: value, description: unknownTeamText(directory) }
}

/** Loading, no-connection, error and truncation notes for the listing. */
function ListingStatus({ squadId }: { squadId: string }) {
  const { query, directory } = useLinearTeams(squadId)
  if (query.isPending)
    return (
      <p role="status" className="text-xs text-muted">
        Loading Linear teams…
      </p>
    )
  if (query.isError)
    return (
      <p role="alert" className="text-xs text-status-danger-500">
        Could not load Linear teams.{' '}
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    )
  if (directory.connections.length === 0)
    return (
      <p role="status" className="text-xs text-muted">
        No Linear connection is attached to this squad, so there are no teams to choose from. Attach one above.
      </p>
    )
  const failed = directory.connections.filter((connection) => connection.status === 'error')
  const truncated = directory.connections.filter((connection) => connection.truncated)
  if (failed.length === 0 && truncated.length === 0) return null
  return (
    <div role="alert" className="space-y-1 text-xs text-status-attention-600 dark:text-status-attention-400">
      {failed.map((connection) => (
        <p key={connection.id}>
          Could not list teams for {connection.displayName}:{' '}
          {LISTING_ERRORS[connection.error ?? 'provider_unavailable']}.
        </p>
      ))}
      {truncated.map((connection) => (
        <p key={connection.id}>
          {connection.displayName} has more teams than Ficus lists; some teams are missing from the list.
        </p>
      ))}
      {failed.length > 0 && (
        <button type="button" className="underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      )}
    </div>
  )
}

/** When nothing can be listed, a team ID can still be added by hand so routing never becomes uneditable. */
function ManualTeamEntry({ onAdd, disabled }: { onAdd: (teamId: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('')
  const add = () => {
    if (!text.trim()) return
    onAdd(text.trim())
    setText('')
  }
  return (
    <div className="flex gap-2">
      <input
        type="text"
        aria-label="Linear team ID"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          add()
        }}
        placeholder="Team ID"
        className="ficus-field w-full rounded border border-th-border bg-surface px-3 py-1.5 text-sm text-primary focus:ring-1 focus:ring-accent/50"
      />
      <button
        type="button"
        disabled={disabled || !text.trim()}
        onClick={add}
        className="ficus-button ficus-button-secondary shrink-0 rounded-md px-3 py-1.5 text-sm"
      >
        Add team ID
      </button>
    </div>
  )
}

/**
 * The squad's routed Linear teams (`metadata.linear`), chosen from the teams its attached connections
 * list. Values are team IDs; a saved key or an unknown ID stays visible and removable, never dropped.
 */
export function LinearTeamRoutingPicker({
  squadId,
  value,
  onChange,
  disabled,
}: {
  squadId: string
  value: readonly string[]
  onChange: (teamIds: string[]) => void
  disabled?: boolean
}) {
  const { query, directory, teams } = useLinearTeams(squadId)
  const popover = usePopover({ kind: 'dialog' })
  const listed = new Set(teams.map((team) => team.id))
  const options = [
    ...value.filter((teamId) => !listed.has(teamId)).map((teamId) => savedOption(teamId, directory)),
    ...teams.map((team) => teamOption(team, directory)),
  ]
  const remove = (teamId: string) => onChange(value.filter((item) => item !== teamId))
  const canList = teams.length > 0

  return (
    // The settings search's "Linear teams" entry lands here.
    <div className="space-y-3" data-setting-target="team-id">
      {value.length === 0 ? (
        <p className="text-sm text-muted">No teams selected. Linear issues are not routed to this squad by team.</p>
      ) : (
        <ul aria-label="Routed Linear teams" className="space-y-2">
          {value.map((teamId) => {
            const match = matchLinearTeamValue(teamId, teams)
            const known = match.kind !== 'unknown'
            const name = known ? match.team.name : teamId
            return (
              <li
                key={teamId}
                className="flex items-start gap-2 rounded-lg border border-panel-border px-3 py-2 text-sm"
                data-team-match={match.kind}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-primary wrap-break-word">
                    {name}
                    {known && <span className="ml-2 text-xs font-normal text-muted">{match.team.key}</span>}
                  </p>
                  {match.kind === 'key' && (
                    <p className="mt-1 text-xs text-status-attention-600 dark:text-status-attention-400">
                      Saved by its key {teamId}. Routing matches team IDs, so this entry does not route issues.{' '}
                      {!disabled && (
                        <button
                          type="button"
                          className="underline"
                          onClick={() =>
                            onChange(
                              value
                                .map((item) => (item === teamId ? match.team.id : item))
                                .filter((item, index, all) => all.indexOf(item) === index)
                            )
                          }
                        >
                          Use the team ID
                        </button>
                      )}
                    </p>
                  )}
                  {match.kind === 'unknown' && !query.isPending && !canList && (
                    <p className="mt-1 text-xs text-muted">Saved team ID. Its name shows once teams can be listed.</p>
                  )}
                  {match.kind === 'unknown' && canList && (
                    <p className="mt-1 text-xs text-status-attention-600 dark:text-status-attention-400">
                      {unknownTeamText(directory)}. It stays saved until you remove it.
                    </p>
                  )}
                </div>
                {!disabled && (
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => remove(teamId)}
                    className="ficus-button ficus-button-ghost shrink-0 rounded-md p-1"
                  >
                    <CloseIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <ListingStatus squadId={squadId} />
      {canList ? (
        <>
          <button
            {...popover.triggerProps}
            type="button"
            onClick={popover.toggle}
            disabled={disabled}
            className="ficus-button ficus-button-secondary inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm"
          >
            Choose teams
            <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <Picker
            {...popover.popoverProps}
            multiple
            label="Linear teams"
            search={TEAM_SEARCH}
            value={value}
            options={options}
            onChange={onChange}
            align="start"
            width={320}
            maxHeight={400}
          />
        </>
      ) : (
        !query.isPending && (
          <ManualTeamEntry disabled={disabled} onAdd={(teamId) => onChange([...new Set([...value, teamId])])} />
        )
      )}
    </div>
  )
}

/** One Linear team for an event rule's team filter, or any team (`undefined`). */
export function LinearTeamFilterPicker({
  squadId,
  value,
  onChange,
  disabled,
  className,
}: {
  squadId: string
  value: string | undefined
  onChange: (teamId: string | undefined) => void
  disabled?: boolean
  className: string
}) {
  const { query, directory, teams } = useLinearTeams(squadId)
  const popover = usePopover({ kind: 'dialog' })
  const current = value ?? ''
  const match = current ? matchLinearTeamValue(current, teams) : null
  const options: PickerOption<string>[] = [
    { value: '', label: 'Any connected team' },
    ...(current && match?.kind !== 'id' ? [savedOption(current, directory)] : []),
    ...teams.map((team) => teamOption(team, directory)),
  ]
  const shown = !match
    ? 'Any connected team'
    : match.kind === 'id'
      ? `${match.team.name} (${match.team.key})`
      : match.kind === 'key'
        ? `${match.team.name} (saved by key ${current})`
        : query.isPending
          ? current
          : `Unknown team ${current}`

  if (!query.isPending && teams.length === 0)
    return (
      <input
        className={className}
        aria-label="Team filter"
        value={current}
        disabled={disabled}
        placeholder="Any connected team (no teams could be listed; enter a team ID)"
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    )
  return (
    <>
      <button
        {...popover.triggerProps}
        type="button"
        role="combobox"
        aria-label={`Team filter: ${shown}`}
        disabled={disabled}
        onClick={popover.toggle}
        className={`${className} flex items-center justify-between gap-2 text-left`}
        data-team-match={match?.kind ?? 'any'}
      >
        <span
          className={
            match?.kind === 'unknown' || match?.kind === 'key'
              ? 'text-status-attention-600 dark:text-status-attention-400'
              : undefined
          }
        >
          {shown}
        </span>
        <ChevronDownIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>
      <Picker
        {...popover.popoverProps}
        label="Team filter"
        search={TEAM_SEARCH}
        value={current}
        options={options}
        onChange={(teamId) => onChange(teamId || undefined)}
        align="start"
        width="anchor"
        maxHeight={400}
      />
    </>
  )
}
