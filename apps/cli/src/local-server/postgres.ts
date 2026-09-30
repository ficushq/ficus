import { connect as netConnect } from 'net'
import type { Runner } from './runner'
import { SetupFailure } from './types'

/** The image the installer runs: postgres + ParadeDB's search/analytics extensions. */
export const POSTGRES_IMAGE = 'paradedb/paradedb:latest'

/** The database a new install creates (`--db-name` overrides it). */
export const DEFAULT_DB_NAME = 'ficus'
/** Where the image keeps its data: the mount point of the instance's volume. */
const DEFAULT_DATA_DIR = '/var/lib/postgresql'

/** PostgreSQL identifier we are willing to interpolate into SQL / a createdb argv. */
export const DB_NAME_RE = /^[a-z_][a-z0-9_]*$/
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
/** How far above the first candidate findFreePort() will scan before giving up. */
const PORT_SCAN_LIMIT = 50

export function parseDatabaseUrl(url: string): { host: string; port: number; database: string } {
  const u = new URL(url)
  return { host: u.hostname, port: u.port ? Number(u.port) : 5432, database: u.pathname.replace(/^\//, '') }
}

/**
 * True when the URL targets a PostgreSQL this installer manages: one on
 * loopback, i.e. a container of ours. Anything else is someone else's
 * database — the installer must never docker-run over it. An unparsable DSN
 * is not ours either.
 */
export function isManagedPostgresUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(parseDatabaseUrl(url).host)
  } catch {
    return false
  }
}

/**
 * True when the URL looks like one the installer WROTE: loopback with the
 * container's default credentials. It is how a stale DSN of ours is told from
 * a PostgreSQL the operator runs themselves, which happens to be on loopback
 * too — that one has its own credentials and must never be taken over.
 */
export function isManagedShapedUrl(url: string): boolean {
  if (!isManagedPostgresUrl(url)) return false
  try {
    const u = new URL(url)
    return u.username === 'postgres' && u.password === 'postgres'
  } catch {
    return false
  }
}

interface PortBinding {
  HostPort?: string
}
export interface ContainerMount {
  Type?: string
  Name?: string
  Destination?: string
}
/** The parts of `docker inspect -f '{{json .}}'` the installer reads. */
export interface ContainerInfo {
  /** The image ID the container runs (not the tag, which may have moved since). */
  Image?: string
  State?: { Running?: boolean }
  Mounts?: ContainerMount[]
  /** Live mappings — present only while the container RUNS ({} when stopped). */
  NetworkSettings?: { Ports?: Record<string, PortBinding[] | null> }
  /** The mapping it was created with — what `docker start` will restore. */
  HostConfig?: { PortBindings?: Record<string, PortBinding[] | null> }
}

/** `docker inspect` of a container, or undefined when there is none (or docker cannot say). */
export async function inspectContainer(runner: Runner, container: string): Promise<ContainerInfo | undefined> {
  const r = await runner(['docker', 'inspect', '-f', '{{json .}}', container])
  if (r.code !== 0) return undefined
  try {
    return JSON.parse(r.stdout) as ContainerInfo
  } catch {
    return undefined
  }
}

/** The host port a container publishes postgres on, live or as created (see `publishedPort`). */
export function containerHostPort(info: ContainerInfo | undefined): number | undefined {
  const bound =
    info?.NetworkSettings?.Ports?.['5432/tcp']?.[0]?.HostPort ??
    info?.HostConfig?.PortBindings?.['5432/tcp']?.[0]?.HostPort
  const port = Number(bound)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/** The named volume mounted at the postgres data dir (either layout the image has used). */
export function postgresDataMount(mounts: ContainerMount[] | undefined): ContainerMount | undefined {
  return mounts?.find(
    (m) =>
      m.Type === 'volume' && (m.Destination === '/var/lib/postgresql' || m.Destination === '/var/lib/postgresql/data')
  )
}

/**
 * The host port an existing container publishes (or would publish again on
 * `docker start`) for postgres, or undefined when there is no such container.
 * This is ground truth a re-run has to follow: a container's port mapping is
 * fixed at creation, so the installer agrees with it rather than picking a
 * port. One `{{json .}}` inspect covers both states — a stopped container has
 * an empty NetworkSettings.Ports and only HostConfig.PortBindings.
 */
export async function publishedPort(runner: Runner, container: string): Promise<number | undefined> {
  return containerHostPort(await inspectContainer(runner, container))
}

/**
 * The volume name the container actually mounts its postgres data dir from —
 * ground truth for uninstall instructions. Compose-derived names are the
 * lowercased/stripped checkout basename, which the derived instance name can
 * only guess at; the mount table cannot be wrong. Any failure (no container,
 * docker down, unparsable output) falls back to the derived name.
 */
export async function containerVolumeName(runner: Runner, container: string, fallback: string): Promise<string> {
  const r = await runner(['docker', 'inspect', '-f', '{{json .Mounts}}', container])
  if (r.code !== 0) return fallback
  try {
    return postgresDataMount(JSON.parse(r.stdout) as ContainerMount[])?.Name || fallback
  } catch {
    return fallback
  }
}

export interface PostgresContainer {
  /** Container name — the instance's, so two instances never share one. */
  container: string
  /** Named docker volume holding the data directory. */
  volume: string
  /** Host port published on loopback only. */
  port: number
  /** POSTGRES_DB: the database a first boot (an empty volume) creates. Default DEFAULT_DB_NAME. */
  database?: string
  /** Image to run. Default POSTGRES_IMAGE; the rename passes the old container's image ID. */
  image?: string
  /** Mount point of the volume. Default /var/lib/postgresql. */
  dataDir?: string
}

/**
 * The instance's PostgreSQL, addressed by container name rather than by
 * compose project: run it if it does not exist, start it if it is stopped
 * (a container docker compose created for this checkout counts — same name).
 */
export async function ensurePostgresContainer(
  runner: Runner,
  {
    container,
    volume,
    port,
    database = DEFAULT_DB_NAME,
    image = POSTGRES_IMAGE,
    dataDir = DEFAULT_DATA_DIR,
  }: PostgresContainer,
  // `inherit` is for the run/start calls only — docker's pull progress is worth
  // watching. Inheriting the inspect below would leave its stdout empty, and
  // this function branches on that.
  { inherit = false }: { inherit?: boolean } = {}
): Promise<'started' | 'created' | 'running'> {
  const inspect = await runner(['docker', 'inspect', '-f', '{{.State.Running}}', container])
  if (inspect.code === 0) {
    if (inspect.stdout.trim() === 'true') return 'running'
    const started = await runner(['docker', 'start', container], { inherit })
    if (started.code !== 0) throw new Error(`docker start ${container} failed:\n${started.stderr || started.stdout}`)
    return 'started'
  }
  // A non-zero inspect means there is no such container (any other docker
  // failure surfaces from the run below, with docker's own message).
  const created = await runner(
    [
      'docker',
      'run',
      '-d',
      '--name',
      container,
      '--restart',
      'unless-stopped',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-v',
      `${volume}:${dataDir}`,
      image,
    ],
    { inherit }
  )
  if (created.code !== 0) throw new Error(`docker run ${container} failed:\n${created.stderr || created.stdout}`)
  return 'created'
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * ParadeDB's first boot is initdb → start → install extensions → RESTART, so
 * postgres briefly accepts connections before the restart. Require 3 successes
 * in a row 2 s apart (the toolkit's rule) before declaring it stably ready.
 *
 * Probe over TCP (`-h 127.0.0.1`), never the unix socket: the entrypoint's
 * temporary init server listens on the socket only, for as long as the init
 * scripts take (~6 s for ParadeDB's extension load), so a socket probe collects
 * its three successes during init and the migration then lands on the restart
 * (`read ECONNRESET`). Migrations connect over TCP; so must the probe.
 */
export async function waitForPostgres(
  runner: Runner,
  container: string,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; intervalMs?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? 60
  const sleep = options.sleep ?? defaultSleep
  const interval = options.intervalMs ?? 2000
  let streak = 0
  for (let i = 0; i < attempts; i++) {
    const r = await runner([
      'docker',
      'exec',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-tAc',
      'SELECT 1',
    ])
    streak = r.code === 0 ? streak + 1 : 0
    if (streak >= 3) return
    await sleep(interval)
  }
  throw new Error(
    `postgres container ${container} did not become ready (${attempts} attempts) — see \`docker logs ${container}\``
  )
}

export async function ensureDatabase(runner: Runner, container: string, name: string): Promise<void> {
  if (!DB_NAME_RE.test(name)) throw new Error(`database name "${name}" is not a safe identifier`)
  const exists = await runner([
    'docker',
    'exec',
    container,
    'psql',
    '-U',
    'postgres',
    '-tAc',
    `SELECT 1 FROM pg_database WHERE datname='${name}'`,
  ])
  if (exists.code !== 0) throw new Error(`database existence check failed:\n${exists.stderr || exists.stdout}`)
  if (exists.stdout.trim() === '1') return
  const created = await runner(['docker', 'exec', container, 'createdb', '-U', 'postgres', name])
  if (created.code !== 0) throw new Error(`createdb ${name} failed:\n${created.stderr || created.stdout}`)
}

const CONNECT_TIMEOUT_MS = 2000

function tcpConnect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    const fail = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    // A port that neither accepts nor refuses (a firewall DROP) must not hang
    // the installer — and must not be mistaken for a free one either.
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(Object.assign(new Error(`timed out connecting to ${host}:${port}`), { code: 'ETIMEDOUT' }))
    )
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', fail)
  })
}

/**
 * The first loopback port from `from` upward that nothing answers on — where a
 * second instance's PostgreSQL can publish. A connect that SUCCEEDS means the
 * port is taken. Only ECONNREFUSED proves a port is free: any other failure
 * (timeout, permission, address problem) is inconclusive, and binding a port
 * on a guess would collide with whatever is really there, so it propagates.
 */
export async function findFreePort(
  from: number,
  connect: (host: string, port: number) => Promise<void> = tcpConnect
): Promise<number> {
  for (let port = from; port < from + PORT_SCAN_LIMIT; port++) {
    if (!(await isPortInUse(port, connect))) return port
  }
  throw new Error(`no free port for PostgreSQL between ${from} and ${from + PORT_SCAN_LIMIT - 1} — pass --db-port`)
}

/**
 * Whether something on loopback answers on `port`. Only ECONNREFUSED means
 * "nothing there"; every other failure is inconclusive and surfaces as a
 * SetupFailure naming the port and the socket's code, rather than being read
 * as an empty port.
 */
export async function isPortInUse(
  port: number,
  connect: (host: string, port: number) => Promise<void> = tcpConnect
): Promise<boolean> {
  try {
    await connect('127.0.0.1', port)
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'ECONNREFUSED') return false
    throw new SetupFailure(
      `cannot tell whether port ${port} is free (${code ?? 'unknown error'}): ${(err as Error)?.message ?? err}`
    )
  }
  return true
}

export async function waitForTcp(
  host: string,
  port: number,
  options: {
    attempts?: number
    sleep?: (ms: number) => Promise<void>
    connect?: (h: string, p: number) => Promise<void>
  } = {}
): Promise<void> {
  const attempts = options.attempts ?? 30
  const sleep = options.sleep ?? defaultSleep
  const connect = options.connect ?? tcpConnect
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      await connect(host, port)
      return
    } catch (err) {
      last = err
      await sleep(2000)
    }
  }
  throw new Error(`cannot reach postgres at ${host}:${port}: ${(last as Error)?.message ?? 'timeout'}`)
}
