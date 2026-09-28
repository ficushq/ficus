#!/usr/bin/env bun
/**
 * Offline update — runs the in-app updater's task table WITHOUT the API or
 * the database, for `ficus update apply --offline` / `ficus server update`.
 *
 *   bun run update:offline -- --from <sha-before-pull>
 *
 * Same constants as services/updates/change-detector.ts (tasks selected from
 * `git diff --name-only <from>..HEAD`), same status file as LocalUpdateManager
 * (`.tau/local-update-status.json`, mode 'offline'), MINUS the restart
 * commands: the CLI restarts through pm2 afterwards, so a failed build never
 * leaves a half-restarted pair. This module must not import anything that
 * opens a database connection at load time.
 */
import '../boot/legacy-env'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { commandsForTasks, detectUpdateTasks, isServiceRestartCommand } from '../services/updates/change-detector'
import { CommandRunner, type RunProcess } from '../services/updates/command-runner'
import { detectDeploymentFlavor, resolveRepoRoot, type DeploymentFlavor } from '../services/updates/deployment-flavor'
import type { LocalUpdateRun, PlannedCommand, UpdateTask } from '../services/updates/types'

export class OfflineUpdateBlockedError extends Error {}

/**
 * A persisted 'running'/'checking' run older than this is presumed dead rather
 * than genuinely in flight (see the staleness rule below).
 */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000

export function planOfflineUpdate(
  changedFiles: string[],
  flavor: DeploymentFlavor
): { tasks: UpdateTask[]; commands: PlannedCommand[] } {
  const tasks = detectUpdateTasks(changedFiles, flavor)
  const commands = commandsForTasks(tasks, changedFiles, flavor).filter((c) => !isServiceRestartCommand(c.command))
  return { tasks, commands }
}

export interface OfflineUpdateOptions {
  repoRoot: string
  fromSha: string
  env: Record<string, string | undefined>
  git(args: string[]): Promise<string>
  runProcess?: RunProcess
  statusPath?: string
  now?: () => string
}

export async function runOfflineUpdate(options: OfflineUpdateOptions): Promise<LocalUpdateRun> {
  const statusPath = options.statusPath ?? join(options.repoRoot, '.tau', 'local-update-status.json')
  const now = options.now ?? (() => new Date().toISOString())
  const persist = (run: LocalUpdateRun) => {
    try {
      mkdirSync(dirname(statusPath), { recursive: true })
      writeFileSync(statusPath, JSON.stringify(run))
    } catch {
      // Status persistence is best effort; the run itself (and its thrown/returned
      // result) still reflects the truth even if the sidecar file write failed.
    }
  }

  if (existsSync(statusPath)) {
    try {
      const prev = JSON.parse(readFileSync(statusPath, 'utf8')) as LocalUpdateRun
      if (prev.status === 'running' || prev.status === 'checking') {
        // An offline run has no surviving process once this script is invoked again
        // (runs are sequential and this script is the only writer of offline runs),
        // so a persisted 'offline' run is always stale. A non-offline run (e.g. the
        // in-app updater's 'manual'/'automatic') might genuinely still be in flight,
        // so only treat it as stale — and reconcile it — once it is older than
        // STALE_RUN_MS; the manager's own boot reconciliation can't clear an offline
        // run for it (offline runs carry no restart command), so this script must.
        const ageMs = Date.parse(now()) - Date.parse(prev.startedAt)
        const stale = prev.mode === 'offline' || ageMs > STALE_RUN_MS
        if (!stale) {
          throw new OfflineUpdateBlockedError(
            `an update run (${prev.id}, ${prev.mode}) is still ${prev.status} — wait for it or remove ${statusPath}`
          )
        }
        prev.status = 'failed'
        prev.completedAt = now()
        prev.error = 'interrupted (stale run reconciled by offline update)'
        persist(prev)
      }
    } catch (err) {
      if (err instanceof OfflineUpdateBlockedError) throw err
    }
  }

  // Not a pm2 child here, so detection alone would say 'unknown'; a local install is pm2 unless told otherwise.
  const env = options.env
  const flavor = detectDeploymentFlavor({ repoRoot: options.repoRoot, env })
  const afterSha = (await options.git(['rev-parse', 'HEAD'])).trim()
  const changedFiles = (await options.git(['diff', '--name-only', `${options.fromSha}..HEAD`]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const { tasks, commands } = planOfflineUpdate(changedFiles, flavor)

  const run: LocalUpdateRun = {
    id: randomUUID(),
    status: 'running',
    mode: 'offline',
    startedAt: now(),
    beforeSha: options.fromSha,
    afterSha,
    changedFiles,
    selectedTasks: tasks,
    commands,
    flavor,
    supported: true,
    localRuntime: flavor.sandboxRuntime === 'k3d-local',
  }
  persist(run)

  const runner = new CommandRunner({
    cwd: options.repoRoot,
    runProcess: options.runProcess,
    onUpdate: () => persist(run),
  })
  try {
    await runner.runAll(commands)
    run.status = 'succeeded'
    run.message =
      commands.length === 0 ? 'No build tasks needed for the changed files.' : `Ran ${commands.length} command(s).`
  } catch (err) {
    run.status = 'failed'
    run.error = (err as Error).message
    run.completedAt = now()
    persist(run)
    throw err
  }
  run.completedAt = now()
  persist(run)
  return run
}

async function gitOut(repoRoot: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err.trim()}`)
  return out
}

if (import.meta.main) {
  const idx = process.argv.indexOf('--from')
  const fromSha = idx >= 0 ? process.argv[idx + 1] : undefined
  if (!fromSha || !/^[0-9a-f]{40}$/.test(fromSha)) {
    console.error('usage: bun run update:offline -- --from <40-hex sha before the pull>')
    process.exit(2)
  }
  const repoRoot = resolveRepoRoot()
  try {
    const run = await runOfflineUpdate({ repoRoot, fromSha, env: process.env, git: (args) => gitOut(repoRoot, args) })
    console.log(`offline update ${run.status}: ${run.message ?? ''} (${run.selectedTasks.join(', ') || 'no tasks'})`)
  } catch (err) {
    console.error(`offline update failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
