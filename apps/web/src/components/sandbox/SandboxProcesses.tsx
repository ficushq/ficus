import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  isSandboxOverloaded,
  type SandboxPressure,
  type SandboxProcess,
  type SandboxProcessSignal,
} from '@ficus/shared'
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

      {error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {actionErrorMessage(error)}
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
                        <ProcessControls
                          key={`${target.kind}:${target.kind === 'squad' ? target.squadId : target.agentId}:${process.pid}:${process.command}`}
                          target={target}
                          process={process}
                          refresh={refresh}
                        />
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
                      <ContainerControls
                        key={`${target.kind}:${target.kind === 'squad' ? target.squadId : target.agentId}:${container.id}`}
                        target={target}
                        id={container.id}
                        name={container.name}
                        refresh={refresh}
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

/** Each row owns both its mutation state and its transport cancellation. */
function useRowControl<T>(action: (value: T, signal: AbortSignal) => Promise<void>, refresh: () => Promise<unknown>) {
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  return useMutation({
    mutationFn: async (value: T) => {
      const current = new AbortController()
      controller.current = current
      try {
        await action(value, current.signal)
      } finally {
        if (controller.current === current) controller.current = null
      }
    },
    retry: false,
    // Refresh is best-effort. A hung listing must not keep a finished control disabled.
    onSettled: () => {
      void refresh()
    },
  })
}

function ControlError({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="whitespace-normal text-status-danger-600 dark:text-status-danger-400">
      {actionErrorMessage(error)}
    </p>
  ) : null
}

function ProcessControls({
  target,
  process,
  refresh,
}: {
  target: SandboxProcessesTarget
  process: SandboxProcess
  refresh: () => Promise<unknown>
}) {
  const signal = useRowControl(
    (signal: SandboxProcessSignal, abortSignal) =>
      target.kind === 'squad'
        ? signalSandboxProcess(target.squadId, process.pid, signal, abortSignal)
        : signalAgentSandboxProcess(target.agentId, process.pid, signal, abortSignal),
    refresh
  )
  // Match the executable, not incidental mentions in arguments. This is guidance only;
  // ownership and protected-process checks still run on the server for every signal.
  const executable = process.command.split(/\s+/, 1)[0]?.split('/').pop() ?? ''
  const killDirectly = /^(?:containerd-shim(?:-[\w-]+)?|runc)$/.test(executable)
  return (
    <div>
      {killDirectly && (
        <p className="max-w-64 whitespace-normal text-muted">
          Stop (TERM) is ineffective for containerd shims. Use Kill for shim/runc processes; running containers may be
          disrupted.
        </p>
      )}
      <span className="flex gap-1">
        {!killDirectly && (
          <ConfirmButton
            label="Stop"
            confirmLabel="Stop?"
            ariaLabel={`Stop process ${process.pid}`}
            disabled={signal.isPending}
            onConfirm={() => signal.mutate('TERM')}
          />
        )}
        <ConfirmButton
          label="Kill"
          confirmLabel="Kill?"
          ariaLabel={`Kill process ${process.pid}`}
          disabled={signal.isPending}
          onConfirm={() => signal.mutate('KILL')}
        />
        {signal.isPending && (
          <span role="status" className="text-muted">
            Sending…
          </span>
        )}
      </span>
      <ControlError error={signal.error} />
    </div>
  )
}

function ContainerControls({
  target,
  id,
  name,
  refresh,
}: {
  target: SandboxProcessesTarget
  id: string
  name: string
  refresh: () => Promise<unknown>
}) {
  const stop = useRowControl(
    (_: void, abortSignal) =>
      target.kind === 'squad'
        ? stopSandboxContainer(target.squadId, id, abortSignal)
        : stopAgentSandboxContainer(target.agentId, id, abortSignal),
    refresh
  )
  return (
    <div>
      <ConfirmButton
        label="Stop"
        confirmLabel="Stop?"
        ariaLabel={`Stop container ${name}`}
        disabled={stop.isPending}
        onConfirm={() => stop.mutate()}
      />
      {stop.isPending && (
        <span role="status" className="text-muted">
          {' '}
          Stopping…
        </span>
      )}
      <ControlError error={stop.error} />
    </div>
  )
}
