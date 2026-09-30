import { describe, expect, it } from 'bun:test'
import {
  containerVolumeName,
  ensureDatabase,
  ensurePostgresContainer,
  findFreePort,
  isManagedPostgresUrl,
  isManagedShapedUrl,
  isPortInUse,
  publishedPort,
  parseDatabaseUrl,
  POSTGRES_IMAGE,
  waitForPostgres,
  waitForTcp,
} from './postgres'
import { recordingRunner } from './runner'
import { SetupFailure } from './types'

/** What a connect to a port nothing listens on rejects with. */
const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

describe('parseDatabaseUrl / isManagedPostgresUrl', () => {
  it('extracts host, port and database', () => {
    expect(parseDatabaseUrl('postgres://u:p@db.example:6543/mydb?sslmode=require')).toEqual({
      host: 'db.example',
      port: 6543,
      database: 'mydb',
    })
    expect(parseDatabaseUrl('postgres://postgres:postgres@localhost/tau').port).toBe(5432)
  })
  it('recognises a database of ours by its loopback host, whatever the port', () => {
    expect(isManagedPostgresUrl('postgres://postgres:postgres@localhost:5432/tau')).toBe(true)
    expect(isManagedPostgresUrl('postgres://postgres:postgres@127.0.0.1:5432/other')).toBe(true)
    expect(isManagedPostgresUrl('postgres://postgres:postgres@localhost:5433/tau')).toBe(true)
    expect(isManagedPostgresUrl('postgres://u:p@db.example:5432/tau')).toBe(false)
    expect(isManagedPostgresUrl('not a url')).toBe(false)
  })
})

describe('isManagedShapedUrl', () => {
  it('is true only for a loopback DSN carrying the container default credentials', () => {
    expect(isManagedShapedUrl('postgres://postgres:postgres@localhost:5433/tau')).toBe(true)
    expect(isManagedShapedUrl('postgres://postgres:postgres@127.0.0.1:5432/other')).toBe(true)
    // A PostgreSQL the operator installed themselves: loopback, but theirs.
    expect(isManagedShapedUrl('postgres://me:pw@localhost:5432/app')).toBe(false)
    expect(isManagedShapedUrl('postgres://postgres:hunter2@localhost:5432/tau')).toBe(false)
    expect(isManagedShapedUrl('postgres://localhost:5432/tau')).toBe(false)
    // Default credentials off-box are still not ours to manage.
    expect(isManagedShapedUrl('postgres://postgres:postgres@db.example:5432/tau')).toBe(false)
    expect(isManagedShapedUrl('not a url')).toBe(false)
  })
})

describe('publishedPort', () => {
  const inspect = (info: unknown) => recordingRunner({ 'docker inspect': { stdout: JSON.stringify(info) + '\n' } })
  it('reads the live mapping of a running container', async () => {
    const rec = inspect({
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5433' }] } },
      HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5433' }] } },
    })
    expect(await publishedPort(rec.runner, 'postgres-tau-smoke')).toBe(5433)
    expect(rec.calls[0].command).toEqual(['docker', 'inspect', '-f', '{{json .}}', 'postgres-tau-smoke'])
  })
  it('falls back to the created mapping of a STOPPED container, whose live Ports are empty', async () => {
    // docker empties NetworkSettings.Ports while a container is stopped, but
    // `docker start` restores HostConfig.PortBindings — that is the port the
    // installer has to agree with.
    const rec = inspect({
      NetworkSettings: { Ports: {} },
      HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5434' }] } },
    })
    expect(await publishedPort(rec.runner, 'postgres-tau-smoke')).toBe(5434)
  })
  it('is undefined when there is no such container, or it publishes nothing', async () => {
    const missing = recordingRunner({ 'docker inspect': { code: 1, stderr: 'No such object' } })
    expect(await publishedPort(missing.runner, 'postgres-tau-smoke')).toBeUndefined()
    const unpublished = inspect({ NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: {} } })
    expect(await publishedPort(unpublished.runner, 'postgres-tau-smoke')).toBeUndefined()
    const garbage = recordingRunner({ 'docker inspect': { stdout: 'not json' } })
    expect(await publishedPort(garbage.runner, 'postgres-tau-smoke')).toBeUndefined()
  })
})

describe('containerVolumeName', () => {
  const mounts = (name: string, dest: string) =>
    JSON.stringify([{ Type: 'volume', Name: name, Source: '/var/lib/docker/volumes/' + name, Destination: dest }])
  it('reads the volume docker actually mounted at the postgres data dir', async () => {
    // A checkout in ~/code/tau-main gets the compose project name "taumain",
    // so the derived "tau_postgres-data" would name a volume that does not
    // exist. The mount table cannot be wrong.
    const rec = recordingRunner({
      'docker inspect': { stdout: mounts('taumain_postgres-data', '/var/lib/postgresql') },
    })
    expect(await containerVolumeName(rec.runner, 'postgres-tau', 'tau_postgres-data')).toBe('taumain_postgres-data')
    expect(rec.calls[0].command).toEqual(['docker', 'inspect', '-f', '{{json .Mounts}}', 'postgres-tau'])
  })
  it('accepts the compose-core data-dir layout too', async () => {
    const rec = recordingRunner({
      'docker inspect': { stdout: mounts('taumain_postgres-data', '/var/lib/postgresql/data') },
    })
    expect(await containerVolumeName(rec.runner, 'postgres-tau', 'tau_postgres-data')).toBe('taumain_postgres-data')
  })
  it('falls back to the derived name when the container or docker is gone', async () => {
    const rec = recordingRunner({ 'docker inspect': { code: 1, stdout: '' } })
    expect(await containerVolumeName(rec.runner, 'postgres-tau', 'tau_postgres-data')).toBe('tau_postgres-data')
  })
  it('falls back when no mount matches the postgres data dir', async () => {
    const rec = recordingRunner({
      'docker inspect': {
        stdout: JSON.stringify([{ Type: 'volume', Name: 'other', Destination: '/etc/config' }]),
      },
    })
    expect(await containerVolumeName(rec.runner, 'postgres-tau', 'tau_postgres-data')).toBe('tau_postgres-data')
  })
  it('falls back when the mount table is unparsable', async () => {
    const rec = recordingRunner({ 'docker inspect': { stdout: 'not json' } })
    expect(await containerVolumeName(rec.runner, 'postgres-tau', 'tau_postgres-data')).toBe('tau_postgres-data')
  })
})

describe('isPortInUse', () => {
  it('is true when something answers and false only on ECONNREFUSED', async () => {
    expect(await isPortInUse(5432, async () => {})).toBe(true)
    expect(
      await isPortInUse(5432, async () => {
        throw refused()
      })
    ).toBe(false)
    await expect(
      isPortInUse(5432, async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
      })
    ).rejects.toThrow(/timed out/)
  })
  it('reports an inconclusive probe as a SetupFailure naming the port and the error code', async () => {
    // Not a crash of ours: the operator has to look at that port, so say which
    // one and what the socket said, in the form the CLI prints cleanly.
    const inconclusive = isPortInUse(5433, async () => {
      throw Object.assign(new Error('timed out connecting to 127.0.0.1:5433'), { code: 'ETIMEDOUT' })
    })
    await expect(inconclusive).rejects.toBeInstanceOf(SetupFailure)
    await expect(inconclusive).rejects.toThrow(/port 5433/)
    await expect(inconclusive).rejects.toThrow(/ETIMEDOUT/)
  })
})

const smoke = { container: 'postgres-tau-smoke', volume: 'tau-smoke_postgres-data', port: 5433 }

describe('ensurePostgresContainer', () => {
  it('does nothing when the container is already running', async () => {
    const rec = recordingRunner({ 'docker inspect': { stdout: 'true\n' } })
    expect(await ensurePostgresContainer(rec.runner, smoke)).toBe('running')
    expect(rec.calls.map((c) => c.command)).toEqual([
      ['docker', 'inspect', '-f', '{{.State.Running}}', 'postgres-tau-smoke'],
    ])
  })
  it('starts an existing but stopped container (a compose-created one included)', async () => {
    const rec = recordingRunner({ 'docker inspect': { stdout: 'false\n' } })
    expect(await ensurePostgresContainer(rec.runner, smoke)).toBe('started')
    expect(rec.calls.at(-1)?.command).toEqual(['docker', 'start', 'postgres-tau-smoke'])
  })
  it('creates the container with the instance name, volume and loopback-only port mapping', async () => {
    const rec = recordingRunner({ 'docker inspect': { code: 1, stderr: 'Error: No such object: postgres-tau-smoke' } })
    expect(await ensurePostgresContainer(rec.runner, smoke)).toBe('created')
    expect(rec.calls.at(-1)?.command).toEqual([
      'docker',
      'run',
      '-d',
      '--name',
      'postgres-tau-smoke',
      '--restart',
      'unless-stopped',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=ficus',
      '-p',
      '127.0.0.1:5433:5432',
      '-v',
      'tau-smoke_postgres-data:/var/lib/postgresql',
      POSTGRES_IMAGE,
    ])
    expect(POSTGRES_IMAGE).toBe('paradedb/paradedb:latest')
  })
  it('boots a new container with the database, image and data dir it is given', async () => {
    const rec = recordingRunner({ 'docker inspect': { code: 1, stderr: 'no such object' } })
    await ensurePostgresContainer(rec.runner, {
      ...smoke,
      database: 'appdb',
      image: 'sha256:0123abcd',
      dataDir: '/var/lib/postgresql/data',
    })
    const run = rec.calls.at(-1)?.command ?? []
    expect(run).toContain('POSTGRES_DB=appdb')
    expect(run).toContain(`${smoke.volume}:/var/lib/postgresql/data`)
    expect(run.at(-1)).toBe('sha256:0123abcd')
  })
  it('inherits the terminal for the run/start calls only, so a first pull is visible', async () => {
    const created = recordingRunner({ 'docker inspect': { code: 1, stderr: 'no such object' } })
    await ensurePostgresContainer(created.runner, smoke, { inherit: true })
    // Inheriting the inspect would blank the stdout this function branches on.
    expect(created.calls[0].options.inherit).toBeFalsy()
    expect(created.calls.at(-1)?.command[1]).toBe('run')
    expect(created.calls.at(-1)?.options.inherit).toBe(true)
    const started = recordingRunner({ 'docker inspect': { stdout: 'false\n' } })
    await ensurePostgresContainer(started.runner, smoke, { inherit: true })
    expect(started.calls.at(-1)?.command[1]).toBe('start')
    expect(started.calls.at(-1)?.options.inherit).toBe(true)
    const quiet = recordingRunner({ 'docker inspect': { code: 1, stderr: 'no such object' } })
    await ensurePostgresContainer(quiet.runner, smoke)
    expect(quiet.calls.at(-1)?.options.inherit).toBeFalsy()
  })
  it('throws with docker stderr when the container cannot be created or started', async () => {
    const created = recordingRunner({
      'docker inspect': { code: 1, stderr: 'no such object' },
      'docker run': { code: 125, stderr: 'port is already allocated' },
    })
    await expect(ensurePostgresContainer(created.runner, smoke)).rejects.toThrow(/port is already allocated/)
    const started = recordingRunner({
      'docker inspect': { stdout: 'false\n' },
      'docker start': { code: 1, stderr: 'driver failed' },
    })
    await expect(ensurePostgresContainer(started.runner, smoke)).rejects.toThrow(/driver failed/)
  })
})

describe('waitForPostgres', () => {
  it('probes the named container and requires three consecutive successes', async () => {
    const codes = [1, 0, 0, 1, 0, 0, 0]
    let i = 0
    const commands: string[][] = []
    const runner = async (command: string[]) => {
      commands.push(command)
      return { code: codes[i++] ?? 1, stdout: '', stderr: '' }
    }
    await waitForPostgres(runner, 'postgres-tau-smoke', { attempts: 10, sleep: async () => {} })
    expect(i).toBe(7)
    // Over TCP, not the unix socket: the entrypoint's temporary init server
    // (initdb → init scripts → extension install) listens on the socket only,
    // and a socket probe reports "ready" minutes before the real server is.
    expect(commands[0]).toEqual([
      'docker',
      'exec',
      'postgres-tau-smoke',
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-tAc',
      'SELECT 1',
    ])
  })
  it('throws after the attempt budget, naming the container to look at', async () => {
    const runner = async () => ({ code: 1, stdout: '', stderr: 'no' })
    await expect(waitForPostgres(runner, 'postgres-tau-smoke', { attempts: 3, sleep: async () => {} })).rejects.toThrow(
      /postgres-tau-smoke did not become ready/
    )
  })
})

describe('ensureDatabase', () => {
  it('creates the database only when the existence query returns nothing', async () => {
    const present = recordingRunner({
      'docker exec postgres-tau-smoke psql -U postgres -tAc SELECT 1 FROM pg_database': { stdout: '1\n' },
    })
    await ensureDatabase(present.runner, 'postgres-tau-smoke', 'tau2')
    expect(present.calls.some((c) => c.command.includes('createdb'))).toBe(false)
    const absent = recordingRunner({
      'docker exec postgres-tau-smoke psql -U postgres -tAc SELECT 1 FROM pg_database': { stdout: '' },
    })
    await ensureDatabase(absent.runner, 'postgres-tau-smoke', 'tau2')
    expect(absent.calls.at(-1)?.command).toEqual([
      'docker',
      'exec',
      'postgres-tau-smoke',
      'createdb',
      '-U',
      'postgres',
      'tau2',
    ])
  })
  it('rejects a name that is not a safe identifier', async () => {
    const { runner } = recordingRunner()
    await expect(ensureDatabase(runner, 'postgres-tau', 'bad name')).rejects.toThrow(/identifier/)
  })
  it('rejects if the existence query fails', async () => {
    const rec = recordingRunner({
      'docker exec postgres-tau psql -U postgres -tAc SELECT 1 FROM pg_database': { code: 1, stderr: 'not ready' },
    })
    await expect(ensureDatabase(rec.runner, 'postgres-tau', 'tau2')).rejects.toThrow(/existence check failed/)
    await expect(ensureDatabase(rec.runner, 'postgres-tau', 'tau2')).rejects.toThrow(/not ready/)
    expect(rec.calls.some((c) => c.command.includes('createdb'))).toBe(false)
  })
})

describe('findFreePort', () => {
  it('returns the first port that refuses the connection, skipping the occupied ones', async () => {
    const tried: number[] = []
    // A resolved connect() means something is listening — that port is taken.
    const connect = async (_host: string, port: number) => {
      tried.push(port)
      if (port >= 5435) throw refused()
    }
    expect(await findFreePort(5433, connect)).toBe(5435)
    expect(tried).toEqual([5433, 5434, 5435])
  })
  it('refuses to call a port free on anything but ECONNREFUSED', async () => {
    // A DROPping firewall answers neither way: claiming the port and failing to
    // bind it is worse than saying so.
    const timeout = async () => {
      throw Object.assign(new Error('timed out connecting to 127.0.0.1:5433'), { code: 'ETIMEDOUT' })
    }
    await expect(findFreePort(5433, timeout)).rejects.toThrow(/timed out/)
    const denied = async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    await expect(findFreePort(5433, denied)).rejects.toThrow(/permission denied/)
  })
  it('gives up instead of scanning forever when everything answers', async () => {
    let tried = 0
    const connect = async () => {
      tried++
    }
    await expect(findFreePort(5433, connect)).rejects.toThrow(/no free port/)
    expect(tried).toBe(50)
  })
})

describe('waitForTcp', () => {
  it('retries the injected connect until it succeeds', async () => {
    let n = 0
    const connect = async () => {
      n++
      if (n < 3) throw new Error('refused')
    }
    await waitForTcp('h', 1, { attempts: 5, sleep: async () => {}, connect })
    expect(n).toBe(3)
  })
})
