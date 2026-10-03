import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { CORE_ROOT_PACKAGE_NAMES, type CoreRootPackageName } from '@ficus/shared/identity'
import { expandTilde, LEGACY_HOME_DIR_NAME, LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'
import { CURRENT_IDENTITY, normalizeLabel } from './instance'
import { LOCAL_SUPERVISORS, type LocalSupervisor } from './types'
import { cliHome } from './home-move'

/** One installed instance: the checkout it lives in and the port it serves on. */
export interface InstanceRecord {
  root: string
  port: number
  supervisor: LocalSupervisor
  createdAt: string
  updatedAt: string
  /**
   * `2`: the instance runs under the ficus names (setup registers it so, `ficus server
   * rename-identity` moves an older one). Absent: it still has the names it was installed under.
   * Every read → write keeps it; the registry `version` stays 3 either way. Any other number was
   * written by a newer CLI: the lenient read (`list`) keeps and shows it, mutating reads refuse.
   */
  identity?: number
}

/**
 * Every instance installed on this machine, plus the one `ficus server`
 * commands act on when nothing else says which. Version 1 was a single
 * bare record ({ root, port, … }) — it reads as the legacy default instance.
 */
export interface LocalServerRegistry {
  version: 3
  default?: string
  instances: Record<string, InstanceRecord>
}

export const REGISTRY_VERSION = 3

/**
 * A registry this CLI refuses to mutate: unreadable, a version this code does
 * not know, or carrying a record that fails validation. Read-only commands
 * (list) still answer with an empty view; anything that would write, dispatch,
 * or uninstall must stop instead of silently adopting the surviving subset.
 */
export class InvalidRegistryError extends Error {
  constructor(reason: string, path: string) {
    super(`${reason} in ${path} — fix or remove the file (see \`ficus server list\`) before changing instances`)
    this.name = 'InvalidRegistryError'
  }
}

/** The filesystem identity of a root: its realpath when it exists, else the resolved path. */
export function canonicalRoot(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

export class NoRootError extends Error {
  constructor(detail: string) {
    super(
      `No local Ficus checkout found (${detail}). Run \`ficus server install\`, pass --root <dir>, set FICUS_SERVER_ROOT, or run from inside a checkout.`
    )
    this.name = 'NoRootError'
  }
}

export class UnknownInstanceError extends Error {
  constructor(label: string, known: string[]) {
    super(
      `unknown instance "${label}" — ${
        known.length > 0 ? `known instances: ${known.join(', ')}` : 'no instances are registered'
      } (see \`ficus server list\`)`
    )
    this.name = 'UnknownInstanceError'
  }
}

export function getStatePath(env: Record<string, string | undefined> = process.env): string {
  return expandTilde(
    env.FICUS_LOCAL_SERVER_STATE || join(cliHome({ homedir: env.HOME ?? homedir() }), 'cli', 'local-server.json')
  )
}

/** Refusal-only bridge inventory: never read or select a retired registry for normal management. */
export function assertDefaultRegistryReady(
  env: Record<string, string | undefined> = process.env,
  statePath = getStatePath(env)
): void {
  const home = env.HOME ?? homedir()
  const canonical = join(cliHome({ homedir: home }), 'cli', 'local-server.json')
  // An explicit registry is an independent operator selection, not a default-home lookup.
  if (resolve(statePath) !== resolve(canonical)) return
  const present = (path: string): boolean => {
    try {
      lstatSync(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error('cannot inspect local registry layout — resolve access before managing instances', {
        cause: error,
      })
    }
  }
  const retired = join(home, LEGACY_HOME_DIR_NAME, 'cli', 'local-server.json')
  if (!present(retired)) return
  if (present(canonical)) {
    // A migrated home link (or another path to the same inode) is one registry, not a hidden instance.
    const currentFile = statSync(canonical)
    const retiredFile = statSync(retired)
    if (currentFile.dev === retiredFile.dev && currentFile.ino === retiredFile.ino) return
  }
  throw new Error(
    'local registry predates the Ficus home layout or has separate copies — upgrade through the ficus-host-layout-bridge Core release first'
  )
}

function emptyRegistry(): LocalServerRegistry {
  return { version: REGISTRY_VERSION, instances: {} }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A record is only usable if it satisfies its complete persisted schema. */
function toRecord(value: unknown, legacy: boolean): InstanceRecord | null {
  if (!isPlainObject(value)) return null
  const v = value as Partial<InstanceRecord>
  if (
    typeof v.root !== 'string' ||
    v.root.trim() === '' ||
    (!legacy && !isAbsolute(v.root)) ||
    !Number.isInteger(v.port) ||
    (v.port as number) < 1 ||
    (v.port as number) > 65_532
  )
    return null
  const supervisor = legacy ? 'pm2' : v.supervisor
  if (!supervisor || !(LOCAL_SUPERVISORS as readonly string[]).includes(supervisor)) return null
  if (!legacy && (typeof v.createdAt !== 'string' || typeof v.updatedAt !== 'string')) return null
  // An identity is a whole number; one this code does not know (a newer CLI's) is kept as it is —
  // see unsupportedIdentity — never dropped.
  if (v.identity !== undefined && !Number.isInteger(v.identity)) return null
  return {
    root: v.root,
    port: v.port as number,
    supervisor,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    ...(v.identity !== undefined ? { identity: v.identity } : {}),
  }
}

/** An entry a newer CLI wrote: an identity this code does not know how to name. */
export function unsupportedIdentity(record: InstanceRecord): boolean {
  return record.identity !== undefined && record.identity !== 1 && record.identity !== CURRENT_IDENTITY
}

function validRegistryLabel(label: string): boolean {
  try {
    return normalizeLabel(label) === label
  } catch {
    return false
  }
}

/**
 * The registry as it is on disk, migrated forward. A file this CLI cannot make
 * sense of reads as an empty registry rather than throwing: `ficus server` must
 * stay usable (with --root) when the registry is damaged. Mutating paths use
 * {@link readRegistryStrict}, which fails closed instead.
 */
export function readRegistry(path = getStatePath()): LocalServerRegistry {
  return parseRegistryFile(path).registry
}

/**
 * The read `ficus server list` makes: strict, except that entries a newer CLI wrote are kept and
 * named in `unsupported` rather than failing the listing — they are shown, never hidden.
 */
export function readRegistryListing(path = getStatePath()): {
  registry: LocalServerRegistry
  unsupported: Set<string>
} {
  const parsed = parseRegistryFile(path)
  const unsupported = new Set(parsed.unsupported ?? [])
  const onlyUnsupported = unsupported.size > 0 && !parsed.strictError?.startsWith('registry has an invalid')
  if (parsed.strictError && !onlyUnsupported) throw new InvalidRegistryError(parsed.strictError, path)
  return { registry: parsed.registry, unsupported }
}

/** The same read, but a damaged/unknown registry is an error, never an empty one. */
export function readRegistryStrict(path = getStatePath()): LocalServerRegistry {
  const parsed = parseRegistryFile(path)
  if (parsed.strictError) throw new InvalidRegistryError(parsed.strictError, path)
  return parsed.registry
}

/**
 * One parse, two views: `registry` is the permissive view read-only commands
 * use (drop what does not validate, empty for a version this code does not
 * know), while `strictError` names the first reason a mutating command must
 * refuse to touch the file at all.
 */
function parseRegistryFile(path: string): {
  registry: LocalServerRegistry
  strictError?: string
  /** Entries a newer CLI wrote (see unsupportedIdentity); the only strict error when alone. */
  unsupported?: string[]
} {
  if (!existsSync(path)) return { registry: emptyRegistry() }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { registry: emptyRegistry(), strictError: 'registry is unreadable (invalid JSON)' }
  }
  if (!isPlainObject(parsed)) return { registry: emptyRegistry(), strictError: 'registry is unreadable (wrong shape)' }
  const object = parsed as { version?: unknown; default?: unknown; instances?: unknown }

  // v1: one bare record without an explicit registry version, written before
  // labels existed: the legacy default instance, under its legacy names. A
  // literally empty object carries no claim at all, so it stays an empty registry.
  if (object.version === undefined) {
    const v1 = toRecord(parsed, true)
    if (v1)
      return {
        registry: {
          version: REGISTRY_VERSION,
          default: LEGACY_LOCAL_INSTANCE,
          instances: { [LEGACY_LOCAL_INSTANCE]: v1 },
        },
      }
    if (Object.keys(object).length === 0) return { registry: emptyRegistry() }
    return { registry: emptyRegistry(), strictError: 'registry is unreadable (v1 record is invalid)' }
  }
  if (object.version !== 2 && object.version !== REGISTRY_VERSION)
    return {
      registry: emptyRegistry(),
      strictError: `registry version ${String(object.version)} is not supported`,
    }

  const legacy = object.version === 2
  if (!isPlainObject(object.instances)) {
    return { registry: emptyRegistry(), strictError: 'registry is unreadable (instances must be an object)' }
  }
  const instances: Record<string, InstanceRecord> = {}
  let invalid = false
  const unsupported: string[] = []
  for (const [label, value] of Object.entries(object.instances)) {
    if (!validRegistryLabel(label)) {
      invalid = true
      continue
    }
    const record = toRecord(value, legacy)
    if (record) instances[label] = record
    else invalid = true
    if (record && unsupportedIdentity(record)) unsupported.push(label)
  }
  let fallback: string | undefined
  if (object.default !== undefined) {
    if (typeof object.default === 'string' && validRegistryLabel(object.default) && instances[object.default]) {
      fallback = object.default
    } else {
      invalid = true
    }
  }
  const registry: LocalServerRegistry = {
    version: REGISTRY_VERSION,
    ...(fallback ? { default: fallback } : {}),
    instances,
  }
  if (invalid) return { registry, strictError: 'registry has an invalid record or default', unsupported }
  if (unsupported.length > 0)
    return {
      registry,
      unsupported,
      strictError: `instance ${unsupported.map((l) => `"${l}"`).join(', ')} was registered by a newer CLI (an identity this one does not know) — update the CLI`,
    }
  return { registry }
}

/**
 * Replace the registry in one step: a half-written file would read as an empty
 * registry and orphan every instance, so the new content lands under a
 * temporary name in the same directory and is renamed over the target. The
 * chmod comes after the rename so a file that already existed with looser
 * permissions is tightened too (it holds nothing secret, but it decides which
 * checkout `ficus server` acts on).
 */
export function writeRegistry(registry: LocalServerRegistry, path = getStatePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/** The instance a bare `ficus server` command acts on when nothing names one. */
export function defaultLabel(registry: LocalServerRegistry): string | undefined {
  if (registry.default && registry.instances[registry.default]) return registry.default
  // A hand-edited file can lose its `default` line; the instances are still real.
  return Object.keys(registry.instances).sort()[0]
}

export function upsertInstance(
  label: string,
  record: InstanceRecord,
  options: { makeDefault?: boolean } = {},
  path = getStatePath()
): void {
  const registry = readRegistryStrict(path)
  // A registry with instances always has a default: the first install wins it,
  // and a later one only takes it when it asks (--default).
  const hadDefault = defaultLabel(registry) !== undefined
  registry.instances[label] = record
  if (options.makeDefault || !hadDefault) registry.default = label
  writeRegistry(registry, path)
}

/** Drop an instance; the default moves to whatever is left, or goes away. */
export function removeInstance(label: string, path = getStatePath()): void {
  const registry = readRegistryStrict(path)
  if (!(label in registry.instances) && registry.default !== label) return
  delete registry.instances[label]
  if (registry.default === label) {
    const next = Object.keys(registry.instances).sort()[0]
    if (next) registry.default = next
    else delete registry.default
  }
  writeRegistry(registry, path)
}

export function findInstanceByRoot(
  root: string,
  path = getStatePath()
): { label: string; record: InstanceRecord } | undefined {
  const target = canonicalRoot(root)
  const registry = readRegistryStrict(path)
  for (const [label, record] of Object.entries(registry.instances)) {
    if (canonicalRoot(record.root) === target) return { label, record }
  }
  return undefined
}

export function isCheckout(dir: string): boolean {
  try {
    if (!existsSync(join(dir, '.git'))) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    return CORE_ROOT_PACKAGE_NAMES.includes(pkg.name as CoreRootPackageName)
  } catch {
    return false
  }
}

function walkUp(start: string): string | null {
  let dir = resolve(start)
  for (;;) {
    if (isCheckout(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** A label from the ambient environment: unusable ones are simply not a selection. */
function optionalLabel(raw: string): string | undefined {
  try {
    return normalizeLabel(raw)
  } catch {
    return undefined
  }
}

/** --root, then FICUS_SERVER_ROOT. Either, when given, must be a checkout. */
function explicitRoot(flag: string | undefined, env: Record<string, string | undefined>): string | null {
  const candidates: { source: string; dir: string }[] = []
  if (flag) candidates.push({ source: '--root', dir: resolve(expandTilde(flag)) })
  if (env.FICUS_SERVER_ROOT)
    candidates.push({ source: 'FICUS_SERVER_ROOT', dir: resolve(expandTilde(env.FICUS_SERVER_ROOT)) })
  for (const c of candidates) {
    if (isCheckout(c.dir)) return canonicalRoot(c.dir)
    throw new NoRootError(`${c.source}=${c.dir} is not a Ficus checkout`)
  }
  return null
}

/**
 * --root > FICUS_SERVER_ROOT > --instance / FICUS_INSTANCE > the checkout the cwd
 * is in > the registry default. A named instance outranks the cwd (you asked
 * for it by name), and the cwd outranks the default (the checkout you are
 * standing in is the one you mean). Flag/env roots must be checkouts.
 */
export function resolveRoot(options: {
  flag?: string
  env: Record<string, string | undefined>
  instance?: string
  statePath?: string
  cwd?: string
}): string {
  const explicit = explicitRoot(options.flag, options.env)
  if (explicit) return explicit
  const registry = readRegistryStrict(options.statePath ?? getStatePath(options.env))
  // --instance is a request: honour it or refuse. FICUS_INSTANCE is ambient — a
  // checkout's own .env puts it in the environment — so a label it names that
  // this machine cannot use is ignored rather than turned into a failure of an
  // otherwise perfectly answerable command.
  const fromFlag = options.instance !== undefined
  const asked = options.instance ?? options.env.FICUS_INSTANCE
  if (asked) {
    const label = fromFlag ? normalizeLabel(asked) : optionalLabel(asked)
    const record = label === undefined ? undefined : registry.instances[label]
    if (record && isCheckout(record.root)) return canonicalRoot(record.root)
    // Only the flag reports why it could not be honoured. Every way the
    // environment's label can fail — unparsable, unregistered, or registered
    // at a checkout that has since been deleted — leaves resolution to carry
    // on as if FICUS_INSTANCE had not been set at all.
    if (fromFlag) {
      if (!record) throw new UnknownInstanceError(label as string, Object.keys(registry.instances).sort())
      throw new NoRootError(`instance "${label}" is registered at ${record.root}, which is not a checkout`)
    }
  }
  const walked = walkUp(options.cwd ?? process.cwd())
  if (walked) return canonicalRoot(walked)
  const label = defaultLabel(registry)
  const record = label ? registry.instances[label] : undefined
  if (record && isCheckout(record.root)) return canonicalRoot(record.root)
  throw new NoRootError(
    record ? `instance "${label}" is registered at ${record.root}, which is not a checkout` : 'no instances registered'
  )
}

/**
 * Root resolution for `setup` only: --root > FICUS_SERVER_ROOT > walk up from cwd.
 * The registry is deliberately NOT consulted — once an install exists, using it
 * would make `bun run setup` inside a second checkout configure, migrate and
 * pm2-start the FIRST one. Management commands (start/stop/status/…) act on "the
 * installed instance" and do use it (resolveRoot).
 */
export function resolveSetupRoot(options: {
  flag?: string
  env: Record<string, string | undefined>
  cwd?: string
}): string {
  const explicit = explicitRoot(options.flag, options.env)
  if (explicit) return explicit
  const walked = walkUp(options.cwd ?? process.cwd())
  if (walked) return canonicalRoot(walked)
  throw new NoRootError('not inside a Ficus checkout')
}
