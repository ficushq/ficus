import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { expandTilde, FICUS_HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, renamedLocalInstanceLabel } from '@ficus/shared/node'
import { parseEnvFile, renderValue } from './env-file'
import { moveCliHome, unmoveCliHome } from './home-move'
import { CURRENT_IDENTITY, generateEcosystem, instanceNames, recordIdentity, type InstanceIdentity } from './instance'
import { launchdNames, launchdSupervisor, nativeLogPath } from './launchd'
import { containerVolumeName } from './postgres'
import { parseJlist, pm2Args, runPm2 } from './pm2'
import {
  finalizeLocalPostgresRename,
  localPostgresMove,
  newRenameRunId,
  planLocalPostgresRename,
  renameLocalPostgres,
  undoLocalPostgresRename,
  type LocalPostgresPlan,
} from './postgres-rename'
import type { Runner } from './runner'
import { canonicalRoot, readRegistryStrict, writeRegistry, type LocalServerRegistry } from './state'
import { statusSupervisor, supervisorAdapter, type SupervisorContext } from './supervisor'
import { systemdUserNames, systemdUserSupervisor } from './systemd-user'
import type { LocalSupervisor } from './types'

// ─── Supervisor identities ──────────────────────────────────────────────────

/**
 * One instance under one naming era: the supervisor it is registered with, its label, and the
 * process names that era gives it. Identity 1 is the pre-rename names (the legacy launchd prefix,
 * `LEGACY_UNITS`), identity 2 the ficus names (`sh.ficus.*`, `ficus-api`).
 */
export interface SupervisorIdentity {
  supervisor: LocalSupervisor
  label: string
  identity: InstanceIdentity
  api: string
  worker: string
}

export function supervisorIdentity(
  supervisor: LocalSupervisor,
  label: string,
  identity: InstanceIdentity
): SupervisorIdentity {
  const names = instanceNames(label, identity)
  return { supervisor, label: names.label, identity, api: names.api, worker: names.worker }
}

export interface SupervisorDeps {
  /** The checkout both identities run from. */
  root: string
  /** The adapter context for one identity of the instance at `root`. */
  context(id: SupervisorIdentity, root: string): SupervisorContext
  /**
   * The environment a pm2 start hands its client (laid over this process's; undefined removes a
   * key). pm2 bakes its client's environment into the apps it starts; launchd and systemd do not,
   * so only pm2 uses it.
   */
  startEnv?(root: string): Record<string, string | undefined>
}

async function must(ctx: SupervisorContext, command: string[]): Promise<void> {
  const result = await ctx.runner(command)
  if (result.code !== 0)
    throw new Error(
      `${command.join(' ')} failed (exit ${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`
    )
}

/** The instance's pm2 apps that pm2 knows about right now, api first. */
async function pm2Present(ctx: SupervisorContext, id: SupervisorIdentity): Promise<string[]> {
  const result = await runPm2(ctx.runner, ctx.root, ['jlist'])
  if (result.code !== 0) throw new Error(`pm2 jlist failed (exit ${result.code})`)
  const known = new Set(parseJlist(result.stdout, id).map((p) => p.name))
  return [id.api, id.worker].filter((name) => known.has(name))
}

async function pm2Must(
  ctx: SupervisorContext,
  args: string[],
  env?: Record<string, string | undefined>
): Promise<void> {
  const result = await runPm2(ctx.runner, ctx.root, args, true, env)
  if (result.code !== 0) throw new Error(`pm2 ${args.join(' ')} failed (exit ${result.code})`)
}

/** Deletes the instance's apps pm2 knows and saves the list, so a resurrect cannot bring them back. */
async function pm2Remove(ctx: SupervisorContext, id: SupervisorIdentity): Promise<void> {
  const present = await pm2Present(ctx, id)
  if (present.length === 0) return
  await pm2Must(ctx, ['delete', ...present])
  // --force: an empty process list is saved too (plain `save` then keeps the old dump).
  await pm2Must(ctx, ['save', '--force'])
}

/** `launchctl enable|disable gui/<uid>/<label>` for both jobs: the override survives a reboot. */
async function launchdOverride(ctx: SupervisorContext, verb: 'enable' | 'disable'): Promise<void> {
  for (const component of ['api', 'worker'] as const)
    await must(ctx, ['launchctl', verb, `gui/${ctx.uid}/${launchdNames(ctx, component).label}`])
}

/** The unit files of an identity that exist, api first. */
function systemdUnitsPresent(ctx: SupervisorContext) {
  return (['api', 'worker'] as const).map((c) => systemdUserNames(ctx, c)).filter((n) => existsSync(n.path))
}

/**
 * Stops both processes of `id` so that nothing brings them back by itself, not even a reboot:
 * launchd `bootout` (API, then worker; a loaded job must be this checkout's) and `disable` (the
 * plists stay, and would otherwise load again at login), systemd `disable --now`, pm2 `delete`
 * then `save --force` (else `pm2 resurrect` at login restores them from the dump). The
 * definitions stay; a missing process is not an error.
 */
export async function stopSupervisor(id: SupervisorIdentity, deps: SupervisorDeps): Promise<void> {
  const ctx = deps.context(id, deps.root)
  if (id.supervisor === 'launchd') {
    await launchdSupervisor.stop(ctx)
    await launchdOverride(ctx, 'disable')
    return
  }
  if (id.supervisor === 'systemd-user') {
    for (const names of systemdUnitsPresent(ctx))
      await must(ctx, ['systemctl', '--user', 'disable', '--now', names.unit])
    return
  }
  await pm2Remove(ctx, id)
}

/**
 * Writes the definitions of `id` and starts it: launchd `enable` + plists + `bootstrap`, systemd
 * units + `enable --now`, pm2 `start ecosystem.config.js` for its two apps (with
 * `deps.startEnv(root)` as its client environment), then `save`. launchd plists and systemd units
 * carry no `.env` value: the app reads `<root>/.env` itself when it starts.
 */
export async function installSupervisor(id: SupervisorIdentity, root: string, deps: SupervisorDeps): Promise<void> {
  const ctx = deps.context(id, root)
  if (id.supervisor === 'pm2') {
    await pm2Must(ctx, pm2Args('start', id), deps.startEnv?.(root))
    await pm2Must(ctx, ['save'])
    return
  }
  if (id.supervisor === 'launchd') await launchdOverride(ctx, 'enable')
  await supervisorAdapter(id.supervisor).start(ctx)
}

/**
 * Removes the definitions of an identity that is already stopped: its plists or unit files (each
 * only when this checkout owns it). pm2 keeps no definition beyond its process list.
 */
export async function removeSupervisorDefinitions(
  id: SupervisorIdentity,
  root: string,
  deps: SupervisorDeps
): Promise<void> {
  const ctx = deps.context(id, root)
  if (id.supervisor === 'launchd') return uninstallLaunchd(ctx)
  if (id.supervisor === 'systemd-user') {
    if (systemdUnitsPresent(ctx).length > 0) await systemdUserSupervisor.uninstall(ctx)
  }
}

/**
 * Removes an identity's plists, then enables its labels again: a `disable` override only matters
 * while a plist exists, and one left behind makes a later bootstrap of that label fail (a new
 * setup under the same label, or the old plists restored by hand).
 */
async function uninstallLaunchd(ctx: SupervisorContext): Promise<void> {
  await launchdSupervisor.uninstall(ctx)
  await launchdOverride(ctx, 'enable')
}

/** Stops `id` and removes its definitions, whatever of it exists (the undo of a started identity). */
async function removeSupervisor(id: SupervisorIdentity, root: string, deps: SupervisorDeps): Promise<void> {
  const ctx = deps.context(id, root)
  if (id.supervisor === 'launchd') return uninstallLaunchd(ctx)
  if (id.supervisor === 'systemd-user') {
    const present = systemdUnitsPresent(ctx)
    for (const names of present) await must(ctx, ['systemctl', '--user', 'disable', '--now', names.unit])
    for (const names of present) rmSync(names.path, { force: true })
    if (present.length > 0) await must(ctx, ['systemctl', '--user', 'daemon-reload'])
    return
  }
  await pm2Remove(ctx, id)
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * The registry with instance `from` renamed to `to`: the entry (root, port, supervisor and every
 * other field) moves unchanged, and a `default` that named `from` names `to`. Throws when `from`
 * is not registered or `to` already is. The input is not changed.
 */
export function relabelInstance(registry: LocalServerRegistry, from: string, to: string): LocalServerRegistry {
  if (!registry.instances[from]) throw new Error(`no instance "${from}" is registered`)
  const taken = registry.instances[to]
  if (taken) throw new Error(`instance "${to}" is already registered (${taken.root}) — unregister it first`)
  const instances: LocalServerRegistry['instances'] = {}
  for (const [label, record] of Object.entries(registry.instances)) instances[label === from ? to : label] = record
  return {
    ...registry,
    ...(registry.default !== undefined ? { default: registry.default === from ? to : registry.default } : {}),
    instances,
  }
}

// ─── .env edits ─────────────────────────────────────────────────────────────

/** One key of `.env` changed by a step: its whole line before (null: absent) and after. */
export interface EnvEdit {
  key: string
  before: string | null
  after: string
}

const lineKey = (line: string) => /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]

function splitLines(text: string): { lines: string[]; newline: boolean } {
  const lines = text.split('\n')
  const newline = text.endsWith('\n')
  if (newline) lines.pop()
  return { lines, newline }
}

/** The index of the line that decides `key` (the last one, as the parser reads it), or -1. */
function keyLine(lines: string[], key: string): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lineKey(lines[i]) === key) return i
  return -1
}

/** The edits that set each key to its value; a key already at that value needs none. */
function planEnvEdits(text: string, values: Record<string, string>): EnvEdit[] {
  const { lines } = splitLines(text)
  const edits: EnvEdit[] = []
  for (const [key, value] of Object.entries(values)) {
    const at = keyLine(lines, key)
    const before = at >= 0 ? lines[at] : null
    const after = `${key}=${renderValue(value)}`
    if (before !== after) edits.push({ key, before, after })
  }
  return edits
}

function applyEnvEdits(text: string, edits: EnvEdit[]): string {
  const { lines } = splitLines(text)
  for (const edit of edits) {
    const at = keyLine(lines, edit.key)
    if (at >= 0) lines[at] = edit.after
    else lines.push(edit.after)
  }
  return lines.join('\n') + '\n'
}

/**
 * Puts back each line an edit wrote; a line changed since then is left alone and reported.
 * `noFinalNewline`: the file had no final newline before the edits (which always add one).
 */
function revertEnvEdits(text: string, edits: EnvEdit[], noFinalNewline = false): { text: string; kept: string[] } {
  const { lines, newline } = splitLines(text)
  const kept: string[] = []
  for (const edit of [...edits].reverse()) {
    const at = keyLine(lines, edit.key)
    const current = at >= 0 ? lines[at] : null
    if (current === edit.before) continue
    if (current !== edit.after) {
      kept.push(edit.key)
      continue
    }
    if (edit.before === null) lines.splice(at, 1)
    else lines[at] = edit.before
  }
  const final = noFinalNewline ? '' : newline || lines.length > 0 ? '\n' : ''
  return { text: lines.join('\n') + final, kept }
}

/** Replaces a file in one step, keeping its mode (a temp file in the same directory, then a rename). */
function writeFileAtomic(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
  try {
    const fd = openSync(temp, 'w', mode)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, mode)
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
}

// ─── Journal ────────────────────────────────────────────────────────────────

/** The journal of a rename-identity run in progress (or cut short), in the CLI home. */
export const RENAME_JOURNAL = 'rename-identity.journal'

/**
 * One line of the journal. Every step that changes something writes its line BEFORE it acts, so
 * a run killed at any point leaves enough to undo it. `undone` lines record undo progress.
 */
type JournalEntry =
  | { op: 'begin'; root: string; supervisor: LocalSupervisor; from: string; to: string; port: number; home: string }
  | { op: 'stopped' }
  | { op: 'home-move'; home: string }
  | { op: 'home-rebase'; from: string; to: string }
  | { op: 'env'; edits: EnvEdit[]; backup?: string; noFinalNewline?: true }
  | { op: 'postgres'; runId: string; preRelabelLabel: string }
  | { op: 'postgres-done' }
  | { op: 'postgres-rolled-back' }
  | { op: 'ecosystem'; backup: string | null }
  | { op: 'registry'; from: string; to: string }
  | { op: 'new-identity' }
  | { op: 'healthy' }
  | { op: 'postgres-finalized'; policy: string }
  | { op: 'undo' }
  | { op: 'undone'; index: number }

type Begin = Extract<JournalEntry, { op: 'begin' }>

function appendJournal(path: string, entry: JournalEntry): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // A last line without its newline: a whole entry (the reader counts it) gets its newline; a
  // torn one (a crash mid-append, which the reader skips) is cut off, so it never ends up mid-file.
  let lead = ''
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8')
    if (text.length > 0 && !text.endsWith('\n')) {
      const start = text.lastIndexOf('\n') + 1
      if (parsesAsJson(text.slice(start))) lead = '\n'
      else truncateSync(path, Buffer.byteLength(text.slice(0, start)))
    }
  }
  const fd = openSync(path, 'a', 0o600)
  try {
    writeSync(fd, lead + JSON.stringify(entry) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** The journal's entries, or undefined when there is none. A torn last line (a crash) is ignored. */
function readJournal(path: string): JournalEntry[] | undefined {
  if (!existsSync(path)) return undefined
  const entries: JournalEntry[] = []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  lines.forEach((line, i) => {
    try {
      entries.push(JSON.parse(line) as JournalEntry)
    } catch (error) {
      if (i !== lines.length - 1) throw new Error(`the rename-identity journal ${path} is damaged (line ${i + 1})`)
      void error
    }
  })
  if (entries[0]?.op !== 'begin') throw new Error(`the rename-identity journal ${path} is damaged (no begin line)`)
  return entries
}

/** The run a journal left behind (root, labels), or undefined when there is no journal. */
export function readRenameJournal(path: string): { root: string; from: string; to: string } | undefined {
  const begin = readJournal(path)?.[0] as Begin | undefined
  return begin ? { root: begin.root, from: begin.from, to: begin.to } : undefined
}

/** Where a completed run's journal is kept for `--undo`, beside the active journal. */
function completedJournal(activePath: string, label: string): string {
  return join(dirname(activePath), `rename-identity.${label}.journal`)
}

// ─── The rename ─────────────────────────────────────────────────────────────

/** T20's local Postgres move; injectable for tests. */
export interface PostgresOps {
  plan: typeof planLocalPostgresRename
  rename: typeof renameLocalPostgres
  undo: typeof undoLocalPostgresRename
  finalize: typeof finalizeLocalPostgresRename
  newRunId: () => string
}

const POSTGRES: PostgresOps = {
  plan: planLocalPostgresRename,
  rename: renameLocalPostgres,
  undo: undoLocalPostgresRename,
  finalize: finalizeLocalPostgresRename,
  newRunId: newRenameRunId,
}

export interface RenameDeps {
  runner: Runner
  statePath: string
  /** `<cliHome>/rename-identity.journal`, resolved on every call: the CLI home moves mid-run. */
  journalPath(): string
  /** The user's home (`~`). */
  home: string
  supervisorContext(id: SupervisorIdentity, root: string): SupervisorContext
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): Date
  log(line: string): void
  postgres?: Partial<PostgresOps>
  /**
   * This process's environment. A CLI run from inside a checkout auto-loaded that checkout's `.env`
   * at launch, so it may hold values the run has since rewritten: every child that reads `.env`
   * values gets them from the file on disk instead (see `childEnv`).
   */
  env?: Record<string, string | undefined>
}

/** Keys a `.env` owns: a child must never inherit them from this process instead of the file. */
const ENV_OWNED_KEY = /^(DATABASE_URL|HOME_DIR|FICUS_[A-Z0-9_]*)$/

/**
 * The environment for a child that must see `<root>/.env` as it is on disk NOW: every key of the
 * file with its current value, and every key this process holds that a `.env` owns
 * (`ENV_OWNED_KEY`) or that the checkout's `.env` held when this invocation began (what the CLI's
 * own dotenv autoload may have put there) but the file no longer has, removed (undefined).
 */
function childEnv(root: string, deps: RunDeps): Record<string, string | undefined> {
  const path = join(root, '.env')
  const file = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {}
  const env: Record<string, string | undefined> = {}
  const stale = new Set([
    ...Object.keys(deps.env ?? process.env).filter((k) => ENV_OWNED_KEY.test(k)),
    ...deps.startKeys,
  ])
  for (const key of stale) if (!(key in file)) env[key] = undefined
  return { ...env, ...file }
}

export interface RenameReport {
  root: string
  status: 'renamed' | 'already' | 'dry-run' | 'undone'
  from: { label: string; supervisor: LocalSupervisor; api: string; worker: string }
  to: { label: string; api: string; worker: string }
  /** The CLI home moved (or, undone, moved back). */
  homeMoved?: boolean
  postgres?: LocalPostgresPlan['action']
  /** A volume the Postgres undo kept, holding the writes made since the rename. */
  keptVolume?: string
  /** An interrupted run was finished (its health check had passed) rather than undone. */
  resumed?: boolean
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

const isRealDir = (stat: Stats | null) => stat !== null && !stat.isSymbolicLink() && stat.isDirectory()

/**
 * HOME_DIR is the legacy default home: `.env` names `~/<legacy>` itself, or names nothing while
 * `~/<legacy>` is still a real directory (Core's default then is that directory).
 */
function homeIsLegacyDefault(homeDir: string | undefined, home: string): boolean {
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  if (homeDir?.trim()) return resolve(expandTilde(homeDir.trim(), home)) === legacy
  return isRealDir(lstatOrNull(legacy))
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
}

interface Plan {
  root: string
  label: string
  toLabel: string
  supervisor: LocalSupervisor
  port: number
  oldId: SupervisorIdentity
  newId: SupervisorIdentity
  moveHome: boolean
  postgres: LocalPostgresPlan
  /** Step 7's change (pm2 only). */
  ecosystem?: EcosystemChange
}

/** RenameDeps plus what one invocation fixes at its start. */
type RunDeps = RenameDeps & {
  /** The keys of `<root>/.env` when this invocation began: what the CLI may have auto-loaded. */
  startKeys: ReadonlySet<string>
}

/** Everything a run and its undo share. */
function runContext(deps: RunDeps, root: string, begin: Omit<Begin, 'op'>) {
  const oldId = supervisorIdentity(begin.supervisor, begin.from, 1)
  const newId = supervisorIdentity(begin.supervisor, begin.to, CURRENT_IDENTITY)
  const supervisors: SupervisorDeps = {
    root,
    context: deps.supervisorContext,
    startEnv: (dir) => childEnv(dir, deps),
  }
  const pg: PostgresOps = { ...POSTGRES, ...deps.postgres }
  const docker = { runner: deps.runner, sleep: deps.sleep }
  return { oldId, newId, supervisors, pg, docker, envPath: join(root, '.env') }
}

async function rebaseHome(
  root: string,
  from: string,
  to: string,
  deps: RunDeps,
  opts: { dryRun?: boolean } = {}
): Promise<string[]> {
  // The rebase program reads DATABASE_URL from its environment only: hand it the checkout's .env.
  const result = await deps.runner(
    [
      'bun',
      join(root, 'apps/core/dist/rebase-home.js'),
      '--from',
      from,
      '--to',
      to,
      ...(opts.dryRun ? ['--dry-run'] : []),
    ],
    { cwd: join(root, 'apps/core'), env: childEnv(root, deps) }
  )
  const lines = result.stdout.split('\n').filter(Boolean)
  if (!opts.dryRun) for (const line of lines) deps.log(`    ${line}`)
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n').at(-1)
    throw new Error(`rebase-home --from ${from} --to ${to} exited with ${result.code}${reason ? `: ${reason}` : ''}`)
  }
  return lines
}

/** How long `/ready` gets after a start: a cold boot waits for the database and runs migrations. */
const READY_ATTEMPTS = 61
const READY_INTERVAL_MS = 2000
const READY_REQUEST_TIMEOUT_MS = 5000

/**
 * Waits for `GET /ready` to answer 200. Unlike `/health` (served before boot finishes), `/ready`
 * turns 200 only once the database is reachable, the migrations have run and init is done, and a
 * failed init ends the process — so a wrong DATABASE_URL, a missing database or a failed
 * migration fails this check. Core serves `/ready` publicly on the local port (no auth), so only
 * 200 counts.
 */
async function waitReady(port: number, deps: RenameDeps): Promise<void> {
  const url = `http://localhost:${port}/ready`
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    try {
      // Each request is bounded too: an API that accepts but never answers must not hold one
      // attempt for the fetch default of minutes.
      if ((await deps.fetch(url, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) })).status === 200) return
    } catch {
      /* not up yet */
    }
    if (i === READY_ATTEMPTS - 1)
      throw new Error(
        `the API did not answer ${url} with 200 within ${((READY_ATTEMPTS - 1) * READY_INTERVAL_MS) / 1000}s (readiness check) — see \`ficus server logs\``
      )
    await deps.sleep(READY_INTERVAL_MS)
  }
}

function describePostgres(plan: LocalPostgresPlan): string {
  if (plan.action === 'external')
    return "Postgres: external (DATABASE_URL is not the installer's container) — nothing to move"
  if (plan.action === 'already') return `Postgres: already moved (${plan.container})`
  const database = plan.database ? `database ${plan.database.from} → ${plan.database.to}` : 'database name kept'
  return `Postgres: ${plan.from.container} → ${plan.to.container} (volume ${plan.from.volume} → ${plan.to.volume}, ${database}, port ${plan.port})`
}

/** The new file-log targets: under the CLI home the move leaves (`~/.ficus/logs`), or the current one. */
function newLogPath(plan: Plan, deps: RenameDeps, component: 'api' | 'worker'): string {
  if (plan.moveHome) return join(deps.home, FICUS_HOME_DIR_NAME, 'logs', `${plan.newId[component]}.log`)
  return nativeLogPath(deps.supervisorContext(plan.newId, plan.root), component)
}

/** Step 6's values: the label and the process names the checkout's .env still spells the old way. */
function identityEnvValues(plan: Plan, env: Record<string, string>, deps: RenameDeps): Record<string, string> {
  const values: Record<string, string> = {}
  if (env.FICUS_INSTANCE?.trim() === plan.label && plan.toLabel !== plan.label) values.FICUS_INSTANCE = plan.toLabel
  if (env.FICUS_PM2_API_NAME === plan.oldId.api) values.FICUS_PM2_API_NAME = plan.newId.api
  if (env.FICUS_PM2_WORKER_NAME === plan.oldId.worker) values.FICUS_PM2_WORKER_NAME = plan.newId.worker
  for (const component of ['api', 'worker'] as const) {
    const key = component === 'api' ? 'FICUS_LOG_FILE_API' : 'FICUS_LOG_FILE_WORKER'
    const value = env[key]?.trim()
    if (value && basename(value) === `${plan.oldId[component]}.log`) values[key] = newLogPath(plan, deps, component)
  }
  return values
}

// ─── ecosystem.config.js ────────────────────────────────────────────────────

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The ecosystem file with the old identity's app names swapped for the new ones IN PLACE: every
 * string literal that is exactly an old app name — each app's `name:`, `FICUS_PM2_*_NAME`, any
 * other reference — becomes the new name; every other byte is kept (hand edits such as
 * `max_memory_restart` or pinned ports included). Throws, changing nothing, unless each old app
 * is declared (`name: '<old>'`) exactly once.
 */
export function renameEcosystemApps(
  text: string,
  from: { api: string; worker: string },
  to: { api: string; worker: string }
): string {
  for (const component of ['api', 'worker'] as const) {
    const declared = text.match(new RegExp(`\\bname:\\s*(['"\`])${escapeRegExp(from[component])}\\1`, 'g'))
    if (declared?.length !== 1)
      throw new Error(
        `ecosystem.config.js declares the app "${from[component]}" ${declared?.length ?? 0} times, not once — rename it there by hand, then run again`
      )
  }
  let out = text
  for (const component of ['api', 'worker'] as const) {
    const literal = new RegExp(`(['"\`])${escapeRegExp(from[component])}\\1`, 'g')
    out = out.replace(literal, (_match, quote: string) => `${quote}${to[component]}${quote}`)
  }
  return out
}

/** The lines that differ between two versions of a file with the same line count, as a small diff. */
function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: string[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    out.push(`@@ line ${i + 1}`, `- ${a[i] ?? ''}`, `+ ${b[i] ?? ''}`)
  }
  return out
}

/** Step 7's change: the file as it is and as it will be (`before` null: there is none yet). */
interface EcosystemChange {
  before: string | null
  after: string
}

function planEcosystem(root: string, plan: Pick<Plan, 'oldId' | 'newId' | 'toLabel'>): EcosystemChange {
  const path = join(root, 'ecosystem.config.js')
  if (existsSync(path)) {
    const before = readFileSync(path, 'utf8')
    return { before, after: renameEcosystemApps(before, plan.oldId, plan.newId) }
  }
  // Nothing to preserve: the file setup would write.
  const examplePath = join(root, 'ecosystem.config.example.js')
  if (!existsSync(examplePath))
    throw new Error(`${root} has neither ecosystem.config.js nor ecosystem.config.example.js — pm2 cannot start it`)
  const example = readFileSync(examplePath, 'utf8')
  return { before: null, after: generateEcosystem(example, instanceNames(plan.toLabel)) }
}

// ─── Plan output ────────────────────────────────────────────────────────────

function stepLines(plan: Plan, deps: RenameDeps, env: Record<string, string>): Array<[string, string[]]> {
  const { oldId, newId, root } = plan
  const oldCtx = deps.supervisorContext(oldId, root)
  const legacyHome = join(deps.home, LEGACY_HOME_DIR_NAME)
  const ficusHome = join(deps.home, FICUS_HOME_DIR_NAME)
  const stop =
    oldId.supervisor === 'launchd'
      ? (['api', 'worker'] as const).flatMap((c) => [
          `launchctl bootout gui/${oldCtx.uid}/${launchdNames(oldCtx, c).label}`,
          `launchctl disable gui/${oldCtx.uid}/${launchdNames(oldCtx, c).label}`,
        ])
      : oldId.supervisor === 'systemd-user'
        ? (['api', 'worker'] as const).map((c) => `systemctl --user disable --now ${systemdUserNames(oldCtx, c).unit}`)
        : [`pm2 delete ${oldId.api} ${oldId.worker}`, 'pm2 save --force']
  const newCtx = deps.supervisorContext(newId, root)
  const start =
    newId.supervisor === 'launchd'
      ? [
          ...(['worker', 'api'] as const).map(
            (c) => `launchctl bootstrap gui/${newCtx.uid} ${launchdNames(newCtx, c).plist}`
          ),
          ...(['worker', 'api'] as const).map((c) => `remove ${launchdNames(oldCtx, c).plist}`),
        ]
      : newId.supervisor === 'systemd-user'
        ? [
            ...(['worker', 'api'] as const).map(
              (c) => `systemctl --user enable --now ${systemdUserNames(newCtx, c).unit}`
            ),
            ...(['worker', 'api'] as const).map((c) => `remove ${systemdUserNames(oldCtx, c).path}`),
          ]
        : [
            `pm2 start ecosystem.config.js --only ${newId.api},${newId.worker} (environment from ${join(root, '.env')} as rewritten)`,
            'pm2 save',
          ]
  const homeDir = plan.moveHome ? `~/${FICUS_HOME_DIR_NAME}` : env.HOME_DIR?.trim() || `~/${FICUS_HOME_DIR_NAME}`
  const identity = identityEnvValues(plan, env, deps)
  const ecosystem = plan.ecosystem
  return [
    [`Registry entry "${plan.label}" (${plan.supervisor}, port ${plan.port}) at ${root}`, []],
    [`Stop "${plan.label}" under ${plan.supervisor} (${oldId.api}, ${oldId.worker})`, stop],
    [
      'CLI home',
      plan.moveHome
        ? [
            `move ${legacyHome} → ${ficusHome}, leaving the link ${legacyHome} -> ${FICUS_HOME_DIR_NAME}`,
            `bun ${join(root, 'apps/core/dist/rebase-home.js')} --from ${legacyHome} --to ${ficusHome}`,
          ]
        : [`HOME_DIR is ${env.HOME_DIR?.trim() || ficusHome} — nothing to move`],
    ],
    [
      '.env: explicit HOME_DIR',
      [`HOME_DIR=${homeDir}`, `backup: ${join(root, `.env.pre-ficus-rename-${utcStamp(deps.now())}`)}`],
    ],
    ['Postgres', [describePostgres(plan.postgres)]],
    [
      '.env: instance and process names',
      Object.keys(identity).length > 0
        ? Object.entries(identity).map(([k, v]) => `${k}=${v}`)
        : ['nothing names the old identity'],
    ],
    [
      'ecosystem.config.js',
      !ecosystem
        ? ['native supervisor — no ecosystem file']
        : ecosystem.before === null
          ? [`create it from ecosystem.config.example.js for ${newId.api} / ${newId.worker}`]
          : [
              'rename the apps in place — every other line is kept; the old file is kept beside the journal:',
              ...lineDiff(ecosystem.before, ecosystem.after),
            ],
    ],
    [
      'Registry',
      [
        plan.toLabel !== plan.label
          ? `relabel "${plan.label}" → "${plan.toLabel}" (default follows), identity 2`
          : `"${plan.label}": identity 2`,
      ],
    ],
    [`Start "${plan.toLabel}" under ${plan.supervisor} (${newId.api}, ${newId.worker})`, start],
    [
      'Readiness check',
      [
        `http://localhost:${plan.port}/ready answers 200 (database reached, migrations run) within ${((READY_ATTEMPTS - 1) * READY_INTERVAL_MS) / 1000}s`,
        ...(plan.postgres.action === 'rename' ? [`give ${plan.postgres.to.container} the old restart policy`] : []),
      ],
    ],
  ]
}

function printSteps(plan: Plan, deps: RenameDeps, env: Record<string, string>): void {
  const steps = stepLines(plan, deps, env)
  steps.forEach(([title, lines], i) => {
    deps.log(`▸ ${i + 1}/${steps.length} ${title}`)
    for (const line of lines) deps.log(`    ${line}`)
  })
}

function report(plan: Plan, status: RenameReport['status'], extra: Partial<RenameReport> = {}): RenameReport {
  return {
    root: plan.root,
    status,
    from: { label: plan.label, supervisor: plan.supervisor, api: plan.oldId.api, worker: plan.oldId.worker },
    to: { label: plan.toLabel, api: plan.newId.api, worker: plan.newId.worker },
    homeMoved: plan.moveHome,
    postgres: plan.postgres.action,
    ...extra,
  }
}

// ─── Lock ───────────────────────────────────────────────────────────────────

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** When process `pid` started (`ps -o lstart=`), or undefined when that cannot be told. */
function processStart(pid: number): string | undefined {
  try {
    const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
    const started = result.stdout.toString().trim()
    return result.exitCode === 0 && started ? started : undefined
  } catch {
    return undefined
  }
}

interface LockOwner {
  pid: number
  /** The owner's start time: a pid alive but started at another time was reused (a reboot). */
  started?: string
}

function readLockOwner(path: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as LockOwner
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : undefined
  } catch {
    return undefined
  }
}

/** The lock's owner is still running: its pid is alive and (when both are known) started when it says. */
function ownerRunning(owner: LockOwner): boolean {
  if (!processAlive(owner.pid)) return false
  const started = processStart(owner.pid)
  return owner.started === undefined || started === undefined || started === owner.started
}

/**
 * One rename-identity at a time: `<journal>.lock` holds the running invocation's pid and start
 * time. A lock whose process is gone, or whose pid now belongs to a process started at another
 * time (reused after a reboot), is taken over. It lives beside the journal, so it moves with the
 * CLI home.
 */
async function withLock<T>(deps: RenameDeps, fn: () => Promise<T>): Promise<T> {
  const path = `${deps.journalPath()}.lock`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const me: LockOwner = { pid: process.pid, started: processStart(process.pid) }
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(me), { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error
      const owner = readLockOwner(path)
      if (owner && ownerRunning(owner))
        throw new Error(
          `another \`ficus server rename-identity\` (pid ${owner.pid}${owner.started ? `, started ${owner.started}` : ''}) holds ${path} — wait for it to finish. If \`ps -o lstart=,command= -p ${owner.pid}\` shows no rename-identity started then, the lock is stale: delete ${path} and run again`
        )
      rmSync(path, { force: true })
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(`${deps.journalPath()}.lock`, { force: true })
  }
}

// ─── The rename ─────────────────────────────────────────────────────────────

function envKeys(root: string): Set<string> {
  const path = join(root, '.env')
  return new Set(Object.keys(existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {}))
}

/**
 * `ficus server rename-identity`: moves one registered local instance from its pre-rename names
 * to the ficus names — supervisor labels and process names, the CLI home (when the instance uses
 * the legacy default home), the installer-managed Postgres, `.env`, `ecosystem.config.js` and the
 * registry (`identity: 2`; the legacy default label becomes `ficus`). Every step is journaled in
 * `<cliHome>/rename-identity.journal` before it acts; a failure undoes the completed steps in
 * reverse and restarts the old identity, and a run cut short is resolved by the next invocation
 * before anything else. `undo` replays a completed run's journal in reverse. Every start reads the
 * checkout's `.env` as it is on disk at that moment (see `childEnv`).
 */
export async function renameIdentity(
  opts: { root: string; dryRun?: boolean; undo?: boolean },
  renameDeps: RenameDeps
): Promise<RenameReport> {
  const root = canonicalRoot(opts.root)
  const deps: RunDeps = { ...renameDeps, startKeys: envKeys(root) }
  const run = () => renameOrResolve(root, opts, deps)
  return opts.dryRun ? run() : withLock(deps, run)
}

async function renameOrResolve(
  root: string,
  opts: { dryRun?: boolean; undo?: boolean },
  deps: RunDeps
): Promise<RenameReport> {
  const active = readJournal(deps.journalPath())
  if (active) return resolveInterrupted(root, active, opts, deps)
  if (opts.undo) return undoCompleted(root, opts, deps)

  const registry = readRegistryStrict(deps.statePath)
  const found = Object.entries(registry.instances).find(([, record]) => canonicalRoot(record.root) === root)
  if (!found) throw new Error(`${root} is not a registered instance — see \`ficus server list\``)
  const [label, record] = found
  const toLabel = renamedLocalInstanceLabel(label)
  const envPath = join(root, '.env')
  const env = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {}
  const identity = recordIdentity(record)
  const base = {
    root,
    label,
    toLabel: identity === CURRENT_IDENTITY ? label : toLabel,
    supervisor: record.supervisor,
    port: record.port,
    oldId: supervisorIdentity(record.supervisor, label, identity),
    newId: supervisorIdentity(record.supervisor, identity === CURRENT_IDENTITY ? label : toLabel, CURRENT_IDENTITY),
  }
  if (identity === CURRENT_IDENTITY) {
    deps.log(`Instance "${label}" (${root}) already runs under the ficus names (identity 2) — nothing to do.`)
    return report({ ...base, moveHome: false, postgres: { action: 'already', container: '' } }, 'already', {
      homeMoved: false,
      postgres: undefined,
    })
  }
  if (toLabel !== label && registry.instances[toLabel]) {
    throw new Error(
      `instance "${toLabel}" is already registered (${registry.instances[toLabel].root}); "${label}" cannot take its label — unregister it first`
    )
  }

  // Refusals that need nothing changed first.
  const moveHome = homeIsLegacyDefault(env.HOME_DIR, deps.home)
  const legacyHome = join(deps.home, LEGACY_HOME_DIR_NAME)
  const ficusHome = join(deps.home, FICUS_HOME_DIR_NAME)
  const legacyHomeIsDir = isRealDir(lstatOrNull(legacyHome))
  if (moveHome) {
    if (legacyHomeIsDir && lstatOrNull(ficusHome))
      throw new Error(`${ficusHome} already exists beside ${legacyHome} — merge the two by hand, then run again`)
    const script = join(root, 'apps/core/dist/rebase-home.js')
    if (!existsSync(script))
      throw new Error(
        `${script} is missing — update this checkout (ficus server update --root ${root}), then run again`
      )
  }
  const ecosystem = record.supervisor === 'pm2' ? planEcosystem(root, base) : undefined
  const ctx = runContext(deps, root, {
    root,
    supervisor: record.supervisor,
    from: label,
    to: toLabel,
    port: record.port,
    home: deps.home,
  })
  const move = localPostgresMove({ preRelabelLabel: label })
  const postgres = await ctx.pg.plan(move, root, { runner: deps.runner })
  const plan: Plan = { ...base, moveHome, postgres, ecosystem }

  if (opts.dryRun) {
    deps.log(`Dry run — nothing will be changed. rename-identity would move "${label}" to "${toLabel}":`)
    printSteps(plan, deps, env)
    if (moveHome) await previewRebase(root, legacyHome, ficusHome, deps)
    return report(plan, 'dry-run')
  }

  deps.log(`Renaming "${label}" → "${toLabel}". Plan:`)
  printSteps(plan, deps, env)
  const journal = (entry: JournalEntry) => appendJournal(deps.journalPath(), entry)
  const step = (n: number, title: string) => deps.log(`  [${n}/10] ${title}`)
  journal({
    op: 'begin',
    root,
    supervisor: record.supervisor,
    from: label,
    to: toLabel,
    port: record.port,
    home: deps.home,
  })
  try {
    step(2, `stopping "${label}"`)
    journal({ op: 'stopped' })
    await stopSupervisor(ctx.oldId, ctx.supervisors)

    if (moveHome) {
      step(3, 'moving the CLI home')
      if (legacyHomeIsDir) {
        journal({ op: 'home-move', home: deps.home })
        const oldCtx = deps.supervisorContext(ctx.oldId, root)
        await moveCliHome({
          homedir: deps.home,
          running: async () =>
            (await statusSupervisor(oldCtx)).some((p) => p.status === 'online' || p.status === 'launching'),
        })
      }
      const entries = readJournal(deps.journalPath()) ?? []
      journal({ op: 'home-rebase', from: legacyHome, to: ficusHome })
      try {
        await rebaseHome(root, legacyHome, ficusHome, deps)
      } catch (error) {
        // One transaction: a failed run wrote nothing, so there is nothing to reverse.
        journal({ op: 'undone', index: entries.length })
        throw error
      }
    }

    step(4, '.env: HOME_DIR')
    if (existsSync(ctx.envPath)) {
      const backup = join(root, `.env.pre-ficus-rename-${utcStamp(deps.now())}`)
      copyFileSync(ctx.envPath, backup)
      const text = readFileSync(ctx.envPath, 'utf8')
      const homeDir = moveHome
        ? `~/${FICUS_HOME_DIR_NAME}`
        : env.HOME_DIR?.trim()
          ? undefined
          : `~/${FICUS_HOME_DIR_NAME}`
      const edits = homeDir ? planEnvEdits(text, { HOME_DIR: homeDir }) : []
      journal({
        op: 'env',
        edits,
        backup,
        ...(text.length > 0 && !text.endsWith('\n') ? { noFinalNewline: true } : {}),
      })
      if (edits.length > 0) writeFileAtomic(ctx.envPath, applyEnvEdits(text, edits))
    }

    if (postgres.action === 'rename') {
      step(5, 'moving the local Postgres')
      const runId = ctx.pg.newRunId()
      journal({ op: 'postgres', runId, preRelabelLabel: label })
      try {
        await ctx.pg.rename(move, root, ctx.docker, { runId })
      } catch (error) {
        // renameLocalPostgres puts everything back before it throws.
        journal({ op: 'postgres-rolled-back' })
        throw error
      }
      journal({ op: 'postgres-done' })
    }

    step(6, '.env: instance and process names')
    if (existsSync(ctx.envPath)) {
      const text = readFileSync(ctx.envPath, 'utf8')
      const edits = planEnvEdits(text, identityEnvValues(plan, parseEnvFile(text), deps))
      if (edits.length > 0) {
        journal({ op: 'env', edits, ...(text.length > 0 && !text.endsWith('\n') ? { noFinalNewline: true } : {}) })
        writeFileAtomic(ctx.envPath, applyEnvEdits(text, edits))
      }
    }

    if (ecosystem) {
      step(7, 'ecosystem.config.js')
      const path = join(root, 'ecosystem.config.js')
      const change = planEcosystem(root, base)
      let backup: string | null = null
      if (change.before !== null) {
        // Beside the journal, not in the checkout: a new file there would dirty the tree.
        backup = join(dirname(deps.journalPath()), `ecosystem.config.js.pre-ficus-rename-${utcStamp(deps.now())}`)
        copyFileSync(path, backup)
      }
      journal({ op: 'ecosystem', backup })
      writeFileAtomic(path, change.after)
    }

    step(8, 'registry')
    journal({ op: 'registry', from: label, to: toLabel })
    const current = readRegistryStrict(deps.statePath)
    const next = toLabel !== label ? relabelInstance(current, label, toLabel) : current
    next.instances[toLabel] = { ...next.instances[toLabel], identity: CURRENT_IDENTITY }
    writeRegistry(next, deps.statePath)

    step(9, `starting "${toLabel}"`)
    journal({ op: 'new-identity' })
    await installSupervisor(ctx.newId, root, ctx.supervisors)
    await removeSupervisorDefinitions(ctx.oldId, root, ctx.supervisors)

    step(10, 'readiness check')
    await waitReady(record.port, deps)
    journal({ op: 'healthy' })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const entries = readJournal(deps.journalPath()) ?? []
    deps.log(`  warning: rename-identity failed (${reason}); undoing the completed steps`)
    const undone = await undoEntries(root, entries, deps)
    if (undone.error) {
      throw new Error(
        `rename-identity failed (${reason}), and undoing it failed too (${undone.error}). The journal ${deps.journalPath()} is kept: run \`ficus server rename-identity --root ${root}\` to finish the undo`
      )
    }
    rmSync(deps.journalPath(), { force: true })
    throw new Error(
      `rename-identity failed: ${reason}. Every completed step was undone and "${label}" restarted under its old names${notReadyNote(undone.notReady)}${keptNote(undone.keptVolume)}`
    )
  }
  if (postgres.action === 'rename') {
    try {
      const policy = await ctx.pg.finalize(move, { runner: deps.runner })
      journal({ op: 'postgres-finalized', policy })
    } catch (error) {
      // The instance is renamed and ready; only the restart policy is missing. Keep the journal:
      // the next invocation finishes it (resolveInterrupted), no undo.
      throw new Error(
        `"${toLabel}" is renamed and ready, but giving ${postgres.to.container} the old restart policy failed (${error instanceof Error ? error.message : String(error)}). The journal is kept: run \`ficus server rename-identity --root ${root}\` again to finish`
      )
    }
  }
  complete(deps, toLabel)
  deps.log(
    `Renamed "${label}" → "${toLabel}": ${ctx.newId.api} / ${ctx.newId.worker} under ${record.supervisor}${moveHome ? `, CLI home ${ficusHome}` : ''}. Undo with: ficus server rename-identity --undo --root ${root}`
  )
  return report(plan, 'renamed')
}

/** The dry run's view of step 3: rebase-home's own read-only count, and whether it would refuse. */
async function previewRebase(root: string, from: string, to: string, deps: RunDeps): Promise<void> {
  try {
    const lines = await rebaseHome(root, from, to, deps, { dryRun: true })
    deps.log('rebase-home --dry-run (step 3):')
    for (const line of lines) deps.log(`    ${line}`)
    if (lines.some((line) => /^REBASE_HOME_TARGET \S+=[1-9]\d*$/.test(line)))
      deps.log(
        `  warning: the database already holds paths under ${to} (REBASE_HOME_TARGET above): step 3 would refuse and the run would be undone — inspect those rows first`
      )
  } catch (error) {
    deps.log(`  warning: could not preview step 3 (${error instanceof Error ? error.message : String(error)})`)
  }
}

function keptNote(volume: string | undefined): string {
  return volume
    ? `. The volume ${volume} is kept: it holds whatever the app wrote since the rename (the restored database is the snapshot from before it)`
    : ''
}

function notReadyNote(reason: string | undefined): string {
  return reason ? `, but it is not ready: ${reason}` : ''
}

/** A finished run: its journal moves aside for `--undo`, and `ficus server start` is free again. */
function complete(deps: RenameDeps, toLabel: string): void {
  renameSync(deps.journalPath(), completedJournal(deps.journalPath(), toLabel))
}

/**
 * Undoes a journal's entries in reverse, skipping those already undone, and records each as it
 * goes (so a failed undo resumes where it stopped). It first stops both identities the journal
 * may have running — the new one, and the old one (a reboot mid-run can have brought it back) —
 * so nothing is reversed under a live app. When it restarts the old identity it waits for
 * `/ready`; a failure there is reported as `notReady` (the undo itself is complete). Never throws:
 * the first failure is returned as `error`.
 */
async function undoEntries(
  root: string,
  entries: JournalEntry[],
  deps: RunDeps
): Promise<{ keptVolume?: string; error?: string; notReady?: string }> {
  const begin = entries[0] as Begin
  const ctx = runContext(deps, root, begin)
  const done = new Set(entries.flatMap((e) => (e.op === 'undone' ? [e.index] : [])))
  const pending = (op: JournalEntry['op']) => entries.some((e, i) => e.op === op && !done.has(i))
  // The Postgres undo keeps the new volume once the new identity may have written to it.
  const appStarted = entries.some((e) => e.op === 'new-identity')
  const rolledBack = entries.some((e) => e.op === 'postgres-rolled-back')
  let keptVolume: string | undefined
  try {
    if (pending('new-identity')) await stopSupervisor(ctx.newId, ctx.supervisors)
    if (pending('stopped')) await stopSupervisor(ctx.oldId, ctx.supervisors)
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (done.has(index)) continue
      switch (entry.op) {
        case 'new-identity':
          await removeSupervisor(ctx.newId, root, ctx.supervisors)
          break
        case 'registry':
          undoRegistry(deps.statePath, root, entry.from, entry.to)
          break
        case 'ecosystem': {
          const ecosystem = join(root, 'ecosystem.config.js')
          if (entry.backup) writeFileAtomic(ecosystem, readFileSync(entry.backup, 'utf8'))
          else rmSync(ecosystem, { force: true })
          break
        }
        case 'env':
          if (existsSync(ctx.envPath) && entry.edits.length > 0) {
            const reverted = revertEnvEdits(readFileSync(ctx.envPath, 'utf8'), entry.edits, entry.noFinalNewline)
            writeFileAtomic(ctx.envPath, reverted.text)
            for (const key of reverted.kept) deps.log(`  warning: ${key} in .env changed since the rename — left as is`)
          }
          break
        case 'postgres':
          if (!rolledBack) {
            const move = localPostgresMove({ preRelabelLabel: entry.preRelabelLabel })
            const result = await ctx.pg.undo(move, root, ctx.docker, { appStarted, runId: entry.runId })
            keptVolume = result.keptVolume
          }
          break
        case 'home-rebase':
          await rebaseHome(root, entry.to, entry.from, deps)
          break
        case 'home-move':
          unmoveCliHome({ homedir: entry.home })
          break
        case 'stopped':
          await installSupervisor(ctx.oldId, root, ctx.supervisors)
          break
        default:
          continue
      }
      deps.log(`  undone: ${entry.op}`)
      appendJournal(deps.journalPath(), { op: 'undone', index })
    }
  } catch (error) {
    return { keptVolume, error: error instanceof Error ? error.message : String(error) }
  }
  if (keptVolume) deps.log(`  warning${keptNote(keptVolume)}`)
  let notReady: string | undefined
  if (entries.some((e, i) => e.op === 'stopped' && !done.has(i))) {
    try {
      await waitReady(begin.port, deps)
    } catch (error) {
      notReady = error instanceof Error ? error.message : String(error)
      deps.log(`  warning: "${begin.from}" was restarted but is not ready: ${notReady}`)
    }
  }
  return { keptVolume, notReady }
}

/** Step 8 in reverse: the entry goes back to its old label and loses `identity: 2`. */
function undoRegistry(statePath: string, root: string, from: string, to: string): void {
  const registry = readRegistryStrict(statePath)
  const entry = registry.instances[to]
  if (!entry || canonicalRoot(entry.root) !== root) return
  const next = from !== to ? relabelInstance(registry, to, from) : registry
  const { identity, ...record } = next.instances[from]
  void identity
  next.instances[from] = record
  writeRegistry(next, statePath)
}

/** The Postgres move a journal records, unless it rolled itself back. */
function journalledMove(entries: JournalEntry[]) {
  const entry = entries.find((e): e is Extract<JournalEntry, { op: 'postgres' }> => e.op === 'postgres')
  if (!entry || entries.some((e) => e.op === 'postgres-rolled-back')) return undefined
  return localPostgresMove({ preRelabelLabel: entry.preRelabelLabel })
}

/** A journal left by a run that did not finish, found at the start of the next invocation. */
async function resolveInterrupted(
  root: string,
  entries: JournalEntry[],
  opts: { dryRun?: boolean; undo?: boolean },
  deps: RunDeps
): Promise<RenameReport> {
  const begin = entries[0] as Begin
  if (canonicalRoot(begin.root) !== root) {
    throw new Error(
      `a rename-identity run for ${begin.root} did not finish — run \`ficus server rename-identity --root ${begin.root}\` first (it finishes or undoes that run)`
    )
  }
  const ctx = runContext(deps, root, begin)
  const plan: Plan = {
    root,
    label: begin.from,
    toLabel: begin.to,
    supervisor: begin.supervisor,
    port: begin.port,
    oldId: ctx.oldId,
    newId: ctx.newId,
    moveHome: entries.some((e) => e.op === 'home-move' || e.op === 'home-rebase'),
    postgres: { action: 'external' },
  }
  const moved = { postgres: postgresMoved(entries) }
  const undoRequested = opts.undo || entries.some((e) => e.op === 'undo')
  // Past the readiness check only the Postgres restart policy and the bookkeeping were left: finish.
  const finish = !undoRequested && entries.some((e) => e.op === 'healthy')
  if (opts.dryRun) {
    deps.log(
      `Dry run — a rename-identity run for ${root} did not finish; this command would ${finish ? 'finish it' : 'undo it'} first. Journal: ${deps.journalPath()}`
    )
    return report(plan, 'dry-run', moved)
  }
  if (finish) {
    const move = journalledMove(entries)
    if (move) {
      if (!entries.some((e) => e.op === 'postgres-finalized')) {
        const policy = await ctx.pg.finalize(move, { runner: deps.runner })
        appendJournal(deps.journalPath(), { op: 'postgres-finalized', policy })
      }
      // A reboot since the check left the moved container stopped (it was `--restart no` until now).
      const started = await deps.runner(['docker', 'start', move.ficus.container])
      if (started.code !== 0) deps.log(`  warning: docker start ${move.ficus.container} failed (exit ${started.code})`)
    }
    complete(deps, begin.to)
    deps.log(`Finished the interrupted rename of "${begin.from}" → "${begin.to}" (its readiness check had passed).`)
    try {
      await waitReady(begin.port, deps)
    } catch (error) {
      throw new Error(
        `finished the interrupted rename of "${begin.from}" → "${begin.to}", but ${error instanceof Error ? error.message : String(error)} — run \`ficus server restart --root ${root}\``
      )
    }
    return report(plan, 'renamed', { ...moved, resumed: true })
  }
  deps.log(`A rename-identity run for ${root} did not finish; undoing it first (journal ${deps.journalPath()})`)
  const undone = await undoEntries(root, entries, deps)
  if (undone.error) {
    throw new Error(
      `undoing the interrupted rename-identity run failed (${undone.error}). The journal ${deps.journalPath()} is kept: fix the cause and run \`ficus server rename-identity --root ${root}\` again`
    )
  }
  rmSync(deps.journalPath(), { force: true })
  if (undoRequested && !undone.notReady) return report(plan, 'undone', { ...moved, keptVolume: undone.keptVolume })
  throw new Error(
    undoRequested
      ? `the undo finished: "${begin.from}" runs under its old names again${notReadyNote(undone.notReady)}${keptNote(undone.keptVolume)}`
      : `an interrupted rename-identity run for ${root} was found and undone: "${begin.from}" runs under its old names again${notReadyNote(undone.notReady)}${keptNote(undone.keptVolume)}. Nothing is renamed — run the command again to rename it`
  )
}

/** 'rename' when the journal moved the local Postgres (and the move was not rolled back). */
function postgresMoved(entries: JournalEntry[]): LocalPostgresPlan['action'] | undefined {
  return journalledMove(entries) ? 'rename' : undefined
}

/**
 * What `--undo` needs that it cannot create, checked read-only before anything changes: the old
 * Postgres container and its volume, the rebase program, the home the move left.
 */
async function assertUndoable(root: string, entries: JournalEntry[], deps: RunDeps): Promise<void> {
  const problems: string[] = []
  const move = journalledMove(entries)
  if (move) {
    const inspected = await deps.runner(['docker', 'inspect', '-f', '{{.Name}}', move.legacy.container])
    if (inspected.code !== 0) problems.push(`the old Postgres container ${move.legacy.container} is gone`)
    else {
      const volume = await containerVolumeName(deps.runner, move.legacy.container, move.legacy.volume)
      if ((await deps.runner(['docker', 'volume', 'inspect', volume])).code !== 0)
        problems.push(`the old Postgres volume ${volume} is gone`)
    }
  }
  const rebase = entries.find((e): e is Extract<JournalEntry, { op: 'home-rebase' }> => e.op === 'home-rebase')
  if (rebase && !existsSync(join(root, 'apps/core/dist/rebase-home.js')))
    problems.push(`${join(root, 'apps/core/dist/rebase-home.js')} is missing`)
  const homeMove = entries.find((e): e is Extract<JournalEntry, { op: 'home-move' }> => e.op === 'home-move')
  if (homeMove) {
    const legacy = join(homeMove.home, LEGACY_HOME_DIR_NAME)
    const link = lstatOrNull(legacy)
    const ficus = lstatOrNull(join(homeMove.home, FICUS_HOME_DIR_NAME))
    if (!(link?.isSymbolicLink() && readlinkSync(legacy) === FICUS_HOME_DIR_NAME && isRealDir(ficus)))
      problems.push(`${legacy} is no longer the link to ${FICUS_HOME_DIR_NAME} the move left`)
  }
  if (problems.length > 0) throw new Error(`--undo cannot run: ${problems.join('; ')}. Nothing was changed`)
}

/** `--undo` after a completed run: its kept journal, replayed in reverse. */
async function undoCompleted(root: string, opts: { dryRun?: boolean }, deps: RunDeps): Promise<RenameReport> {
  const registry = readRegistryStrict(deps.statePath)
  const found = Object.entries(registry.instances).find(([, record]) => canonicalRoot(record.root) === root)
  if (!found) throw new Error(`${root} is not a registered instance — see \`ficus server list\``)
  const [label, record] = found
  if (recordIdentity(record) !== CURRENT_IDENTITY)
    throw new Error(`instance "${label}" (${root}) has not been renamed — nothing to undo`)
  const kept = completedJournal(deps.journalPath(), label)
  const entries = readJournal(kept)
  const begin = entries?.[0] as Begin | undefined
  if (!entries || !begin || canonicalRoot(begin.root) !== root)
    throw new Error(`no completed rename-identity journal for "${label}" at ${kept} — undo it by hand`)
  const ctx = runContext(deps, root, begin)
  const plan: Plan = {
    root,
    label: begin.from,
    toLabel: begin.to,
    supervisor: begin.supervisor,
    port: begin.port,
    oldId: ctx.oldId,
    newId: ctx.newId,
    moveHome: entries.some((e) => e.op === 'home-move'),
    postgres: { action: 'external' },
  }
  const moved = { postgres: postgresMoved(entries) }
  const actions = entries
    .map((e) => e.op)
    .filter((op) =>
      ['new-identity', 'registry', 'ecosystem', 'env', 'postgres', 'home-rebase', 'home-move', 'stopped'].includes(op)
    )
    .reverse()
  await assertUndoable(root, entries, deps)
  if (opts.dryRun) {
    deps.log(`Dry run — --undo would put "${begin.to}" back to "${begin.from}", in this order: ${actions.join(', ')}`)
    return report(plan, 'dry-run', moved)
  }
  deps.log(`Undoing the rename of "${begin.from}" → "${begin.to}": ${actions.join(', ')}`)
  renameSync(kept, deps.journalPath())
  appendJournal(deps.journalPath(), { op: 'undo' })
  const undone = await undoEntries(root, [...entries, { op: 'undo' }], deps)
  if (undone.error) {
    throw new Error(
      `--undo failed (${undone.error}). The journal ${deps.journalPath()} is kept: fix the cause and run \`ficus server rename-identity --undo --root ${root}\` again`
    )
  }
  rmSync(deps.journalPath(), { force: true })
  if (undone.notReady)
    throw new Error(
      `the undo finished: "${begin.from}" runs under its old names again${notReadyNote(undone.notReady)}${keptNote(undone.keptVolume)}`
    )
  deps.log(`"${begin.from}" runs under its old names again${keptNote(undone.keptVolume)}.`)
  return report(plan, 'undone', { ...moved, keptVolume: undone.keptVolume })
}

/** Refuses to start an instance while a rename-identity run is unfinished (see `server start`). */
export function assertNoRenameInFlight(journalPath: string): void {
  const run = readRenameJournal(journalPath)
  if (!run) return
  throw new Error(
    `a \`ficus server rename-identity\` run for ${run.root} did not finish — run \`ficus server rename-identity --root ${run.root}\` to finish or undo it, then start again`
  )
}
