import { randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'fs'
import { basename, dirname, join } from 'path'
import { LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'
import { parseEnvFile } from './env-file'
import {
  DB_NAME_RE,
  containerHostPort,
  ensurePostgresContainer,
  isManagedShapedUrl,
  parseDatabaseUrl,
  postgresDataMount,
  waitForPostgres,
  type ContainerInfo,
} from './postgres'
import type { Runner } from './runner'

/** The stem of every name after the rename (the legacy stem is `LEGACY_LOCAL_INSTANCE`). */
const FICUS_STEM = 'ficus'
/**
 * Label the rename puts on the container it creates; the value is the container it moved
 * from. It is how a later run tells its own container from one that merely has the name.
 */
export const RENAMED_FROM_LABEL = 'sh.ficus.renamed-from'
/**
 * Label the rename puts on the volume (and container) it creates; the value is the caller's
 * run id. Volume labels cannot change, so a volume some other run created can never carry
 * this run's id: `undoLocalPostgresRename` removes a volume only when it does.
 */
export const RENAME_RUN_LABEL = 'sh.ficus.rename-run'
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** A fresh run id for `renameLocalPostgres`; the caller journals it BEFORE the rename. */
export function newRenameRunId(): string {
  return randomUUID()
}

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) throw new Error(`rename run id "${runId}" must match ${RUN_ID_RE.source}`)
}
/** Seconds `docker stop` gives PostgreSQL to shut down cleanly before it is killed. */
const STOP_TIMEOUT_S = '60'

export interface LocalPostgresNames {
  /** Docker container of the installer-managed PostgreSQL. */
  container: string
  /** Named volume the installer would create for it (the rename reads the real one from the container). */
  volume: string
  /** The database a default install uses. */
  database: string
}

/**
 * An installer-managed PostgreSQL's names for one naming era (`stem`) and instance label:
 * `postgres-<stem>`, `<stem>_postgres-data` for the default instance (what docker compose named
 * them in a checkout called `<stem>`), `postgres-<stem>-<label>`, `<stem>-<label>_postgres-data`
 * for any other. The database is `<stem>` either way.
 */
export function localPostgresNames(stem: string, label: string, isDefault: boolean): LocalPostgresNames {
  const project = isDefault ? stem : `${stem}-${label}`
  return {
    container: isDefault ? `postgres-${stem}` : `postgres-${stem}-${label}`,
    volume: `${project}_postgres-data`,
    database: stem,
  }
}

/** What `renameLocalPostgres` moves: the legacy names and the ficus names of one instance. */
export interface LocalPostgresMove {
  legacy: LocalPostgresNames
  ficus: LocalPostgresNames
}

/**
 * Both identities of one local instance. `preRelabelLabel` is the instance's registry label
 * BEFORE any relabel: the legacy default label (`LEGACY_LOCAL_INSTANCE`) is the default
 * instance on both sides, any other label keeps its label. Passing a label that was already
 * relabelled is wrong: `'ficus'` is then read as a labelled instance (`postgres-<legacy>-ficus`),
 * so a caller skips the Postgres move for an instance whose rename is already recorded.
 */
export function localPostgresMove(instance: { preRelabelLabel: string }): LocalPostgresMove {
  const label = instance.preRelabelLabel
  const isDefault = label === LEGACY_LOCAL_INSTANCE
  return {
    legacy: localPostgresNames(LEGACY_LOCAL_INSTANCE, label, isDefault),
    ficus: localPostgresNames(FICUS_STEM, label, isDefault),
  }
}

export interface DockerDeps {
  runner: Runner
  /** Between readiness probes of the new container (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

// scheme://authority/path?query#fragment — the authority cannot contain `/`, `?` or `#`.
const URL_PATH_RE = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)\/([^?#]*)(.*)$/

/**
 * `url` with its path (the database) replaced; credentials, host, port and query are kept
 * byte for byte. Errors never quote the URL: it carries a password.
 */
export function withDatabaseName(url: string, database: string): string {
  const m = URL_PATH_RE.exec(url)
  if (!m) throw new Error('DATABASE_URL has no database path to rewrite')
  return `${m[1]}/${database}${m[3]}`
}

const ENV_LINE_RE = /^(\s*DATABASE_URL=)(["']?)(.*?)\2(\s*)$/

/** `.env` text with every DATABASE_URL line that names database `from` pointed at `to`. */
function rewriteEnvDatabase(text: string, from: string, to: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = ENV_LINE_RE.exec(line)
      if (!m || !isManagedShapedUrl(m[3]) || parseDatabaseUrl(m[3]).database !== from) return line
      return `${m[1]}${m[2]}${withDatabaseName(m[3], to)}${m[2]}${m[4]}`
    })
    .join('\n')
}

/**
 * Replaces a file in one rename: a sibling temp file with the same mode, flushed to disk before
 * the rename (and the directory after it, where the platform allows), so neither a crash nor a
 * power loss leaves it half written or empty.
 */
function writeFileAtomic(path: string, text: string): void {
  const target = realpathSync(path)
  const mode = statSync(target).mode & 0o7777
  const dir = dirname(target)
  const temp = join(dir, `.${basename(target)}.ficus-rename-${process.pid}.tmp`)
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
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  try {
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // Best effort: not every platform can fsync a directory; the file itself is already durable.
  }
}

/** Rewrites `.env` in place; false when no DATABASE_URL line named database `from`. */
function pointEnvAt(envPath: string, from: string, to: string): boolean {
  const before = readFileSync(envPath, 'utf8')
  const after = rewriteEnvDatabase(before, from, to)
  if (after === before) return false
  writeFileAtomic(envPath, after)
  return true
}

async function must(runner: Runner, command: string[]): Promise<void> {
  const r = await runner(command)
  if (r.code !== 0) throw new Error(`${command.slice(0, 3).join(' ')} failed:\n${r.stderr || r.stdout}`)
}

/** Runs `command`, treating docker's "no such <thing>" as done: removals that may have nothing left to remove. */
async function removeIfPresent(runner: Runner, command: string[]): Promise<void> {
  const r = await runner(command)
  if (r.code !== 0 && !/no such (container|volume)/i.test(r.stderr)) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed:\n${r.stderr || r.stdout}`)
  }
}

/** `docker inspect` of a container: undefined only when docker says there is no such container. */
async function inspectOrAbsent(runner: Runner, container: string): Promise<ContainerInfo | undefined> {
  const r = await runner(['docker', 'inspect', '-f', '{{json .}}', container])
  if (r.code !== 0) {
    if (/no such (object|container)/i.test(r.stderr)) return undefined
    throw new Error(`docker inspect ${container} failed:\n${r.stderr || r.stdout}`)
  }
  try {
    return JSON.parse(r.stdout) as ContainerInfo
  } catch {
    throw new Error(`docker inspect ${container} printed something that is not JSON`)
  }
}

interface VolumeInfo {
  Labels?: Record<string, string> | null
}

/** `docker volume inspect`: undefined only when docker says there is no such volume. */
async function inspectVolume(runner: Runner, volume: string): Promise<VolumeInfo | undefined> {
  const r = await runner(['docker', 'volume', 'inspect', volume])
  if (r.code !== 0) {
    if (/no such volume/i.test(r.stderr)) return undefined
    throw new Error(`docker volume inspect ${volume} failed:\n${r.stderr || r.stdout}`)
  }
  try {
    const [info] = JSON.parse(r.stdout) as VolumeInfo[]
    return info ?? {}
  } catch {
    throw new Error(`docker volume inspect ${volume} printed something that is not JSON`)
  }
}

async function volumeExists(runner: Runner, volume: string): Promise<boolean> {
  return (await inspectVolume(runner, volume)) !== undefined
}

function assertSafeNames({ legacy, ficus }: LocalPostgresMove): void {
  for (const name of [legacy.database, ficus.database]) {
    if (!DB_NAME_RE.test(name)) throw new Error(`database name "${name}" is not a safe identifier`)
  }
}

/** The DATABASE_URL in `.env` when it is one the installer wrote (loopback, container credentials). */
function managedDatabaseUrl(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined
  const url = parseEnvFile(readFileSync(envPath, 'utf8')).DATABASE_URL
  return url && isManagedShapedUrl(url) ? url : undefined
}

function stateOf(info: ContainerInfo | undefined): string {
  if (!info) return 'missing'
  return info.State?.Running ? 'running' : 'stopped'
}

/** What `renameLocalPostgres` would do, found without changing anything. */
export type LocalPostgresPlan =
  | { action: 'external' }
  | { action: 'already'; container: string }
  | {
      action: 'rename'
      from: { container: string; volume: string; running: boolean }
      to: { container: string; volume: string }
      /** Host port, the same on both sides. */
      port: number
      /** The old container's image ID, which the copy and the new container run. */
      image: string
      /** Where the image keeps its data: the mount point on both sides. */
      dataDir: string
      /** The database rename, or undefined for a name the operator chose (kept). */
      database: { from: string; to: string } | undefined
    }

/**
 * The read-only half of `renameLocalPostgres`: reads `<root>/.env` and inspects docker, and
 * returns the plan (what a dry run prints), or throws the refusal the rename would throw.
 */
export async function planLocalPostgresRename(
  move: LocalPostgresMove,
  root: string,
  deps: Pick<DockerDeps, 'runner'>
): Promise<LocalPostgresPlan> {
  assertSafeNames(move)
  const { legacy, ficus } = move
  const { runner } = deps
  const envPath = join(root, '.env')
  const url = managedDatabaseUrl(envPath)
  if (!url) return { action: 'external' }
  const database = parseDatabaseUrl(url).database
  if (!DB_NAME_RE.test(database)) {
    // e.g. an inline `# comment` after the URL, which the URL parser folds into the path.
    throw new Error(
      `DATABASE_URL in ${envPath} does not end in a plain database name (an inline comment on that line?) — fix the line and run again`
    )
  }
  const renameDb = database === legacy.database
  const legacyInfo = await inspectOrAbsent(runner, legacy.container)
  const ficusInfo = await inspectOrAbsent(runner, ficus.container)
  const legacyMount = postgresDataMount(legacyInfo?.Mounts)

  if (ficusInfo) {
    const ours = ficusInfo.Config?.Labels?.[RENAMED_FROM_LABEL] === legacy.container
    if (ours && !renameDb) return { action: 'already', container: ficus.container }
    if (!ours && !legacyInfo) return { action: 'already', container: ficus.container }
    const found = `found: ${ficus.container} (${stateOf(ficusInfo)}), ${legacy.container} (${stateOf(legacyInfo)})`
    const legacyStopped = legacyInfo && !legacyInfo.State?.Running
    const downNote = legacyStopped ? ` While ${legacy.container} is stopped the app cannot reach its database.` : ''
    if (!ours) {
      throw new Error(
        `a container named ${ficus.container} exists that no rename created (it has no ${RENAMED_FROM_LABEL} label); ${found}. ` +
          `This instance's data is still in ${legacy.container}.${downNote} ` +
          `If ${ficus.container} is not something you need, remove it and run again; this command will not touch it.`
      )
    }
    const intact = legacyInfo && legacyMount?.Name && legacyMount.Name !== ficus.volume
    const back = intact
      ? ` ${legacy.container} and its volume ${legacyMount?.Name} are intact. These commands go back to them: they ` +
        `remove ${ficus.container} and ${ficus.volume} — the copy this rename made, plus anything written to ` +
        `${ficus.container} since (check first if anything may have run against it) — and do not touch ` +
        `${legacy.container} or ${legacyMount?.Name}:\n` +
        `  docker rm -f ${ficus.container}\n  docker volume rm ${ficus.volume}\n  docker start ${legacy.container}\n` +
        `then run again.`
      : ` ${legacy.container} is ${legacyInfo ? 'not on a named volume' : 'gone'}, so ${ficus.container} and ${ficus.volume} ` +
        `may hold the only copy of the data: do not remove them — move this instance by hand.`
    throw new Error(
      `an earlier rename from ${legacy.container} to ${ficus.container} did not finish; ${found}; ` +
        `DATABASE_URL in ${envPath} still names database "${legacy.database}".${downNote}${back}`
    )
  }

  if (!legacyInfo) throw new Error(`no container ${legacy.container} to move to ${ficus.container}`)
  const port = containerHostPort(legacyInfo)
  if (port === undefined) throw new Error(`container ${legacy.container} publishes no port for postgres`)
  if (!legacyMount?.Name || !legacyMount.Destination) {
    throw new Error(`container ${legacy.container} keeps its data outside a named docker volume — move it by hand`)
  }
  if (legacyMount.Name === ficus.volume) {
    throw new Error(
      `${legacy.container} already keeps its data in volume ${ficus.volume}, the name the rename would copy into. ` +
        `That volume holds this instance's only data — do not remove it. Move this instance by hand.`
    )
  }
  // The image ID, not its tag: the tag may point at a newer postgres since, one that cannot open this data dir.
  const image = legacyInfo.Image
  if (!image) throw new Error(`cannot tell which image container ${legacy.container} runs`)
  if (await volumeExists(runner, ficus.volume)) {
    const start = legacyInfo.State?.Running
      ? ''
      : ` (docker start ${legacy.container} brings the database back meanwhile)`
    throw new Error(
      `volume ${ficus.volume} already exists but container ${ficus.container} does not. It may be left by an interrupted ` +
        `rename, be the copy an undone rename kept (holding writes made after that rename), or belong to something else. ` +
        `${legacy.container} (${stateOf(legacyInfo)}) and its volume ${legacyMount.Name} still hold this instance's data${start}. ` +
        `Check what ${ficus.volume} holds; if it is nothing you need, docker volume rm ${ficus.volume} and run again.`
    )
  }
  return {
    action: 'rename',
    from: { container: legacy.container, volume: legacyMount.Name, running: legacyInfo.State?.Running === true },
    to: { container: ficus.container, volume: ficus.volume },
    port,
    image,
    dataDir: legacyMount.Destination,
    database: renameDb ? { from: legacy.database, to: ficus.database } : undefined,
  }
}

/**
 * Installer-managed Postgres only. Stops the legacy container, creates the new volume, copies
 * the data (`docker run --rm -v <old>:/from:ro -v <new>:/to <same image> sh -c 'cp -a /from/. /to/'`),
 * starts the new container (labelled `RENAMED_FROM_LABEL`) on the SAME host port, renames the
 * legacy default database to `ficus`, and rewrites DATABASE_URL's path in `<root>/.env`. A
 * database name the operator chose (`--db-name`) is kept. The old container is left STOPPED and
 * the old volume untouched (the rollback copy; P5-T26 prints their removal).
 *
 * The app must be stopped: ALTER DATABASE … RENAME fails while anything is connected to the
 * database. The new container has just been started from the copy, so nothing is.
 *
 * - 'external': DATABASE_URL is not one the installer wrote; no docker call is made.
 * - 'already': the new container is this rename's (by its label) and .env no longer names the
 *   legacy database, or a container of the new name exists and no legacy container does.
 * - Throws, touching nothing, on any refusal `planLocalPostgresRename` makes (each message says
 *   what it found and how to go back). A failure after the first change undoes this run's
 *   changes and throws, so a throw never leaves a half-made rename behind and needs no undo.
 *
 * The new container is created with `--restart no`, so an interrupted move never brings it up
 * by itself (at login, or when docker restarts) for the old identity to write into; the caller
 * calls `finalizeLocalPostgresRename` once the app is healthy on it.
 *
 * `runId` (see `newRenameRunId`) labels the new volume and container (`RENAME_RUN_LABEL`).
 * Required call order for a caller that journals (T19): `planLocalPostgresRename` and require
 * `action === 'rename'` → journal "Postgres move started" WITH the run id → this function →
 * journal "done" on 'renamed'. The run id is what lets `undoLocalPostgresRename` tell the volume
 * this run created from one that was already there.
 */
export async function renameLocalPostgres(
  move: LocalPostgresMove,
  root: string,
  deps: DockerDeps,
  opts: { runId: string }
): Promise<'renamed' | 'external' | 'already'> {
  assertRunId(opts.runId)
  const plan = await planLocalPostgresRename(move, root, deps)
  if (plan.action !== 'rename') return plan.action
  const { runner } = deps
  const { from, to } = plan
  const undo: (() => Promise<void>)[] = []
  try {
    await must(runner, ['docker', 'stop', '-t', STOP_TIMEOUT_S, from.container])
    if (from.running) undo.push(() => must(runner, ['docker', 'start', from.container]))
    await must(runner, ['docker', 'volume', 'create', '--label', `${RENAME_RUN_LABEL}=${opts.runId}`, to.volume])
    // Only ever this run's own volume: the plan refused one that already existed.
    undo.push(() => removeIfPresent(runner, ['docker', 'volume', 'rm', to.volume]))
    await must(runner, [
      'docker',
      'run',
      '--rm',
      '-v',
      `${from.volume}:/from:ro`,
      '-v',
      `${to.volume}:/to`,
      plan.image,
      'sh',
      '-c',
      'cp -a /from/. /to/',
    ])
    // Registered before the run: a run that fails to start can still leave a created container.
    undo.push(() => removeIfPresent(runner, ['docker', 'rm', '-f', to.container]))
    await ensurePostgresContainer(runner, {
      container: to.container,
      volume: to.volume,
      port: plan.port,
      database: move.ficus.database,
      image: plan.image,
      dataDir: plan.dataDir,
      labels: { [RENAMED_FROM_LABEL]: from.container, [RENAME_RUN_LABEL]: opts.runId },
      // No auto-start until the caller has seen the app healthy on it: see finalizeLocalPostgresRename.
      restart: 'no',
    })
    await waitForPostgres(runner, to.container, { sleep: deps.sleep })
    if (plan.database) {
      await must(runner, [
        'docker',
        'exec',
        to.container,
        'psql',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `ALTER DATABASE "${plan.database.from}" RENAME TO "${plan.database.to}"`,
      ])
      const envPath = join(root, '.env')
      if (!pointEnvAt(envPath, plan.database.from, plan.database.to)) {
        // The database is renamed but the app would still ask for the old name: undo the whole move.
        throw new Error(
          `no DATABASE_URL line in ${envPath} names database "${plan.database.from}" any more (was .env edited during the move?)`
        )
      }
    }
  } catch (error) {
    const failures: string[] = []
    for (const step of undo.reverse()) {
      try {
        await step()
      } catch (undoError) {
        failures.push((undoError as Error).message)
      }
    }
    const message = (error as Error).message
    throw new Error(
      failures.length === 0
        ? `moving ${from.container} to ${to.container} failed, and was undone: ${message}`
        : `moving ${from.container} to ${to.container} failed (${message}), and undoing it failed too: ${failures.join('; ')}`,
      { cause: error }
    )
  }
  return 'renamed'
}

/**
 * The last step of a move, once the app has come up healthy on the new database (T19: after the
 * step-10 health check): gives the new container the old container's restart policy (unless-stopped
 * when docker reports none, or the old container is gone), so from now on it starts the way the old
 * one did. Until then it has `--restart no`.
 * Refuses a new-name container the rename did not create. Returns the policy applied.
 */
export async function finalizeLocalPostgresRename(
  move: LocalPostgresMove,
  deps: Pick<DockerDeps, 'runner'>
): Promise<string> {
  const { legacy, ficus } = move
  const { runner } = deps
  const ficusInfo = await inspectOrAbsent(runner, ficus.container)
  if (!ficusInfo) throw new Error(`no container ${ficus.container} to finalize`)
  if (ficusInfo.Config?.Labels?.[RENAMED_FROM_LABEL] !== legacy.container) {
    throw new Error(
      `container ${ficus.container} was not created by a rename from ${legacy.container} (no ${RENAMED_FROM_LABEL} label) — not changing it`
    )
  }
  const policy = (await inspectOrAbsent(runner, legacy.container))?.HostConfig?.RestartPolicy
  const name = policy?.Name || 'unless-stopped'
  const restart =
    name === 'on-failure' && (policy?.MaximumRetryCount ?? 0) > 0 ? `${name}:${policy?.MaximumRetryCount}` : name
  await must(runner, ['docker', 'update', '--restart', restart, ficus.container])
  return restart
}

/**
 * Reverses `renameLocalPostgres`, completed or cut short by a crash. Before changing anything it
 * checks that the old container and its volume are still there, and that a container with the
 * new name is the rename's own (`RENAMED_FROM_LABEL`); otherwise it throws, touching nothing.
 * Then it stops and removes the new container, starts the old one and confirms it runs, points
 * DATABASE_URL back at the legacy database, and only then deals with the new volume.
 *
 * `appStarted` says whether any process of the new identity may have run against the new
 * database. It must be true from the moment the caller starts installing or starting the new
 * identity (T19 step 9, `installSupervisor`, which starts the processes) — T19 journals "new
 * identity may be running" right before step 9 and derives `appStarted` from that entry:
 * - false (a failure in T19 steps 5–8, or a step 5 that a crash cut short): the new volume is
 *   removed — but ONLY when it carries `RENAME_RUN_LABEL=<runId>`, i.e. this run created it, so
 *   a retry copies afresh. A volume without that label (from an earlier run, kept by an undo
 *   with `appStarted: true`, or made by something else) is kept, and `keptBecause` says why.
 * - true (a failure from T19 step 9 on, or `--undo` after a completed run): the new volume holds
 *   everything the app wrote since the rename and is KEPT; the result names it, and the caller
 *   must report it — the restored database is the pre-rename snapshot.
 * A volume the old container itself mounts is never removed.
 *
 * DATABASE_URL goes back only when it names `ficus`. An install whose chosen `--db-name` was
 * literally `ficus` would be pointed at the legacy name; T19 restores `.env` from its step-4
 * backup, which covers that.
 */
export async function undoLocalPostgresRename(
  move: LocalPostgresMove,
  root: string,
  deps: DockerDeps,
  opts: { appStarted: boolean; runId: string }
): Promise<{ keptVolume: string | undefined; keptBecause?: string }> {
  assertSafeNames(move)
  assertRunId(opts.runId)
  const { legacy, ficus } = move
  const { runner } = deps
  const legacyInfo = await inspectOrAbsent(runner, legacy.container)
  const legacyVolume = postgresDataMount(legacyInfo?.Mounts)?.Name
  if (!legacyInfo || !legacyVolume || !(await volumeExists(runner, legacyVolume))) {
    throw new Error(
      `cannot undo the move to ${ficus.container}: ${legacy.container} or its data volume is gone, so ` +
        `${ficus.container} and ${ficus.volume} may hold the only copy of the data — left untouched`
    )
  }
  const ficusInfo = await inspectOrAbsent(runner, ficus.container)
  if (ficusInfo && ficusInfo.Config?.Labels?.[RENAMED_FROM_LABEL] !== legacy.container) {
    throw new Error(
      `cannot undo the move to ${ficus.container}: a container of that name exists (${stateOf(ficusInfo)}, ` +
        `data volume ${postgresDataMount(ficusInfo.Mounts)?.Name ?? 'none'}) but no rename from ${legacy.container} ` +
        `created it (no ${RENAMED_FROM_LABEL}=${legacy.container} label) — left untouched, ${legacy.container} (${stateOf(legacyInfo)}) too`
    )
  }
  if (ficusInfo) {
    await removeIfPresent(runner, ['docker', 'stop', '-t', STOP_TIMEOUT_S, ficus.container])
    await removeIfPresent(runner, ['docker', 'rm', '-f', ficus.container])
  }
  await must(runner, ['docker', 'start', legacy.container])
  if (!(await inspectOrAbsent(runner, legacy.container))?.State?.Running) {
    throw new Error(`${legacy.container} did not stay running after docker start; ${ficus.volume} is kept`)
  }
  const envPath = join(root, '.env')
  if (existsSync(envPath)) pointEnvAt(envPath, ficus.database, legacy.database)
  const volume = await inspectVolume(runner, ficus.volume)
  if (!volume) return { keptVolume: undefined }
  if (opts.appStarted) {
    return { keptVolume: ficus.volume, keptBecause: 'the app may have written to it since the rename' }
  }
  if (legacyVolume === ficus.volume) {
    return { keptVolume: ficus.volume, keptBecause: `${legacy.container} keeps its own data in it` }
  }
  const owner = volume.Labels?.[RENAME_RUN_LABEL]
  if (owner !== opts.runId) {
    return {
      keptVolume: ficus.volume,
      keptBecause: owner
        ? `it was created by another rename run (${owner}), not this one (${opts.runId})`
        : `it has no ${RENAME_RUN_LABEL} label, so this run did not create it`,
    }
  }
  await removeIfPresent(runner, ['docker', 'volume', 'rm', ficus.volume])
  return { keptVolume: undefined }
}
