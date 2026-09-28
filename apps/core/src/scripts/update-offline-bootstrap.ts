#!/usr/bin/env bun
/**
 * Entry point of `bun run update:offline` (the root package.json script, which
 * every CLI, old and new, runs from the checkout it just moved to a new release).
 *
 * It exists because that checkout's `node_modules` still holds the PREVIOUS
 * release's dependencies. `update-offline.ts` imports this release's workspace
 * packages, and across a scope change (the Tau → Ficus rename left only `@tau/*`
 * installed) loading it crashed with "Cannot find module '@ficus/shared/…'",
 * leaving the checkout moved, unbuilt, and the old processes running.
 *
 * So this file imports only Bun/Node built-ins and the import-free
 * `dependency-install.ts`, and:
 *   1. runs the updater's install command when the diff changed the dependencies
 *      (the same rule the update plan uses) or a workspace package of this checkout
 *      is not installed;
 *   2. removes the stale old-scope directories (`node_modules/@tau`) that
 *      `bun install` leaves behind;
 *   3. then runs `update-offline.ts` in a fresh process with the original args,
 *      telling it the install is done so the plan does not run it twice. That
 *      module still imports `boot/legacy-env` first, before any env is read.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  BOOTSTRAP_INSTALLED_FLAG,
  BOOTSTRAP_STALE_FLAG,
  DEPENDENCY_INSTALL_COMMAND,
  touchesDependencies,
} from '../services/updates/dependency-install'

/** Package scopes an earlier release used for its workspace packages. */
export const LEGACY_WORKSPACE_SCOPES = ['@tau'] as const

const SHA = /^[0-9a-f]{40}$/
export const USAGE = 'usage: bun run update:offline -- --from <40-hex sha before the pull>'

export interface BootstrapProcess {
  (command: string[], options: { cwd: string; inherit: boolean }): Promise<{ code: number; stdout: string }>
}

export interface BootstrapOptions {
  root: string
  /** The script's own arguments (process.argv after the script path). */
  args: string[]
  /** Runs a command. `inherit` streams its output to this process's stdout/stderr. */
  run: BootstrapProcess
  /** argv prefix that runs update-offline.ts (default: this Bun and the sibling file). */
  updateCommand?: string[]
  log?(line: string): void
  error?(line: string): void
}

function workspaceDirs(root: string): string[] {
  let patterns: unknown
  try {
    patterns = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown }).workspaces
  } catch {
    return []
  }
  if (!Array.isArray(patterns)) return []
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    if (!pattern.endsWith('/*')) {
      dirs.push(join(root, pattern))
      continue
    }
    const parent = join(root, pattern.slice(0, -2))
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(parent, entry.name))
      }
    } catch {
      // A workspace glob whose parent does not exist matches nothing.
    }
  }
  return dirs
}

/** Names of this checkout's workspace packages (those with a package.json and a name). */
export function workspacePackageNames(root: string): string[] {
  const names: string[] = []
  for (const dir of workspaceDirs(root)) {
    try {
      const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
      if (typeof name === 'string' && name !== '') names.push(name)
    } catch {
      // Not a package.
    }
  }
  return names
}

/**
 * Workspace packages of this checkout that are not linked into `node_modules`: the
 * sign that it holds another release's dependencies (after the Tau → Ficus rename,
 * `@tau/*` installed and `@ficus/*` missing). [] when every one is there.
 */
export function missingWorkspacePackages(root: string, names: string[] = workspacePackageNames(root)): string[] {
  return names.filter((name) => !existsSync(join(root, 'node_modules', name)))
}

/** Installed directories of a legacy scope that no current workspace package uses. */
export function legacyScopeDirs(root: string, names: string[] = workspacePackageNames(root)): string[] {
  const scopes = LEGACY_WORKSPACE_SCOPES.filter((scope) => !names.some((name) => name.startsWith(`${scope}/`)))
  const bases = [root, ...workspaceDirs(root)]
  return bases.flatMap((base) => scopes.map((scope) => join(base, 'node_modules', scope))).filter((d) => existsSync(d))
}

function parseFrom(args: string[]): string | undefined {
  const idx = args.indexOf('--from')
  const sha = idx >= 0 ? args[idx + 1] : undefined
  return sha && SHA.test(sha) ? sha : undefined
}

/** Runs the bootstrap and returns the exit code for the process. */
export async function bootstrapOfflineUpdate(options: BootstrapOptions): Promise<number> {
  const { root, args, run } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const error = options.error ?? ((line: string) => console.error(line))

  const fromSha = parseFrom(args)
  if (!fromSha) {
    error(USAGE)
    return 2
  }

  const diff = await run(['git', 'diff', '--name-only', `${fromSha}..HEAD`], { cwd: root, inherit: false })
  const changed =
    diff.code === 0
      ? diff.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : null
  const missing = missingWorkspacePackages(root)
  // A failed diff fails the update itself below; installing first costs little and
  // lets the real update report that failure instead of crashing on an import.
  const install = changed === null || touchesDependencies(changed) || missing.length > 0

  if (install) {
    const why = missing.length > 0 ? ` (not installed: ${missing.join(', ')})` : ''
    log(`Installing dependencies before loading this release${why}`)
    const installed = await run([...DEPENDENCY_INSTALL_COMMAND], { cwd: root, inherit: true })
    if (installed.code !== 0) {
      error(`offline update failed: ${DEPENDENCY_INSTALL_COMMAND.join(' ')} exited with ${installed.code}`)
      return 1
    }
  }
  // `bun install` never removes a scope the lockfile no longer names, and the leftover
  // copies can mask a missed rename. Nothing running needs them: builds bundle their
  // workspace packages.
  for (const dir of legacyScopeDirs(root)) {
    log(`Removing stale ${dir.slice(root.length + 1)}`)
    rmSync(dir, { recursive: true, force: true })
  }
  if (install) {
    const still = missingWorkspacePackages(root)
    if (still.length > 0) {
      error(
        `offline update failed: ${still.join(', ')} still not installed after ${DEPENDENCY_INSTALL_COMMAND.join(' ')}`
      )
      return 1
    }
  }

  const updateCommand = options.updateCommand ?? [process.execPath, join(import.meta.dir, 'update-offline.ts')]
  const flags = install ? [BOOTSTRAP_INSTALLED_FLAG, ...(missing.length > 0 ? [BOOTSTRAP_STALE_FLAG] : [])] : []
  const update = await run([...updateCommand, ...args, ...flags], { cwd: root, inherit: true })
  return update.code
}

async function spawnProcess(
  command: string[],
  options: { cwd: string; inherit: boolean }
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: options.inherit ? 'inherit' : 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    stderr: 'inherit',
  })
  const stdout = options.inherit ? '' : await new Response(proc.stdout as ReadableStream).text()
  return { code: await proc.exited, stdout }
}

if (import.meta.main) {
  // This file lives at apps/core/src/scripts/: the checkout root is four levels up.
  const root = resolve(import.meta.dir, '../../../..')
  try {
    process.exit(await bootstrapOfflineUpdate({ root, args: process.argv.slice(2), run: spawnProcess }))
  } catch (err) {
    // e.g. bun or git missing from PATH: report it like every other offline-update failure.
    console.error(`offline update failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
