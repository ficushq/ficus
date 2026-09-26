import { $ } from 'bun'
import { existsSync } from 'fs'
import { join } from 'path'
import { MONOREPO_ROOT } from '../paths'

let cliPathOverride: string | null = null
/** Test-only: force getCliHostPath()'s result. */
export function setCliPathOverrideForTests(path: string | null): void {
  cliPathOverride = path
}

/**
 * Get the absolute host path to the tau CLI binary.
 * Used for volume-mounting into sandbox containers and generating help output.
 */
export function getCliHostPath(): string {
  return cliPathOverride ?? join(MONOREPO_ROOT, 'apps/cli/dist/ficus.js')
}

const CLI_ERROR = `[ERROR] The tau CLI is not installed or not accessible. Tell the user that the CLI could not be found and ask them to install it (e.g. run "bun run build:cli" in the project root and ensure the "tau" binary is on the PATH). You cannot execute any tau commands until this is resolved.`

/**
 * Generate CLI help for specific subcommands.
 * Always includes `tau --help` as the first entry.
 */
async function generateHelpFor(subcommands: string[]): Promise<string> {
  const tauPath = getCliHostPath()
  // Rely solely on the built CLI at apps/cli/dist/ficus.js. A shipped artifact
  // has no `apps/cli/src/`, so the old `bun apps/cli/src/index.ts` source
  // fallback would silently vanish there; when the dist bundle is missing we
  // surface the actionable CLI_ERROR instead of spawning a nonexistent file.
  if (!existsSync(tauPath)) return CLI_ERROR
  const cliCommand = [tauPath]

  try {
    const promises = [
      $`${cliCommand} --help`.text().catch(() => ''),
      ...subcommands.map((cmd) => $`${cliCommand} ${cmd} --help`.text().catch(() => '')),
    ]
    const results = await Promise.all(promises)

    const filtered = results.filter(Boolean)
    if (filtered.length > 0) {
      return `You have access to the \`tau\` CLI. Here's the full command reference:\n\n${filtered.join('\n\n---\n\n')}`
    }
    throw new Error('No help output')
  } catch {
    return CLI_ERROR
  }
}

/** Subcommands relevant to system manager */
const SYSTEM_MANAGER_SUBCOMMANDS = ['agent', 'squad', 'workflow', 'inbox']

/** Subcommands relevant to task-workflow agents and the system manager */
const TASK_SUBCOMMANDS = ['task', 'schedule', 'task-type', 'agent-type']

/** Subcommands relevant to squad workers */
const SQUAD_WORKER_SUBCOMMANDS = ['agent', 'workstream', 'workflow', 'squad', 'inbox']

/** Subcommands relevant to squad managers */
const SQUAD_MANAGER_SUBCOMMANDS = ['agent', 'workstream', 'workflow', 'squad', 'inbox']

// Separate caches per help profile
const cache: Record<string, string> = {}

/** Test-only: drop the per-profile help cache. */
export function resetCliHelpCacheForTests(): void {
  for (const k of Object.keys(cache)) delete cache[k]
}

/**
 * Cache ONLY successful help. The error sentinel is returned but never stored:
 * a worker that boots one second before apps/cli/dist/ficus.js lands (artifact
 * activation, first build) must not bake "CLI not installed" into every agent
 * prompt for the life of the process.
 */
async function cachedHelp(key: string, subcommands: string[]): Promise<string> {
  if (cache[key]) return cache[key]
  const help = await generateHelpFor(subcommands)
  if (help !== CLI_ERROR) cache[key] = help
  return help
}

/** CLI help for system manager */
export async function getSystemManagerCliHelp(): Promise<string> {
  return cachedHelp('systemManager', SYSTEM_MANAGER_SUBCOMMANDS)
}

/** CLI help for task-workflow runners */
export async function getTaskWorkflowCliHelp(): Promise<string> {
  return cachedHelp('task', TASK_SUBCOMMANDS)
}

/** CLI help for squad workers */
export async function getSquadWorkerCliHelp(): Promise<string> {
  return cachedHelp('squadWorker', SQUAD_WORKER_SUBCOMMANDS)
}

/** CLI help for squad managers */
export async function getSquadManagerCliHelp(): Promise<string> {
  return cachedHelp('squadManager', SQUAD_MANAGER_SUBCOMMANDS)
}

export async function warmupCliHelpCaches(): Promise<void> {
  await Promise.all([getSystemManagerCliHelp(), getSquadWorkerCliHelp(), getSquadManagerCliHelp()])
}

export function clearCliHelpCache(): void {
  for (const key of Object.keys(cache)) {
    delete cache[key]
  }
}
