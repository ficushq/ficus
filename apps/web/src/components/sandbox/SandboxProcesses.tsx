import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { isSandboxOverloaded, type SandboxPressure, type SandboxProcessSignal } from '@ficus/shared'
import { signalAgentSandboxProcess, stopAgentSandboxContainer } from '../../api/agents'
import { signalSandboxProcess, stopSandboxContainer } from '../../api/workspace'
import { actionErrorMessage } from '../../lib/actionError'
import { queries } from '../../queryOptions'
import { ConfirmButton } from '../ConfirmButton'

export type SandboxProcessesTarget = { kind: 'squad'; squadId: string } | { kind: 'agent'; agentId: string }

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

export function PressureSummary({ pressure }: { pressure: SandboxPressure }) {
  const overloaded = isSandboxOverloaded(pressure)
  return (
    <p
      className={clsx('text-sm', overloaded ? 'text-status-danger-600 dark:text-status-danger-400' : 'text-secondary')}
    >
      {overloaded && <span className="font-medium">Overloaded: </span>}
      Load {pressure.load[0].toFixed(1)} on {pressure.cpus} {pressure.cpus === 1 ? 'CPU' : 'CPUs'} ·{' '}
      {formatMemory(pressure.memAvailableMb)} free of {formatMemory(pressure.memTotalMb)}
    </p>
  )
}

/**
 * What a sandbox is running, with controls to stop a runaway process or
 * container. Loaded on request: sampling current CPU takes about a second, and
 * command lines can carry secrets.
 */
export function SandboxProcesses({ target }: { target: SandboxProcessesTarget }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  // Both options resolve to SandboxProcesses; only their key tuples differ.
  const query = (
    target.kind === 'squad'
      ? queries.sandbox.processes(target.squadId)
      : queries.agents.sandboxProcesses(target.agentId)
  ) as ReturnType<typeof queries.sandbox.processes>
  const { data, error, isFetching, refetch } = useQuery({ ...query, enabled: open, staleTime: 0 })
  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey })

  const signal = useMutation({
    mutationFn: ({ pid, signal }: { pid: number; signal: SandboxProcessSignal }) =>
      target.kind === 'squad'
        ? signalSandboxProcess(target.squadId, pid, signal)
        : signalAgentSandboxProcess(target.agentId, pid, signal),
    onSettled: refresh,
  })
  const stopContainer = useMutation({
    mutationFn: (containerId: string) =>
      target.kind === 'squad'
        ? stopSandboxContainer(target.squadId, containerId)
        : stopAgentSandboxContainer(target.agentId, containerId),
    onSettled: refresh,
  })
  const failure = signal.error ?? stopContainer.error ?? error

  return (
    <section aria-labelledby="sandbox-processes-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="sandbox-processes-heading" className="text-sm font-medium text-primary">
            Processes
          </h3>
          <p className="text-xs text-muted">
            What this sandbox is running. Stop a runaway job here instead of restarting the whole sandbox.
          </p>
        </div>
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md disabled:opacity-50"
          disabled={isFetching}
          onClick={() => (open ? void refetch() : setOpen(true))}
        >
          {isFetching ? 'Loading…' : open ? 'Refresh' : 'Show processes'}
        </button>
      </div>

      {failure && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {actionErrorMessage(failure)}
        </p>
      )}

      {open && data && (
        <div className="space-y-4">
          {data.pressure && <PressureSummary pressure={data.pressure} />}

          <div className="overflow-x-auto">
            <table className="ficus-table w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-medium text-right whitespace-nowrap">CPU</th>
                  <th className="py-1 pr-3 font-medium text-right whitespace-nowrap">Memory</th>
                  <th className="py-1 pr-3 font-medium text-right whitespace-nowrap">Age</th>
                  <th className="py-1 pr-3 font-medium">Command</th>
                  <th className="py-1 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.processes.map((process) => (
                  <tr key={process.pid} className="align-top">
                    <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">
                      {process.cpuPercent.toFixed(0)}%
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">
                      {formatMemory(process.memRssMb)}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">
                      {formatAge(process.ageSeconds)}
                    </td>
                    <td
                      className="min-w-[16rem] py-1 pr-3 font-mono break-all text-primary"
                      title={`pid ${process.pid}`}
                    >
                      {process.command}
                    </td>
                    <td className="py-1 whitespace-nowrap">
                      {process.protected ? (
                        <span className="text-muted">Runs the sandbox</span>
                      ) : (
                        <span className="flex gap-1">
                          <ConfirmButton
                            label="Stop"
                            confirmLabel="Stop?"
                            ariaLabel={`Stop process ${process.pid}`}
                            disabled={signal.isPending}
                            onConfirm={() => signal.mutate({ pid: process.pid, signal: 'TERM' })}
                          />
                          <ConfirmButton
                            label="Kill"
                            confirmLabel="Kill?"
                            ariaLabel={`Kill process ${process.pid}`}
                            disabled={signal.isPending}
                            onConfirm={() => signal.mutate({ pid: process.pid, signal: 'KILL' })}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h4 className="text-xs font-medium text-secondary">Containers</h4>
            {!data.containers.available ? (
              <p className="mt-1 text-xs text-muted">{data.containers.reason}</p>
            ) : data.containers.containers.length === 0 ? (
              <p className="mt-1 text-xs text-muted">No containers.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {data.containers.containers.map((container) => (
                  <li key={container.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="min-w-0">
                      <span className="font-mono text-primary">{container.name}</span>{' '}
                      <span className="text-muted">
                        {container.image} · {container.status}
                        {container.cpuPercent !== undefined ? ` · ${container.cpuPercent.toFixed(0)}% CPU` : ''}
                        {container.memUsage ? ` · ${container.memUsage}` : ''}
                      </span>
                    </span>
                    {container.state === 'running' && (
                      <ConfirmButton
                        label="Stop"
                        confirmLabel="Stop?"
                        ariaLabel={`Stop container ${container.name}`}
                        disabled={stopContainer.isPending}
                        onConfirm={() => stopContainer.mutate(container.id)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
