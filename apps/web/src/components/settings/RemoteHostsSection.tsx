import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { Squad } from '@ficus/shared'
import { queryKeys } from '../../queryKeys'
import { listSquads } from '../../api/squads'
import {
  listRemoteHosts,
  getRemoteHost,
  createRemoteHost,
  deleteRemoteHost,
  grantRemoteHost,
  revokeRemoteHostGrant,
  checkRemoteHost,
  type RemoteHostWithGrants,
  type RevokeRotationResult,
} from '../../api/remote-hosts'
import { usePermissions } from '../../hooks/usePermissions'
import { PublicKeyBlock } from './PublicKeyBlock'
import { RotationCallout } from './RotationCallout'
import { ConfirmButton } from '../ConfirmButton'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton, LoadingSurface, SkeletonBlock, SkeletonLine } from '../loading/Skeleton'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const PORT_RE = /^\d+$/

/** A blank port is valid (server defaults to 22); a non-blank one must be a whole number in 1-65535. */
function isPortValid(port: string): boolean {
  const trimmed = port.trim()
  if (!trimmed) return true
  if (!PORT_RE.test(trimmed)) return false
  const n = Number(trimmed)
  return n >= 1 && n <= 65535
}

/**
 * Admin registry for the remote-hosts feature: every team-owned SSH target,
 * which squads have been granted access, and a connectivity check. Mirrors
 * MachinesSection's structure (useQuery list + row mutations + a register
 * form + a usePermissions gate); registered in SettingsPage's Admin group
 * after Machines.
 */
export function RemoteHostsSection() {
  const { data: hosts = [], isLoading } = useQuery({
    queryKey: queryKeys.remoteHosts.all,
    queryFn: listRemoteHosts,
  })
  const loadingRowCount = useLoadingShapeCount('settings:remote-hosts', isLoading ? undefined : hosts.length, {
    fallbackCount: 4,
    maxCount: 10,
  })
  const { data: squads = [] } = useQuery({
    queryKey: queryKeys.squads.list(),
    queryFn: () => listSquads(),
  })
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canRead = !permissionsLoading && can('remote-hosts:read')
  const canWrite = !permissionsLoading && can('remote-hosts:write')

  if (isLoading || permissionsLoading) {
    return <CollectionSkeleton label="Loading remote hosts" count={loadingRowCount} />
  }

  if (!canRead) {
    return <div className="py-12 text-center text-sm text-muted">You do not have permission to view remote hosts.</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Remote Hosts</h3>
        <p className="text-sm text-muted mt-1">
          Team-owned SSH targets. Register a host, grant squads access, and agents can ssh, scp, and rsync to it from
          their workspace.
        </p>
      </div>

      <div className="ficus-section overflow-hidden">
        {hosts.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">No remote hosts registered yet.</div>
        ) : (
          <div className="divide-y divide-th-border">
            {hosts.map((host) => (
              <RemoteHostRow key={host.id} host={host} squads={squads} canWrite={canWrite} />
            ))}
          </div>
        )}
      </div>

      {canWrite && <RegisterRemoteHostForm squads={squads} />}
    </div>
  )
}

function RemoteHostRow({ host, squads, canWrite }: { host: RemoteHostWithGrants; squads: Squad[]; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [pickedSquadId, setPickedSquadId] = useState('')
  const [rotation, setRotation] = useState<RevokeRotationResult | null>(null)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.remoteHosts.all })
  const invalidateSquad = (squadId: string) =>
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.remoteHosts(squadId) })

  // The list payload already carries squadIds, but pull detail on expand to
  // match MachinesSection's fetch-on-expand idiom (and stay fresh if another
  // tab mutated grants).
  const detail = useQuery({
    queryKey: queryKeys.remoteHosts.detail(host.id),
    queryFn: () => getRemoteHost(host.id),
    enabled: expanded,
  })

  const checkMutation = useMutation({ mutationFn: () => checkRemoteHost(host.id) })
  const deleteMutation = useMutation({
    mutationFn: () => deleteRemoteHost(host.id),
    onSuccess: () => {
      invalidate()
      // Deleting the host revokes every squad's access at once, so the
      // squad-scoped Remote Hosts view for each formerly-granted squad
      // would otherwise stay stale for up to `staleTime` (there's no WS
      // event for grant changes).
      for (const squadId of detail.data?.squadIds ?? host.squadIds) {
        invalidateSquad(squadId)
      }
    },
  })
  const grantMutation = useMutation({
    mutationFn: (squadId: string) => grantRemoteHost(host.id, squadId),
    onSuccess: (_data, squadId) => {
      invalidate()
      invalidateSquad(squadId)
      setPickedSquadId('')
    },
  })
  const revokeGrantMutation = useMutation({
    mutationFn: (squadId: string) => revokeRemoteHostGrant(host.id, squadId),
    onSuccess: (data, squadId) => {
      invalidate()
      invalidateSquad(squadId)
      // Revoking rotates the host key — surface the new pubkey so the operator
      // can install it (or the warning if rotation failed).
      setRotation(data)
    },
  })

  const squadIds = detail.data?.squadIds ?? host.squadIds
  const squadName = (squadId: string) => squads.find((s) => s.id === squadId)?.name ?? squadId
  const grantableSquads = squads.filter((s) => !squadIds.includes(s.id))

  const actionError = checkMutation.error ?? deleteMutation.error ?? grantMutation.error ?? revokeGrantMutation.error
  const checkResult = checkMutation.data
  const isMutating = checkMutation.isPending || deleteMutation.isPending

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="ficus-button text-sm font-medium text-primary hover:text-accent-light"
              aria-expanded={expanded}
            >
              {expanded ? '▾' : '▸'} {host.name}
            </button>
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary border border-th-border text-secondary">
              {squadIds.length} {squadIds.length === 1 ? 'squad' : 'squads'}
            </span>
            {checkResult && (
              <span
                className={clsx(
                  'text-xs px-1.5 py-0.5 rounded',
                  checkResult.reachable
                    ? 'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-700 dark:text-status-success-400'
                    : 'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-400'
                )}
              >
                {checkResult.reachable ? 'reachable' : 'unreachable'}
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">
            {host.sshUser}@{host.sshHost}:{host.sshPort}
            {host.description ? ` · ${host.description}` : ''}
          </p>
        </div>

        {canWrite && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              onClick={() => checkMutation.mutate()}
              disabled={isMutating}
              className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium disabled:opacity-50"
            >
              {checkMutation.isPending ? 'Checking…' : 'Check'}
            </button>
            <span className="text-muted">·</span>
            <ConfirmButton
              onConfirm={() => deleteMutation.mutate()}
              label="Delete"
              confirmLabel="Confirm?"
              className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium disabled:opacity-50"
              confirmClassName="text-xs text-status-danger-700 dark:text-status-danger-300 font-medium"
              disabled={isMutating}
            />
          </div>
        )}
      </div>

      {actionError && (
        <p className="text-xs text-status-danger-600 dark:text-status-danger-400 mt-2">
          {(actionError as Error).message}
        </p>
      )}
      {checkResult && !checkResult.reachable && checkResult.error && (
        <p className="text-xs text-status-danger-600 dark:text-status-danger-400 mt-2">{checkResult.error}</p>
      )}

      {expanded && (
        <div className="border-b border-panel-border last:border-b-0 mt-3 p-3 space-y-3 text-xs text-muted">
          {detail.isLoading ? (
            <LoadingSurface label="Loading remote host details" className="space-y-2 py-2">
              <SkeletonLine className="w-2/5" />
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonLine className="w-3/5" />
            </LoadingSurface>
          ) : detail.isError ? (
            <p className="text-status-danger-600 dark:text-status-danger-400">{(detail.error as Error).message}</p>
          ) : (
            <PublicKeyBlock label="SSH public key" value={host.sshPublicKey} />
          )}

          <div>
            <p className="font-medium text-secondary mb-1">Granted squads</p>
            {squadIds.length === 0 ? (
              <p>No squads granted access.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {squadIds.map((squadId) => (
                  <span
                    key={squadId}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-secondary border border-th-border text-secondary"
                  >
                    {squadName(squadId)}
                    {canWrite && (
                      <button
                        onClick={() => revokeGrantMutation.mutate(squadId)}
                        disabled={revokeGrantMutation.isPending}
                        className="ficus-button text-muted hover:text-status-danger-600 dark:hover:text-status-danger-400 disabled:opacity-50"
                        title={`Revoke ${squadName(squadId)}'s access`}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {canWrite && grantableSquads.length > 0 && (
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={pickedSquadId}
                  onChange={(e) => setPickedSquadId(e.target.value)}
                  className="ficus-field text-xs bg-surface border border-th-border rounded px-2 py-1 text-primary  focus:ring-1 focus:ring-accent"
                >
                  <option value="">Grant a squad…</option>
                  {grantableSquads.map((squad) => (
                    <option key={squad.id} value={squad.id}>
                      {squad.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => pickedSquadId && grantMutation.mutate(pickedSquadId)}
                  disabled={!pickedSquadId || grantMutation.isPending}
                  className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium disabled:opacity-50"
                >
                  {grantMutation.isPending ? 'Granting…' : 'Grant'}
                </button>
              </div>
            )}
          </div>

          {rotation && <RotationCallout result={rotation} />}
        </div>
      )}
    </div>
  )
}

function RegisterRemoteHostForm({ squads }: { squads: Squad[] }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [description, setDescription] = useState('')
  const [registered, setRegistered] = useState<RemoteHostWithGrants | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.remoteHosts.all })

  const registerMutation = useMutation({
    mutationFn: () =>
      createRemoteHost({
        name: name.trim(),
        sshHost: sshHost.trim(),
        sshPort: sshPort.trim() ? Number(sshPort) : undefined,
        sshUser: sshUser.trim(),
        description: description.trim() || undefined,
      }),
    onSuccess: (host) => {
      invalidate()
      setRegistered(host)
      setName('')
      setSshHost('')
      setSshPort('22')
      setSshUser('root')
      setDescription('')
    },
  })

  const canSubmit =
    name.trim().length > 0 &&
    NAME_RE.test(name.trim()) &&
    sshHost.trim().length > 0 &&
    sshUser.trim().length > 0 &&
    isPortValid(sshPort) &&
    !registerMutation.isPending

  const inputClass =
    'text-sm bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent'

  return (
    <div className="ficus-section overflow-hidden">
      <div className="px-4 py-3 border-b border-th-border">
        <h4 className="text-sm font-medium text-secondary">Register a remote host</h4>
        <p className="text-xs text-muted mt-0.5">
          Add a team-owned SSH target. Ficus mints a dedicated keypair — you'll install its public half on the host.
        </p>
      </div>
      <div className="px-4 py-4 space-y-3">
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className={clsx('ficus-field', inputClass, 'flex-1 min-w-[10rem]')}
          />
          <input
            value={sshHost}
            onChange={(e) => setSshHost(e.target.value)}
            placeholder="Host"
            className={clsx('ficus-field', inputClass, 'flex-1 min-w-[10rem]')}
          />
          <input
            value={sshPort}
            onChange={(e) => setSshPort(e.target.value)}
            placeholder="Port"
            inputMode="numeric"
            className={clsx(
              'ficus-field',
              inputClass,
              'w-24',
              sshPort && !isPortValid(sshPort) && 'border-status-danger-500'
            )}
          />
          <input
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            placeholder="User"
            className={clsx('ficus-field', inputClass, 'w-32')}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className={clsx('ficus-field', inputClass, 'flex-1 min-w-[12rem]')}
          />
          <button
            onClick={() => registerMutation.mutate()}
            disabled={!canSubmit}
            className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {registerMutation.isPending ? 'Registering…' : 'Register'}
          </button>
        </div>
        {name && !NAME_RE.test(name) && (
          <p className="text-xs text-status-danger-500">Name must be lowercase letters, digits, and hyphens only</p>
        )}
        {sshPort && !isPortValid(sshPort) && (
          <p className="text-xs text-status-danger-500">Port must be between 1 and 65535</p>
        )}

        {registerMutation.isError && (
          <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
            {(registerMutation.error as Error).message}
          </p>
        )}

        {registered && (
          <div className="border-b border-panel-border last:border-b-0 p-3 space-y-2">
            <p className="text-xs text-primary font-medium">
              Add this public key to <span className="font-mono">{registered.sshUser}</span>'s{' '}
              <span className="font-mono">~/.ssh/authorized_keys</span> on the host, then grant it to squads that need
              it.
            </p>
            <PublicKeyBlock value={registered.sshPublicKey} />
          </div>
        )}

        {squads.length === 0 && (
          <p className="text-xs text-muted">No squads exist yet — create one before granting access.</p>
        )}
      </div>
    </div>
  )
}
