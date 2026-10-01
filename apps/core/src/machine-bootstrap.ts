#!/usr/bin/env bun
/**
 * Operator machine re-bootstrap, bundled as `dist/machine-bootstrap.js` so it
 * exists on an artifact install. Run on the tenant Core VM from
 * `/opt/ficus-core`, where Bun loads Core's `.env` (database and secret store):
 *
 *   FICUS_MB_MACHINE=<machineId>|all-stale bun current/apps/core/dist/machine-bootstrap.js
 *
 * It runs the same `bootstrapMachine` that `POST /api/machines/:id/bootstrap`
 * runs, claiming the machine first exactly as that route does, for one machine
 * or for every machine whose stored `bootstrapVersion` differs from the script
 * version this Core would stamp. It prints one line per machine:
 *
 *   MACHINE_BOOTSTRAP <id> ok
 *   MACHINE_BOOTSTRAP <id> failed <reason>
 *
 * Exit 0 when every machine succeeded (or none was stale), 1 when any failed,
 * 2 for a bad request or an unknown machine id.
 */
import type { Machine } from './services/machines/queries'

/** Statuses `all-stale` re-bootstraps: a machine in service, or one whose last bootstrap failed. */
const STALE_CANDIDATE_STATUSES = ['ready', 'unreachable'] as const

export const ALL_STALE = 'all-stale'

export interface MachineBootstrapDeps {
  listMachines(): Promise<Machine[]>
  currentBootstrapVersion(): string
  claimMachineForBootstrap(id: string, from?: readonly string[]): Promise<Machine | null>
  failMachineBootstrapClaim(id: string, lastError: string): Promise<void>
  bootstrapMachine(machine: Machine): Promise<unknown>
  print(line: string): void
  printError(line: string): void
}

/** Read the target from the environment. Validated before it reaches anything. */
export function parseMachineBootstrapTarget(env: Record<string, string | undefined>): string {
  const target = env.FICUS_MB_MACHINE ?? ''
  if (!/^[A-Za-z0-9._:-]+$/.test(target)) {
    throw new Error(`FICUS_MB_MACHINE must be a machine id or ${ALL_STALE} (got '${target}')`)
  }
  return target
}

/** One line, bounded, for the per-machine result. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n')[0]?.trim() || 'unknown error'
  return first.length > 300 ? `${first.slice(0, 300)}…` : first
}

async function bootstrapOne(
  machine: Machine,
  from: readonly string[] | undefined,
  deps: MachineBootstrapDeps
): Promise<boolean> {
  const claimed = await deps.claimMachineForBootstrap(machine.id, from)
  if (!claimed) {
    deps.print(`MACHINE_BOOTSTRAP ${machine.id} failed a bootstrap is already running; re-run once it settles`)
    return false
  }
  try {
    await deps.bootstrapMachine(claimed)
    deps.print(`MACHINE_BOOTSTRAP ${machine.id} ok`)
    return true
  } catch (error) {
    // bootstrapMachine stamps `unreachable` itself for failures it reaches; this
    // settles a claim it never got to, exactly as the route does.
    const message = error instanceof Error ? error.message : String(error)
    await deps.failMachineBootstrapClaim(machine.id, message).catch(() => {})
    deps.print(`MACHINE_BOOTSTRAP ${machine.id} failed ${reasonOf(error)}`)
    return false
  }
}

export async function runMachineBootstrap(target: string, deps: MachineBootstrapDeps): Promise<number> {
  const machines = await deps.listMachines()
  if (target !== ALL_STALE) {
    const machine = machines.find((m) => m.id === target)
    if (!machine) {
      deps.printError(`machine not found: ${target}`)
      return 2
    }
    return (await bootstrapOne(machine, undefined, deps)) ? 0 : 1
  }

  const current = deps.currentBootstrapVersion()
  const stale = machines.filter(
    (m) =>
      m.bootstrapVersion !== current &&
      ((STALE_CANDIDATE_STATUSES as readonly string[]).includes(m.status) || m.status === 'bootstrapping')
  )
  if (stale.length === 0) {
    deps.printError(`no stale machines (every machine is at bootstrap version ${current.slice(0, 12)})`)
    return 0
  }
  let failed = 0
  // One at a time: each run is a long SSH session with its own 15-minute bound.
  for (const machine of stale) {
    if (!(await bootstrapOne(machine, STALE_CANDIDATE_STATUSES, deps))) failed++
  }
  return failed > 0 ? 1 : 0
}

async function main(): Promise<number> {
  let target: string
  try {
    target = parseMachineBootstrapTarget(process.env)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  // Loaded only after the request validates: these connect to the database
  // and secret store as they load.
  const { getSecretStore } = await import('./services/secrets/store')
  const queries = await import('./services/machines/queries')
  const { bootstrapMachine, currentBootstrapVersion, capLastError } = await import('./services/machines/bootstrap')
  await getSecretStore().initialize()
  return runMachineBootstrap(target, {
    listMachines: queries.listMachines,
    currentBootstrapVersion: () => currentBootstrapVersion(),
    claimMachineForBootstrap: queries.claimMachineForBootstrap,
    failMachineBootstrapClaim: (id, lastError) => queries.failMachineBootstrapClaim(id, capLastError(lastError)),
    // No background devbox pre-warm from this short-lived process: it exits as
    // soon as the last machine is done, which would cut the pre-warm off mid-run.
    bootstrapMachine: (machine) => bootstrapMachine(machine, { prewarmDevbox: () => {} }),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  })
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
