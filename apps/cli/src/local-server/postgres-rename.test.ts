import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'
import {
  finalizeLocalPostgresRename,
  RENAMED_FROM_LABEL,
  RENAME_RUN_LABEL,
  localPostgresMove,
  localPostgresNames,
  newRenameRunId,
  planLocalPostgresRename,
  renameLocalPostgres,
  undoLocalPostgresRename,
  withDatabaseName,
  type LocalPostgresMove,
} from './postgres-rename'
import type { Runner, RunResult } from './runner'

const L = LEGACY_LOCAL_INSTANCE
const IMAGE_ID = 'sha256:0123abcd'

interface FakeContainer {
  image: string
  port: number
  volume: string
  dataDir: string
  running: boolean
  labels?: Record<string, string>
  /** HostConfig.RestartPolicy; undefined reads as unless-stopped (what the installer creates). */
  restart?: { Name: string; MaximumRetryCount?: number }
}

/**
 * A docker that keeps state: containers (image, port, volume, labels, running) and volumes.
 * Enough of the CLI surface for the rename — inspect, stop/start, rm -f, volume
 * inspect/create/rm, run (--rm and -d, with host-port collisions) and exec (the readiness
 * probe, ALTER DATABASE). `fail` answers any command starting with a prefix with a failure.
 */
function fakeDocker(
  init: { containers: Record<string, FakeContainer>; volumes: string[] },
  fail: Record<string, Partial<RunResult>> = {}
) {
  const calls: string[][] = []
  const containers: Record<string, FakeContainer> = structuredClone(init.containers)
  const volumes = new Set(init.volumes)
  const volumeLabels = new Map<string, Record<string, string>>()
  const labelsOf = (args: string[]) =>
    Object.fromEntries(args.flatMap((a, i) => (a === '--label' ? [args[i + 1].split('=') as [string, string]] : [])))
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
  const no = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr })
  const runner: Runner = async (command) => {
    calls.push(command)
    const joined = command.join(' ')
    const failKey = Object.keys(fail).find((prefix) => joined.startsWith(prefix))
    if (failKey) return { code: 1, stdout: '', stderr: 'injected failure', ...fail[failKey] }
    const [, verb, ...rest] = command
    if (verb === 'inspect') {
      const name = rest.at(-1) as string
      const c = containers[name]
      if (!c) return no(`Error: No such object: ${name}`)
      if (rest[1] === '{{.State.Running}}') return ok(`${c.running}\n`)
      const binding = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: String(c.port) }] }
      return ok(
        JSON.stringify({
          Image: c.image,
          State: { Running: c.running },
          Config: { Labels: c.labels ?? null },
          Mounts: [{ Type: 'volume', Name: c.volume, Destination: c.dataDir }],
          NetworkSettings: { Ports: c.running ? binding : {} },
          HostConfig: { PortBindings: binding, RestartPolicy: c.restart ?? { Name: 'unless-stopped' } },
        }) + '\n'
      )
    }
    if (verb === 'volume') {
      const sub = rest[0]
      const name = rest.at(-1) as string
      if (sub === 'inspect') {
        if (!volumes.has(name)) return no(`Error: no such volume: ${name}`)
        return ok(JSON.stringify([{ Name: name, Labels: volumeLabels.get(name) ?? null }]) + '\n')
      }
      if (sub === 'create') {
        if (!volumes.has(name)) volumeLabels.set(name, labelsOf(rest))
        volumes.add(name)
        return ok(`${name}\n`)
      }
      if (sub === 'rm') {
        if (Object.values(containers).some((c) => c.volume === name)) return no(`Error: volume is in use - [${name}]`)
        volumeLabels.delete(name)
        return volumes.delete(name) ? ok(`${name}\n`) : no(`Error: No such volume: ${name}`)
      }
    }
    if (verb === 'stop' || verb === 'start') {
      const name = rest.at(-1) as string
      const c = containers[name]
      if (!c) return no(`Error: No such container: ${name}`)
      c.running = verb === 'start'
      return ok(`${name}\n`)
    }
    if (verb === 'update') {
      const name = rest.at(-1) as string
      const c = containers[name]
      if (!c) return no(`Error: No such container: ${name}`)
      const [policy, count] = rest[rest.indexOf('--restart') + 1].split(':')
      c.restart = count ? { Name: policy, MaximumRetryCount: Number(count) } : { Name: policy }
      return ok(`${name}\n`)
    }
    if (verb === 'rm') {
      const name = rest.at(-1) as string
      if (!containers[name]) return no(`Error: No such container: ${name}`)
      delete containers[name]
      return ok(`${name}\n`)
    }
    if (verb === 'run' && rest[0] === '--rm') return ok()
    if (verb === 'run') {
      const arg = (flag: string) => rest[rest.indexOf(flag) + 1]
      const port = Number(arg('-p').split(':')[1])
      const [volume, dataDir] = arg('-v').split(':')
      const labels = labelsOf(rest)
      if (Object.values(containers).some((c) => c.running && c.port === port)) {
        return { code: 125, stdout: '', stderr: `Bind for 127.0.0.1:${port} failed: port is already allocated` }
      }
      volumes.add(volume)
      containers[arg('--name')] = {
        image: rest.at(-1) as string,
        port,
        volume,
        dataDir,
        running: true,
        labels,
        restart: { Name: arg('--restart') },
      }
      return ok('deadbeef\n')
    }
    if (verb === 'exec') return ok('1\n')
    return no(`fake docker: unhandled ${joined}`)
  }
  return { runner, calls, containers, volumes, volumeLabels }
}

/** Everything but the read-only inspects and the readiness probes: what the rename DOES. */
const mutations = (calls: string[][]) =>
  calls
    .map((c) => c.join(' '))
    .filter((c) => !/^docker (inspect|volume inspect) /.test(c) && !c.endsWith('-tAc SELECT 1'))

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-pg-rename-')))
})
afterEach(() => {
  chmodSync(root, 0o700)
  rmSync(root, { recursive: true, force: true })
})

const move = localPostgresMove({ preRelabelLabel: L })
const legacyUrl = (db = move.legacy.database) => `postgres://postgres:postgres@localhost:5433/${db}?sslmode=disable`
const ficusUrl = legacyUrl('ficus')
const envText = (url: string) => `PORT=3000\n# the database\nDATABASE_URL=${url}\nFICUS_SANDBOX_RUNTIME=host\n`
const readEnv = () => readFileSync(join(root, '.env'), 'utf8')
const noSleep = async () => {}
const RUN = 'run-1'
const label = { [RENAMED_FROM_LABEL]: move.legacy.container, [RENAME_RUN_LABEL]: RUN }

function legacyDocker(m: LocalPostgresMove = move, fail: Record<string, Partial<RunResult>> = {}) {
  return fakeDocker(
    {
      containers: {
        [m.legacy.container]: {
          image: IMAGE_ID,
          port: 5433,
          volume: m.legacy.volume,
          dataDir: '/var/lib/postgresql',
          running: true,
        },
      },
      volumes: [m.legacy.volume],
    },
    fail
  )
}

/** A docker after a completed rename: the old container stopped, the new one (ours) running. */
async function renamedDocker(fail: Record<string, Partial<RunResult>> = {}) {
  writeFileSync(join(root, '.env'), envText(legacyUrl()))
  const docker = legacyDocker(move, fail)
  expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })).toBe(
    'renamed'
  )
  docker.calls.length = 0
  return docker
}

const newContainer = (over: Partial<FakeContainer> = {}): FakeContainer => ({
  image: IMAGE_ID,
  port: 5433,
  volume: 'ficus_postgres-data',
  dataDir: '/var/lib/postgresql',
  running: false,
  ...over,
})

async function thrown(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected a throw')
}

describe('localPostgresNames / localPostgresMove', () => {
  it('derives the default instance names from the stem alone, and a label is inserted after it', () => {
    expect(localPostgresNames('ficus', 'ignored', true)).toEqual({
      container: 'postgres-ficus',
      volume: 'ficus_postgres-data',
      database: 'ficus',
    })
    expect(localPostgresNames('ficus', 'lab', false)).toEqual({
      container: 'postgres-ficus-lab',
      volume: 'ficus-lab_postgres-data',
      database: 'ficus',
    })
  })
  it('pairs the legacy names (from the marked constant) with the ficus names, from the pre-relabel label', () => {
    expect(localPostgresMove({ preRelabelLabel: L })).toEqual({
      legacy: localPostgresNames(L, L, true),
      ficus: { container: 'postgres-ficus', volume: 'ficus_postgres-data', database: 'ficus' },
    })
    expect(localPostgresMove({ preRelabelLabel: 'lab' })).toEqual({
      legacy: localPostgresNames(L, 'lab', false),
      ficus: { container: 'postgres-ficus-lab', volume: 'ficus-lab_postgres-data', database: 'ficus' },
    })
  })
})

describe('withDatabaseName', () => {
  it('replaces only the path segment, keeping credentials, host, port and query exactly', () => {
    expect(withDatabaseName('postgres://postgres:p%40ss@localhost:5433/old?sslmode=disable&x=1', 'ficus')).toBe(
      'postgres://postgres:p%40ss@localhost:5433/ficus?sslmode=disable&x=1'
    )
    expect(withDatabaseName('postgres://postgres:postgres@127.0.0.1/old', 'ficus')).toBe(
      'postgres://postgres:postgres@127.0.0.1/ficus'
    )
  })
  it('refuses a URL without a database path, without echoing the URL (it carries a password)', () => {
    let message = ''
    try {
      withDatabaseName('postgres://postgres:s3cret@localhost:5433', 'ficus')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/no database path/)
    expect(message).not.toContain('s3cret')
  })
})

describe('planLocalPostgresRename', () => {
  it('describes the move without changing anything (what a dry run prints)', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    expect(await planLocalPostgresRename(move, root, { runner: docker.runner })).toEqual({
      action: 'rename',
      from: { container: move.legacy.container, volume: move.legacy.volume, running: true },
      to: { container: 'postgres-ficus', volume: 'ficus_postgres-data' },
      port: 5433,
      image: IMAGE_ID,
      dataDir: '/var/lib/postgresql',
      database: { from: move.legacy.database, to: 'ficus' },
    })
    expect(mutations(docker.calls)).toEqual([])
    expect(readEnv()).toBe(envText(legacyUrl()))
  })
  it('is "external" with no docker call, and "already" after a rename', async () => {
    writeFileSync(join(root, '.env'), envText('postgres://user:pw@db.example.com:5432/app'))
    const external = legacyDocker()
    expect(await planLocalPostgresRename(move, root, { runner: external.runner })).toEqual({ action: 'external' })
    expect(external.calls).toEqual([])
    const docker = await renamedDocker()
    expect(await planLocalPostgresRename(move, root, { runner: docker.runner })).toEqual({
      action: 'already',
      container: 'postgres-ficus',
    })
  })
})

describe('renameLocalPostgres', () => {
  it('stops the old container, copies its volume, starts the new one on the same port and renames the database', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })).toBe(
      'renamed'
    )
    expect(mutations(docker.calls)).toEqual([
      `docker stop -t 60 ${move.legacy.container}`,
      `docker volume create --label ${RENAME_RUN_LABEL}=${RUN} ficus_postgres-data`,
      `docker run --rm -v ${move.legacy.volume}:/from:ro -v ficus_postgres-data:/to ${IMAGE_ID} sh -c cp -a /from/. /to/`,
      `docker run -d --name postgres-ficus --restart no --label ${RENAMED_FROM_LABEL}=${move.legacy.container} --label ${RENAME_RUN_LABEL}=${RUN} -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5433:5432 -v ficus_postgres-data:/var/lib/postgresql ${IMAGE_ID}`,
      `docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ALTER DATABASE "${move.legacy.database}" RENAME TO "ficus"`,
    ])
    // It waited for the new server before renaming inside it.
    const joined = docker.calls.map((c) => c.join(' '))
    const alter = joined.findIndex((c) => c.includes('ALTER DATABASE'))
    expect(
      joined
        .slice(0, alter)
        .filter((c) => c === 'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1')
    ).toHaveLength(3)
    // The old container is left stopped and its volume untouched: the rollback copy.
    expect(docker.containers[move.legacy.container].running).toBe(false)
    expect(docker.volumes.has(move.legacy.volume)).toBe(true)
    expect(docker.containers['postgres-ficus']).toMatchObject({
      port: 5433,
      running: true,
      volume: 'ficus_postgres-data',
      labels: label,
    })
  })
  it('rewrites only the database segment of DATABASE_URL, atomically, keeping the file mode and the rest of .env', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()), { mode: 0o600 })
    chmodSync(join(root, '.env'), 0o600)
    await renameLocalPostgres(move, root, { runner: legacyDocker().runner, sleep: noSleep }, { runId: RUN })
    expect(readEnv()).toBe(envText(ficusUrl))
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
    expect(readdirSync(root)).toEqual(['.env'])
  })
  it('keeps quotes and CRLF line endings on the DATABASE_URL line', async () => {
    const crlf = (url: string) => `PORT=3000\r\nDATABASE_URL="${url}"\r\nX=1\r\n`
    writeFileSync(join(root, '.env'), crlf(legacyUrl()))
    await renameLocalPostgres(move, root, { runner: legacyDocker().runner, sleep: noSleep }, { runId: RUN })
    expect(readEnv()).toBe(crlf(ficusUrl))
  })
  it('copies from the volume the old container really mounts, and mounts the copy at the same place', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].volume = 'checkoutdir_postgres-data'
    docker.containers[move.legacy.container].dataDir = '/var/lib/postgresql/data'
    await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })
    const joined = mutations(docker.calls)
    expect(joined[2]).toContain('-v checkoutdir_postgres-data:/from:ro -v ficus_postgres-data:/to')
    expect(joined[3]).toContain('-v ficus_postgres-data:/var/lib/postgresql/data')
  })
  it('moves a labelled instance to its own ficus names', async () => {
    const lab = localPostgresMove({ preRelabelLabel: 'lab' })
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(lab)
    expect(await renameLocalPostgres(lab, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })).toBe(
      'renamed'
    )
    expect(mutations(docker.calls)).toEqual([
      `docker stop -t 60 ${lab.legacy.container}`,
      `docker volume create --label ${RENAME_RUN_LABEL}=${RUN} ficus-lab_postgres-data`,
      `docker run --rm -v ${lab.legacy.volume}:/from:ro -v ficus-lab_postgres-data:/to ${IMAGE_ID} sh -c cp -a /from/. /to/`,
      `docker run -d --name postgres-ficus-lab --restart no --label ${RENAMED_FROM_LABEL}=${lab.legacy.container} --label ${RENAME_RUN_LABEL}=${RUN} -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5433:5432 -v ficus-lab_postgres-data:/var/lib/postgresql ${IMAGE_ID}`,
      `docker exec postgres-ficus-lab psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ALTER DATABASE "${lab.legacy.database}" RENAME TO "ficus"`,
    ])
  })
  it('keeps a database name the operator chose (only the legacy default is renamed)', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl('appdb')))
    const docker = legacyDocker()
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })).toBe(
      'renamed'
    )
    expect(docker.calls.some((c) => c.join(' ').includes('ALTER DATABASE'))).toBe(false)
    expect(readEnv()).toBe(envText(legacyUrl('appdb')))
    expect(docker.containers['postgres-ficus']?.running).toBe(true)
  })
  it('leaves an external database alone, without a single docker call', async () => {
    for (const url of [
      'postgres://user:pw@db.example.com:5432/app',
      // loopback, but the operator's own credentials: not a container of ours
      'postgres://me:pw@localhost:5432/app',
    ]) {
      writeFileSync(join(root, '.env'), envText(url))
      const docker = legacyDocker()
      expect(await renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN })).toBe('external')
      expect(docker.calls).toEqual([])
      expect(readEnv()).toBe(envText(url))
    }
  })
  it('refuses a DATABASE_URL with an inline comment rather than moving the container and skipping the rename', async () => {
    // With no query, the URL parser folds ` # local db` into the path: the database reads `<legacy>%20`.
    writeFileSync(
      join(root, '.env'),
      envText(`postgres://postgres:postgres@localhost:5433/${move.legacy.database} # local db`)
    )
    const docker = legacyDocker()
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))).toMatch(
      /not end in a plain database name/
    )
    expect(docker.calls).toEqual([])
  })
  it('is "already" on a second run, touching nothing', async () => {
    const docker = await renamedDocker()
    const env = readEnv()
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })).toBe(
      'already'
    )
    expect(mutations(docker.calls)).toEqual([])
    expect(readEnv()).toBe(env)
  })
  it('is "already" for a chosen database name only when the new container is this rename\'s', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl('appdb')))
    const docker = legacyDocker()
    await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })
    expect(await renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN })).toBe('already')
    // A container of the new name that something else created, next to the intact old one: refused.
    delete docker.containers['postgres-ficus'].labels
    docker.calls.length = 0
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))).toMatch(
      /no rename created/
    )
    expect(mutations(docker.calls)).toEqual([])
  })
  it('is "already" when a container of the new name exists and there is no old container', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = fakeDocker({ containers: { 'postgres-ficus': newContainer({ running: true }) }, volumes: [] })
    expect(await renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN })).toBe('already')
    expect(mutations(docker.calls)).toEqual([])
  })
  it('on an interrupted run of its own, says what it found and exactly how to go back', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].running = false
    docker.containers['postgres-ficus'] = newContainer({ labels: label })
    docker.volumes.add('ficus_postgres-data')
    const message = await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))
    expect(message).toContain('an earlier rename')
    expect(message).toContain('did not finish')
    expect(message).toContain(`postgres-ficus (stopped), ${move.legacy.container} (stopped)`)
    expect(message).toContain('the app cannot reach its database')
    expect(message).toContain(
      `  docker rm -f postgres-ficus\n  docker volume rm ficus_postgres-data\n  docker start ${move.legacy.container}\n`
    )
    expect(mutations(docker.calls)).toEqual([])
  })
  it('never advises removing the new volume when the old container is gone', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = fakeDocker({
      containers: { 'postgres-ficus': newContainer({ labels: label }) },
      volumes: ['ficus_postgres-data'],
    })
    const message = await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))
    expect(message).toContain('did not finish')
    expect(message).toContain('may hold the only copy of the data: do not remove them')
    expect(message).not.toContain('docker volume rm')
  })
  it('a container of the new name that no rename created is not called an interrupted rename', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers['postgres-ficus'] = newContainer({ port: 5499 })
    const message = await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))
    expect(message).toContain(`no ${RENAMED_FROM_LABEL} label`)
    expect(message).not.toContain('interrupted')
    expect(message).not.toContain('docker volume rm')
    expect(mutations(docker.calls)).toEqual([])
  })
  it('refuses, before stopping anything, when the new volume already exists (it may hold data)', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.volumes.add('ficus_postgres-data')
    const message = await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))
    expect(message).toContain('volume ficus_postgres-data already exists')
    expect(message).toContain(`${move.legacy.container} (running) and its volume ${move.legacy.volume} still hold`)
    expect(message).toContain('holding writes made after that rename')
    expect(mutations(docker.calls)).toEqual([])
    expect(docker.containers[move.legacy.container].running).toBe(true)
  })
  it('refuses, never advising removal, when the old container already mounts a volume of the new name', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].volume = 'ficus_postgres-data'
    docker.volumes.add('ficus_postgres-data')
    const message = await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))
    expect(message).toContain("holds this instance's only data — do not remove it")
    expect(message).not.toContain('docker volume rm')
    expect(mutations(docker.calls)).toEqual([])
  })
  it('treats a failing docker volume inspect as an error, not as "no such volume"', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, {
      'docker volume inspect': { stderr: 'Cannot connect to the Docker daemon' },
    })
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))).toMatch(
      /volume inspect ficus_postgres-data failed/
    )
    expect(mutations(docker.calls)).toEqual([])
  })
  it('treats a failing docker inspect as an error, not as "no such container"', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, { 'docker inspect': { stderr: 'Cannot connect to the Docker daemon' } })
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))).toMatch(
      /docker inspect .* failed/
    )
    expect(mutations(docker.calls)).toEqual([])
  })
  it('refuses when there is no old container to move', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = fakeDocker({ containers: {}, volumes: [] })
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))).toContain(
      `no container ${move.legacy.container}`
    )
    expect(mutations(docker.calls)).toEqual([])
  })

  const rolledBack = (docker: ReturnType<typeof fakeDocker>) => {
    expect(docker.containers['postgres-ficus']).toBeUndefined()
    expect(docker.volumes.has('ficus_postgres-data')).toBe(false)
    expect(docker.containers[move.legacy.container].running).toBe(true)
    expect(readEnv()).toBe(envText(legacyUrl()))
  }
  it('puts everything back when the ALTER fails: new container and volume gone, old one running, .env untouched', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, {
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ALTER': {
        stderr: 'database is being accessed by other users',
      },
    })
    expect(
      await thrown(renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN }))
    ).toMatch(/being accessed by other users/)
    expect(mutations(docker.calls).slice(-3)).toEqual([
      'docker rm -f postgres-ficus',
      'docker volume rm ficus_postgres-data',
      `docker start ${move.legacy.container}`,
    ])
    rolledBack(docker)
  })
  it('puts everything back when the new container cannot bind the port', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers.squatter = newContainer({ volume: 'other', running: true })
    expect(
      await thrown(renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN }))
    ).toMatch(/port is already allocated/)
    rolledBack(docker)
  })
  it('puts everything back when the new server never becomes ready', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, { 'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1': {} })
    expect(
      await thrown(renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN }))
    ).toMatch(/did not become ready/)
    rolledBack(docker)
  })
  it('puts everything back when .env cannot be written after the ALTER', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    chmodSync(root, 0o500) // the temp file beside .env cannot be created
    await thrown(renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN }))
    chmodSync(root, 0o700)
    rolledBack(docker)
  })
  it('undoes the whole move when no DATABASE_URL line can be rewritten after the ALTER, naming the file, never the URL', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    const otherUrl = 'postgres://postgres:postgres@localhost:5433/appdb'
    // Something edits .env while the move runs: by the time of the rewrite, no line names the old database.
    const editing: Runner = async (command, options) => {
      if (command.join(' ').includes('ALTER DATABASE')) writeFileSync(join(root, '.env'), envText(otherUrl))
      return docker.runner(command, options)
    }
    const message = await thrown(renameLocalPostgres(move, root, { runner: editing, sleep: noSleep }, { runId: RUN }))
    expect(message).toContain(`no DATABASE_URL line in ${join(root, '.env')} names database "${move.legacy.database}"`)
    expect(message).not.toContain('postgres://')
    expect(docker.containers['postgres-ficus']).toBeUndefined()
    expect(docker.volumes.has('ficus_postgres-data')).toBe(false)
    expect(docker.containers[move.legacy.container].running).toBe(true)
    expect(readEnv()).toBe(envText(otherUrl))
  })
  it('does not start an old container on rollback that was stopped before the rename', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, { 'docker run --rm': { stderr: 'no space left on device' } })
    docker.containers[move.legacy.container].running = false
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: RUN }))).toMatch(
      /no space left/
    )
    expect(mutations(docker.calls).at(-1)).toBe('docker volume rm ficus_postgres-data')
    expect(docker.containers[move.legacy.container].running).toBe(false)
  })
})

describe('finalizeLocalPostgresRename', () => {
  it("the new container starts with --restart no; finalize gives it the old container's policy", async () => {
    const docker = await renamedDocker()
    expect(docker.containers['postgres-ficus'].restart).toEqual({ Name: 'no' })
    expect(await finalizeLocalPostgresRename(move, { runner: docker.runner })).toBe('unless-stopped')
    expect(mutations(docker.calls)).toEqual(['docker update --restart unless-stopped postgres-ficus'])
    expect(docker.containers['postgres-ficus'].restart).toEqual({ Name: 'unless-stopped' })
  })
  it('carries over another policy, including on-failure with its retry count', async () => {
    const docker = await renamedDocker()
    docker.containers[move.legacy.container].restart = { Name: 'always' }
    expect(await finalizeLocalPostgresRename(move, { runner: docker.runner })).toBe('always')
    docker.containers[move.legacy.container].restart = { Name: 'on-failure', MaximumRetryCount: 3 }
    expect(await finalizeLocalPostgresRename(move, { runner: docker.runner })).toBe('on-failure:3')
    expect(docker.containers['postgres-ficus'].restart).toEqual({ Name: 'on-failure', MaximumRetryCount: 3 })
  })
  it('defaults to unless-stopped when docker reports no policy or the old container is gone', async () => {
    const docker = await renamedDocker()
    docker.containers[move.legacy.container].restart = { Name: '' }
    expect(await finalizeLocalPostgresRename(move, { runner: docker.runner })).toBe('unless-stopped')
    delete docker.containers[move.legacy.container]
    expect(await finalizeLocalPostgresRename(move, { runner: docker.runner })).toBe('unless-stopped')
  })
  it('refuses a new-name container the rename did not create, or none at all', async () => {
    const docker = legacyDocker()
    expect(await thrown(finalizeLocalPostgresRename(move, { runner: docker.runner }))).toContain(
      'no container postgres-ficus to finalize'
    )
    docker.containers['postgres-ficus'] = newContainer({ running: true })
    expect(await thrown(finalizeLocalPostgresRename(move, { runner: docker.runner }))).toContain('not changing it')
    expect(mutations(docker.calls)).toEqual([])
  })
})

describe('undoLocalPostgresRename', () => {
  it('after the app ran on the new database: stops and removes the new container, starts the old one, KEEPS the new volume and names it', async () => {
    const docker = await renamedDocker()
    expect(
      await undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: true, runId: RUN })
    ).toEqual({
      keptVolume: 'ficus_postgres-data',
      keptBecause: 'the app may have written to it since the rename',
    })
    expect(mutations(docker.calls)).toEqual([
      'docker stop -t 60 postgres-ficus',
      'docker rm -f postgres-ficus',
      `docker start ${move.legacy.container}`,
    ])
    expect(docker.containers['postgres-ficus']).toBeUndefined()
    expect(docker.containers[move.legacy.container].running).toBe(true)
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
    expect(readEnv()).toBe(envText(legacyUrl()))
  })
  it('before the app started on it: removes the new volume last, once the old container runs, so a retry copies afresh', async () => {
    const docker = await renamedDocker()
    expect(
      await undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: false, runId: RUN })
    ).toEqual({
      keptVolume: undefined,
    })
    expect(mutations(docker.calls)).toEqual([
      'docker stop -t 60 postgres-ficus',
      'docker rm -f postgres-ficus',
      `docker start ${move.legacy.container}`,
      'docker volume rm ficus_postgres-data',
    ])
    expect(docker.volumes.has('ficus_postgres-data')).toBe(false)
    expect(readEnv()).toBe(envText(legacyUrl()))
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: RUN })).toBe(
      'renamed'
    )
  })
  it('touches nothing when the old container is gone: the new volume may be the only copy', async () => {
    const docker = await renamedDocker()
    delete docker.containers[move.legacy.container]
    docker.volumes.delete(move.legacy.volume)
    const message = await thrown(
      undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: false, runId: RUN })
    )
    expect(message).toContain('may hold the only copy of the data — left untouched')
    expect(mutations(docker.calls)).toEqual([])
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
    expect(docker.containers['postgres-ficus']?.running).toBe(true)
    expect(readEnv()).toBe(envText(ficusUrl))
  })
  it('keeps the new volume when the old container does not come back up', async () => {
    const docker = await renamedDocker({ 'docker start': { stderr: 'driver failed' } })
    expect(
      await thrown(undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: false, runId: RUN }))
    ).toMatch(/driver failed/)
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
    expect(mutations(docker.calls).some((c) => c.startsWith('docker volume rm'))).toBe(false)
  })
  it('keeps the new volume when the old container starts but does not stay running', async () => {
    const docker = await renamedDocker()
    const inner = docker.runner
    const flaky: Runner = async (command, options) => {
      const result = await inner(command, options)
      if (command[1] === 'start') docker.containers[move.legacy.container].running = false
      return result
    }
    expect(
      await thrown(undoLocalPostgresRename(move, root, { runner: flaky }, { appStarted: false, runId: RUN }))
    ).toMatch(/did not stay running/)
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
  })
  it('undoes a rename cut short after this run created the volume (the new container already gone is fine too)', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].running = false
    docker.volumes.add('ficus_postgres-data')
    docker.volumeLabels.set('ficus_postgres-data', { [RENAME_RUN_LABEL]: RUN })
    await undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: false, runId: RUN })
    expect(docker.containers[move.legacy.container].running).toBe(true)
    expect(docker.volumes.has('ficus_postgres-data')).toBe(false)
    expect(readEnv()).toBe(envText(legacyUrl()))
  })
  it('keeps a new volume another run created, even with appStarted false, and says why', async () => {
    const docker = await renamedDocker()
    const result = await undoLocalPostgresRename(
      move,
      root,
      { runner: docker.runner },
      { appStarted: false, runId: 'run-2' }
    )
    expect(result).toEqual({
      keptVolume: 'ficus_postgres-data',
      keptBecause: `it was created by another rename run (${RUN}), not this one (run-2)`,
    })
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
    expect(mutations(docker.calls).some((c) => c.startsWith('docker volume rm'))).toBe(false)
    expect(docker.containers[move.legacy.container].running).toBe(true)
  })
  it('keeps a new volume with no run label, even with appStarted false', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].running = false
    docker.volumes.add('ficus_postgres-data')
    const result = await undoLocalPostgresRename(
      move,
      root,
      { runner: docker.runner },
      { appStarted: false, runId: RUN }
    )
    expect(result).toEqual({
      keptVolume: 'ficus_postgres-data',
      keptBecause: `it has no ${RENAME_RUN_LABEL} label, so this run did not create it`,
    })
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
  })
  it('never lets a later run delete the volume an earlier undo kept (plan → journal → rename, then a wrong undo)', async () => {
    // Run 1 completes; the app writes; --undo keeps the new volume (appStarted: true).
    const docker = await renamedDocker()
    await undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: true, runId: RUN })
    // Run 2: the plan refuses (the kept volume exists), so the move never starts...
    expect(await thrown(planLocalPostgresRename(move, root, { runner: docker.runner }))).toContain(
      'volume ficus_postgres-data already exists'
    )
    expect(
      await thrown(renameLocalPostgres(move, root, { runner: docker.runner, sleep: noSleep }, { runId: 'run-2' }))
    ).toContain('already exists')
    // ...and even a caller that wrongly undoes run 2 with appStarted false cannot delete run 1's volume.
    const result = await undoLocalPostgresRename(
      move,
      root,
      { runner: docker.runner },
      { appStarted: false, runId: 'run-2' }
    )
    expect(result.keptVolume).toBe('ficus_postgres-data')
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
  })
  it("refuses, touching nothing, when the new-name container is not the rename's own", async () => {
    writeFileSync(join(root, '.env'), envText(ficusUrl))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].running = false
    docker.containers['postgres-ficus'] = newContainer({ running: true, volume: 'something_else' })
    const message = await thrown(
      undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: false, runId: RUN })
    )
    expect(message).toContain('no rename from')
    expect(message).toContain('a container of that name exists (running, data volume something_else)')
    expect(message).toContain(`${move.legacy.container} (stopped) too`)
    expect(mutations(docker.calls)).toEqual([])
    expect(docker.containers['postgres-ficus'].running).toBe(true)
    expect(readEnv()).toBe(envText(ficusUrl))
  })
  it('rejects a run id that cannot be a docker label value', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    expect(await thrown(renameLocalPostgres(move, root, { runner: docker.runner }, { runId: 'bad id=x' }))).toMatch(
      /run id/
    )
    expect(docker.calls).toEqual([])
    expect(newRenameRunId()).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('leaves a chosen database name alone', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl('appdb')))
    const docker = legacyDocker()
    await undoLocalPostgresRename(move, root, { runner: docker.runner }, { appStarted: true, runId: RUN })
    expect(readEnv()).toBe(envText(legacyUrl('appdb')))
  })
})
