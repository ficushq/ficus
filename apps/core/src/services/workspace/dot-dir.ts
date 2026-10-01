/**
 * The per-workspace settings dir, `<work root>/.ficus/`.
 *
 * A work root is a squad workspace (`<HOME_DIR>/workspaces/squads/<id>`, `/workspace[/<id>]` in a
 * container, `~/workspace` on a vm box) or an agent's private dir (`<HOME_DIR>/private/<sandboxId>`,
 * `/private`, `~/.private`). Its dot dir holds the squad env (`env.user`, the generated `.env`), the
 * agent identity key (`identity.pem`), the managed toolchain, the interactive `.bashrc`, the
 * workspace `setup.sh`, and the monitor and local-deployment run dirs.
 *
 * Before the rename the dir had the legacy name. Bridge (phase 5, U4): the worker moves every legacy
 * dir once at start ({@link migrateWorkspaceDotDirs}), and Core moves one lazily before it reads or
 * writes a work root ({@link migrateWorkspaceDotDir}), so an api process that serves a request before
 * the worker has run never creates a second, empty `.ficus` beside the legacy dir. The legacy name
 * stays behind as a RELATIVE symlink to `.ficus`: a Core rolled back past this release, an agent
 * whose shell still has the legacy path, and a sandbox image that predates the rename all keep
 * finding the same files. The relative target resolves the same inside a container that mounts the
 * work root somewhere else.
 *
 * The move is one `rename(2)` of the directory entry, so every file keeps its inode, bytes and mode,
 * and an open file descriptor keeps writing into the moved dir. Nothing is ever merged, and no
 * symlink is followed: a work root, legacy dir or `.ficus` that is not a real directory is reported
 * and left alone.
 */
import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, symlinkSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('workspace-dot-dir')

/** The settings dir name inside every work root. */
export const WORKSPACE_DOT_DIR = '.ficus'
/** The settings dir name before the rename; only the migration and the bridge link use it. */
export const LEGACY_WORKSPACE_DOT_DIR = '.tau' // ficus-p5-bridge

/** `<workspaceRoot>/.ficus/<segments>`. A pure path join; it touches no filesystem. */
export function workspaceDotPath(workspaceRoot: string, ...segments: string[]): string {
  return join(workspaceRoot, WORKSPACE_DOT_DIR, ...segments)
}

/** What one work root needed: `moved` when its legacy dir was renamed by this call. */
export type WorkspaceDotDirOutcome = { moved: boolean; conflict?: string }

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String(error)
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** Leaves `<root>/<legacy> -> .ficus`. Returns a conflict when something else took the name. */
function ensureBridgeLink(root: string): string | undefined {
  const legacy = join(root, LEGACY_WORKSPACE_DOT_DIR)
  try {
    symlinkSync(WORKSPACE_DOT_DIR, legacy)
    return undefined
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') return `could not link ${LEGACY_WORKSPACE_DOT_DIR}: ${errorCode(error)}`
  }
  // Another process got there first. Accept it only when it is the same link.
  const existing = lstatOrNull(legacy)
  if (existing?.isSymbolicLink() && readlinkSync(legacy) === WORKSPACE_DOT_DIR) return undefined
  return `both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist`
}

/**
 * Brings one work root to the Ficus shape, synchronously and idempotently:
 *
 * - legacy is a real dir, `.ficus` absent → rename it to `.ficus`, leave the legacy link (`moved`).
 * - `.ficus` is a real dir, legacy absent → add the legacy link (a crash between the rename and the
 *   link, or a dir Core created fresh).
 * - legacy is already the link to `.ficus`, or neither exists → nothing.
 * - both are real dirs; legacy is a link to anything else; either name is not a directory; the work
 *   root itself is a symlink; a rename or link the OS refuses (permissions) → a `conflict`, and
 *   nothing is changed. A later call retries.
 *
 * Two callers racing on the same root both converge: the loser's rename finds the legacy dir gone
 * (ENOENT) and re-reads the state, and an EEXIST on the link is accepted when it is the same link.
 */
export function migrateWorkspaceDotDir(root: string, retried = false): WorkspaceDotDirOutcome {
  try {
    const rootStat = lstatOrNull(root)
    if (!rootStat) return { moved: false }
    if (rootStat.isSymbolicLink()) return { moved: false, conflict: 'the workspace is a symlink, not followed' }
    if (!rootStat.isDirectory()) return { moved: false }

    const target = join(root, WORKSPACE_DOT_DIR)
    const legacy = join(root, LEGACY_WORKSPACE_DOT_DIR)
    const current = lstatOrNull(target)
    const old = lstatOrNull(legacy)

    if (current && !current.isDirectory()) return { moved: false, conflict: `${WORKSPACE_DOT_DIR} is not a directory` }
    if (old?.isSymbolicLink()) {
      const pointsAt = readlinkSync(legacy)
      if (pointsAt === WORKSPACE_DOT_DIR) return { moved: false }
      return {
        moved: false,
        conflict: `${LEGACY_WORKSPACE_DOT_DIR} is a link to ${pointsAt}, not to ${WORKSPACE_DOT_DIR}`,
      }
    }
    if (old && !old.isDirectory()) return { moved: false, conflict: `${LEGACY_WORKSPACE_DOT_DIR} is not a directory` }
    if (old && current)
      return { moved: false, conflict: `both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist` }

    if (current) {
      const conflict = ensureBridgeLink(root)
      return conflict ? { moved: false, conflict } : { moved: false }
    }
    if (!old) return { moved: false }

    try {
      // rename(2) never replaces a non-empty directory, so a `.ficus` that appeared since the
      // lstat above makes this fail (EEXIST/ENOTEMPTY) instead of being merged or clobbered.
      renameSync(legacy, target)
    } catch (error) {
      const code = errorCode(error)
      // Another process moved it between our lstat and the rename: re-read once.
      if (code === 'ENOENT' && !retried) return migrateWorkspaceDotDir(root, true)
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR')
        return { moved: false, conflict: `both ${LEGACY_WORKSPACE_DOT_DIR} and ${WORKSPACE_DOT_DIR} exist` }
      return { moved: false, conflict: `could not move ${LEGACY_WORKSPACE_DOT_DIR}: ${code}` }
    }
    const conflict = ensureBridgeLink(root)
    return conflict ? { moved: true, conflict } : { moved: true }
  } catch (error) {
    return { moved: false, conflict: `could not inspect: ${errorCode(error)}` }
  }
}

const warnedRoots = new Set<string>()

/**
 * {@link migrateWorkspaceDotDir} for a caller about to use `root`'s dot dir. A conflict is logged
 * (once per root per process) and the caller goes on with `.ficus`; the worker's start-up pass
 * reports it in its summary line for the operator.
 */
export function prepareWorkspaceDotDir(root: string): void {
  const outcome = migrateWorkspaceDotDir(root)
  if (outcome.moved) log.info(`Moved ${join(root, LEGACY_WORKSPACE_DOT_DIR)} to ${WORKSPACE_DOT_DIR}`)
  if (outcome.conflict && !warnedRoots.has(root)) {
    warnedRoots.add(root)
    log.warn(`Workspace dot dir not migrated: ${root}: ${outcome.conflict}`)
  }
}

/** Moves a legacy dir if there is one, creates `<root>/.ficus` if needed, links the legacy name, and returns the dir. */
export function ensureWorkspaceDotDir(root: string): string {
  prepareWorkspaceDotDir(root)
  const dir = workspaceDotPath(root)
  mkdirSync(dir, { recursive: true })
  // Link the legacy name to the dir just created, for an image or a rolled-back Core that reads it.
  prepareWorkspaceDotDir(root)
  return dir
}

/** The exact summary line the F4 runbook checks in the worker log. */
export function workspaceDotDirsLogLine(result: { moved: number; conflicts: string[] }): string {
  return `migrateWorkspaceDotDirs moved=${result.moved} conflicts=${JSON.stringify(result.conflicts)}`
}

/**
 * The worker's one start-up pass. For each squad workspace under `<homeDir>/workspaces/squads/*` and
 * each agent private dir under `<homeDir>/private/*` (the identity key lives there), a legacy dot dir
 * that is a real dir while `.ficus` is absent is renamed to `.ficus`, and a RELATIVE symlink
 * `<legacy> -> .ficus` is left (the bridge for a rolled-back Core and for running agents). Both
 * present → untouched and reported. Idempotent. Never throws: every problem is a `conflicts` entry
 * (`<work root>: <reason>`), and the other roots still run.
 */
export async function migrateWorkspaceDotDirs(homeDir: string): Promise<{ moved: number; conflicts: string[] }> {
  let moved = 0
  const conflicts: string[] = []
  for (const base of [join(homeDir, 'workspaces', 'squads'), join(homeDir, 'private')]) {
    let names: string[]
    try {
      names = readdirSync(base).sort()
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') conflicts.push(`${base}: could not list: ${errorCode(error)}`)
      continue
    }
    for (const name of names) {
      const root = join(base, name)
      // migrateWorkspaceDotDir never throws and refuses a symlinked root itself; a plain file is skipped.
      const outcome = migrateWorkspaceDotDir(root)
      if (outcome.moved) moved++
      if (outcome.conflict) conflicts.push(`${root}: ${outcome.conflict}`)
    }
  }
  const result = { moved, conflicts }
  if (conflicts.length > 0) log.warn(workspaceDotDirsLogLine(result))
  else log.info(workspaceDotDirsLogLine(result))
  return result
}
