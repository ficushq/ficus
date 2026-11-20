import { isDeploymentIntegrationKey, permissionMatches } from '@ficus/shared'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { attachIntegration, detachIntegration, type IntegrationConnection } from '../../api/integrations'
import { queries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'
import { ConfirmButton } from '../ConfirmButton'

/** A squad's Integrations tab, where its own integration settings (Linear team routing, for example) live. */
const squadIntegrationsPath = (squadId: string) =>
  `/squads/${encodeURIComponent(squadId)}/settings?section=integrations`

/**
 * Providers whose squads hold several accounts at once, one of them the default. Every other
 * provider holds one account per squad, so attaching another account replaces the squad's current one.
 */
const holdsSeveralAccounts = (provider: string) => provider === 'github' || isDeploymentIntegrationKey(provider)

/** Squad assignment routes check this permission in each squad, never the global integration permission. */
const SQUAD_INTEGRATIONS_WRITE = 'integrations:write'
/** Squads listed inline before the rest collapse into "and N more". */
const SHOWN_SQUADS = 8

interface SquadOption {
  id: string
  name: string
}

/**
 * Squads that are not archived, and which of them this person may change integrations for. A
 * system-wide grant covers every squad; otherwise each squad's own permissions are read. The
 * server still checks every assignment, so this only decides what the card offers.
 */
function useSquadsWithIntegrationWrite() {
  const squads = useQuery(queries.squads.list())
  const global = useQuery(queries.auth.permissions())
  const live: SquadOption[] = (squads.data ?? [])
    .filter((squad) => squad.status !== 'archived')
    .map((squad) => ({ id: squad.id, name: squad.name }))
  const everywhere = (global.data?.permissions ?? []).some((held) => permissionMatches(held, SQUAD_INTEGRATIONS_WRITE))
  const perSquad = useQueries({
    queries: global.isSuccess && !everywhere ? live.map((squad) => queries.auth.permissions(squad.id)) : [],
  })
  const writable = new Set(
    everywhere
      ? live.map((squad) => squad.id)
      : live
          .filter((_squad, index) =>
            (perSquad[index]?.data?.permissions ?? []).some((held) => permissionMatches(held, SQUAD_INTEGRATIONS_WRITE))
          )
          .map((squad) => squad.id)
  )
  const pending = squads.isPending || global.isPending || perSquad.some((query) => query.isPending)
  return { squads: live, writable, pending }
}

/**
 * Which squads use one pooled connection, with links to each squad's Integrations tab, a clear
 * next step when no squad can use it, and (for squads this person manages) adding or removing it
 * right here. Adding and removing go through the same squad assignment routes as the squad's own
 * Integrations tab.
 */
export function ConnectionSquads({
  provider,
  providerLabel,
  connection,
  connections,
  noun = 'account',
  nextStep,
  inherited = false,
}: {
  provider: string
  /** Shown in prose, for example "Linear". */
  providerLabel: string
  connection: IntegrationConnection
  /** Every connection of this provider, to tell which squads already use another one. */
  connections: readonly IntegrationConnection[]
  /** What this connection is called in prose: "account", "workspace" or "vault". */
  noun?: string
  /** What is still left to do in each squad once it uses this connection. */
  nextStep?: ReactNode
  /** The global default that squads, new ones included, inherit unless they choose their own accounts. */
  inherited?: boolean
}) {
  const client = useQueryClient()
  const access = useSquadsWithIntegrationWrite()
  const [choice, setChoice] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const several = holdsSeveralAccounts(provider)
  const usable = connection.enabled && connection.authState === 'authenticated'
  const usedBy = connection.usage.squads ?? []
  const usedIds = new Set(usedBy.map((squad) => squad.id))
  // The other connection each squad already uses, if any.
  const current = new Map<string, IntegrationConnection>()
  for (const other of connections)
    if (other.id !== connection.id)
      for (const squad of other.usage.squads ?? []) if (!current.has(squad.id)) current.set(squad.id, other)
  const offered = access.squads.filter((squad) => access.writable.has(squad.id) && !usedIds.has(squad.id))
  const withoutAny = offered.filter((squad) => !current.has(squad.id))
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.all })
  const attach = useMutation({
    mutationFn: async (squads: readonly SquadOption[]) => {
      const failed: string[] = []
      // One at a time: each assignment locks its squad, and a failure names the squads it missed.
      for (const squad of squads) {
        try {
          // A squad's first account of a several-account provider becomes its default.
          await attachIntegration(squad.id, provider, connection.id, !several || !current.has(squad.id))
        } catch {
          failed.push(squad.name)
        }
      }
      if (failed.length > 0) throw new Error(`Could not add this ${noun} to ${failed.join(', ')}. Try again.`)
    },
    onMutate: () => setFailure(null),
    onSuccess: () => setChoice(''),
    onError: (error) => setFailure(error.message),
    onSettled: refresh,
  })
  const detach = useMutation({
    mutationFn: (squad: SquadOption) => detachIntegration(squad.id, provider, connection.id),
    onMutate: () => setFailure(null),
    onError: (_error, squad) => setFailure(`Could not remove this ${noun} from ${squad.name}. Try again.`),
    onSettled: refresh,
  })
  const busy = attach.isPending || detach.isPending
  const chosen = offered.find((squad) => squad.id === choice)
  const label = connection.displayName
  const canAdd = usable && offered.length > 0
  const nobodyCanAdd = !access.pending && access.writable.size === 0
  return (
    <div className="mt-3 space-y-2 text-sm">
      {usedBy.length === 0 && inherited ? (
        <p className="text-xs text-muted">
          Squads use this {noun} as the global default, new squads included, unless they choose their own.
        </p>
      ) : usedBy.length === 0 ? (
        <div className="rounded-lg bg-status-attention-surface px-3 py-2 text-status-attention-fg">
          <p className="font-medium">No squad can use this {noun} yet.</p>
          <p className="mt-0.5 text-xs">
            {!usable
              ? `Enable or reconnect it first, then add it to a squad so that squad's agents can use ${providerLabel}.`
              : nobodyCanAdd
                ? `Someone who manages a squad's integrations can add it in that squad's Integrations tab.`
                : `Add it to a squad below so that squad's agents can use ${providerLabel}.`}
          </p>
        </div>
      ) : (
        <div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted">Used by</span>
            {usedBy.slice(0, SHOWN_SQUADS).map((squad) => (
              <span key={squad.id} className="inline-flex items-center gap-1">
                <Link
                  to={squadIntegrationsPath(squad.id)}
                  className="text-accent-light hover:text-link-hover hover:underline"
                >
                  {squad.name}
                </Link>
                {access.writable.has(squad.id) && (
                  <ConfirmButton
                    variant="ghost"
                    label="Remove"
                    confirmLabel="Confirm remove"
                    ariaLabel={`Remove ${label} from ${squad.name}`}
                    disabled={busy}
                    className="px-1.5 py-0.5 text-xs text-muted"
                    confirmClassName="px-1.5 py-0.5 text-xs text-status-danger-600 dark:text-status-danger-400"
                    onConfirm={() => detach.mutate(squad)}
                  />
                )}
              </span>
            ))}
            {usedBy.length > SHOWN_SQUADS && (
              <span className="text-muted">and {usedBy.length - SHOWN_SQUADS} more</span>
            )}
          </p>
          {nextStep && <p className="mt-1 text-xs text-muted">{nextStep}</p>}
        </div>
      )}
      {canAdd && (
        // Not a <form>: the card's own forms (an API key, application settings) stay the only forms.
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Squad to add ${label} to`}
            className="ficus-field w-full min-w-0 rounded-md px-2 py-1.5 text-sm sm:w-64"
            value={chosen ? choice : ''}
            disabled={busy}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">Choose a squad</option>
            {offered.map((squad) => {
              const other = current.get(squad.id)
              return (
                <option key={squad.id} value={squad.id}>
                  {other && !several ? `${squad.name} (replaces ${other.displayName})` : squad.name}
                </option>
              )
            })}
          </select>
          <button
            type="button"
            className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={!chosen || busy}
            onClick={() => chosen && attach.mutate([chosen])}
          >
            {attach.isPending ? 'Adding…' : 'Add to squad'}
          </button>
          {withoutAny.length > 1 && (
            <button
              type="button"
              className="ficus-button ficus-button-ghost rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
              disabled={busy}
              onClick={() => attach.mutate(withoutAny)}
            >
              Add to all {withoutAny.length} squads without {providerLabel}
            </button>
          )}
        </div>
      )}
      {failure && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {failure}
        </p>
      )}
    </div>
  )
}
