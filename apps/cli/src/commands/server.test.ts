import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { isJsonMode, output, outputError, setOutputOptions } from '../output'
import { EnvNamingError, PRE_FICUS_ENCRYPTION_KEY } from '@ficus/shared/env-naming'
import { recordingRunner } from '../local-server/runner'
import { getStatePath, readRegistry, upsertInstance } from '../local-server/state'
const LEGACY_HOME_DIR_NAME = '.tau'
const LEGACY_LOCAL_INSTANCE = 'tau'
import { cliHome } from '../local-server/home-move'
import { registerServerCommands, type ServerDeps } from './server'

let root: string
let statePath: string
let savedExitCode: number | string | undefined
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-server-')))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
  writeFileSync(
    join(root, '.env'),
    'PORT=3000\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/ficus\nFICUS_SANDBOX_RUNTIME=host\n'
  )
  statePath = join(root, 'state.json')
  upsertInstance(
    'ficus',
    { root, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
    { makeDefault: true },
    statePath
  )
  ;(output as ReturnType<typeof mock>).mockClear()
  ;(outputError as ReturnType<typeof mock>).mockClear()
  ;(setOutputOptions as ReturnType<typeof mock>).mockClear()
  // guarded() sets process.exitCode on error paths; save/reset so one test's
  // failure path doesn't leak into `bun test`'s own exit code.
  savedExitCode = process.exitCode
  process.exitCode = 0
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  process.exitCode = savedExitCode
})

function make(
  responses: Record<string, { code?: number; stdout?: string; stderr?: string }> = {},
  depsOverrides: Partial<ServerDeps> = {}
) {
  const rec = recordingRunner({ 'bunx pm2 jlist': { stdout: '[]' }, ...responses })
  const deps: ServerDeps = {
    runner: rec.runner,
    env: {},
    cwd: tmpdir(),
    statePath,
    fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
    isTTY: false,
    prompter: { select: async () => 'host', confirm: async () => true },
    sleep: async () => {},
    which: (cmd) => (['git', 'bun'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    renameJournalPath: join(root, 'rename-identity.journal'),
    ...depsOverrides,
  }
  async function run(args: string[]) {
    const program = new Command()
    program.exitOverride()
    registerServerCommands(program, deps)
    await program.parseAsync(args, { from: 'user' })
  }
  return { run, calls: rec.calls, deps }
}

const joined = (calls: { command: string[] }[]) => calls.map((c) => c.command.join(' '))

/** A recording runner whose `git clone` actually creates a fake checkout at `installRoot`. */
function cloningRunner(installRoot: string) {
  const rec = recordingRunner({ 'bun --version': { stdout: '1.3.8\n' } })
  const runner = async (
    command: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined>; inherit?: boolean }
  ) => {
    const r = await rec.runner(command, options)
    if (command[0] === 'git' && command[1] === 'clone') {
      mkdirSync(join(installRoot, '.git'), { recursive: true })
      writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ name: 'ficus' }))
      writeFileSync(join(installRoot, '.bun-version'), '1.3.8\n')
    }
    return r
  }
  return { runner, calls: rec.calls }
}

describe('ficus server', () => {
  it('start brings up the managed postgres container and pm2 from the state-file root', async () => {
    const { run, calls } = make({ 'docker inspect': { stdout: 'true\n' } })
    await run(['server', 'start'])
    expect(joined(calls)).toEqual([
      'docker inspect -f {{.State.Running}} postgres-ficus',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env',
    ])
    expect(calls.at(-1)?.options.cwd).toBe(root)
  })
  it('start creates the instance container, volume and port when it does not exist yet', async () => {
    writeFileSync(
      join(root, '.env'),
      'FICUS_INSTANCE=smoke\nPORT=3100\nDATABASE_URL=postgres://postgres:postgres@localhost:5433/ficus\n'
    )
    const { run, calls } = make({ 'docker inspect': { code: 1, stderr: 'Error: No such object' } })
    await run(['server', 'start'])
    expect(joined(calls)).toEqual([
      'docker inspect -f {{.State.Running}} postgres-ficus',
      'docker run -d --name postgres-ficus --restart unless-stopped -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ficus -p 127.0.0.1:5433:5432 -v ficus_postgres-data:/var/lib/postgresql paradedb/paradedb:latest',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env',
    ])
    // The pull's progress needs the terminal; the inspect it branches on must not have it.
    expect(calls.find((c) => c.command[1] === 'run')?.options.inherit).toBe(true)
    expect(calls.find((c) => c.command[1] === 'inspect')?.options.inherit).toBeFalsy()
  })
  // A container recreated for an existing checkout must boot the database its
  // DATABASE_URL names, not the installer's current default.
  it('start creates a missing container with the database DATABASE_URL names', async () => {
    writeFileSync(join(root, '.env'), 'PORT=3000\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/appdb\n')
    const { run, calls } = make({ 'docker inspect': { code: 1, stderr: 'Error: No such object' } })
    await run(['server', 'start'])
    expect(outputError).not.toHaveBeenCalled()
    expect(calls.find((c) => c.command[1] === 'run')?.command).toContain('POSTGRES_DB=appdb')
  })
  it('narrates the container start, but not under --json', async () => {
    const capture = async (json: boolean) => {
      const { run } = make({ 'docker inspect': { stdout: 'true\n' } })
      const printed: string[] = []
      const realLog = console.log
      console.log = (line?: unknown) => void printed.push(String(line))
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(json)
      try {
        await run(['server', 'start'])
      } finally {
        console.log = realLog
        ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      }
      return printed.some((l) => l.includes('Starting PostgreSQL container postgres-ficus'))
    }
    // A pull can take minutes, so say so — unless --json promised one
    // machine-readable document on stdout.
    expect(await capture(false)).toBe(true)
    expect(await capture(true)).toBe(false)
  })
  it('start touches no container for an external database', async () => {
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://u:p@db.example:5432/x\n')
    const { run, calls } = make()
    await run(['server', 'start'])
    expect(joined(calls)).toEqual(['bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env'])
  })
  it('start leaves a native loopback PostgreSQL alone and still starts pm2', async () => {
    // Loopback with the operator's own credentials is not our container (setup
    // treats it as external): a docker run on its port would only fail with
    // "port is already allocated" and pm2 would never be reached.
    writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://me:pw@localhost:5432/app\n')
    const { run, calls } = make()
    await run(['server', 'start'])
    expect(joined(calls)).toEqual(['bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env'])
  })
  it('stop and restart address the two apps', async () => {
    const { run, calls } = make()
    await run(['server', 'stop'])
    await run(['server', 'restart'])
    expect(joined(calls)).toEqual([
      'bunx pm2 stop ficus-api ficus-worker',
      'bunx pm2 restart ficus-worker --update-env',
      'bunx pm2 restart ficus-api --update-env',
    ])
  })
  describe('on a checkout whose .env predates the Ficus naming', () => {
    const old = `${PRE_FICUS_ENCRYPTION_KEY}=old-key-value\nFICUS_SANDBOX_RUNTIME=host\n`
    beforeEach(() => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
      writeFileSync(join(root, '.env'), old)
    })

    for (const verb of ['start', 'restart']) {
      it(`${verb} refuses with EnvNamingError, leaves .env byte-identical and starts nothing`, async () => {
        const before = readdirSync(root).sort()
        const { run, calls } = make()
        await run(['server', verb])
        expect(calls).toEqual([])
        const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
        expect(error).toBeInstanceOf(EnvNamingError)
        expect(error.message).toContain(PRE_FICUS_ENCRYPTION_KEY)
        expect(error.message).not.toContain('old-key-value')
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe(old)
        expect(readdirSync(root).sort()).toEqual(before)
      })
    }
  })
  it('start and restart warn when the built web bundle was made for a different base path', async () => {
    writeFileSync(
      join(root, '.env'),
      'PORT=3000\nDATABASE_URL=postgres://user:pw@db.example.com:5432/ficus\nAPP_BASE_PATH=/ficus\n'
    )
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true })
    writeFileSync(
      join(root, 'apps', 'web', 'dist', 'index.html'),
      '<script type="module" crossorigin src="/assets/index-abc.js"></script>'
    )
    const capture = async (args: string[], json: boolean) => {
      const { run } = make()
      const printed: string[] = []
      const realLog = console.log
      console.log = (line?: unknown) => void printed.push(String(line))
      ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(json)
      try {
        await run(args)
      } finally {
        console.log = realLog
        ;(isJsonMode as ReturnType<typeof mock>).mockReturnValue(false)
      }
      const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>]
      return { printed, data }
    }
    for (const verb of ['start', 'restart']) {
      const { printed, data } = await capture(['server', verb], false)
      const line = printed.find((l) => l.includes('warning:'))
      expect(line).toContain('built for base "/"')
      expect(line).toContain('APP_BASE_PATH=/ficus')
      expect(line).toContain('bun run build:web')
      expect(data.warnings).toEqual([expect.stringContaining('built for base "/"')])
    }
    // --json promised one machine-readable document: the warning rides in it, not stdout.
    const { printed, data } = await capture(['server', 'restart'], true)
    expect(printed.some((l) => l.includes('warning:'))).toBe(false)
    expect(data.warnings).toEqual([expect.stringContaining('built for base "/"')])
  })
  it('start and restart stay quiet when the bundle matches the base path', async () => {
    writeFileSync(join(root, '.env'), 'PORT=3000\nAPP_BASE_PATH=/ficus\n')
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true })
    writeFileSync(
      join(root, 'apps', 'web', 'dist', 'index.html'),
      '<script type="module" crossorigin src="/ficus/assets/index-abc.js"></script>'
    )
    const { run } = make()
    await run(['server', 'restart'])
    const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>]
    expect(data.warnings).toBeUndefined()
  })
  it('status reports root, processes and health', async () => {
    const { run } = make({
      'bunx pm2 jlist': {
        stdout: JSON.stringify([{ name: 'ficus-api', pid: 5, pm2_env: { status: 'online', pm_cwd: root } }]),
      },
      'git rev-parse --short HEAD': { stdout: 'abc1234\n' },
    })
    await run(['server', 'status'])
    const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>]
    expect(data.root).toBe(root)
    expect(data.instance).toBe('ficus')
    expect(data.port).toBe(3000)
    expect(data.runtime).toBe('host')
    expect(data.commit).toBe('abc1234')
    expect(data.health).toBe('ok')
    expect((data.processes as { name: string; status: string }[])[0]).toEqual({
      name: 'ficus-api',
      status: 'online',
      pid: 5,
      cwd: root,
    })
  })
  it('status reports the instance label and its pm2 apps', async () => {
    writeFileSync(join(root, '.env'), 'FICUS_INSTANCE=smoke\nPORT=3100\n')
    const { run, calls } = make()
    await run(['server', 'status'])
    const [data, text] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>, string]
    expect(data.instance).toBe('ficus')
    expect(text).toContain('instance: ficus')
    expect(text).toContain('ficus-api: not registered')
    expect(joined(calls)).toContain('bunx pm2 jlist')
  })
  it('probes the public root /health route (/api/health is 401-only behind identity middleware)', async () => {
    const { run, deps } = make()
    const urls: string[] = []
    deps.fetch = async (input) => {
      urls.push(String(input))
      return new Response('{"status":"ok"}', { status: 200 })
    }
    await run(['server', 'status'])
    expect(urls).toEqual(['http://localhost:3000/health'])
  })
  it('status treats a 401 health probe as ok (auth-gated /api/*, not a downed API)', async () => {
    const { run, deps } = make()
    deps.fetch = async () => new Response('', { status: 401 })
    await run(['server', 'status'])
    const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>]
    expect(data.health).toBe('ok')
  })
  it('status reports a non-401 error status verbatim', async () => {
    const { run, deps } = make()
    deps.fetch = async () => new Response('', { status: 503 })
    await run(['server', 'status'])
    const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>]
    expect(data.health).toBe('http 503')
  })
  it('logs passes component and line count through to pm2', async () => {
    const { run, calls } = make()
    await run(['server', 'logs', '-c', 'worker', '-n', '20'])
    expect(joined(calls)).toEqual(['bunx pm2 logs ficus-worker --lines 20 --nostream'])
    await run(['server', 'logs', '-f'])
    expect(joined(calls).at(-1)).toBe('bunx pm2 logs ficus-api ficus-worker --lines 100')
    expect(calls.at(-1)?.options.inherit).toBe(true)
  })
  it('logs reports a non-zero pm2 exit through outputError', async () => {
    const { run } = make({ 'bunx pm2 logs': { code: 1 } })
    await run(['server', 'logs'])
    expect(outputError).toHaveBeenCalled()
  })
  it('logs rejects a non-integer --lines without calling pm2', async () => {
    const { run, calls } = make()
    await run(['server', 'logs', '-n', 'abc'])
    expect(outputError).toHaveBeenCalled()
    expect(calls.some((c) => c.command.join(' ').startsWith('bunx pm2 logs'))).toBe(false)
  })
  it('uninstall deletes pm2 apps, saves, removes the state file and names the volume docker actually has', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-')))
    const { run, calls } = make(
      {
        'docker inspect -f {{json .Mounts}}': {
          stdout: JSON.stringify([
            { Type: 'volume', Name: 'ficusmain_postgres-data', Destination: '/var/lib/postgresql' },
          ]),
        },
      },
      { env: { HOME: home } }
    )
    await run(['server', 'uninstall', '--yes'])
    expect(joined(calls)).toEqual([
      'bunx pm2 delete ficus-api ficus-worker',
      'bunx pm2 save',
      'docker inspect -f {{json .Mounts}} postgres-ficus',
    ])
    expect(readRegistry(statePath).instances).toEqual({})
    const [data, message] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>, string]
    expect(message).toContain(root)
    // The discovered compose project name, not the derived instance name.
    expect(message).toContain('docker rm -f postgres-ficus && docker volume rm ficusmain_postgres-data')
    expect(data.kept).toContain('ficusmain_postgres-data')
    expect(data.kept).toContain('~/.ficus')
    expect(message).toContain('data:       ~/.ficus')
    expect(message).toContain('removed instance "ficus"')
    rmSync(home, { recursive: true, force: true })
  })
  it('uninstall names a legacy CLI home that has not moved yet as the default instance data', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-')))
    mkdirSync(join(home, LEGACY_HOME_DIR_NAME))
    const { run } = make({ 'docker inspect -f {{json .Mounts}}': { code: 1, stdout: '' } }, { env: { HOME: home } })
    await run(['server', 'uninstall', '--yes'])
    const message = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(message).toContain('data:       ~/.ficus\n')
    rmSync(home, { recursive: true, force: true })
  })
  it('uninstall falls back to the derived volume name when docker cannot answer', async () => {
    const { run } = make({ 'docker inspect -f {{json .Mounts}}': { code: 1, stdout: '' } })
    await run(['server', 'uninstall', '--yes'])
    const message = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(message).toContain('docker rm -f postgres-ficus && docker volume rm ficus_postgres-data')
  })
  it('uninstall names the labelled instance own container, volume and data directory', async () => {
    writeFileSync(join(root, '.env'), 'FICUS_INSTANCE=smoke\nHOME_DIR=~/.ficus-smoke\n')
    const { run, calls } = make()
    await run(['server', 'uninstall', '--yes'])
    // The registry resolves the default instance's names; the volume probe
    // still runs (empty answer → derived-name fallback, asserted below).
    expect(joined(calls)).toEqual([
      'bunx pm2 delete ficus-api ficus-worker',
      'bunx pm2 save',
      'docker inspect -f {{json .Mounts}} postgres-ficus',
    ])
    const message = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(message).toContain('docker rm -f postgres-ficus && docker volume rm ficus_postgres-data')
    expect(message).toContain('~/.ficus-smoke')
  })
  it('uninstall leaves the registry alone for a checkout nobody registered', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-other-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    const { run, calls } = make()
    await run(['server', 'uninstall', '--root', other, '--yes'])
    expect(joined(calls)).toEqual([])
    expect(outputError).toHaveBeenCalled()
    // The registered instance (a different checkout) is untouched.
    expect(readRegistry(statePath).instances.ficus?.root).toBe(root)
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toContain('not registered')
    rmSync(other, { recursive: true, force: true })
  })
  // A checkout deleted by hand (an old worktree, a scratch dir) leaves a
  // registry entry nothing can resolve; `--instance` must still be able to
  // retire it, cleaning the supervisor up as far as it can.
  it('uninstall --instance retires a registration whose checkout no longer exists', async () => {
    const gone = join(tmpdir(), `ficus-gone-${process.pid}`)
    upsertInstance(
      'smoke',
      { root: gone, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
      {},
      statePath
    )
    const { run, calls } = make()
    await run(['server', 'uninstall', '--instance', 'smoke', '--yes'])
    expect(outputError).not.toHaveBeenCalled()
    expect(joined(calls)).toEqual(['bunx pm2 delete ficus-smoke-api ficus-smoke-worker', 'bunx pm2 save'])
    // pm2 ran somewhere that exists, not in the vanished checkout.
    expect(calls.every((c) => c.options.cwd !== gone)).toBe(true)
    expect(readRegistry(statePath).instances).toEqual({
      ficus: expect.objectContaining({ root }),
    })
    const [data, message] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [Record<string, unknown>, string]
    expect(data.unregistered).toBe('smoke')
    expect(message).toContain(`removed instance "smoke"`)
    expect(message).toContain('no longer exists')
    expect(message).toContain('docker rm -f postgres-ficus-smoke && docker volume rm ficus-smoke_postgres-data')
    expect(message).toContain('~/.ficus-smoke')
  })
  it('uninstall --instance of a vanished checkout still removes the registration when the supervisor cleanup fails', async () => {
    const gone = join(tmpdir(), `ficus-gone-${process.pid}-b`)
    upsertInstance(
      'smoke',
      { root: gone, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
      {},
      statePath
    )
    const { run } = make({ 'bunx pm2 delete': { code: 1, stderr: 'pm2 is not running' } })
    await run(['server', 'uninstall', '--instance', 'smoke', '--yes'])
    expect(outputError).not.toHaveBeenCalled()
    expect(readRegistry(statePath).instances.smoke).toBeUndefined()
    const message = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(message).toContain('supervisor cleanup failed')
  })
  it('uninstall refuses to prompt on a non-TTY without --yes', async () => {
    const { run, calls } = make()
    await run(['server', 'uninstall'])
    expect(outputError).toHaveBeenCalled()
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toBe('uninstall needs a terminal to confirm — pass --yes')
    expect(calls.some((c) => c.command[0] === 'bunx' && c.command[1] === 'pm2')).toBe(false)
  })
  it('bootstrap-sysbox runs the guarded plan on a capable host', async () => {
    const capable = {
      platform: 'linux' as NodeJS.Platform,
      arch: 'x64',
      kernelRelease: '6.8.0-40-generic',
      systemdActive: true,
      wsl: false,
      which: (cmd: string) => `/usr/bin/${cmd}`,
    }
    const { run, calls } = make(
      { 'docker ps': { stdout: 'web\n' }, 'docker info --format': { stdout: '{"sysbox-runc":{}}' } },
      { sysboxHost: capable }
    )
    await run(['server', 'bootstrap-sysbox', '--yes'])
    const joinedCalls = calls.map((c) => c.command.join(' '))
    expect(joinedCalls).toContain('docker rm -f web')
    expect(joinedCalls.some((c) => c.startsWith('sudo dpkg -i'))).toBe(true)
    expect(joinedCalls.at(-1)).toBe('docker info --format {{json .Runtimes}}')
  })
  it('bootstrap-sysbox refuses to run on a host that cannot, before touching docker', async () => {
    const { run, calls } = make(
      {},
      {
        sysboxHost: {
          platform: 'darwin' as NodeJS.Platform,
          arch: 'arm64',
          kernelRelease: '5.4.0',
          systemdActive: false,
          wsl: false,
          which: () => null,
        },
      }
    )
    await run(['server', 'bootstrap-sysbox', '--yes'])
    expect(outputError).toHaveBeenCalled()
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toMatch(/cannot run the sysbox bootstrap/)
    expect(calls).toEqual([])
  })
  it('bootstrap-sysbox dry-run changes nothing', async () => {
    const capable = {
      platform: 'linux' as NodeJS.Platform,
      arch: 'x64',
      kernelRelease: '6.8.0-40-generic',
      systemdActive: true,
      wsl: false,
      which: (cmd: string) => `/usr/bin/${cmd}`,
    }
    const { run, calls } = make({ 'docker ps': { stdout: 'web\n' } }, { sysboxHost: capable })
    await run(['server', 'bootstrap-sysbox', '--dry-run'])
    expect(calls.map((c) => c.command.join(' '))).toEqual(['docker ps -a --format {{.Names}}'])
  })
  it('honours --root over the state file', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-other-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    const { run, calls } = make()
    await run(['server', 'stop', '--root', other])
    expect(calls).toEqual([])
    expect(outputError).toHaveBeenCalled()
    rmSync(other, { recursive: true, force: true })
  })
  it('reports a missing root through outputError', async () => {
    const { run, deps } = make()
    deps.statePath = join(root, 'missing.json')
    await run(['server', 'stop'])
    expect(outputError).toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(expect.any(Error), 1)
    expect(process.exitCode).toBe(1)
  })
  it('exits 2 (and tells outputError to exit 2) when a headless run has no runtime', async () => {
    const { run } = make()
    await run(['server', 'setup', '--root', root])
    expect(outputError).toHaveBeenCalledWith(expect.any(Error), 2)
    expect(process.exitCode).toBe(2)
  })
  it('use switches which instance a bare server command acts on', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-other-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    // The pm2/container names come from the checkout's own FICUS_INSTANCE, so a
    // labelled instance has to look like one on disk too.
    writeFileSync(join(other, '.env'), 'FICUS_INSTANCE=lab\n')
    const { run, deps, calls } = make({ 'docker inspect': { stdout: 'true\n' } })
    upsertInstance(
      'lab',
      { root: other, port: 4100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
      {},
      deps.statePath
    )

    await run(['server', 'use', 'lab'])
    expect(readRegistry(deps.statePath).default).toBe('lab')

    // The point of the default: a command that names no instance now acts on
    // `lab`, in lab's checkout and under lab's pm2 names.
    calls.length = 0
    await run(['server', 'start'])
    expect(calls.at(-1)?.command.join(' ')).toContain('ficus-lab-api,ficus-lab-worker')
    expect(calls.at(-1)?.options.cwd).toBe(other)

    // …and --instance still wins over it, for that command ONLY: an override
    // is not a selection, so it must leave the registry's default alone.
    // `use` is the only thing that moves it.
    calls.length = 0
    await run(['server', 'start', '--instance', 'ficus'])
    expect(calls.at(-1)?.command.join(' ')).toContain('ficus-api,ficus-worker')
    expect(calls.at(-1)?.options.cwd).toBe(root)
    expect(readRegistry(deps.statePath).default).toBe('lab')

    // The next bare command is back on the default, unaffected by the override.
    calls.length = 0
    await run(['server', 'start'])
    expect(calls.at(-1)?.command.join(' ')).toContain('ficus-lab-api,ficus-lab-worker')
    rmSync(other, { recursive: true, force: true })
  })

  it('use refuses an unknown label, names the ones that exist, and changes nothing', async () => {
    const { run, deps } = make()
    await run(['server', 'use', 'nope'])
    expect(outputError).toHaveBeenCalled()
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toBe("No local instance named 'nope' — known instances: ficus")
    expect(readRegistry(deps.statePath).default).toBe('ficus')
  })

  it('install clones a fresh root, installs deps and hands off to bun run setup', async () => {
    const installTmp = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-install-')))
    const installRoot = join(installTmp, 'ficus')
    const { runner, calls } = cloningRunner(installRoot)
    const { deps } = make()
    deps.runner = runner
    const program = new Command()
    program.exitOverride()
    registerServerCommands(program, deps)
    await program.parseAsync(
      ['server', 'install', '--root', installRoot, '--repo', 'x', '--ref', 'main', '--', '--runtime', 'host'],
      { from: 'user' }
    )
    expect(joined(calls)).toEqual([
      `git clone --recurse-submodules --branch main x ${installRoot}`,
      'bun --version',
      'bun install --frozen-lockfile',
      `bun run setup -- --root ${installRoot} --runtime host`,
    ])
    rmSync(installTmp, { recursive: true, force: true })
  })
  it('install without --root clones into the CLI home as ~/.ficus/ficus when nothing is registered', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-')))
    const installRoot = join(home, '.ficus', 'ficus')
    const { runner, calls } = cloningRunner(installRoot)
    const { run } = make({}, { env: { HOME: home }, runner, statePath: join(home, 'empty-registry.json') })
    await run(['server', 'install', '--repo', 'x', '--ref', 'main', '--runtime', 'host'])
    expect(joined(calls)[0]).toBe(`git clone --recurse-submodules --branch main x ${installRoot}`)
    rmSync(home, { recursive: true, force: true })
  })
  it('install without --root reuses the registered default instance checkout instead of cloning another', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-home-')))
    writeFileSync(join(root, '.bun-version'), '1.3.8\n')
    const { runner, calls } = cloningRunner(join(home, '.ficus', 'ficus'))
    const { run } = make({}, { env: { HOME: home }, runner })
    await run(['server', 'install', '--repo', 'x', '--ref', 'main', '--runtime', 'host'])
    expect(joined(calls).some((call) => call.startsWith('git clone'))).toBe(false)
    expect(joined(calls).at(-1)).toBe(`bun run setup -- --root ${root} --runtime host`)
    rmSync(home, { recursive: true, force: true })
  })
  it('install refuses malformed registry state before clone or destination mutation', async () => {
    const installRoot = join(root, 'new-install')
    writeFileSync(statePath, JSON.stringify({ version: 3 }))
    const { run, calls } = make()

    await run(['server', 'install', '--root', installRoot, '--runtime', 'host', '--yes'])

    expect(calls).toEqual([])
    expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ name: 'InvalidRegistryError' }), 1)
    expect(existsSync(installRoot)).toBe(false)
  })

  it('install forwards the multi-instance example from its own --help verbatim', async () => {
    // The help text tells operators to run exactly this to stand up a second
    // instance. If --instance stopped reaching setup, every labelled resource
    // would silently fall back to the default names and collide with the
    // existing install — so the documented line is pinned here.
    const installTmp = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-install-')))
    const installRoot = join(installTmp, 'lab')
    const { runner, calls } = cloningRunner(installRoot)
    const { deps } = make()
    deps.runner = runner
    const program = new Command()
    program.exitOverride()
    registerServerCommands(program, deps)
    await program.parseAsync(
      ['server', 'install', '--root', installRoot, '--instance', 'lab', '--runtime', 'host', '--yes'],
      { from: 'user' }
    )
    expect(joined(calls).at(-1)).toBe(`bun run setup -- --root ${installRoot} --instance lab --runtime host --yes`)

    // helpInformation() omits addHelpText, so render the way --help does.
    let help = ''
    const install = program.commands.find((c) => c.name() === 'server')!.commands.find((c) => c.name() === 'install')!
    install.configureOutput({ writeOut: (chunk) => (help += chunk) })
    install.outputHelp()
    expect(help).toContain('--root ~/.ficus/instances/lab --instance lab --runtime host --yes')
    rmSync(installTmp, { recursive: true, force: true })
  })
  it('install parses the production form (no `--` separator) and still forwards the trailing flags to setup', async () => {
    const installTmp = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-install-')))
    const installRoot = join(installTmp, 'ficus')
    const { runner, calls } = cloningRunner(installRoot)
    const { deps } = make()
    deps.runner = runner
    const program = new Command()
    program.exitOverride()
    registerServerCommands(program, deps)
    await program.parseAsync(
      ['server', 'install', '--root', installRoot, '--repo', 'x', '--ref', 'main', '--runtime', 'host', '--yes'],
      { from: 'user' }
    )
    expect(joined(calls)).toEqual([
      `git clone --recurse-submodules --branch main x ${installRoot}`,
      'bun --version',
      'bun install --frozen-lockfile',
      `bun run setup -- --root ${installRoot} --runtime host --yes`,
    ])
    rmSync(installTmp, { recursive: true, force: true })
  })
  it('update pulls (or checks out --ref), runs the offline update and restarts via pm2', async () => {
    const sha = 'a'.repeat(40)
    const { run, calls } = make({
      'git status --porcelain': { stdout: '' },
      'git rev-parse HEAD': { stdout: sha + '\n' },
      'git ls-remote --refs --exit-code origin refs/heads/v1 refs/tags/v1': {
        stdout: `${sha}\trefs/tags/v1\n`,
      },
    })
    await run(['server', 'update', '--ref', 'v1'])
    expect(joined(calls)).toEqual([
      'git status --porcelain',
      'git rev-parse HEAD',
      'git check-ref-format --branch v1',
      'git ls-remote --refs --exit-code origin refs/heads/v1 refs/tags/v1',
      'git fetch --no-tags origin refs/tags/v1:refs/tags/v1',
      'git checkout --recurse-submodules v1',
      'git rev-parse HEAD',
      'bun run update:offline -- --from ' + sha,
      'bunx pm2 restart ficus-worker --update-env',
      'bunx pm2 restart ficus-api --update-env',
    ])
    expect(calls.find((call) => call.command.includes('update:offline'))?.options.env?.FICUS_UPDATE_SUPERVISOR).toBe(
      'pm2'
    )
    expect(calls.every((c) => c.options.cwd === root)).toBe(true)
  })
  it('setup re-run keeps the checkout own instance label and port when no flag says otherwise', async () => {
    writeFileSync(join(root, '.env'), 'FICUS_INSTANCE=smoke\nPORT=3100\nFICUS_SANDBOX_RUNTIME=host\n')
    const seen: unknown[] = []
    const { run, deps } = make()
    deps.cwd = root
    deps.runSetup = async (opts) => {
      seen.push(opts)
      return { handoff: [], cliOnPath: true }
    }
    await run(['server', 'setup', '--runtime', 'host', '--no-start', '--yes'])
    expect(seen[0]).toMatchObject({ instance: 'smoke', port: 3100, apiUrl: 'http://localhost:3100' })
  })
  it('setup targets the checkout you are in, never the state file root', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-cwd-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    const nested = join(other, 'apps', 'core')
    mkdirSync(nested, { recursive: true })
    const seen: unknown[] = []
    const { run, deps } = make()
    // state file still points at `root` (written in beforeEach)
    deps.cwd = nested
    deps.runSetup = async (opts) => {
      seen.push(opts)
      return { handoff: [], cliOnPath: true }
    }
    await run(['server', 'setup', '--runtime', 'host', '--no-start', '--yes'])
    expect((seen[0] as { root: string }).root).toBe(other)
    rmSync(other, { recursive: true, force: true })
  })
  it('setup wires options and deps through to runSetup', async () => {
    const seen: unknown[] = []
    const { run, deps } = make()
    deps.runSetup = async (opts) => {
      seen.push(opts)
      return { handoff: [], cliOnPath: true }
    }
    await run(['server', 'setup', '--root', root, '--runtime', 'host', '--port', '3100', '--no-start', '--yes'])
    expect(seen).toHaveLength(1)
    const opts = seen[0] as { root: string; runtime: string; port: number; start: boolean }
    expect(opts.root).toBe(root)
    expect(opts.runtime).toBe('host')
    expect(opts.port).toBe(3100)
    expect(opts.start).toBe(false)
  })
  it('setup honours --instance from argv', async () => {
    // Regression: a group-level --instance on `server` swallowed the flag here,
    // so `bun run setup -- --instance smoke` silently configured the default instance.
    const seen: unknown[] = []
    const { run, deps } = make()
    deps.runSetup = async (opts) => {
      seen.push(opts)
      return { handoff: [], cliOnPath: true }
    }
    await run(['server', 'setup', '--root', root, '--instance', 'smoke', '--runtime', 'host', '--no-start', '--yes'])
    expect(seen[0]).toMatchObject({ instance: 'smoke' })
  })
})

describe('ficus server and the ficus identity', () => {
  it('an identity-2 entry is addressed by the ficus names', async () => {
    writeFileSync(join(root, '.env'), 'PORT=3000\nDATABASE_URL=postgres://postgres:postgres@localhost:5432/ficus\n')
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 3,
        default: 'ficus',
        instances: {
          ficus: { root, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
        },
      })
    )
    const { run, calls } = make({ 'docker inspect': { stdout: 'true\n' } })
    await run(['server', 'start'])
    await run(['server', 'stop'])
    expect(joined(calls)).toEqual([
      'docker inspect -f {{.State.Running}} postgres-ficus',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'docker exec postgres-ficus psql -h 127.0.0.1 -U postgres -tAc SELECT 1',
      'bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env',
      'bunx pm2 stop ficus-api ficus-worker',
    ])
    // `use` and friends rewrite the registry without dropping the marker.
    await run(['server', 'use', 'ficus'])
    expect(JSON.parse(readFileSync(statePath, 'utf8')).instances.ficus.identity).toBe(2)
  })

  it('start, restart and update refuse while a rename-identity run is unfinished', async () => {
    const { run, calls, deps } = make()
    writeFileSync(
      deps.renameJournalPath!,
      JSON.stringify({ op: 'begin', root, supervisor: 'pm2', from: 'x', to: 'y', port: 3000, home: root }) + '\n'
    )
    for (const command of ['start', 'restart', 'update']) {
      ;(outputError as ReturnType<typeof mock>).mockClear()
      await run(['server', command])
      const error = (outputError as ReturnType<typeof mock>).mock.calls[0]?.[0] as Error
      expect(error.message).toContain('earlier identity move is unfinished')
    }
    expect(calls).toEqual([])
  })

  it('list shows an instance a newer CLI registered instead of hiding or failing on it', async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 3,
        default: 'ficus',
        instances: {
          ficus: { root, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 3 },
        },
      })
    )
    const { run, calls } = make()
    await run(['server', 'list'])
    expect(outputError).not.toHaveBeenCalled()
    const [data, text] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [
      { instances: { label: string; unsupportedIdentity?: number }[] },
      string,
    ]
    expect(data.instances).toEqual([expect.objectContaining({ label: 'ficus', unsupportedIdentity: 3 })])
    expect(text).toContain('identity 3')
    // It asks no supervisor about names it cannot derive.
    expect(calls).toEqual([])
  })

  it('names the ficus identity in its help', () => {
    const program = new Command()
    registerServerCommands(program, make().deps)
    const server = program.commands.find((c) => c.name() === 'server')!
    const sub = (name: string) => server.commands.find((c) => c.name() === name)!
    expect(sub('start').description()).toBe('Start ficus-api and ficus-worker under the recorded supervisor')
    expect(sub('stop').description()).toBe('Stop ficus-api and ficus-worker')
    expect(sub('restart').description()).toBe('Restart ficus-api and ficus-worker')
    expect(sub('setup').helpInformation()).toContain('(default ficus)')
    let help = ''
    sub('install').configureOutput({ writeOut: (chunk) => (help += chunk) })
    sub('install').outputHelp()
    expect(help).toContain('ficus-lab-api/ficus-lab-worker')
    expect(help).toContain('postgres-ficus-lab')
    expect(help).toContain('~/.ficus-lab')
  })
})

describe('ficus server list', () => {
  /** A second registered instance, in its own checkout. */
  function secondInstance() {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-smoke-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    writeFileSync(join(other, '.env'), 'FICUS_INSTANCE=smoke\nPORT=3100\n')
    upsertInstance(
      'smoke',
      { root: other, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
      {},
      statePath
    )
    return other
  }

  it('lists every instance by querying its recorded supervisor', async () => {
    const other = secondInstance()
    const { run, calls } = make({
      'bunx pm2 jlist': {
        stdout: JSON.stringify([
          { name: 'ficus-api', pid: 5, pm2_env: { status: 'online', pm_cwd: root } },
          { name: 'ficus-smoke-worker', pid: 6, pm2_env: { status: 'stopped', pm_cwd: other } },
        ]),
      },
    })
    await run(['server', 'list'])
    // Mixed supervisors cannot share one global query; each record is dispatched independently.
    expect(joined(calls)).toEqual(['bunx pm2 jlist', 'bunx pm2 jlist'])
    expect(calls[0].options.cwd).toBe(root)
    const text = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(text).toContain(`* ficus`)
    expect(text).toContain(root)
    expect(text).toContain('http://localhost:3000')
    expect(text).toContain('api: online')
    expect(text).toContain('smoke')
    expect(text).toContain(other)
    expect(text).toContain('http://localhost:3100')
    expect(text).toContain('worker: stopped')
    expect(text).toContain('api: not registered')
    // Only the default carries the marker.
    expect(
      text
        .split('\n')
        .find((l) => l.includes('smoke'))
        ?.startsWith('*')
    ).toBe(false)
    rmSync(other, { recursive: true, force: true })
  })
  it('--json emits the machine-readable listing', async () => {
    const other = secondInstance()
    const { run } = make({
      'bunx pm2 jlist': {
        stdout: JSON.stringify([{ name: 'ficus-api', pid: 5, pm2_env: { status: 'online', pm_cwd: root } }]),
      },
    })
    await run(['server', 'list', '--json'])
    expect(setOutputOptions).toHaveBeenCalledWith({ json: true })
    const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [
      { default?: string; instances: Record<string, unknown>[] },
    ]
    expect(data.default).toBe('ficus')
    expect(data.instances).toEqual([
      {
        label: 'ficus',
        root,
        port: 3000,
        url: 'http://localhost:3000',
        default: true,
        supervisor: 'pm2',
        processes: [{ name: 'ficus-api', status: 'online', pid: 5, cwd: root }],
      },
      {
        label: 'smoke',
        root: other,
        port: 3100,
        url: 'http://localhost:3100',
        default: false,
        supervisor: 'pm2',
        processes: [],
      },
    ])
    rmSync(other, { recursive: true, force: true })
  })
  it('marks the instance a bare command would act on when the file names no default', async () => {
    const other = secondInstance()
    // A registry that lost its `default` line: resolveRoot falls back to the
    // first label, so the marker has to agree with it.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        instances: {
          ficus: { root, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
          smoke: { root: other, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
        },
      })
    )
    const { run } = make()
    await run(['server', 'list'])
    const [data, text] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [{ default?: string }, string]
    expect(data.default).toBe('ficus')
    expect(
      text
        .split('\n')
        .find((l) => l.includes('ficus'))
        ?.startsWith('*')
    ).toBe(true)
    expect(
      text
        .split('\n')
        .find((l) => l.includes(' smoke '))
        ?.startsWith('*')
    ).toBe(false)
    rmSync(other, { recursive: true, force: true })
  })
  it('says (none) and asks pm2 nothing when no instance is registered', async () => {
    rmSync(statePath, { force: true })
    const { run, calls } = make()
    await run(['server', 'list'])
    const [data, text] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [{ instances: unknown[] }, string]
    expect(text).toContain('(none)')
    expect(data.instances).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('ficus server <cmd> --instance', () => {
  /** A second registered instance in its own checkout, labelled smoke. */
  function smokeCheckout(): string {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-smoke-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    writeFileSync(join(other, '.env'), 'FICUS_INSTANCE=smoke\nPORT=3100\n')
    upsertInstance(
      'smoke',
      { root: other, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
      {},
      statePath
    )
    return other
  }
  it('acts on the named instance instead of the registry default', async () => {
    const other = smokeCheckout()
    const { run, calls } = make()
    await run(['server', 'stop', '--instance', 'smoke'])
    expect(joined(calls)).toEqual(['bunx pm2 stop ficus-smoke-api ficus-smoke-worker'])
    expect(calls[0].options.cwd).toBe(other)
    rmSync(other, { recursive: true, force: true })
  })
  it('status --instance reports the named instance, not the default', async () => {
    const other = smokeCheckout()
    const { run } = make()
    await run(['server', 'status', '--instance', 'smoke'])
    const [data] = (output as ReturnType<typeof mock>).mock.calls.at(-1) as [{ root: string; instance: string }]
    expect(data).toMatchObject({ root: other, instance: 'smoke', port: 3100 })
    rmSync(other, { recursive: true, force: true })
  })
  it('rejects the old group-level form (the option is per-subcommand now)', async () => {
    const other = smokeCheckout()
    const { run, calls } = make()
    await expect(run(['server', '--instance', 'smoke', 'status'])).rejects.toThrow(/unknown option .--instance./)
    expect(calls).toEqual([])
    rmSync(other, { recursive: true, force: true })
  })
  it('reports an unknown instance with the labels it does know', async () => {
    const { run, calls } = make()
    await run(['server', 'stop', '--instance', 'nope'])
    const [error] = (outputError as ReturnType<typeof mock>).mock.calls.at(-1) as [Error]
    expect(error.message).toContain('unknown instance "nope"')
    expect(error.message).toContain('known instances: ficus')
    expect(calls).toEqual([])
  })
  it('uninstall drops the entry and hands the default to a remaining instance', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-smoke-')))
    mkdirSync(join(other, '.git'))
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ficus' }))
    upsertInstance(
      'smoke',
      { root: other, port: 3100, supervisor: 'pm2', createdAt: 't', updatedAt: 't', identity: 2 },
      {},
      statePath
    )
    const { run } = make()
    await run(['server', 'uninstall', '--yes'])
    const registry = readRegistry(statePath)
    expect(Object.keys(registry.instances)).toEqual(['smoke'])
    expect(registry.default).toBe('smoke')
    rmSync(other, { recursive: true, force: true })
  })
})

describe('registry-backed supervisor dispatch', () => {
  it('dispatches a systemd-user stop without touching pm2', async () => {
    upsertInstance(
      'ficus',
      { root, port: 3000, supervisor: 'systemd-user', identity: 2, createdAt: 't', updatedAt: 'u' },
      {},
      statePath
    )
    const { run, calls } = make()
    await run(['server', 'stop'])
    expect(joined(calls)).toEqual([
      'systemctl --user show-environment',
      'systemctl --user stop ficus-api.service',
      'systemctl --user stop ficus-worker.service',
    ])
  })

  it('does not dispatch lifecycle work for a broken registered root', async () => {
    const broken = join(root, '..', `ficus-broken-${Date.now()}`)
    symlinkSync(join(root, '..', 'missing-checkout'), broken)
    upsertInstance(
      'ficus',
      { root: broken, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 'u' },
      {},
      statePath
    )
    try {
      const { run, calls } = make()
      await run(['server', 'stop', '--instance', 'ficus'])
      expect(calls).toEqual([])
      expect(outputError).toHaveBeenCalled()
    } finally {
      rmSync(broken, { force: true })
    }
  })

  it('uses the canonical registry root when lifecycle is selected through a symlink alias', async () => {
    const alias = join(root, '..', `ficus-server-alias-${Date.now()}`)
    symlinkSync(root, alias)
    try {
      const { run, calls } = make()
      await run(['server', 'stop', '--root', alias])
      const pm2 = calls.find((call) => call.command[0] === 'bunx' && call.command[1] === 'pm2')
      expect(pm2?.options.cwd).toBe(realpathSync(root))
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('dispatches launchd restart worker first and API last', async () => {
    upsertInstance(
      'ficus',
      { root, port: 3000, supervisor: 'launchd', identity: 2, createdAt: 't', updatedAt: 'u' },
      {},
      statePath
    )
    const uid = process.getuid?.() ?? 0
    const home = process.env.HOME ?? homedir()
    const printOf = (component: 'api' | 'worker') =>
      `program arguments = {\n\t/usr/bin/bun\n}\n\tworking directory = ${realpathSync(root)}\n\tstderr path = ${join(cliHome({ homedir: home }), 'logs', `ficus-${component}.log`)}\n`
    const { run, calls } = make({
      [`launchctl print gui/${uid}/sh.ficus.ficus-worker`]: { stdout: printOf('worker') },
      [`launchctl print gui/${uid}/sh.ficus.ficus-api`]: { stdout: printOf('api') },
    })
    await run(['server', 'restart'])
    const commands = joined(calls)
    const worker = commands.findIndex((line) => line.includes('kickstart -k') && line.endsWith('ficus-worker'))
    const api = commands.findIndex((line) => line.includes('kickstart -k') && line.endsWith('ficus-api'))
    expect(worker).toBeGreaterThan(-1)
    expect(api).toBeGreaterThan(worker)
    expect(commands.some((line) => line.includes('pm2'))).toBe(false)
  })
})

describe('finalized CLI identity gate', () => {
  for (const command of ['start', 'stop', 'restart', 'status', 'logs', 'update', 'uninstall']) {
    it(`refuses identity-less ${command} before invoking subprocesses`, async () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 3,
          default: LEGACY_LOCAL_INSTANCE,
          instances: {
            [LEGACY_LOCAL_INSTANCE]: { root, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't' },
          },
        })
      )
      const { run, calls } = make()
      const before = readFileSync(statePath, 'utf8')
      await run(['server', command, ...(command === 'uninstall' ? ['--yes'] : [])])
      expect(calls).toEqual([])
      const error = (outputError as ReturnType<typeof mock>).mock.calls[0]?.[0] as Error
      expect(error?.message).toContain('ficus-host-layout-bridge')
      expect(readFileSync(statePath, 'utf8')).toBe(before)
      expect(JSON.parse(before).version).toBe(3)
    })
  }
})

describe('finalized CLI identity gate additional paths', () => {
  for (const args of [
    ['server', 'install', '--root', 'ROOT'],
    ['server', 'use', LEGACY_LOCAL_INSTANCE],
    ['server', 'setup', '--root', 'ROOT', '--runtime', 'host', '--yes'],
    ['server', 'uninstall', '--instance', LEGACY_LOCAL_INSTANCE, '--yes'],
  ]) {
    it(`refuses ${args[1]} for explicit identity1 without modifying the registry`, async () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 3,
          default: LEGACY_LOCAL_INSTANCE,
          instances: {
            [LEGACY_LOCAL_INSTANCE]: {
              root: args[1] === 'uninstall' ? join(root, 'missing') : root,
              port: 3000,
              supervisor: 'pm2',
              createdAt: 't',
              updatedAt: 't',
              identity: 1,
            },
          },
        })
      )
      const before = readFileSync(statePath, 'utf8')
      const { run, calls } = make()
      await run(args.map((arg) => (arg === 'ROOT' ? root : arg)))
      expect(calls).toEqual([])
      expect((outputError as ReturnType<typeof mock>).mock.calls[0]?.[0]?.message).toContain('ficus-host-layout-bridge')
      expect(readFileSync(statePath, 'utf8')).toBe(before)
    })
  }
  it('lists an old entry without probing its supervisor', async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 3,
        instances: {
          [LEGACY_LOCAL_INSTANCE]: { root, port: 3000, supervisor: 'pm2', createdAt: 't', updatedAt: 't' },
        },
      })
    )
    const { run, calls } = make()
    await run(['server', 'list'])
    expect(calls).toEqual([])
    expect((output as ReturnType<typeof mock>).mock.calls[0]?.[1]).toContain('ficus-host-layout-bridge')
  })
})

describe('unmigrated home-only registry', () => {
  for (const args of [
    ['install', '--root', 'ROOT'],
    ['setup', '--root', 'ROOT', '--runtime', 'host', '--yes'],
    ['start', '--root', 'ROOT'],
    ['update', '--root', 'ROOT'],
  ]) {
    it(`refuses ${args[0]} before treating the canonical home as a fresh install`, async () => {
      const home = join(root, 'home')
      const oldState = join(home, LEGACY_HOME_DIR_NAME, 'cli', 'local-server.json')
      mkdirSync(join(oldState, '..'), { recursive: true })
      const before = JSON.stringify({
        version: 3,
        default: LEGACY_LOCAL_INSTANCE,
        instances: {
          [LEGACY_LOCAL_INSTANCE]: { root, port: 3000, supervisor: 'pm2', identity: 1, createdAt: 't', updatedAt: 't' },
        },
      })
      writeFileSync(oldState, before)
      const setup = mock(async () => ({ handoff: [], cliOnPath: true }))
      const { run, calls } = make({}, { env: { HOME: home }, statePath: getStatePath({ HOME: home }), runSetup: setup })
      await run(['server', ...args.map((arg) => (arg === 'ROOT' ? root : arg))])
      expect(calls).toEqual([])
      expect(setup).not.toHaveBeenCalled()
      expect((outputError as ReturnType<typeof mock>).mock.calls[0]?.[0]?.message).toContain('ficus-host-layout-bridge')
      expect(readFileSync(oldState, 'utf8')).toBe(before)
      expect(existsSync(join(home, '.ficus'))).toBe(false)
    })
  }
})
