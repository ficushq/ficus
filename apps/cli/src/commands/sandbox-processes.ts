import type { Command } from 'commander'
import { isSandboxOverloaded, SANDBOX_PROCESS_SIGNALS, type SandboxProcesses } from '@ficus/shared'
import { apiGet, apiPost } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${Math.floor(hours / 24)}d`
}

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`
}

/** Human rendering of a sandbox's processes: load, processes by current CPU, containers. */
export function renderSandboxProcesses(result: SandboxProcesses, limit: number): void {
  if (result.pressure) {
    const { cpus, load, memAvailableMb, memTotalMb } = result.pressure
    const prefix = isSandboxOverloaded(result.pressure) ? 'OVERLOADED  ' : ''
    console.log(
      `${prefix}load ${load.map((value) => value.toFixed(2)).join(' ')} on ${cpus} CPUs · ` +
        `${formatMemory(memAvailableMb)} free of ${formatMemory(memTotalMb)}`
    )
    console.log('')
  }
  outputTable(
    result.processes.slice(0, limit).map((process) => ({
      PID: process.protected ? `${process.pid}*` : String(process.pid),
      CPU: `${process.cpuPercent.toFixed(0)}%`,
      MEM: formatMemory(process.memRssMb),
      AGE: formatAge(process.ageSeconds),
      COMMAND: process.command.length > 100 ? `${process.command.slice(0, 99)}…` : process.command,
    })),
    ['PID', 'CPU', 'MEM', 'AGE', 'COMMAND']
  )
  if (result.processes.some((process) => process.protected)) console.log('* runs the sandbox; cannot be signalled')
  console.log('')
  if (!result.containers.available) {
    console.log(`Containers: ${result.containers.reason}`)
  } else if (result.containers.containers.length === 0) {
    console.log('Containers: none')
  } else {
    outputTable(
      result.containers.containers.map((container) => ({
        CONTAINER: container.name,
        ID: container.id,
        STATUS: container.status,
        CPU: container.cpuPercent === undefined ? '' : `${container.cpuPercent.toFixed(0)}%`,
        MEM: container.memUsage ?? '',
      })),
      ['CONTAINER', 'ID', 'STATUS', 'CPU', 'MEM']
    )
  }
}

/**
 * `sandbox-ps`, `sandbox-kill` and `sandbox-stop-container` for a squad's shared
 * sandbox or an agent's own sandbox.
 */
export function registerSandboxProcessCommands(parent: Command, kind: 'squad' | 'agent'): void {
  const base = (id: string) => `/api/${kind === 'squad' ? 'squads' : 'agents'}/${encodeURIComponent(id)}/sandbox`
  const noun = kind === 'squad' ? "a squad's sandbox" : "an agent's own sandbox"

  parent
    .command('sandbox-ps <id>')
    .description(`Show what ${noun} is running: load, processes by current CPU, and containers`)
    .option('-n, --limit <n>', 'Processes to show', '25')
    .action(async (id, options) => {
      try {
        const result = await apiGet<SandboxProcesses>(`${base(id)}/processes`)
        if (isJsonMode()) output(result)
        else renderSandboxProcesses(result, Math.max(1, Number(options.limit) || 25))
      } catch (error) {
        outputError(error as Error)
      }
    })

  parent
    .command('sandbox-kill <id> <pid>')
    .description(`Signal one process in ${noun} (only processes the sandbox user owns)`)
    .option('-s, --signal <signal>', `Signal: ${SANDBOX_PROCESS_SIGNALS.join(', ')}`, 'TERM')
    .action(async (id, pid, options) => {
      try {
        const result = await apiPost<{ pid: number; signal: string; command: string }>(
          `${base(id)}/processes/${encodeURIComponent(pid)}/signal`,
          { signal: String(options.signal).toUpperCase() }
        )
        if (isJsonMode()) output(result)
        else console.log(`Sent SIG${result.signal} to ${result.pid}: ${result.command}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  parent
    .command('sandbox-stop-container <id> <container>')
    .description(`Stop one container in ${noun}, by id or name`)
    .action(async (id, container) => {
      try {
        const result = await apiPost<{ id: string }>(`${base(id)}/containers/${encodeURIComponent(container)}/stop`, {})
        if (isJsonMode()) output(result)
        else console.log(`Stopped container ${result.id}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
