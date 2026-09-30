import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'
import {
  localPostgresMove,
  localPostgresNames,
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
}

/**
 * A docker that keeps state: containers (image, port, volume, running) and volumes. Enough of the CLI
 * surface for the rename — inspect, stop/start, rm -f, volume inspect/create/rm, run (--rm
 * and -d, with host-port collisions) and exec (the readiness probe, ALTER DATABASE).
 */
function fakeDocker(
  init: { containers: Record<string, FakeContainer>; volumes: string[] },
  fail: Record<string, Partial<RunResult>> = {}
) {
  const calls: string[][] = []
  const containers: Record<string, FakeContainer> = structuredClone(init.containers)
  const volumes = new Set(init.volumes)
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
          Mounts: [{ Type: 'volume', Name: c.volume, Destination: c.dataDir }],
          NetworkSettings: { Ports: c.running ? binding : {} },
          HostConfig: { PortBindings: binding },
        }) + '\n'
      )
    }
    if (verb === 'volume') {
      const [sub, name] = rest
      if (sub === 'inspect') return volumes.has(name) ? ok('[]\n') : no(`Error: no such volume: ${name}`)
      if (sub === 'create') {
        volumes.add(name)
        return ok(`${name}\n`)
      }
      if (sub === 'rm') return volumes.delete(name) ? ok(`${name}\n`) : no(`Error: No such volume: ${name}`)
    }
    if (verb === 'stop' || verb === 'start') {
      const c = containers[rest[0]]
      if (!c) return no(`Error: No such container: ${rest[0]}`)
      c.running = verb === 'start'
      return ok(`${rest[0]}\n`)
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
      if (Object.values(containers).some((c) => c.running && c.port === port)) {
        return no(`Bind for 127.0.0.1:${port} failed: port is already allocated`)
      }
      containers[arg('--name')] = { image: rest.at(-1) as string, port, volume, dataDir, running: true }
      return ok('deadbeef\n')
    }
    if (verb === 'exec') return ok('1\n')
    return no(`fake docker: unhandled ${joined}`)
  }
  return { runner, calls, containers, volumes }
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
  rmSync(root, { recursive: true, force: true })
})

const move = localPostgresMove(L)
const legacyUrl = (db = move.legacy.database) => `postgres://postgres:postgres@localhost:5433/${db}?sslmode=disable`
const envText = (url: string) => `PORT=3000\n# the database\nDATABASE_URL=${url}\nFICUS_SANDBOX_RUNTIME=host\n`
const readEnv = () => readFileSync(join(root, '.env'), 'utf8')

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
  it('pairs the legacy names (from the marked constant) with the ficus names', () => {
    expect(localPostgresMove(L)).toEqual({
      legacy: localPostgresNames(L, L, true),
      ficus: { container: 'postgres-ficus', volume: 'ficus_postgres-data', database: 'ficus' },
    })
    expect(localPostgresMove('lab')).toEqual({
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
    expect(() => withDatabaseName('postgres://postgres:s3cret@localhost:5433', 'ficus')).toThrow(/no database path/)
    let message = ''
    try {
      withDatabaseName('postgres://postgres:s3cret@localhost:5433', 'ficus')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('s3cret')
  })
})

describe('renameLocalPostgres', () => {
  it('stops the old container, copies its volume, starts the new one on the same port and renames the database', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })).toBe('renamed')
    expect(mutations(docker.calls)).toEqual([
      `docker stop ${move.legacy.container}`,
      'docker volume create ficus_postgres-data',
      `docker run --rm -v ${move.legacy.volume}:/from:ro -v ficus_postgres-data:/to ${IMAGE_ID} sh -c cp -a /from/. /to/`,
      `docker run -d --name postgres-ficus --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5433:5432 -v ficus_postgres-data:/var/lib/postgresql ${IMAGE_ID}`,
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
    })
  })
  it('rewrites only the database segment of DATABASE_URL, leaving the rest of .env alone', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    await renameLocalPostgres(move, root, { runner: legacyDocker().runner, sleep: async () => {} })
    expect(readEnv()).toBe(envText('postgres://postgres:postgres@localhost:5433/ficus?sslmode=disable'))
  })
  it('copies from the volume the old container really mounts, and mounts the copy at the same place', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].volume = 'checkoutdir_postgres-data'
    docker.containers[move.legacy.container].dataDir = '/var/lib/postgresql/data'
    await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })
    const joined = mutations(docker.calls)
    expect(joined[2]).toContain('-v checkoutdir_postgres-data:/from:ro -v ficus_postgres-data:/to')
    expect(joined[3]).toContain('-v ficus_postgres-data:/var/lib/postgresql/data')
  })
  it('moves a labelled instance to its own ficus names', async () => {
    const lab = localPostgresMove('lab')
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(lab)
    expect(await renameLocalPostgres(lab, root, { runner: docker.runner, sleep: async () => {} })).toBe('renamed')
    expect(mutations(docker.calls)).toEqual([
      `docker stop ${lab.legacy.container}`,
      'docker volume create ficus-lab_postgres-data',
      `docker run --rm -v ${lab.legacy.volume}:/from:ro -v ficus-lab_postgres-data:/to ${IMAGE_ID} sh -c cp -a /from/. /to/`,
      `docker run -d --name postgres-ficus-lab --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5433:5432 -v ficus-lab_postgres-data:/var/lib/postgresql ${IMAGE_ID}`,
      `docker exec postgres-ficus-lab psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ALTER DATABASE "${lab.legacy.database}" RENAME TO "ficus"`,
    ])
  })
  it('keeps a database name the operator chose (only the legacy default is renamed)', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl('appdb')))
    const docker = legacyDocker()
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })).toBe('renamed')
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
      expect(await renameLocalPostgres(move, root, { runner: docker.runner })).toBe('external')
      expect(docker.calls).toEqual([])
      expect(readEnv()).toBe(envText(url))
    }
  })
  it('is "already" on a second run, touching nothing', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })
    docker.calls.length = 0
    const env = readEnv()
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })).toBe('already')
    expect(mutations(docker.calls)).toEqual([])
    expect(readEnv()).toBe(env)
  })
  it('refuses, before stopping anything, when the new container exists but .env still names the old database', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.containers['postgres-ficus'] = {
      image: IMAGE_ID,
      port: 5499,
      volume: 'ficus_postgres-data',
      dataDir: '/var/lib/postgresql',
      running: false,
    }
    await expect(renameLocalPostgres(move, root, { runner: docker.runner })).rejects.toThrow(/interrupted/)
    expect(mutations(docker.calls)).toEqual([])
  })
  it('refuses, before stopping anything, when the new volume already exists (it may hold data)', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    docker.volumes.add('ficus_postgres-data')
    await expect(renameLocalPostgres(move, root, { runner: docker.runner })).rejects.toThrow(
      /volume ficus_postgres-data already exists/
    )
    expect(mutations(docker.calls)).toEqual([])
    expect(docker.containers[move.legacy.container].running).toBe(true)
  })
  it('refuses when there is no old container to move', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = fakeDocker({ containers: {}, volumes: [] })
    await expect(renameLocalPostgres(move, root, { runner: docker.runner })).rejects.toThrow(
      new RegExp(`no container ${move.legacy.container}`)
    )
    expect(mutations(docker.calls)).toEqual([])
  })
  it('puts everything back when a step fails: new container and volume gone, old one running, .env untouched', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, {
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ALTER': {
        stderr: 'database is being accessed by other users',
      },
    })
    await expect(renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })).rejects.toThrow(
      /being accessed by other users/
    )
    expect(mutations(docker.calls).slice(-3)).toEqual([
      'docker rm -f postgres-ficus',
      'docker volume rm ficus_postgres-data',
      `docker start ${move.legacy.container}`,
    ])
    expect(docker.containers['postgres-ficus']).toBeUndefined()
    expect(docker.volumes.has('ficus_postgres-data')).toBe(false)
    expect(docker.containers[move.legacy.container].running).toBe(true)
    expect(readEnv()).toBe(envText(legacyUrl()))
  })
  it('does not start an old container on rollback that was stopped before the rename', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker(move, { 'docker run --rm': { stderr: 'no space left on device' } })
    docker.containers[move.legacy.container].running = false
    await expect(renameLocalPostgres(move, root, { runner: docker.runner })).rejects.toThrow(/no space left/)
    expect(mutations(docker.calls).at(-1)).toBe('docker volume rm ficus_postgres-data')
    expect(docker.containers[move.legacy.container].running).toBe(false)
  })
})

describe('undoLocalPostgresRename', () => {
  it('removes the new container, starts the old one and points DATABASE_URL back at the old database', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })
    docker.calls.length = 0
    await undoLocalPostgresRename(move, root, { runner: docker.runner })
    expect(mutations(docker.calls)).toEqual(['docker rm -f postgres-ficus', `docker start ${move.legacy.container}`])
    expect(docker.containers['postgres-ficus']).toBeUndefined()
    expect(docker.containers[move.legacy.container].running).toBe(true)
    // The copy is kept unless the caller says it never served the app.
    expect(docker.volumes.has('ficus_postgres-data')).toBe(true)
    expect(readEnv()).toBe(envText(legacyUrl()))
  })
  it('removes the new volume too when asked, so a retry can copy afresh', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl()))
    const docker = legacyDocker()
    await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })
    docker.calls.length = 0
    await undoLocalPostgresRename(move, root, { runner: docker.runner }, { removeVolume: true })
    expect(mutations(docker.calls)).toEqual([
      'docker rm -f postgres-ficus',
      'docker volume rm ficus_postgres-data',
      `docker start ${move.legacy.container}`,
    ])
    expect(docker.volumes.has('ficus_postgres-data')).toBe(false)
    expect(await renameLocalPostgres(move, root, { runner: docker.runner, sleep: async () => {} })).toBe('renamed')
  })
  it('tolerates a new container that is already gone, and leaves a chosen database name alone', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl('appdb')))
    const docker = legacyDocker()
    docker.containers[move.legacy.container].running = false
    await undoLocalPostgresRename(move, root, { runner: docker.runner })
    expect(docker.containers[move.legacy.container].running).toBe(true)
    expect(readEnv()).toBe(envText(legacyUrl('appdb')))
  })
  it('throws when the old container cannot be started', async () => {
    writeFileSync(join(root, '.env'), envText(legacyUrl('ficus')))
    const docker = legacyDocker(move, { 'docker start': { stderr: 'driver failed' } })
    await expect(undoLocalPostgresRename(move, root, { runner: docker.runner })).rejects.toThrow(/driver failed/)
  })
})
