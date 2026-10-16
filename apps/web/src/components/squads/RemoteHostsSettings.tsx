import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queryKeys } from '../../queryKeys'
import {
  listSquadRemoteHosts,
  addSquadRemoteHost,
  revokeSquadRemoteHost,
  checkSquadRemoteHost,
  decideSquadRemoteHostKey,
  listSquadKnownHostsConflicts,
  resolveSquadKnownHostsConflict,
  scanSquadRemoteHostKeys,
  type KnownHostsConflict,
  type RemoteHost,
  type RemoteHostWithGrants,
  type RevokeRotationResult,
} from '../../api/remote-hosts'
import { ConfirmButton } from '../ConfirmButton'
import { PublicKeyBlock } from '../settings/PublicKeyBlock'
import { RotationCallout } from '../settings/RotationCallout'
import { HostKeyStateBadge, HostKeysPanel, hostKeyNeedsAttention } from '../settings/HostKeysPanel'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

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
 * Squad settings section for the remote-hosts registry: hosts granted to
 * THIS squad, an add-and-grant form, and per-row copy/check/revoke.
 * Modeled on SquadSshKeys (usePermissions + can(), inline add-form,
 * ConfirmButton revoke, mutations invalidate onSuccess).
 */
export function RemoteHostsSettings({ squadId }: Props) {
  const queryClient = useQueryClient()
  const [showAddForm, setShowAddForm] = useState(false)
  const [name, setName] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [description, setDescription] = useState('')
  const [added, setAdded] = useState<RemoteHostWithGrants | null>(null)
  const [rotation, setRotation] = useState<RevokeRotationResult | null>(null)
  const { can, isLoading: permissionsLoading } = usePermissions(squadId)
  const canWrite = !permissionsLoading && can('remote-hosts:write')
  const canResolveConflicts = !permissionsLoading && can('ssh:write')

  const queryKey = queryKeys.squads.remoteHosts(squadId)

  const {
    data: hosts = [],
    isLoading,
    isSuccess,
  } = useQuery({
    queryKey,
    queryFn: () => listSquadRemoteHosts(squadId),
  })
  const hostSkeletonCount = useLoadingShapeCount(
    `squads:${squadId}:remote-hosts`,
    isSuccess ? hosts.length : undefined,
    { fallbackCount: 2, maxCount: 8 }
  )

  const resetFormFields = () => {
    setName('')
    setSshHost('')
    setSshPort('22')
    setSshUser('root')
    setDescription('')
  }

  const addMutation = useMutation({
    mutationFn: () =>
      addSquadRemoteHost(squadId, {
        name: name.trim(),
        sshHost: sshHost.trim(),
        sshPort: sshPort.trim() ? Number(sshPort) : undefined,
        sshUser: sshUser.trim(),
        description: description.trim() || undefined,
      }),
    onSuccess: (host) => {
      queryClient.invalidateQueries({ queryKey })
      // Add-and-grant registers a new host in the global registry, so the
      // admin Remote Hosts view (if open in another tab) would otherwise
      // stay stale for up to `staleTime` (there's no WS event for this).
      queryClient.invalidateQueries({ queryKey: queryKeys.remoteHosts.all })
      setAdded(host)
      resetFormFields()
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (hostId: string) => revokeSquadRemoteHost(squadId, hostId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: queryKeys.remoteHosts.all })
      // Revoking rotates the host key — surface the new pubkey so the operator
      // can install it (or the warning if rotation failed / nothing to rotate).
      setRotation(data)
    },
  })

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!name.trim() || !sshHost.trim() || !sshUser.trim() || !NAME_RE.test(name.trim()) || !isPortValid(sshPort))
        return
      addMutation.mutate()
    },
    [name, sshHost, sshUser, sshPort, addMutation]
  )

  const closeForm = () => {
    setShowAddForm(false)
    setAdded(null)
    resetFormFields()
  }

  const canSubmit =
    name.trim().length > 0 &&
    NAME_RE.test(name.trim()) &&
    sshHost.trim().length > 0 &&
    sshUser.trim().length > 0 &&
    isPortValid(sshPort)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 data-setting-target="remote-hosts" className="text-sm font-medium text-primary">
            Remote Hosts
          </h3>
          <p className="text-xs text-muted mt-1">
            SSH targets granted to this squad. Agents can ssh, scp, and rsync to any host listed below.
          </p>
        </div>
        {canWrite && !showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md font-medium transition-colors"
          >
            Add Host
          </button>
        )}
      </div>

      {rotation && (
        <div className="mb-3">
          <RotationCallout result={rotation} />
        </div>
      )}

      {isLoading ? (
        <CollectionSkeleton label="Loading remote hosts" count={hostSkeletonCount} />
      ) : hosts.length === 0 && !showAddForm ? (
        <div className="text-sm text-muted py-4 text-center border border-dashed border-th-border rounded-lg">
          No remote hosts granted to this squad yet.
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {hosts.map((host) => (
            <RemoteHostRow
              key={host.id}
              squadId={squadId}
              host={host}
              canWrite={canWrite}
              onRevoke={() => revokeMutation.mutate(host.id)}
              revoking={revokeMutation.isPending && revokeMutation.variables === host.id}
              onHostKeysChanged={() => {
                queryClient.invalidateQueries({ queryKey })
                queryClient.invalidateQueries({ queryKey: queryKeys.remoteHosts.all })
              }}
            />
          ))}
        </div>
      )}

      <KnownHostsConflictsPanel squadId={squadId} canResolve={canResolveConflicts} />

      {canWrite && showAddForm && (
        <form onSubmit={handleSubmit} className="ficus-inset p-4">
          <h4 className="text-sm font-medium text-primary mb-3">Add Remote Host</h4>

          {!added && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="staging-db"
                  className={clsx(
                    'ficus-field',
                    'w-full px-3 py-2 text-sm rounded-md border bg-surface text-primary',
                    'placeholder:text-placeholder',
                    ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                    name && !NAME_RE.test(name) ? 'border-status-danger-500' : 'border-th-border'
                  )}
                />
                {name && !NAME_RE.test(name) && (
                  <p className="text-xs text-status-danger-500 mt-1">Lowercase letters, digits, and hyphens only</p>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-secondary mb-1">
                    Host <span className="text-status-danger-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="203.0.113.10"
                    className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-secondary mb-1">Port</label>
                  <input
                    type="text"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    placeholder="22"
                    inputMode="numeric"
                    className={clsx(
                      'ficus-field',
                      'w-full px-3 py-2 text-sm rounded-md border bg-surface text-primary',
                      'placeholder:text-placeholder',
                      ' focus:ring-2 focus:ring-accent/50 focus:border-accent',
                      sshPort && !isPortValid(sshPort) ? 'border-status-danger-500' : 'border-th-border'
                    )}
                  />
                  {sshPort && !isPortValid(sshPort) && <p className="text-xs text-status-danger-500 mt-1">1-65535</p>}
                </div>
                <div className="w-32">
                  <label className="block text-xs font-medium text-secondary mb-1">
                    User <span className="text-status-danger-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root"
                    className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this host for?"
                  className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-th-border bg-surface text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50 focus:border-accent"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={closeForm}
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md font-medium transition-colors"
            >
              {added ? 'Done' : 'Cancel'}
            </button>
            {!added && (
              <button
                type="submit"
                disabled={!canSubmit || addMutation.isPending}
                className={clsx(
                  'ficus-button ficus-button-primary',
                  'px-4 py-1.5 text-sm rounded-md font-medium transition-colors',
                  !canSubmit && 'opacity-50 cursor-not-allowed'
                )}
              >
                {addMutation.isPending ? 'Adding...' : 'Add Host'}
              </button>
            )}
          </div>

          {addMutation.isError && (
            <p className="text-xs text-status-danger-500 mt-2">
              Failed to add host: {(addMutation.error as Error).message}
            </p>
          )}

          {added && (
            <div className="border-b border-panel-border last:border-b-0 mt-4 p-3 space-y-2">
              <p className="text-xs text-primary font-medium">
                Add this public key to <span className="font-mono">{added.sshUser}</span>'s{' '}
                <span className="font-mono">~/.ssh/authorized_keys</span> on{' '}
                <span className="font-mono">{added.sshHost}</span>, then verify the connection.
              </p>
              <PublicKeyBlock value={added.sshPublicKey} />
              <HostKeysPanel
                host={added}
                canAct={canWrite}
                scan={() => scanSquadRemoteHostKeys(squadId, added.id)}
                decide={async (keyId, decision) => {
                  const updated = await decideSquadRemoteHostKey(squadId, added.id, keyId, decision)
                  setAdded({ ...added, ...updated })
                  return updated
                }}
                onChanged={() => queryClient.invalidateQueries({ queryKey })}
              />
              {canWrite && <CheckControl squadId={squadId} hostId={added.id} />}
            </div>
          )}
        </form>
      )}
    </div>
  )
}

function RemoteHostRow({
  squadId,
  host,
  canWrite,
  onRevoke,
  revoking,
  onHostKeysChanged,
}: {
  squadId: string
  host: RemoteHost
  canWrite: boolean
  onRevoke: () => void
  revoking: boolean
  onHostKeysChanged: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [showKeys, setShowKeys] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(host.sshPublicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy public key:', err)
    }
  }, [host.sshPublicKey])

  return (
    <div className="border-b border-panel-border last:border-b-0 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded bg-surface-secondary flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 12a2 2 0 012-2h10a2 2 0 012 2v0a2 2 0 01-2 2H7a2 2 0 01-2-2v0zM5 12V6a2 2 0 012-2h10a2 2 0 012 2v6m-14 6a2 2 0 002 2h10a2 2 0 002-2v0"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-primary">{host.name}</span>
              <span className="text-xs text-muted font-mono truncate">
                {host.sshUser}@{host.sshHost}:{host.sshPort}
              </span>
              <button
                onClick={() => setShowKeys((v) => !v)}
                className="ficus-button ficus-button-ghost"
                aria-expanded={showKeys || hostKeyNeedsAttention(host)}
                title="Host keys"
              >
                <HostKeyStateBadge state={host.hostKeyState} />
              </button>
            </div>
            {host.description && <p className="text-xs text-muted mt-0.5">{host.description}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canWrite && <CheckControl squadId={squadId} hostId={host.id} />}
          <button
            onClick={handleCopy}
            className="ficus-button ficus-button-secondary px-2 py-1 text-xs rounded transition-colors"
          >
            {copied ? '✓ Copied' : 'Copy Public Key'}
          </button>
          {canWrite && (
            <ConfirmButton onConfirm={onRevoke} label="Revoke" confirmLabel="Confirm?" disabled={revoking} />
          )}
        </div>
      </div>
      {(showKeys || hostKeyNeedsAttention(host)) && (
        <div className="mt-3 p-3 ficus-inset">
          <HostKeysPanel
            host={host}
            canAct={canWrite}
            scan={() => scanSquadRemoteHostKeys(squadId, host.id)}
            decide={(keyId, decision) => decideSquadRemoteHostKey(squadId, host.id, keyId, decision)}
            onChanged={onHostKeysChanged}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Box known_hosts conflicts for this squad: a box pins a different key than
 * Ficus manages for the same host. Read-only unless the viewer may edit the
 * squad's SSH settings; the server additionally requires a signed-in person.
 */
function KnownHostsConflictsPanel({ squadId, canResolve }: { squadId: string; canResolve: boolean }) {
  const queryClient = useQueryClient()
  const queryKey = queryKeys.squads.knownHostsConflicts(squadId)
  const { data: conflicts = [] } = useQuery({ queryKey, queryFn: () => listSquadKnownHostsConflicts(squadId) })
  const resolveMutation = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: 'keep-box' | 'use-core' }) =>
      resolveSquadKnownHostsConflict(squadId, id, choice),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })
  const open = conflicts.filter((c) => c.status === 'open')
  if (!open.length) return null

  return (
    <div className="mt-4 p-3 ficus-inset space-y-2 text-xs" data-testid="known-hosts-conflicts">
      <h4 className="text-sm font-medium text-primary">Known hosts conflicts</h4>
      <p className="text-muted">
        A squad box already trusts a different key for a host whose key Ficus manages, so the Ficus entry was not
        written there. Keep the box key, or replace it with the Ficus key. A wildcard line is never edited
        automatically: edit it on the box, or keep the box key.
      </p>
      <ul className="space-y-2">
        {open.map((c: KnownHostsConflict) => (
          <li key={c.id} className="space-y-1">
            <div className="text-secondary">
              <span className="font-mono">{c.host}</span> {c.keyType} on{' '}
              <span className="font-mono">{c.sandboxId}</span> (line {c.boxLine}
              {c.wildcard ? ', wildcard' : ''})
            </div>
            <div className="font-mono text-muted break-all">box: {c.boxFingerprint}</div>
            <div className="font-mono text-muted break-all">Ficus: {c.coreFingerprint}</div>
            {canResolve && (
              <div className="flex items-center gap-2">
                <ConfirmButton
                  variant="secondary"
                  className="px-2 py-0.5 text-xs rounded"
                  label="Keep box key"
                  confirmLabel="Confirm keep?"
                  disabled={resolveMutation.isPending}
                  onConfirm={() => resolveMutation.mutate({ id: c.id, choice: 'keep-box' })}
                />
                {!c.wildcard && (
                  <ConfirmButton
                    variant="secondary"
                    className="px-2 py-0.5 text-xs rounded"
                    label="Use Ficus key"
                    confirmLabel="Confirm replace?"
                    disabled={resolveMutation.isPending}
                    onConfirm={() => resolveMutation.mutate({ id: c.id, choice: 'use-core' })}
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {resolveMutation.isError && (
        <p className="text-status-danger-600 dark:text-status-danger-400">{(resolveMutation.error as Error).message}</p>
      )}
    </div>
  )
}

/** Squad-scoped connectivity probe: a "Check" button + inline reachable/unreachable result. */
function CheckControl({ squadId, hostId }: { squadId: string; hostId: string }) {
  const checkMutation = useMutation({
    mutationFn: () => checkSquadRemoteHost(squadId, hostId),
  })
  const result = checkMutation.data

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => checkMutation.mutate()}
        disabled={checkMutation.isPending}
        className="ficus-button ficus-button-secondary px-2 py-1 text-xs rounded transition-colors disabled:opacity-50"
      >
        {checkMutation.isPending ? 'Checking…' : 'Check'}
      </button>
      {result && (
        <span
          className={clsx(
            'text-xs',
            result.reachable
              ? 'text-status-success-600 dark:text-status-success-400'
              : 'text-status-danger-600 dark:text-status-danger-400'
          )}
        >
          {result.reachable ? 'Reachable' : `Unreachable${result.error ? `: ${result.error}` : ''}`}
        </span>
      )}
    </div>
  )
}
