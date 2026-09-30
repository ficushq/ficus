import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'
import { parseEnvFile } from './env-file'
import {
  DB_NAME_RE,
  containerHostPort,
  ensurePostgresContainer,
  inspectContainer,
  isManagedShapedUrl,
  parseDatabaseUrl,
  postgresDataMount,
  waitForPostgres,
} from './postgres'
import type { Runner } from './runner'

/** The stem of every name after the rename (the legacy stem is `LEGACY_LOCAL_INSTANCE`). */
const FICUS_STEM = 'ficus'

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
 * Both identities of one local instance, from its label BEFORE any relabel: the legacy default
 * label (`LEGACY_LOCAL_INSTANCE`) is the default instance on both sides; any other label keeps
 * its label.
 */
export function localPostgresMove(legacyLabel: string): LocalPostgresMove {
  const isDefault = legacyLabel === LEGACY_LOCAL_INSTANCE
  return {
    legacy: localPostgresNames(LEGACY_LOCAL_INSTANCE, legacyLabel, isDefault),
    ficus: localPostgresNames(FICUS_STEM, legacyLabel, isDefault),
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

function pointEnvAt(envPath: string, from: string, to: string): void {
  const before = readFileSync(envPath, 'utf8')
  const after = rewriteEnvDatabase(before, from, to)
  if (after !== before) writeFileSync(envPath, after)
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

function assertSafeNames({ legacy, ficus }: LocalPostgresMove): void {
  for (const name of [legacy.database, ficus.database]) {
    if (!DB_NAME_RE.test(name)) throw new Error(`database name "${name}" is not a safe identifier`)
  }
}

/** The DATABASE_URL in `<root>/.env` when it is one the installer wrote (loopback, container credentials). */
function managedDatabaseUrl(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined
  const url = parseEnvFile(readFileSync(envPath, 'utf8')).DATABASE_URL
  return url && isManagedShapedUrl(url) ? url : undefined
}

/**
 * Installer-managed Postgres only. Stops the legacy container, creates the new volume, copies
 * the data (`docker run --rm -v <old>:/from:ro -v <new>:/to <same image> sh -c 'cp -a /from/. /to/'`),
 * starts the new container on the SAME host port, renames the legacy default database to
 * `ficus`, and rewrites DATABASE_URL's path in `<root>/.env`. A database name the operator chose
 * (`--db-name`) is kept. The old container is left STOPPED and the old volume untouched (the
 * rollback copy; P5-T26 prints their removal).
 *
 * The app must be stopped: ALTER DATABASE … RENAME fails while anything is connected to the
 * database. The new container has just been started from the copy, so nothing is.
 *
 * - 'external': DATABASE_URL is not one the installer wrote; no docker call is made.
 * - 'already': the new container exists and .env no longer names the legacy database.
 * - Throws, touching nothing, when the new container exists but .env still names the legacy
 *   database (an interrupted run), when the new volume already exists, or when there is no
 *   legacy container to move. A failure after the first change undoes this run's changes and
 *   throws.
 */
export async function renameLocalPostgres(
  move: LocalPostgresMove,
  root: string,
  deps: DockerDeps
): Promise<'renamed' | 'external' | 'already'> {
  assertSafeNames(move)
  const { legacy, ficus } = move
  const { runner } = deps
  const envPath = join(root, '.env')
  const url = managedDatabaseUrl(envPath)
  if (!url) return 'external'
  const renameDb = parseDatabaseUrl(url).database === legacy.database

  if (await inspectContainer(runner, ficus.container)) {
    if (renameDb) {
      throw new Error(
        `container ${ficus.container} exists but DATABASE_URL in ${envPath} still names database "${legacy.database}" — ` +
          `an earlier rename was interrupted; undo it (or remove ${ficus.container}) and run again`
      )
    }
    return 'already'
  }
  const info = await inspectContainer(runner, legacy.container)
  if (!info) throw new Error(`no container ${legacy.container} to move to ${ficus.container}`)
  const port = containerHostPort(info)
  const mount = postgresDataMount(info.Mounts)
  if (port === undefined) throw new Error(`container ${legacy.container} publishes no port for postgres`)
  if (!mount?.Name || !mount.Destination) {
    throw new Error(`container ${legacy.container} keeps its data outside a named docker volume — move it by hand`)
  }
  // The image ID, not its tag: the tag may point at a newer postgres since, one that cannot open this data dir.
  const image = info.Image
  if (!image) throw new Error(`cannot tell which image container ${legacy.container} runs`)
  if ((await runner(['docker', 'volume', 'inspect', ficus.volume])).code === 0) {
    throw new Error(
      `volume ${ficus.volume} already exists and may hold data — inspect it, remove it (docker volume rm ${ficus.volume}) and run again`
    )
  }

  const undo: (() => Promise<void>)[] = []
  try {
    await must(runner, ['docker', 'stop', legacy.container])
    if (info.State?.Running) undo.push(() => must(runner, ['docker', 'start', legacy.container]))
    await must(runner, ['docker', 'volume', 'create', ficus.volume])
    undo.push(() => removeIfPresent(runner, ['docker', 'volume', 'rm', ficus.volume]))
    await must(runner, [
      'docker',
      'run',
      '--rm',
      '-v',
      `${mount.Name}:/from:ro`,
      '-v',
      `${ficus.volume}:/to`,
      image,
      'sh',
      '-c',
      'cp -a /from/. /to/',
    ])
    // Registered before the run: a run that fails to start can still leave a created container.
    undo.push(() => removeIfPresent(runner, ['docker', 'rm', '-f', ficus.container]))
    await ensurePostgresContainer(runner, {
      container: ficus.container,
      volume: ficus.volume,
      port,
      database: ficus.database,
      image,
      dataDir: mount.Destination,
    })
    await waitForPostgres(runner, ficus.container, { sleep: deps.sleep })
    if (renameDb) {
      await must(runner, [
        'docker',
        'exec',
        ficus.container,
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
        `ALTER DATABASE "${legacy.database}" RENAME TO "${ficus.database}"`,
      ])
      pointEnvAt(envPath, legacy.database, ficus.database)
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
        ? `moving ${legacy.container} to ${ficus.container} failed, and was undone: ${message}`
        : `moving ${legacy.container} to ${ficus.container} failed (${message}), and undoing it failed too: ${failures.join('; ')}`,
      { cause: error }
    )
  }
  return 'renamed'
}

/**
 * Reverses a completed `renameLocalPostgres`: removes the new container, starts the old one,
 * and points DATABASE_URL back at the legacy database. The new volume is kept unless
 * `removeVolume` (it holds whatever the app wrote after the rename); pass it when the new
 * database never served the app, so a later rename can copy afresh.
 */
export async function undoLocalPostgresRename(
  move: LocalPostgresMove,
  root: string,
  deps: DockerDeps,
  opts: { removeVolume?: boolean } = {}
): Promise<void> {
  assertSafeNames(move)
  const { legacy, ficus } = move
  const { runner } = deps
  await removeIfPresent(runner, ['docker', 'rm', '-f', ficus.container])
  if (opts.removeVolume) await removeIfPresent(runner, ['docker', 'volume', 'rm', ficus.volume])
  await must(runner, ['docker', 'start', legacy.container])
  const envPath = join(root, '.env')
  if (existsSync(envPath)) pointEnvAt(envPath, ficus.database, legacy.database)
}
