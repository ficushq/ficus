import { SecretsSection } from './SecretsSection'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  registerMachine,
  bootstrapMachine,
  checkMachine,
  deleteMachine,
  type Machine,
  type MachineUtilization,
  type RegisterMachineInput,
} from '../../api/machines'
import { usePermissions } from '../../hooks/usePermissions'
import { PublicKeyBlock } from './PublicKeyBlock'
import { RebalancePanel } from './RebalancePanel'
import { MigrateControl } from './MigrateControl'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton, LoadingSurface, SkeletonBlock, SkeletonLine } from '../loading/Skeleton'

/**
 * Admin fleet view for the VM sandbox runtime: register BYO-SSH endpoints or
 * provision exe.dev VMs, then bootstrap / check / delete them. Mirrors
 * ProviderAuthSection's structure (useQuery list + row mutations + a register
 * form + a usePermissions gate). Live updates arrive via the QueryInvalidator
 * 'machines' subscription; the list query options already poll while any
 * machine is mid-bootstrap or unreachable, so no extra refetchInterval here.
 */
export function MachinesSection() {
  const { data: machines = [], isLoading } = useQuery(queries.machines.list())
  const loadingRowCount = useLoadingShapeCount('settings:machines', isLoading ? undefined : machines.length, {
    fallbackCount: 4,
    maxCount: 10,
  })
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canRead = !permissionsLoading && can('machines:read')
  const canWrite = !permissionsLoading && can('machines:write')

  if (isLoading || permissionsLoading) {
    return <CollectionSkeleton label="Loading machines" count={loadingRowCount} />
  }

  if (!canRead) {
    return <div className="py-12 text-center text-sm text-muted">You do not have permission to view machines.</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Machines</h3>
        <p className="text-sm text-muted mt-1">
          The VM sandbox fleet. Register a BYO-SSH host or provision an exe.dev VM, then bootstrap it to host agent and
          squad boxes. Agents and squads can be pinned to a machine from their own settings.
        </p>
      </div>

      <div className="ficus-section overflow-hidden">
        {machines.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">No machines registered yet.</div>
        ) : (
          <div className="divide-y divide-th-border">
            {machines.map((machine) => (
              <MachineRow key={machine.id} machine={machine} allMachines={machines} canWrite={canWrite} />
            ))}
          </div>
        )}
      </div>

      {canWrite && machines.length > 0 && <RebalancePanel machines={machines} />}
      {canWrite && <RegisterMachineForm />}
      {can('secrets:read') && <SecretsSection scope="machines" />}
    </div>
  )
}

export function MachineRow({
  machine,
  allMachines,
  canWrite,
}: {
  machine: Machine
  allMachines: Machine[]
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.machines.all })

  // The list payload has no box counts (toPublicMachine omits boxes); pull the
  // per-machine detail lazily on expand rather than N calls up front.
  const detail = useQuery({ ...queries.machines.detail(machine.id), enabled: expanded })

  const bootstrapMutation = useMutation({ mutationFn: () => bootstrapMachine(machine.id), onSuccess: invalidate })
  const checkMutation = useMutation({ mutationFn: () => checkMachine(machine.id), onSuccess: invalidate })
  const deleteMutation = useMutation({ mutationFn: () => deleteMachine(machine.id), onSuccess: invalidate })

  const handleDelete = () => {
    if (confirm(`Delete machine ${machine.name}? This is only allowed when it hosts no boxes.`)) {
      deleteMutation.mutate()
    }
  }

  const boxCount = detail.data?.boxes.length
  const actionError = bootstrapMutation.error ?? checkMutation.error ?? deleteMutation.error
  const isMutating = bootstrapMutation.isPending || checkMutation.isPending || deleteMutation.isPending

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="ficus-button ficus-button-link text-sm font-medium text-primary"
              aria-expanded={expanded}
            >
              {expanded ? '▾' : '▸'} {machine.name}
            </button>
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary border border-th-border text-secondary">
              {machine.provider}
            </span>
            <span className={clsx('text-xs px-1.5 py-0.5 rounded', statusBadgeClass(machine.status))}>
              {machine.status}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary border border-th-border text-secondary">
              {machine.purpose}
              {machine.squadId ? ` · ${machine.squadId}` : ''}
            </span>
            <UtilizationBadge utilization={machine.utilization} />
            {boxCount != null && (
              <span className="text-xs text-muted">
                {boxCount} {boxCount === 1 ? 'box' : 'boxes'}
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">
            {machine.sshUser}@{machine.sshHost}:{machine.sshPort} · last seen {formatLastSeen(machine.lastSeenAt)}
          </p>
          {/*
            The last bootstrap failure's stderr tail, persisted on the row so an
            operator can see WHY without digging through logs. A muted line, not
            a full alert — `actionError` below already owns the loud red text
            for an action the OPERATOR just triggered in this session; this is
            historical context about the row's current state instead.
          */}
          {machine.status === 'unreachable' && machine.lastError && (
            <p className="text-xs text-muted mt-0.5 truncate" title={machine.lastError}>
              {machine.lastError}
            </p>
          )}
        </div>

        {canWrite && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {/*
              Bootstrap is a REPAIR affordance, not a setup step. Platform-
              provisioned hosts are bootstrapped during provisioning and arrive
              ready, so offering the button on a ready machine invites a
              pointless multi-minute reinstall of a working host. It stays
              visible for machines that are not ready (registered, unreachable,
              or a run that died part-way), which is exactly when it is useful.
              'bootstrapping' shows progress instead of a second trigger.
            */}
            {machine.status === 'bootstrapping' ? (
              <span className="text-xs text-muted font-medium">Bootstrapping…</span>
            ) : (
              machine.status !== 'ready' && (
                <button
                  onClick={() => bootstrapMutation.mutate()}
                  disabled={isMutating}
                  className="ficus-button ficus-button-link text-xs font-medium disabled:opacity-50"
                >
                  {bootstrapMutation.isPending ? 'Bootstrapping…' : 'Bootstrap'}
                </button>
              )
            )}
            <button
              onClick={() => checkMutation.mutate()}
              disabled={isMutating}
              className="ficus-button ficus-button-link text-xs font-medium disabled:opacity-50"
            >
              {checkMutation.isPending ? 'Checking…' : 'Check'}
            </button>
            <span className="text-muted">·</span>
            <button
              onClick={handleDelete}
              disabled={isMutating}
              className="ficus-button ficus-button-danger px-2 py-1 text-xs font-medium disabled:opacity-50"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
      </div>

      {actionError && (
        <p className="text-xs text-status-danger-600 dark:text-status-danger-400 mt-2">
          {(actionError as Error).message}
        </p>
      )}

      {expanded && (
        <div className="border-b border-panel-border last:border-b-0 mt-3 p-3 space-y-2 text-xs text-muted">
          {detail.isLoading ? (
            <LoadingSurface label="Loading machine details" className="space-y-2 py-2">
              <SkeletonLine className="w-2/5" />
              <SkeletonBlock className="h-10 w-full" />
              <SkeletonLine className="w-3/5" />
            </LoadingSurface>
          ) : detail.isError ? (
            <p className="text-status-danger-600 dark:text-status-danger-400">{(detail.error as Error).message}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span>Scope</span>
                <span className="text-primary">{machine.scope}</span>
                <span>Egress lockdown</span>
                <span className="text-primary">{machine.egressPolicy ? 'on' : 'off'}</span>
                {machine.capabilities.arch && (
                  <>
                    <span>Arch</span>
                    <span className="text-primary">{machine.capabilities.arch}</span>
                  </>
                )}
                {machine.capabilities.cpus != null && (
                  <>
                    <span>CPUs</span>
                    <span className="text-primary">{machine.capabilities.cpus}</span>
                  </>
                )}
                {machine.capabilities.memMb != null && (
                  <>
                    <span>Memory</span>
                    <span className="text-primary">{machine.capabilities.memMb} MB</span>
                  </>
                )}
                {machine.capabilities.docker && (
                  <>
                    <span>Docker</span>
                    <span className="text-primary">{machine.capabilities.docker}</span>
                  </>
                )}
                {machine.capabilities.browser && (
                  <>
                    <span>Browser</span>
                    {machine.capabilities.browser === 'available' ? (
                      <span className="text-primary">available</span>
                    ) : (
                      // Loud on purpose: a misconfigured host that cannot sandbox
                      // Chromium must stand out (browsing disabled, machine still up).
                      <span className="text-status-danger-600 dark:text-status-danger-400" role="alert">
                        unavailable
                        {machine.capabilities.browserReason ? ` (${machine.capabilities.browserReason})` : ''}
                      </span>
                    )}
                  </>
                )}
              </div>

              {Object.keys(machine.artifactVersions).length > 0 && (
                <div>
                  <p className="font-medium text-secondary">Artifacts</p>
                  <div className="mt-1 space-y-0.5">
                    {Object.entries(machine.artifactVersions).map(([name, hash]) => (
                      <p key={name} className="font-mono text-muted">
                        {name}: {hash.slice(0, 12)}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="font-medium text-secondary">Boxes ({detail.data?.boxes.length ?? 0})</p>
                {detail.data && detail.data.boxes.length > 0 ? (
                  <div className="mt-1 space-y-1">
                    {detail.data.boxes.map((box) => (
                      <div key={box.sandboxId} className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-primary">{box.sandboxId}</span>
                        <span className="px-1.5 py-0.5 rounded bg-surface-secondary border border-th-border">
                          {box.unixUser}:{box.port}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-surface-secondary border border-th-border">
                          {box.status}
                        </span>
                        {canWrite && (
                          <MigrateControl
                            sandboxId={box.sandboxId}
                            machines={allMachines}
                            currentMachineId={machine.id}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1">No boxes hosted.</p>
                )}
              </div>

              <PublicKeyBlock label="SSH public key" value={machine.sshPublicKey} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RegisterMachineForm() {
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<'ssh' | 'exe'>('ssh')
  const [name, setName] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [scope, setScope] = useState<'shared' | 'dedicated'>('shared')
  const [registered, setRegistered] = useState<Machine | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.machines.all })

  const registerMutation = useMutation({
    mutationFn: () => {
      const body: RegisterMachineInput =
        provider === 'exe'
          ? { name, provider: 'exe', scope }
          : { name, sshHost, sshPort: Number(sshPort) || undefined, sshUser, scope }
      return registerMachine(body)
    },
    onSuccess: (machine) => {
      invalidate()
      setRegistered(machine)
      setName('')
      setSshHost('')
      setSshPort('22')
      setSshUser('root')
    },
  })

  const canSubmit =
    name.trim().length > 0 &&
    (provider === 'exe' || (sshHost.trim().length > 0 && sshUser.trim().length > 0)) &&
    !registerMutation.isPending

  const inputClass =
    'text-sm bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent'

  return (
    <div className="ficus-section overflow-hidden">
      <div className="px-4 py-3 border-b border-th-border">
        <h4 className="text-sm font-medium text-secondary">Register a machine</h4>
        <p className="text-xs text-muted mt-0.5">
          Add a BYO-SSH host or provision a new exe.dev VM. exe machines require an exe.dev API Token configured in
          Secrets &amp; Keys.
        </p>
      </div>
      <div className="px-4 py-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as 'ssh' | 'exe')
              setRegistered(null)
            }}
            className={clsx('ficus-field', inputClass, 'w-auto')}
          >
            <option value="ssh">BYO-SSH</option>
            <option value="exe">exe.dev VM</option>
          </select>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'shared' | 'dedicated')}
            className={clsx('ficus-field', inputClass, 'w-auto')}
          >
            <option value="shared">shared</option>
            <option value="dedicated">dedicated</option>
          </select>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className={clsx('ficus-field', inputClass, 'flex-1 min-w-[10rem]')}
          />
          {provider === 'ssh' && (
            <>
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
                className={clsx('ficus-field', inputClass, 'w-24')}
              />
              <input
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                placeholder="User"
                className={clsx('ficus-field', inputClass, 'w-32')}
              />
            </>
          )}
          <button
            onClick={() => registerMutation.mutate()}
            disabled={!canSubmit}
            className="ficus-button ficus-button-primary text-xs px-3 py-1.5 rounded font-medium disabled:opacity-50"
          >
            {registerMutation.isPending ? 'Registering…' : 'Register'}
          </button>
        </div>

        {registerMutation.isError && (
          <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
            {(registerMutation.error as Error).message}
          </p>
        )}

        {registered?.provider === 'ssh' && (
          <div className="border-b border-panel-border last:border-b-0 p-3 space-y-2">
            <p className="text-xs text-primary font-medium">
              Add this public key to <span className="font-mono">{registered.sshUser}</span>'s{' '}
              <span className="font-mono">~/.ssh/authorized_keys</span> on the machine, then bootstrap it.
            </p>
            <PublicKeyBlock value={registered.sshPublicKey} />
          </div>
        )}
      </div>
    </div>
  )
}

/** Placement units this machine's boxes consume against its capacity. Rendered
 *  quietly (muted) when empty so an idle machine doesn't shout a `0/N`. */
function UtilizationBadge({ utilization }: { utilization: MachineUtilization }) {
  const { unitsUsed, unitCapacity } = utilization
  return (
    <span
      title="Placement units used / capacity"
      className={clsx(
        'text-xs px-1.5 py-0.5 rounded bg-surface-secondary border border-th-border',
        unitsUsed === 0 ? 'text-muted' : 'text-secondary'
      )}
    >
      {unitsUsed}/{unitCapacity}
    </span>
  )
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'ready':
      return 'bg-status-success-100 dark:bg-status-success-900/30 text-status-success-700 dark:text-status-success-400'
    case 'bootstrapping':
      return 'bg-status-progress-100 dark:bg-status-progress-900/30 text-status-progress-700 dark:text-status-progress-400'
    case 'unreachable':
      return 'bg-status-danger-100 dark:bg-status-danger-900/30 text-status-danger-700 dark:text-status-danger-400'
    case 'registered':
      return 'bg-status-review-100 dark:bg-status-review-900/30 text-status-review-700 dark:text-status-review-400'
    default:
      return 'bg-status-neutral-200 dark:bg-status-neutral-700 text-status-neutral-600 dark:text-status-neutral-300'
  }
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleString()
}
