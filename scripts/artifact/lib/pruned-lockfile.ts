/**
 * Lockfile pinning for the core artifact's pruned `node_modules`.
 *
 * The artifact ships only the runtime externals (and their dependencies), so it
 * installs them in a scratch directory rather than shipping the checkout's whole
 * `node_modules`. That scratch install used to resolve every TRANSITIVE
 * dependency fresh from npm: a new upstream release could change what the
 * artifact shipped without CI ever testing it, and a release still propagating
 * on the registry could break the build outright (squad playbook
 * `debugging/core-artifact-npm-publish-race.md`).
 *
 * Instead, {@link prunedInstallPlan} carves the dependency closure of the
 * externals out of the checkout's `bun.lock` and writes it as the scratch
 * project's own lockfile, which is then installed with `--frozen-lockfile`.
 * Bun refuses that install outright ("lockfile had changes, but lockfile is
 * frozen", or "Failed to resolve prod dependency") when the manifest and the
 * pruned lockfile disagree, so it can never silently re-resolve.
 * {@link assertInstalledMatchesLock} then re-checks the installed tree against
 * the lock, so a drift is caught even if Bun's own check ever changes.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One `packages` entry: `[ "name@version", registry, meta?, integrity? ]`. */
type LockPackageEntry = [string, string, LockPackageMeta?, string?]

interface LockPackageMeta {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalPeers?: string[]
}

interface LockWorkspace {
  name?: string
  dependencies?: Record<string, string>
}

/** The subset of Bun's text lockfile (`bun.lock`) this module reads and writes. */
export interface BunLockfile {
  lockfileVersion: number
  configVersion?: number
  workspaces: Record<string, LockWorkspace>
  overrides?: Record<string, string>
  packages: Record<string, LockPackageEntry>
}

export interface PrunedInstallPlan {
  /** The scratch manifest's `dependencies`: each external at its exact locked version. */
  dependencies: Record<string, string>
  /** `overrides` from the checkout that touch a package in the closure, carried as-is. */
  overrides: Record<string, string>
  /** The scratch project's `bun.lock`: one root workspace and the closure's packages. */
  lockfile: BunLockfile
  /** Every `name@version` the closure may install. */
  lockedVersions: Set<string>
}

/** The name the scratch project and its lockfile workspace carry. */
export const PRUNED_PROJECT_NAME = 'ficus-core-artifact-externals'

/** `bun.lock` is JSONC (trailing commas), not JSON. */
export function parseBunLockfile(text: string): BunLockfile {
  const lock = Bun.JSONC.parse(text) as BunLockfile
  if (lock === null || typeof lock !== 'object' || typeof lock.packages !== 'object' || !lock.workspaces) {
    throw new Error('bun.lock has no workspaces/packages sections; is it a Bun text lockfile?')
  }
  return lock
}

/** Split a lockfile key such as `jsdom/@scope/pkg/ws` into its package names. */
function keySegments(key: string): string[] {
  const parts = key.split('/')
  const segments: string[] = []
  for (let i = 0; i < parts.length; i++) {
    segments.push(parts[i]!.startsWith('@') ? `${parts[i]}/${parts[++i]}` : parts[i]!)
  }
  return segments
}

/** `name@version` with the name taken from the entry, so scoped names stay whole. */
function entryVersion(name: string, entry: LockPackageEntry): string {
  const id = entry[0]
  if (!id.startsWith(`${name}@`)) {
    throw new Error(`bun.lock entry for ${name} resolves to ${id}, not a registry version of ${name}`)
  }
  return id.slice(name.length + 1)
}

/**
 * Node's resolution over lockfile keys: a dependency of the package at
 * `parent` is `parent/dep` if the lockfile nests one there, else the same
 * lookup one level up, ending at the hoisted root `dep`.
 */
function resolveKey(lock: BunLockfile, parent: string[], name: string): string | undefined {
  for (let depth = parent.length; depth >= 0; depth--) {
    const key = [...parent.slice(0, depth), name].join('/')
    if (lock.packages[key]) return key
  }
  return undefined
}

/**
 * Carve out of `lock` the dependency closure of `packages`, as the workspace at
 * `workspacePath` resolves them, as a standalone lockfile for a scratch project
 * that depends on exactly those packages at their locked versions.
 *
 * Keys keep their original nesting, minus the workspace prefix Bun uses for
 * packages only that workspace resolves differently. Optional dependencies for
 * every platform are kept (Bun installs only the matching ones); optional peers
 * are not followed. Fails, naming the package, rather than guessing when the
 * lockfile cannot resolve a required dependency.
 */
export function prunedInstallPlan(
  lock: BunLockfile,
  opts: { workspacePath: string; packages: readonly string[] }
): PrunedInstallPlan {
  const workspace = lock.workspaces[opts.workspacePath]
  if (!workspace?.name) throw new Error(`bun.lock has no workspace ${opts.workspacePath}`)
  const workspaceName = workspace.name

  const dependencies: Record<string, string> = {}
  const pending: string[] = []
  for (const name of opts.packages) {
    if (!workspace.dependencies?.[name]) {
      throw new Error(`${name} is not a dependency of ${opts.workspacePath} in bun.lock; cannot pin it`)
    }
    const key = resolveKey(lock, [workspaceName], name)
    if (!key) throw new Error(`bun.lock has no resolved package for ${name} (a dependency of ${opts.workspacePath})`)
    dependencies[name] = entryVersion(name, lock.packages[key]!)
    pending.push(key)
  }

  const picked = new Map<string, LockPackageEntry>()
  const seen = new Set<string>()
  while (pending.length > 0) {
    const key = pending.shift()!
    if (seen.has(key)) continue
    seen.add(key)
    const entry = lock.packages[key]!
    let segments = keySegments(key)
    if (segments[0] === workspaceName) segments = segments.slice(1)
    const prunedKey = segments.join('/')
    const existing = picked.get(prunedKey)
    if (existing && existing[0] !== entry[0]) {
      throw new Error(
        `cannot prune bun.lock: ${prunedKey} resolves to both ${existing[0]} and ${entry[0]} once the ${workspaceName} workspace prefix is dropped`
      )
    }
    picked.set(prunedKey, entry)

    const meta = entry[2] ?? {}
    const optionalPeers = new Set(meta.optionalPeers ?? [])
    const edges: { name: string; required: boolean }[] = [
      ...Object.keys(meta.dependencies ?? {}).map((name) => ({ name, required: true })),
      ...Object.keys(meta.optionalDependencies ?? {}).map((name) => ({ name, required: false })),
      ...Object.keys(meta.peerDependencies ?? {})
        .filter((name) => !optionalPeers.has(name))
        .map((name) => ({ name, required: false })),
    ]
    for (const edge of edges) {
      const depKey = resolveKey(lock, keySegments(key), edge.name)
      if (depKey) pending.push(depKey)
      else if (edge.required) {
        throw new Error(`bun.lock cannot resolve ${edge.name}, a dependency of ${entry[0]} (at ${key})`)
      }
    }
  }

  const packages = Object.fromEntries([...picked.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const lockedVersions = new Set(Object.values(packages).map((entry) => entry[0]))
  const closureNames = new Set(Object.values(packages).map((entry) => entry[0].slice(0, entry[0].lastIndexOf('@'))))
  const overrides = Object.fromEntries(Object.entries(lock.overrides ?? {}).filter(([name]) => closureNames.has(name)))

  const lockfile: BunLockfile = {
    lockfileVersion: lock.lockfileVersion,
    ...(lock.configVersion !== undefined ? { configVersion: lock.configVersion } : {}),
    workspaces: { '': { name: PRUNED_PROJECT_NAME, dependencies } },
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    packages,
  }
  return { dependencies, overrides, lockfile, lockedVersions }
}

export interface InstalledPackage {
  /** Path below `node_modules`, e.g. `jsdom` or `gaxios/https-proxy-agent`. */
  path: string
  name: string
  version: string
}

/** Every package in a `node_modules` tree, nested ones included; `.bin` and other dot entries skipped. */
export async function listInstalledPackages(nodeModulesDir: string, prefix = ''): Promise<InstalledPackage[]> {
  let entries
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: InstalledPackage[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue
    const names = entry.name.startsWith('@')
      ? (await readdir(join(nodeModulesDir, entry.name))).map((scoped) => `${entry.name}/${scoped}`)
      : [entry.name]
    for (const name of names) {
      const dir = join(nodeModulesDir, name)
      const path = prefix ? `${prefix}/${name}` : name
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      } catch (error) {
        throw new Error(`installed package node_modules/${path} has no readable package.json: ${String(error)}`)
      }
      found.push({ path, name: String(manifest.name), version: String(manifest.version) })
      found.push(...(await listInstalledPackages(join(dir, 'node_modules'), path)))
    }
  }
  return found
}

/**
 * The installed tree may hold only versions the lockfile pinned, and must hold
 * every external at the top level at its locked version. Throws listing every
 * difference.
 */
export function assertInstalledMatchesLock(installed: InstalledPackage[], plan: PrunedInstallPlan): void {
  const problems: string[] = []
  for (const pkg of installed) {
    const id = `${pkg.name}@${pkg.version}`
    if (!plan.lockedVersions.has(id)) problems.push(`node_modules/${pkg.path} is ${id}, which bun.lock does not pin`)
  }
  for (const [name, version] of Object.entries(plan.dependencies)) {
    const top = installed.find((pkg) => pkg.path === name)
    if (!top) problems.push(`runtime external ${name} is missing from the installed node_modules`)
    else if (top.name !== name || top.version !== version)
      problems.push(
        `runtime external ${name} installed as ${top.name}@${top.version}, but bun.lock pins ${name}@${version}`
      )
  }
  if (problems.length > 0) {
    throw new Error(`pruned node_modules does not match bun.lock:\n  ${problems.join('\n  ')}`)
  }
}
