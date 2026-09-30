import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EnvNamingError, PRE_FICUS_ENCRYPTION_KEY } from '@ficus/shared/env-naming'
import { recordingRunner } from './runner'
import { handoffLines, runSetup, type SetupDeps } from './setup'
import { readRegistry, upsertInstance } from './state'
import type { SetupOptions } from './types'
import { LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'

/** The two `docker inspect` calls the installer makes, as recordingRunner prefixes. */
const PORT_INSPECT = 'docker inspect -f {{json .}}'
const STATE_INSPECT = 'docker inspect -f {{.State.Running}}'

/** What a connect to a port nothing listens on rejects with — the only proof a port is free. */
const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-setup-')))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
  writeFileSync(join(root, '.bun-version'), '1.3.8\n')
  writeFileSync(
    join(root, '.env.example'),
    'FICUS_SERVE_WEB=1\nFICUS_ENCRYPTION_KEY=\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/tau\nFICUS_SANDBOX_RUNTIME=\n'
  )
  // The real example: the config-files step generates a per-instance config from it.
  copyFileSync(join(__dirname, '../../../../ecosystem.config.example.js'), join(root, 'ecosystem.config.example.js'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function opts(partial: Partial<SetupOptions> = {}): SetupOptions {
  return {
    root,
    runtime: 'host',
    supervisor: 'pm2',
    port: 3000,
    apiUrl: 'http://localhost:3000',
    appUrl: 'http://localhost:3000',
    databaseMode: 'compose',
    databaseUrl: 'postgres://postgres:postgres@localhost:5432/tau',
    dbName: 'tau',
    instance: 'ficus',
    makeDefault: false,
    start: true,
    dryRun: false,
    yes: true,
    rebuildImage: false,
    explicit: new Set(['runtime']),
    ...partial,
  }
}

function deps(responses: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const rec = recordingRunner({
    // No container yet: the default fixture exercises the create path.
    [PORT_INSPECT]: { code: 1, stderr: 'Error: No such object' },
    [STATE_INSPECT]: { code: 1, stderr: 'Error: No such object' },
    'docker exec postgres-ficus psql -U postgres -tAc SELECT 1 FROM pg_database': { stdout: '1\n' },
    'docker exec postgres-ficus-smoke psql -U postgres -tAc SELECT 1 FROM pg_database': { stdout: '1\n' },
    'bunx pm2 jlist': { stdout: '[]' },
    ...responses,
  })
  const lines: string[] = []
  const confirms: string[] = []
  // Defaults to "ficus is on PATH" (matches the installed binary these deps imply) so
  // the existing assertions below stay about setup itself, not the PATH hint — tests
  // for the hint construct their own SetupDeps directly (see "end-of-setup CLI PATH check").
  const home = '/home/fixture'
  const d: SetupDeps = {
    runner: rec.runner,
    env: { HOME: home },
    home,
    which: (cmd) => (cmd === 'ficus' ? join(home, '.ficus', 'bin', 'ficus') : null),
    preflight: {
      runner: rec.runner,
      platform: 'darwin',
      which: () => '/usr/bin/x',
      nodeVersion: async () => '24.21.0',
      bunVersion: () => '1.3.8',
      pinnedBunVersion: () => '1.3.8',
      browserPaths: () => ['/b'],
    },
    secrets: { hex32: () => 'ab'.repeat(32), token: () => 'bootstrap-token' },
    fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
    sleep: async () => {},
    // Nothing listens anywhere unless a test says so: no test may touch the network.
    connect: async () => {
      throw refused()
    },
    now: () => '2026-09-02T00:00:00.000Z',
    statePath: join(root, 'state.json'),
    isTTY: false,
    confirm: async (question) => {
      // record what was asked AND how far setup had got when it asked
      confirms.push(`${question} @${rec.calls.length}`)
      return true
    },
    log: (line) => lines.push(line),
  }
  return { d, calls: rec.calls, lines, confirms }
}

describe('runSetup', () => {
  it('runs every step in order for host + compose and writes env, state and handoff', async () => {
    const { d, calls, lines } = deps()
    const result = await runSetup(opts(), d)
    const joined = calls.map((c) => c.command.join(' '))
    expect(joined).toEqual([
      'docker info',
      'docker inspect -f {{json .}} postgres-ficus',
      'docker inspect -f {{.State.Running}} postgres-ficus',
      'docker run -d --name postgres-ficus --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tau -p 127.0.0.1:5432:5432 -v ficus_postgres-data:/var/lib/postgresql paradedb/paradedb:latest',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      "docker exec postgres-ficus psql -U postgres -tAc SELECT 1 FROM pg_database WHERE datname='tau'",
      'bun run db:migrate',
      'bun run build:core',
      'bun run build:cli',
      'bun run build:web',
      'bunx pm2 jlist',
      'bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env',
      'bunx pm2 save',
    ])
    const migrate = calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!
    expect(migrate.options.env).toEqual({
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/tau',
      FICUS_MIGRATE_LIVE: '1',
    })
    expect(migrate.options.cwd).toBe(root)
    const env = readFileSync(join(root, '.env'), 'utf8')
    expect(env).toContain('FICUS_SANDBOX_RUNTIME=host\n')
    expect(env).toContain(`FICUS_ENCRYPTION_KEY=${'ab'.repeat(32)}\n`)
    expect(env).toContain('FICUS_PASSWORD=bootstrap-token\n')
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(root, 'ecosystem.config.js'))).toBe(true)
    expect(readRegistry(join(root, 'state.json')).instances.ficus?.root).toBe(root)
    expect(result.handoff.join('\n')).toContain('http://localhost:3000')
    expect(result.handoff.join('\n')).toContain('passkey')
    expect(result.handoff.join('\n')).toContain('http://localhost:3000/#setup=bootstrap-token')
    expect(lines.some((l) => l.includes('Preflight'))).toBe(true)
  })
  it('refuses an install whose .env predates the Ficus naming before any command runs or any file changes', async () => {
    const old = `${PRE_FICUS_ENCRYPTION_KEY}=old-key-value\nOLD_PASSWORD=real-password\n`
    writeFileSync(join(root, '.env'), old)
    const before = readdirSync(root).sort()
    const { d, calls } = deps()
    const error = (await runSetup(opts(), d).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(EnvNamingError)
    expect(error.message).toContain(PRE_FICUS_ENCRYPTION_KEY)
    expect(error.message).toContain('nothing was written')
    expect(error.message).not.toContain('old-key-value')
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(old)
    expect(readdirSync(root).sort()).toEqual(before)
    expect(calls).toEqual([])
  })
  it('fails closed on a checkout whose package name is not "ficus", or cannot be read', async () => {
    writeFileSync(join(root, '.env'), 'FICUS_PASSWORD=real-password\n')
    for (const [contents, described] of [
      [JSON.stringify({ name: 'my-fork' }), 'is named "my-fork"'],
      ['{not json', 'could not be read'],
    ]) {
      writeFileSync(join(root, 'package.json'), contents)
      const { d, calls } = deps()
      await expect(runSetup(opts(), d)).rejects.toThrow(
        `${root} is not a Ficus checkout: its package.json ${described}, not "ficus"`
      )
      expect(calls).toEqual([])
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe('FICUS_PASSWORD=real-password\n')
    }
  })
  it('keeps an existing encryption key on re-run', async () => {
    writeFileSync(join(root, '.env'), 'FICUS_ENCRYPTION_KEY=keep-me\n')
    const { d } = deps()
    await runSetup(opts(), d)
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('FICUS_ENCRYPTION_KEY=keep-me\n')
  })
  it('dry run touches nothing and prints the plan with secrets redacted', async () => {
    const { d, calls, lines } = deps()
    await runSetup(opts({ dryRun: true }), d)
    // Both are read-only: preflight's docker check and the port lookup that
    // makes the printed plan name the port this instance would really use.
    expect(calls.map((c) => c.command.join(' '))).toEqual([
      'docker info',
      'docker inspect -f {{json .}} postgres-ficus',
    ])
    expect(existsSync(join(root, '.env'))).toBe(false)
    expect(lines.join('\n')).toContain('FICUS_ENCRYPTION_KEY=<redacted>')
    expect(lines.join('\n')).toContain('bun run db:migrate')
    expect(lines.join('\n')).not.toContain('ab'.repeat(32))
  })
  it('fails fast on a preflight failure', async () => {
    const { d, calls } = deps({ 'docker info': { code: 1 } })
    await expect(runSetup(opts(), d)).rejects.toThrow(/docker info/)
    expect(calls.length).toBe(1)
  })
  it('skips the image build when it exists and builds it when missing or forced', async () => {
    const present = deps({ 'docker image inspect tau-sandbox:latest': { code: 0 } })
    await runSetup(opts({ runtime: 'docker-socket' }), present.d)
    expect(present.calls.some((c) => c.command.join(' ') === 'bun run sandbox:build:docker')).toBe(false)
    const missing = deps({ 'docker image inspect tau-sandbox:latest': { code: 1 } })
    await runSetup(opts({ runtime: 'docker-socket' }), missing.d)
    expect(missing.calls.some((c) => c.command.join(' ') === 'bun run sandbox:build:docker')).toBe(true)
    const forced = deps({ 'docker image inspect tau-sandbox:latest': { code: 0 } })
    await runSetup(opts({ runtime: 'docker-socket', rebuildImage: true }), forced.d)
    expect(forced.calls.some((c) => c.command.join(' ') === 'bun run sandbox:build:docker')).toBe(true)
  })
  it('runs k3d:setup only when the cluster is absent', async () => {
    const absent = deps({ 'k3d cluster list': { stdout: '' } })
    await runSetup(opts({ runtime: 'k3d' }), absent.d)
    expect(absent.calls.some((c) => c.command.join(' ') === 'bun run k3d:setup')).toBe(true)
    const present = deps({ 'k3d cluster list': { stdout: 'tau-dev' } })
    await runSetup(opts({ runtime: 'k3d' }), present.d)
    expect(present.calls.some((c) => c.command.join(' ') === 'bun run k3d:setup')).toBe(false)
  })
  it('uses tcp wait instead of a container for an external database', async () => {
    const { d, calls } = deps()
    const connectCalls: [string, number][] = []
    d.connect = async (host, port) => {
      connectCalls.push([host, port])
    }
    await runSetup(opts({ databaseMode: 'external', databaseUrl: 'postgres://u:p@db.example:5432/x' }), d)
    expect(calls.some((c) => c.command.join(' ').startsWith('docker run'))).toBe(false)
    expect(calls.some((c) => c.command.join(' ').startsWith('docker inspect'))).toBe(false)
    // Only the readiness probe — an external database is never port-probed for a free slot.
    expect(connectCalls).toEqual([['db.example', 5432]])
  })
  it('gives a labelled instance its own container, volume and a free port from 5433 up', async () => {
    const { d, calls } = deps()
    const probed: number[] = []
    // A resolved connect means the port is taken; 5432 (the default instance's) is.
    d.connect = async (_host, port) => {
      probed.push(port)
      if (port !== 5432) throw refused()
    }
    await runSetup(
      opts({
        instance: 'smoke',
        port: 3100,
        apiUrl: 'http://localhost:3100',
        appUrl: 'http://localhost:3100',
        explicit: new Set(['runtime', 'instance', 'port']),
      }),
      d
    )
    // The scan starts at 5433: 5432 belongs to the default instance by rule, not by probe.
    expect(probed).toEqual([5433])
    const joined = calls.map((c) => c.command.join(' '))
    expect(joined).toContain('docker inspect -f {{.State.Running}} postgres-ficus-smoke')
    expect(joined).toContain(
      'docker run -d --name postgres-ficus-smoke --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tau -p 127.0.0.1:5433:5432 -v ficus-smoke_postgres-data:/var/lib/postgresql paradedb/paradedb:latest'
    )
    expect(
      joined.filter((c) => c === 'docker exec postgres-ficus-smoke psql -h 127.0.0.1 -U postgres -tAc SELECT 1')
    ).toHaveLength(3)
    expect(joined).toContain(
      "docker exec postgres-ficus-smoke psql -U postgres -tAc SELECT 1 FROM pg_database WHERE datname='tau'"
    )
    expect(joined).toContain(
      'bunx pm2 start ecosystem.config.js --only ficus-smoke-api,ficus-smoke-worker --update-env'
    )
    const url = 'postgres://postgres:postgres@localhost:5433/tau'
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`DATABASE_URL=${url}\n`)
    expect(calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!.options.env?.DATABASE_URL).toBe(url)
  })
  it('follows the port the instance own container already publishes, without probing', async () => {
    // The container's mapping is fixed at creation, and .env says nothing yet.
    const { d, calls } = deps({
      [PORT_INSPECT]: {
        stdout: JSON.stringify({ NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5433' }] } } }),
      },
      [STATE_INSPECT]: { stdout: 'true\n' },
    })
    const probed: number[] = []
    d.connect = async (_host, port) => {
      probed.push(port)
      throw refused()
    }
    await runSetup(opts({ instance: 'smoke', explicit: new Set(['runtime', 'instance']) }), d)
    expect(probed).toEqual([])
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'DATABASE_URL=postgres://postgres:postgres@localhost:5433/tau\n'
    )
    expect(calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!.options.env?.DATABASE_URL).toBe(
      'postgres://postgres:postgres@localhost:5433/tau'
    )
  })
  it('follows the mapping of a STOPPED container and refuses a --db-port it cannot honour', async () => {
    // Its live Ports are empty; only HostConfig.PortBindings says 5434.
    const stopped = {
      [PORT_INSPECT]: {
        stdout: JSON.stringify({
          NetworkSettings: { Ports: {} },
          HostConfig: { PortBindings: { '5432/tcp': [{ HostPort: '5434' }] } },
        }),
      },
      [STATE_INSPECT]: { stdout: 'false\n' },
    }
    const { d, calls } = deps(stopped)
    const probed: number[] = []
    d.connect = async (_host, port) => {
      probed.push(port)
      throw refused()
    }
    await runSetup(opts({ instance: 'smoke', explicit: new Set(['runtime', 'instance']) }), d)
    expect(probed).toEqual([])
    expect(calls.map((c) => c.command.join(' '))).toContain('docker start postgres-ficus-smoke')
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'DATABASE_URL=postgres://postgres:postgres@localhost:5434/tau\n'
    )
    const conflict = deps(stopped)
    await expect(
      runSetup(
        opts({ instance: 'smoke', dbPort: 5500, explicit: new Set(['runtime', 'instance', 'dbPort']) }),
        conflict.d
      )
    ).rejects.toThrow(
      'container postgres-ficus-smoke publishes 5434, not 5500; pass --db-port 5434 or remove the container'
    )
  })
  it('leaves a native loopback PostgreSQL alone instead of starting a container over it', async () => {
    // A hand-installed postgres on 5432 that this checkout already points at:
    // loopback, but not ours. Nothing may be created, and the DSN must survive.
    const dsn = 'postgres://me:pw@localhost:5432/app'
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dsn}\n`)
    const { d, calls, lines } = deps()
    d.connect = async () => {} // something IS listening on 5432
    await runSetup(opts(), d)
    const joined = calls.map((c) => c.command.join(' '))
    expect(
      joined.some((c) => c.startsWith('docker run') || c.startsWith('docker exec') || c.startsWith('docker start'))
    ).toBe(false)
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`DATABASE_URL=${dsn}\n`)
    expect(calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!.options.env?.DATABASE_URL).toBe(dsn)
    expect(lines).toContain('▸ PostgreSQL (external)')
  })
  it('treats a native loopback DSN as external even when its port is closed right now, and waits for it', async () => {
    // Credentials other than the container's mean a PostgreSQL the operator
    // runs. Whether it answers at this moment says nothing about whose it is:
    // no free-port probe, no container, and the readiness wait targets the DSN.
    const dsn = 'postgres://me:pw@localhost:5432/app'
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dsn}\n`)
    const { d, calls, lines } = deps()
    const connectCalls: [string, number][] = []
    d.connect = async (host, port) => {
      connectCalls.push([host, port])
      if (connectCalls.length < 3) throw refused() // closed at first; comes up during the wait
    }
    await runSetup(opts(), d)
    const joined = calls.map((c) => c.command.join(' '))
    expect(joined.filter((c) => c.startsWith('docker'))).toEqual(['docker info'])
    // Only waitForTcp (against the DSN's host) ever connected — never a 127.0.0.1 port scan.
    expect(connectCalls).toEqual([
      ['localhost', 5432],
      ['localhost', 5432],
      ['localhost', 5432],
    ])
    expect(lines).toContain('▸ PostgreSQL (external)')
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`DATABASE_URL=${dsn}\n`)
    expect(calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!.options.env?.DATABASE_URL).toBe(dsn)
  })
  it('refuses container flags when the checkout DATABASE_URL is a Postgres the installer does not manage', async () => {
    const dsn = 'postgres://me:pw@localhost:5432/app'
    writeFileSync(join(root, '.env'), `DATABASE_URL=${dsn}\n`)
    const message = `this checkout's DATABASE_URL points at a Postgres the installer does not manage (${dsn}); pass --database-url to change it, or remove DATABASE_URL from .env to let setup manage a container`
    const byPort = deps()
    await expect(runSetup(opts({ dbPort: 5433, explicit: new Set(['runtime', 'dbPort']) }), byPort.d)).rejects.toThrow(
      message
    )
    expect(byPort.calls.map((c) => c.command.join(' ')).filter((c) => c.startsWith('docker'))).toEqual(['docker info'])
    const byName = deps()
    await expect(
      runSetup(opts({ dbName: 'other', explicit: new Set(['runtime', 'dbName']) }), byName.d)
    ).rejects.toThrow(message)
    expect(byName.calls.map((c) => c.command.join(' ')).filter((c) => c.startsWith('docker'))).toEqual(['docker info'])
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`DATABASE_URL=${dsn}\n`)
  })
  it('follows the instance own container over a stale .env port, whoever holds that port now', async () => {
    // The installer wrote this line when the instance was on 5432, but its
    // container publishes 5433 and 5432 has since been taken by something else.
    // The container is ground truth: the stale line is rewritten to follow it,
    // and 5432 is never probed — its occupant is not this run's business.
    writeFileSync(
      join(root, '.env'),
      'FICUS_INSTANCE=smoke\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/tau\n'
    )
    const { d, calls } = deps({
      [PORT_INSPECT]: {
        stdout: JSON.stringify({ NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5433' }] } } }),
      },
      [STATE_INSPECT]: { stdout: 'true\n' },
    })
    const probed: number[] = []
    d.connect = async (_host, port) => {
      probed.push(port)
      if (port !== 5432) throw refused() // 5432 answers: someone else's postgres
    }
    await runSetup(opts({ instance: 'smoke', explicit: new Set(['runtime']) }), d)
    expect(probed).toEqual([])
    const joined = calls.map((c) => c.command.join(' '))
    expect(joined.some((c) => c.startsWith('docker run'))).toBe(false)
    expect(joined).toContain('docker exec postgres-ficus-smoke psql -h 127.0.0.1 -U postgres -tAc SELECT 1')
    const url = 'postgres://postgres:postgres@localhost:5433/tau'
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(`DATABASE_URL=${url}\n`)
    expect(calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!.options.env?.DATABASE_URL).toBe(url)
  })
  it('refuses to share a port that is occupied by something container-shaped but not our container', async () => {
    // Default credentials mean the installer wrote this line, so whatever holds
    // 5433 is another container-shaped install — sharing it would corrupt both.
    writeFileSync(
      join(root, '.env'),
      'FICUS_INSTANCE=smoke\nDATABASE_URL=postgres://postgres:postgres@localhost:5433/tau\n'
    )
    const { d, calls } = deps()
    d.connect = async (_host, port) => {
      if (port !== 5433) throw refused() // 5434 is free — the suggestion
    }
    await expect(runSetup(opts({ instance: 'smoke', explicit: new Set(['runtime']) }), d)).rejects.toThrow(
      'port 5433 is in use but is not container postgres-ficus-smoke — stop whatever listens there, pass --db-port 5434, or use --database-url for an external database'
    )
    expect(calls.some((c) => c.command.join(' ').startsWith('docker run'))).toBe(false)
  })
  it('manages the container normally when it is the one publishing that port', async () => {
    writeFileSync(
      join(root, '.env'),
      'FICUS_INSTANCE=smoke\nDATABASE_URL=postgres://postgres:postgres@localhost:5433/tau\n'
    )
    const { d, calls } = deps({
      [PORT_INSPECT]: {
        stdout: JSON.stringify({ NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5433' }] } } }),
      },
      [STATE_INSPECT]: { stdout: 'true\n' },
    })
    // Our own postgres is listening on 5433 — that must not read as a collision.
    d.connect = async () => {}
    await runSetup(opts({ instance: 'smoke', explicit: new Set(['runtime']) }), d)
    const joined = calls.map((c) => c.command.join(' '))
    expect(joined).toContain('docker exec postgres-ficus-smoke psql -h 127.0.0.1 -U postgres -tAc SELECT 1')
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'DATABASE_URL=postgres://postgres:postgres@localhost:5433/tau\n'
    )
  })
  it('refuses a database name adopted from the DSN that is not a safe identifier', async () => {
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/my-db\n')
    const { d, calls } = deps()
    await expect(runSetup(opts(), d)).rejects.toThrow(
      `database name "my-db" from this checkout's DATABASE_URL is not a safe identifier — pass --db-name or --database-url`
    )
    // Nothing was created before the refusal.
    expect(calls.some((c) => c.command.join(' ').startsWith('docker run'))).toBe(false)
  })
  it('refuses a --db-port the existing container cannot publish', async () => {
    const { d } = deps({
      [PORT_INSPECT]: {
        stdout: JSON.stringify({ NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: '5433' }] } } }),
      },
    })
    await expect(
      runSetup(opts({ instance: 'smoke', dbPort: 5500, explicit: new Set(['runtime', 'instance', 'dbPort']) }), d)
    ).rejects.toThrow(
      'container postgres-ficus-smoke publishes 5433, not 5500; pass --db-port 5433 or remove the container'
    )
  })
  it('reuses the database name the checkout DSN names, so every step targets it', async () => {
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/other\n')
    const { d, calls } = deps({
      'docker exec postgres-ficus psql -U postgres -tAc SELECT 1 FROM pg_database': { stdout: '' },
    })
    await runSetup(opts(), d)
    expect(calls.find((c) => c.command.join(' ') === 'bun run db:migrate')!.options.env?.DATABASE_URL).toBe(
      'postgres://postgres:postgres@localhost:5432/other'
    )
    const joined = calls.map((c) => c.command.join(' '))
    expect(joined).toContain(
      "docker exec postgres-ficus psql -U postgres -tAc SELECT 1 FROM pg_database WHERE datname='other'"
    )
    expect(joined).toContain('docker exec postgres-ficus createdb -U postgres other')
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'DATABASE_URL=postgres://postgres:postgres@localhost:5432/other\n'
    )
  })
  it('says the container is starting before a pull that can take minutes', async () => {
    const { d, lines, calls } = deps()
    await runSetup(opts(), d)
    expect(lines).toContain(
      'Starting PostgreSQL container postgres-ficus (a first run pulls paradedb/paradedb — this can take a few minutes)'
    )
    // The pull's own progress needs the terminal; the inspect it branches on does not.
    const byName = (name: string) => calls.find((c) => c.command[1] === name)
    expect(byName('run')?.options.inherit).toBe(true)
    expect(byName('inspect')?.options.inherit).toBeFalsy()
  })
  it('never rewrites a DATABASE_URL the checkout already carries to somewhere else', async () => {
    // Hand-pointed at an external database, then re-run without --database-url:
    // the resolved local port must not overwrite the operator's DSN.
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://u:p@db.example:5432/x\n')
    const { d } = deps()
    await runSetup(opts(), d)
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('DATABASE_URL=postgres://u:p@db.example:5432/x\n')
  })
  it('keeps the port the .env already names when a labelled instance is re-run', async () => {
    const first = deps()
    first.d.connect = async (_host, port) => {
      if (port !== 5432) throw refused()
    }
    const labelled = opts({
      instance: 'smoke',
      port: 3100,
      apiUrl: 'http://localhost:3100',
      appUrl: 'http://localhost:3100',
      explicit: new Set(['runtime', 'instance', 'port']),
    })
    await runSetup(labelled, first.d)
    const second = deps()
    const probed: number[] = []
    second.d.connect = async (_host, port) => {
      probed.push(port)
      throw refused()
    }
    await runSetup(labelled, second.d)
    // The port this instance already published is not renegotiated: the only
    // probe is the "is someone else already serving this DSN?" check, and a
    // refusal means the port is ours to keep. No free-port scan (no 5434+).
    expect(probed).toEqual([5433])
    expect(second.calls.map((c) => c.command.join(' '))).toContain(
      'docker inspect -f {{.State.Running}} postgres-ficus-smoke'
    )
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'DATABASE_URL=postgres://postgres:postgres@localhost:5433/tau\n'
    )
  })
  it('honours an explicit --db-port over both the probe and the .env', async () => {
    const { d, calls } = deps()
    const probed: number[] = []
    d.connect = async (_host, port) => {
      probed.push(port)
      throw refused()
    }
    await runSetup(opts({ instance: 'smoke', dbPort: 6000, explicit: new Set(['runtime', 'instance', 'dbPort']) }), d)
    expect(probed).toEqual([])
    expect(calls.map((c) => c.command.join(' ')).some((c) => c.includes('-p 127.0.0.1:6000:5432'))).toBe(true)
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'DATABASE_URL=postgres://postgres:postgres@localhost:6000/tau\n'
    )
  })
  it('refuses to start when pm2 already runs ficus from another root', async () => {
    const { d } = deps({
      'bunx pm2 jlist': {
        stdout: JSON.stringify([{ name: 'ficus-api', pid: 1, pm2_env: { status: 'online', pm_cwd: '/elsewhere' } }]),
      },
    })
    // Both ways out are named: relabel this checkout, or uninstall the other one.
    await expect(runSetup(opts(), d)).rejects.toThrow(
      'pm2 already runs ficus-api for instance "ficus" from another checkout (/elsewhere). Give this checkout its own label with --instance <other-label>, or ficus server uninstall --root /elsewhere the other one'
    )
  })
  it('does not block start on a stopped pm2 row from another checkout', async () => {
    const { d, calls } = deps({
      'bunx pm2 jlist': {
        stdout: JSON.stringify([{ name: 'ficus-api', pid: 0, pm2_env: { status: 'stopped', pm_cwd: '/elsewhere' } }]),
      },
    })
    await runSetup(opts(), d)
    expect(
      calls.some(
        (c) => c.command.join(' ') === 'bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env'
      )
    ).toBe(true)
  })
  it('honours --no-start', async () => {
    const { d, calls } = deps()
    await runSetup(opts({ start: false }), d)
    expect(calls.some((c) => c.command[1] === 'pm2')).toBe(false)
  })
  it('fails when the health probe never succeeds', async () => {
    const { d } = deps()
    d.fetch = async () => new Response('', { status: 503 })
    await expect(runSetup(opts(), d)).rejects.toThrow(/health/)
  })
  it('treats a 401 health probe as up (auth-gated /api/*, FICUS_PASSWORD is set by this same run)', async () => {
    const { d } = deps()
    d.fetch = async () => new Response('', { status: 401 })
    await expect(runSetup(opts(), d)).resolves.toBeTruthy()
  })
  it('probes the public root /health route, not the auth-gated /api/health', async () => {
    const { d } = deps()
    const urls: string[] = []
    d.fetch = async (input) => {
      urls.push(String(input))
      return new Response('{"status":"ok"}', { status: 200 })
    }
    await runSetup(opts(), d)
    expect(urls).toEqual(['http://localhost:3000/health'])
  })
  it('shows the plan and asks for confirmation on a TTY without --yes, then runs the steps', async () => {
    const { d, calls, lines, confirms } = deps()
    d.isTTY = true
    await runSetup(opts({ yes: false }), d)
    // asked once, after the two read-only probes (preflight's `docker info` and
    // the container port lookup) and before any step ran
    expect(confirms).toEqual(['Proceed with setup? @2'])
    // plan-only lines (the run loop logs titles, never the plan bodies)
    expect(lines).toContain('    bun run db:migrate (FICUS_MIGRATE_LIVE=1, DATABASE_URL explicit)')
    expect(lines).toContain(
      '    docker run paradedb/paradedb:latest as postgres-ficus on 127.0.0.1:5432 (or start the existing container)'
    )
    expect(calls.some((c) => c.command.join(' ') === 'bun run db:migrate')).toBe(true)
  })
  it('runs no step and rejects when the confirmation is declined', async () => {
    const { d, calls } = deps()
    d.isTTY = true
    d.confirm = async () => false
    await expect(runSetup(opts({ yes: false }), d)).rejects.toThrow(/cancelled/i)
    // Both are read-only: preflight's docker check and the port lookup that
    // makes the printed plan name the port this instance would really use.
    expect(calls.map((c) => c.command.join(' '))).toEqual([
      'docker info',
      'docker inspect -f {{json .}} postgres-ficus',
    ])
    expect(existsSync(join(root, '.env'))).toBe(false)
  })
  it('registers the instance under its label, and the first install becomes the default', async () => {
    const { d } = deps()
    await runSetup(
      opts({
        instance: 'smoke',
        port: 3100,
        apiUrl: 'http://localhost:3100',
        appUrl: 'http://localhost:3100',
        explicit: new Set(['runtime', 'instance']),
      }),
      d
    )
    expect(readRegistry(join(root, 'state.json'))).toEqual({
      version: 3,
      default: 'smoke',
      instances: {
        smoke: {
          root,
          port: 3100,
          supervisor: 'pm2',
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          identity: 2,
        },
      },
    })
  })
  it('a second instance keeps the existing default unless it asks for it, and keeps its own createdAt', async () => {
    const statePath = join(root, 'state.json')
    upsertInstance(
      'tau',
      { root: '/elsewhere', port: 3000, supervisor: 'pm2', createdAt: 'c', updatedAt: 'u' },
      {},
      statePath
    )
    const smoke = (partial: Partial<SetupOptions> = {}) =>
      opts({
        instance: 'smoke',
        port: 3100,
        apiUrl: 'http://localhost:3100',
        appUrl: 'http://localhost:3100',
        explicit: new Set(['runtime', 'instance']),
        ...partial,
      })
    const first = deps()
    await runSetup(smoke(), first.d)
    expect(readRegistry(statePath).default).toBe('tau')
    expect(Object.keys(readRegistry(statePath).instances).sort()).toEqual(['smoke', 'tau'])

    const second = deps()
    second.d.now = () => 'later'
    await runSetup(smoke({ makeDefault: true }), second.d)
    const registry = readRegistry(statePath)
    expect(registry.default).toBe('smoke')
    expect(registry.instances.smoke).toEqual({
      root,
      port: 3100,
      supervisor: 'pm2',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: 'later',
      identity: 2,
    })
    expect(registry.instances.tau).toEqual({
      root: '/elsewhere',
      port: 3000,
      supervisor: 'pm2',
      createdAt: 'c',
      updatedAt: 'u',
    })
  })
  it('does not confirm with --yes, nor without a TTY', async () => {
    const yes = deps()
    yes.d.isTTY = true
    await runSetup(opts({ yes: true }), yes.d)
    expect(yes.confirms).toEqual([])
    const headless = deps()
    headless.d.isTTY = false
    await runSetup(opts({ yes: false }), headless.d)
    expect(headless.confirms).toEqual([])
  })
})

describe('canonical checkout identity', () => {
  it('mutation-red: a symlink alias cannot re-register a registered checkout under another supervisor', async () => {
    const { d, calls } = deps()
    upsertInstance(
      'ficus',
      { root, port: 3000, supervisor: 'pm2', createdAt: 'c', updatedAt: 'u', identity: 2 },
      {},
      d.statePath
    )
    const alias = join(root, '..', 'ficus-alias')
    symlinkSync(realpathSync(root), alias)
    try {
      await expect(runSetup(opts({ root: alias, supervisor: 'systemd-user' }), d)).rejects.toThrow(
        /registered as instance "ficus" with pm2/
      )
      expect(calls).toEqual([])
      expect(existsSync(join(root, '.env'))).toBe(false)
      expect(readRegistry(d.statePath).instances.ficus?.supervisor).toBe('pm2')
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('persists the canonical root, so later root lookups match through aliases', async () => {
    const { d } = deps()
    await runSetup(opts({}), d)
    expect(readRegistry(d.statePath).instances.ficus?.root).toBe(realpathSync(root))
  })

  it('preserves createdAt when setup reaches an existing checkout through a symlink alias', async () => {
    const { d } = deps()
    upsertInstance(
      'ficus',
      { root, port: 3000, supervisor: 'pm2', createdAt: 'created', updatedAt: 'old', identity: 2 },
      {},
      d.statePath
    )
    const alias = join(root, '..', 'ficus-rerun-alias')
    symlinkSync(root, alias)
    try {
      await runSetup(opts({ root: alias }), d)
      expect(readRegistry(d.statePath).instances.ficus).toMatchObject({
        root: realpathSync(root),
        createdAt: 'created',
        updatedAt: '2026-09-02T00:00:00.000Z',
      })
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('finds a migrated v2 registration through its alias: a pre-rename instance, sent to rename-identity', async () => {
    const { d, calls } = deps()
    const alias = join(root, '..', 'ficus-v2-alias')
    symlinkSync(root, alias)
    const v2 = JSON.stringify({
      version: 2,
      default: LEGACY_LOCAL_INSTANCE,
      instances: { [LEGACY_LOCAL_INSTANCE]: { root: alias, port: 3000, createdAt: 'legacy' } },
    })
    writeFileSync(d.statePath, v2)
    try {
      await expect(runSetup(opts({ root, instance: LEGACY_LOCAL_INSTANCE }), d)).rejects.toThrow(
        `ficus server rename-identity --root ${realpathSync(root)}`
      )
      expect(calls).toEqual([])
      expect(readFileSync(d.statePath, 'utf8')).toBe(v2)
    } finally {
      rmSync(alias, { force: true })
    }
  })
})

describe('PM2 handoff guidance', () => {
  it('prints the optional startup command only for explicit PM2 supervision', () => {
    expect(handoffLines(opts({ supervisor: 'pm2' })).join('\n')).toContain(`cd ${root} && bunx pm2 startup`)
    expect(handoffLines(opts({ supervisor: 'launchd' })).join('\n')).not.toContain('pm2 startup')
  })
})

describe('handoffLines PATH hint', () => {
  it('adds nothing next to step 3 when no hint is given (ficus is on PATH)', () => {
    const lines = handoffLines(opts())
    expect(lines.join('\n')).not.toContain('not on PATH')
  })

  it('inserts the given hint right after step 3, before "Manage it:"', () => {
    const lines = handoffLines(opts(), undefined, [
      'ficus is not on PATH yet (installed at /x/ficus).',
      '  ...or open a new terminal.',
    ])
    const step3 = lines.findIndex((l) => l.includes('3. CLI:'))
    const hint = lines.findIndex((l) => l.includes('not on PATH yet'))
    const manage = lines.findIndex((l) => l.includes('Manage it:'))
    expect(step3).toBeGreaterThan(-1)
    expect(hint).toBeGreaterThan(step3)
    expect(manage).toBeGreaterThan(hint)
  })
})

describe('end-of-setup CLI PATH check', () => {
  const home = '/home/fixture'
  const installedBinary = join(home, '.ficus', 'bin', 'ficus')

  it('runSetup reports cliOnPath: true and prints no PATH hint when ficus resolves to the installed binary', async () => {
    const { d } = deps()
    const result = await runSetup(opts(), {
      ...d,
      env: { HOME: home },
      home,
      which: (cmd) => (cmd === 'ficus' ? installedBinary : null),
    })
    expect(result.cliOnPath).toBe(true)
    expect(result.handoff.join('\n')).not.toContain('not on PATH')
  })

  it('runSetup reports cliOnPath: false and prints a zsh-flavored copy-pasteable fix when ficus is not on PATH', async () => {
    const { d } = deps()
    const result = await runSetup(opts(), {
      ...d,
      env: { HOME: home, SHELL: '/bin/zsh' },
      home,
      which: () => null,
    })
    expect(result.cliOnPath).toBe(false)
    const handoff = result.handoff.join('\n')
    expect(handoff).toContain(`ficus is not on PATH yet (installed at ${installedBinary})`)
    expect(handoff).toContain(`export PATH="${join(home, '.ficus', 'bin')}:$PATH"`)
    expect(handoff).toContain(`>> ~/.zshrc`)
    expect(handoff).toContain('or open a new terminal')
  })

  it('runSetup gives the fish equivalent (no ~/.zshrc / ~/.bashrc guess) when $SHELL is fish', async () => {
    const { d } = deps()
    const result = await runSetup(opts(), {
      ...d,
      env: { HOME: home, SHELL: '/usr/local/bin/fish' },
      home,
      which: () => null,
    })
    const handoff = result.handoff.join('\n')
    expect(handoff).toContain(`set -gx PATH "${join(home, '.ficus', 'bin')}" $PATH`)
    expect(handoff).toContain(`fish_add_path ${join(home, '.ficus', 'bin')}`)
    expect(handoff).not.toContain('.zshrc')
    expect(handoff).not.toContain('.bashrc')
  })

  it('runSetup never logs the setup password/link as part of the PATH hint', async () => {
    const { d, lines } = deps()
    await runSetup(opts(), { ...d, env: { HOME: home }, home, which: () => null })
    const pathHintLines = lines.filter((l) => l.includes('not on PATH') || l.includes('export PATH'))
    expect(pathHintLines.some((l) => l.includes('#setup='))).toBe(false)
  })
})

describe('instances installed before the Ficus rename', () => {
  it('refuses a checkout registered under its pre-rename names and points at rename-identity', async () => {
    const { d, calls } = deps()
    upsertInstance(
      LEGACY_LOCAL_INSTANCE,
      { root, port: 3000, supervisor: 'pm2', createdAt: 'c', updatedAt: 'u' },
      {},
      d.statePath
    )
    await expect(runSetup(opts({ instance: LEGACY_LOCAL_INSTANCE }), d)).rejects.toThrow(
      `ficus server rename-identity --root ${root}`
    )
    expect(calls).toEqual([])
    expect(existsSync(join(root, '.env'))).toBe(false)
  })
  it('refuses an unregistered checkout whose .env still names the pre-rename default instance', async () => {
    const { d, calls } = deps()
    writeFileSync(join(root, '.env'), `FICUS_INSTANCE=${LEGACY_LOCAL_INSTANCE}\n`)
    await expect(runSetup(opts({ instance: LEGACY_LOCAL_INSTANCE }), d)).rejects.toThrow(/rename-identity/)
    expect(calls).toEqual([])
  })
})

describe('supervisor migration safety', () => {
  it('refuses a supervisor change before preflight or mutation', async () => {
    const { d, calls } = deps()
    upsertInstance(
      'ficus',
      { root, port: 3000, supervisor: 'pm2', createdAt: 'c', updatedAt: 'u', identity: 2 },
      {},
      d.statePath
    )
    await expect(runSetup(opts({ supervisor: 'launchd' }), d)).rejects.toThrow(
      /registered.*pm2.*uninstall.*--supervisor launchd/i
    )
    expect(calls).toEqual([])
    expect(existsSync(join(root, '.env'))).toBe(false)
  })
})
