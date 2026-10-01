import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { LEGACY_HOME_DIR_NAME, LEGACY_LAUNCHD_PREFIX, LEGACY_LOCAL_INSTANCE, LEGACY_UNITS } from '@ficus/shared/node'
import { parseEnvFile } from './env-file'
import { recoveryCliHome } from './home-move'
import { launchdDefinition, launchdNames as launchdNamesOf } from './launchd'
import type { RunOptions, Runner, RunResult } from './runner'
import type { LocalServerRegistry } from './state'
import type { SupervisorContext } from './supervisor'
import {
  installSupervisor,
  RENAME_JOURNAL,
  readRenameJournal,
  relabelInstance,
  removeSupervisorDefinitions,
  renameIdentity,
  stopSupervisor,
  supervisorIdentity,
  type RenameDeps,
  type PostgresOps,
} from './supervisor-rename'
import { systemdUserNames, systemdUnit } from './systemd-user'
import type { LocalSupervisor } from './types'

const L = LEGACY_LOCAL_INSTANCE
const EXAMPLE = readFileSync(join(__dirname, '../../../../ecosystem.config.example.js'), 'utf8')
/** The ecosystem file a pre-rename setup generated: the example with the legacy app names. */
const LEGACY_ECOSYSTEM = EXAMPLE.replaceAll("'ficus-api'", `'${LEGACY_UNITS.api}'`).replaceAll(
  "'ficus-worker'",
  `'${LEGACY_UNITS.worker}'`
)
const UID = 501
const BUN = '/usr/bin/bun'

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-rename-identity-')))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

interface World {
  home: string
  root: string
  statePath: string
  envText: string
  registryText: string
  calls: string[][]
  /** The options of each call, parallel to `calls`. */
  options: RunOptions[]
  /** launchd labels `launchctl disable` has turned off (the override survives a reboot). */
  disabled: Set<string>
  /** Answers GET /ready (default 200). */
  ready: { status: number }
  /** What the fake rebase-home prints for a --dry-run. */
  rebasePreview: { stdout: string }
  rebaseDown: { refusals: number }
  /** Commands the fake answers with a failure while `fail(joined)` says so. */
  fail: { match?: (joined: string) => boolean }
  pm2: Set<string>
  loaded: Set<string>
  deps: RenameDeps
  journal(): string
  printed: string[]
}

/**
 * A legacy-identity install of the default instance: `~/<legacy>` a real CLI home holding the
 * registry and logs, a checkout whose .env and ecosystem file name the legacy apps, and fakes
 * for launchctl, systemctl --user, pm2 and the rebase-home program that keep state.
 */
function world(
  supervisor: LocalSupervisor,
  opts: {
    label?: string
    envExtra?: string
    postgres?: Partial<PostgresOps>
    fetch?: typeof fetch
    /** The CLI process's environment (what it auto-loaded from a .env at launch). */
    env?: Record<string, string | undefined>
    databaseUrl?: string
    ecosystem?: string
    /** The old pm2 apps are running when the rename starts (default); false: stopped and deleted. */
    pm2Running?: boolean
  } = {}
): World {
  const label = opts.label ?? L
  const home = join(tmp, 'home')
  const root = join(tmp, 'checkout')
  const legacyHome = join(home, LEGACY_HOME_DIR_NAME)
  mkdirSync(join(legacyHome, 'cli'), { recursive: true })
  mkdirSync(join(legacyHome, 'logs'), { recursive: true })
  mkdirSync(join(legacyHome, 'sessions'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'apps/core/dist'), { recursive: true })
  mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
  writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
  writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.so'), '')
  writeFileSync(join(root, 'apps/core/dist/rebase-home.js'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
  writeFileSync(join(root, 'ecosystem.config.example.js'), EXAMPLE)
  const legacyNames = label === L ? { ...LEGACY_UNITS } : { api: `${L}-${label}-api`, worker: `${L}-${label}-worker` }
  if (supervisor === 'pm2') writeFileSync(join(root, 'ecosystem.config.js'), opts.ecosystem ?? LEGACY_ECOSYSTEM)
  const envText =
    `PORT=3900\n` +
    `DATABASE_URL=${opts.databaseUrl ?? 'postgres://app:secret@db.example.com:5432/app'}\n` +
    `FICUS_INSTANCE=${label}\n` +
    (supervisor === 'pm2'
      ? `FICUS_SYSTEM_LOG_PROVIDER=pm2\nFICUS_PM2_API_NAME=${legacyNames.api}\nFICUS_PM2_WORKER_NAME=${legacyNames.worker}\n`
      : `FICUS_SYSTEM_LOG_PROVIDER=file\nFICUS_LOG_FILE_API=${join(legacyHome, 'logs', legacyNames.api + '.log')}\nFICUS_LOG_FILE_WORKER=${join(legacyHome, 'logs', legacyNames.worker + '.log')}\n`) +
    (opts.envExtra ?? '')
  writeFileSync(join(root, '.env'), envText)
  const statePath = join(legacyHome, 'cli', 'local-server.json')
  const registry = {
    version: 3,
    default: label,
    instances: { [label]: { root, port: 3900, supervisor, createdAt: 'c', updatedAt: 'u' } },
  }
  const registryText = JSON.stringify(registry, null, 2) + '\n'
  writeFileSync(statePath, registryText)

  const calls: string[][] = []
  const options: RunOptions[] = []
  const disabled = new Set<string>()
  const ready = { status: 200 }
  const rebasePreview = { stdout: 'REBASE_HOME sessions.cwd=3\nREBASE_HOME_TARGET sessions.cwd=0\n' }
  /** The next `refusals` runs of rebase-home fail as a Postgres that is still starting does. */
  const rebaseDown = { refusals: 0 }
  const fail: World['fail'] = {}
  const pm2 = new Set<string>(
    supervisor === 'pm2' && opts.pm2Running !== false ? [legacyNames.api, legacyNames.worker] : []
  )
  const loaded = new Set<string>()
  const printed: string[] = []
  const contexts: SupervisorContext[] = []
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
  const runner: Runner = async (command, runOptions = {}) => {
    calls.push(command)
    options.push(runOptions)
    const joined = command.join(' ')
    if (fail.match?.(joined)) return { code: 1, stdout: '', stderr: 'injected failure' }
    if (command[0] === 'bunx' && command[1] === 'pm2') {
      const [verb, ...rest] = command.slice(2)
      if (verb === 'jlist')
        return ok(
          JSON.stringify([...pm2].map((name) => ({ name, pid: 1, pm2_env: { status: 'online', pm_cwd: root } })))
        )
      if (verb === 'delete') {
        for (const name of rest) {
          if (!pm2.has(name)) return { code: 1, stdout: '', stderr: `Process or Namespace ${name} not found` }
          pm2.delete(name)
        }
        return ok()
      }
      if (verb === 'start') {
        const only = rest[rest.indexOf('--only') + 1].split(',')
        const eco = readFileSync(join(root, 'ecosystem.config.js'), 'utf8')
        for (const name of only) {
          if (!eco.includes(`name: '${name}',`)) return { code: 1, stdout: '', stderr: `no app ${name}` }
          pm2.add(name)
        }
        return ok()
      }
      return ok()
    }
    if (command[0] === 'launchctl') {
      const [verb, target, plist] = command.slice(1)
      if (verb === 'print' && target === `gui/${UID}`) return ok()
      if (verb === 'print') {
        const label = target.split('/')[2]
        if (!loaded.has(label)) return { code: 113, stdout: '', stderr: 'not found' }
        const ctx = contexts.find((c) => launchdLabelOf(c, label))
        const log = ctx ? launchdLog(ctx, label) : ''
        return ok(`program = ${BUN}\n\tworking directory = ${root}\n\tstderr path = ${log}\n\tstate = running\n`)
      }
      if (verb === 'bootout') {
        loaded.delete(target.split('/')[2])
        return ok()
      }
      if (verb === 'bootstrap') {
        const label = basename(plist).replace(/\.plist$/, '')
        // What launchd answers for a label `launchctl disable` turned off.
        if (disabled.has(label)) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        loaded.add(label)
        return ok()
      }
      if (verb === 'disable' || verb === 'enable') {
        const label = target.split('/')[2]
        if (verb === 'disable') disabled.add(label)
        else disabled.delete(label)
        return ok()
      }
      return ok()
    }
    if (command[0] === 'bun' && command[1]?.endsWith('rebase-home.js') && rebaseDown.refusals > 0) {
      rebaseDown.refusals--
      return { code: 1, stdout: '', stderr: 'Error: connect ECONNREFUSED 127.0.0.1:5432' }
    }
    if (command[0] === 'bun' && command[1]?.endsWith('rebase-home.js'))
      return ok(command.includes('--dry-run') ? rebasePreview.stdout : 'REBASE_HOME sessions.cwd=3\n')
    return ok()
  }
  // The loaded-job provenance the fake launchctl prints must match what the adapter derives.
  const launchdLabelOf = (ctx: SupervisorContext, label: string) =>
    ['api', 'worker'].some((c) => launchdNamesOf(ctx, c as 'api' | 'worker').label === label)
  const launchdLog = (ctx: SupervisorContext, label: string) =>
    (['api', 'worker'] as const).map((c) => launchdNamesOf(ctx, c)).find((n) => n.label === label)!.log
  const deps: RenameDeps = {
    runner,
    statePath,
    journalPath: () => join(recoveryCliHome(home), RENAME_JOURNAL),
    home,
    fetch:
      opts.fetch ??
      (async (url) => new Response('ok', { status: String(url).endsWith('/ready') ? ready.status : 200 })),
    env: opts.env ?? { PATH: '/usr/bin' },
    sleep: async () => {},
    now: () => new Date('2026-09-30T12:00:00Z'),
    log: (line) => printed.push(line),
    postgres: opts.postgres,
    supervisorContext: (id, dir) => {
      const ctx: SupervisorContext = {
        supervisor: id.supervisor,
        root: dir,
        label: id.label,
        identity: id.identity,
        home,
        bunPath: BUN,
        pathEnv: '/usr/bin',
        platform: supervisor === 'systemd-user' ? 'linux' : 'darwin',
        arch: 'arm64',
        uid: UID,
        username: 'me',
        runner,
        which: () => null,
        log: () => {},
      }
      contexts.push(ctx)
      return ctx
    },
  }
  return {
    home,
    root,
    statePath,
    envText,
    registryText,
    calls,
    options,
    disabled,
    ready,
    rebasePreview,
    rebaseDown,
    fail,
    pm2,
    loaded,
    deps,
    printed,
    journal: () => join(recoveryCliHome(home), RENAME_JOURNAL),
  }
}

const joined = (calls: string[][]) => calls.map((c) => c.join(' '))

/** Old plists as the pre-rename CLI wrote them, and their jobs loaded. */
function installLegacyLaunchd(w: World) {
  const ctx = w.deps.supervisorContext(supervisorIdentity('launchd', L, 1), w.root)
  const agents = join(w.home, 'Library', 'LaunchAgents')
  mkdirSync(agents, { recursive: true })
  for (const component of ['api', 'worker'] as const) {
    const names = launchdNamesOf(ctx, component)
    writeFileSync(names.plist, launchdDefinition(ctx, component))
    w.loaded.add(names.label)
  }
  return agents
}

describe('relabelInstance', () => {
  const e = { root: '/r', port: 3000, supervisor: 'pm2' as const, createdAt: 'c', updatedAt: 'u' }
  it('moves the entry and the default, keeping root, port and supervisor', () => {
    const registry: LocalServerRegistry = { version: 3, default: L, instances: { [L]: e } }
    expect(relabelInstance(registry, L, 'ficus')).toEqual({ version: 3, default: 'ficus', instances: { ficus: e } })
    // The input is not mutated.
    expect(registry.instances[L]).toEqual(e)
  })
  it('leaves another default alone and refuses a label that is taken', () => {
    const registry: LocalServerRegistry = { version: 3, default: 'lab', instances: { [L]: e, lab: e } }
    expect(relabelInstance(registry, L, 'ficus').default).toBe('lab')
    expect(() => relabelInstance(registry, L, 'lab')).toThrow(/lab/)
    expect(() => relabelInstance(registry, 'missing', 'ficus')).toThrow(/missing/)
  })
})

describe('renameIdentity (pm2)', () => {
  it('moves the default instance to the ficus names, home and registry', async () => {
    const w = world('pm2')
    const report = await renameIdentity({ root: w.root }, w.deps)

    // Supervisor: the legacy apps deleted, the ficus apps started from the regenerated file, saved.
    const pm2Calls = joined(w.calls).filter((c) => c.startsWith('bunx pm2') && !c.endsWith('jlist'))
    expect(pm2Calls).toEqual([
      `bunx pm2 delete ${LEGACY_UNITS.api} ${LEGACY_UNITS.worker}`,
      // Saved right away: a reboot mid-run must not resurrect the old apps from the dump.
      'bunx pm2 save --force',
      'bunx pm2 start ecosystem.config.js --only ficus-api,ficus-worker --update-env',
      'bunx pm2 save',
    ])
    expect([...w.pm2].sort()).toEqual(['ficus-api', 'ficus-worker'])
    expect(readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')).toBe(EXAMPLE)

    // Registry: relabelled, identity 2, version still 3.
    const written = JSON.parse(readFileSync(w.statePath, 'utf8'))
    expect(written.version).toBe(3)
    expect(written.default).toBe('ficus')
    expect(Object.keys(written.instances)).toEqual(['ficus'])
    expect(written.instances.ficus).toEqual({
      root: w.root,
      port: 3900,
      supervisor: 'pm2',
      createdAt: 'c',
      updatedAt: 'u',
      identity: 2,
    })

    // The CLI home moved, with the link left behind, and the stored paths rebased.
    const legacyHome = join(w.home, LEGACY_HOME_DIR_NAME)
    expect(lstatSync(join(w.home, '.ficus')).isDirectory()).toBe(true)
    expect(readlinkSync(legacyHome)).toBe('.ficus')
    const rebase = w.calls.find((c) => c[0] === 'bun' && c[1].endsWith('rebase-home.js'))
    expect(rebase).toEqual([
      'bun',
      join(w.root, 'apps/core/dist/rebase-home.js'),
      '--from',
      legacyHome,
      '--to',
      join(w.home, '.ficus'),
    ])

    // .env: explicit HOME_DIR, the ficus label and app names; everything else untouched; a backup.
    const env = readFileSync(join(w.root, '.env'), 'utf8')
    expect(env).toBe(
      w.envText
        .replace(`FICUS_INSTANCE=${L}\n`, 'FICUS_INSTANCE=ficus\n')
        .replace(`FICUS_PM2_API_NAME=${LEGACY_UNITS.api}\n`, 'FICUS_PM2_API_NAME=ficus-api\n')
        .replace(`FICUS_PM2_WORKER_NAME=${LEGACY_UNITS.worker}\n`, 'FICUS_PM2_WORKER_NAME=ficus-worker\n') +
        'HOME_DIR=~/.ficus\n'
    )
    const backups = readdirSync(w.root).filter((f) => f.startsWith('.env.pre-ficus-rename-'))
    expect(backups).toEqual(['.env.pre-ficus-rename-20260930T120000Z'])
    expect(readFileSync(join(w.root, backups[0]), 'utf8')).toBe(w.envText)

    // The run is complete: no active journal (server start is free again), the completed one kept for --undo.
    expect(existsSync(w.journal())).toBe(false)
    expect(readRenameJournal(w.journal())).toBeUndefined()
    expect(existsSync(join(w.home, '.ficus', 'rename-identity.ficus.journal'))).toBe(true)
    expect(report).toMatchObject({ root: w.root, status: 'renamed', from: { label: L }, to: { label: 'ficus' } })
  })

  it('dry-run prints the plan and changes nothing', async () => {
    const w = world('pm2')
    const eco = readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')
    const report = await renameIdentity({ root: w.root, dryRun: true }, w.deps)
    expect(report.status).toBe('dry-run')
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
    expect(readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')).toBe(eco)
    expect(lstatSync(join(w.home, LEGACY_HOME_DIR_NAME)).isDirectory()).toBe(true)
    expect(existsSync(join(w.home, '.ficus'))).toBe(false)
    expect(readdirSync(w.root).some((f) => f.includes('pre-ficus-rename'))).toBe(false)
    expect(existsSync(w.journal())).toBe(false)
    // Nothing reached the supervisor; the rebase program only ran its read-only --dry-run.
    for (const call of joined(w.calls)) expect(call).toMatch(/^bun \S+rebase-home\.js .* --dry-run$/)
    const text = w.printed.join('\n')
    expect(text).toContain(`pm2 delete ${LEGACY_UNITS.api} ${LEGACY_UNITS.worker}`)
    expect(text).toContain('REBASE_HOME_TARGET sessions.cwd=0')
    expect(text).not.toContain('warning')
    expect(text).toContain('ficus-api')
    expect(text).toContain('Postgres: external')
    expect(text).toContain('Dry run')
  })

  it('reports an already renamed instance and changes nothing', async () => {
    const w = world('pm2')
    await renameIdentity({ root: w.root }, w.deps)
    const registry = readFileSync(w.statePath, 'utf8')
    const env = readFileSync(join(w.root, '.env'), 'utf8')
    w.calls.length = 0
    const report = await renameIdentity({ root: w.root }, w.deps)
    expect(report.status).toBe('already')
    expect(readFileSync(w.statePath, 'utf8')).toBe(registry)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(env)
    expect(w.calls).toEqual([])
  })

  it('--undo after a completed run restores the old names, home, registry and .env', async () => {
    const w = world('pm2')
    await renameIdentity({ root: w.root }, w.deps)
    w.calls.length = 0
    const report = await renameIdentity({ root: w.root, undo: true }, w.deps)
    expect(report.status).toBe('undone')
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
    expect(readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')).toBe(LEGACY_ECOSYSTEM)
    expect(lstatSync(join(w.home, LEGACY_HOME_DIR_NAME)).isDirectory()).toBe(true)
    expect(existsSync(join(w.home, '.ficus'))).toBe(false)
    expect([...w.pm2].sort()).toEqual([LEGACY_UNITS.api, LEGACY_UNITS.worker].sort())
    const pm2Calls = joined(w.calls).filter((c) => c.startsWith('bunx pm2') && !c.endsWith('jlist'))
    expect(pm2Calls).toEqual([
      'bunx pm2 delete ficus-api ficus-worker',
      'bunx pm2 save --force',
      `bunx pm2 start ecosystem.config.js --only ${LEGACY_UNITS.api},${LEGACY_UNITS.worker} --update-env`,
      'bunx pm2 save',
    ])
    const rebase = w.calls.find((c) => c[0] === 'bun' && c[1].endsWith('rebase-home.js'))
    expect(rebase?.slice(2)).toEqual(['--from', join(w.home, '.ficus'), '--to', join(w.home, LEGACY_HOME_DIR_NAME)])
    expect(existsSync(w.journal())).toBe(false)
    expect(existsSync(join(w.home, LEGACY_HOME_DIR_NAME, 'rename-identity.ficus.journal'))).toBe(false)
  })

  it('a failed readiness check undoes everything and restarts the old apps', async () => {
    const w = world('pm2', { fetch: async () => new Response('down', { status: 502 }) })
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/ready/)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
    expect(readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')).toBe(LEGACY_ECOSYSTEM)
    expect(lstatSync(join(w.home, LEGACY_HOME_DIR_NAME)).isDirectory()).toBe(true)
    expect([...w.pm2].sort()).toEqual([LEGACY_UNITS.api, LEGACY_UNITS.worker].sort())
    expect(existsSync(w.journal())).toBe(false)
  })
})

describe('renameIdentity (launchd)', () => {
  it('boots out the legacy jobs, bootstraps the sh.ficus jobs and removes the old plists', async () => {
    const w = world('launchd')
    const agents = installLegacyLaunchd(w)
    const oldPlists = readdirSync(agents)
    await renameIdentity({ root: w.root }, w.deps)
    const lines = joined(w.calls)
    const bootoutApi = lines.indexOf(`launchctl bootout gui/${UID}/${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`)
    const bootoutWorker = lines.indexOf(`launchctl bootout gui/${UID}/${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.worker}`)
    const bootstrapApi = lines.indexOf(`launchctl bootstrap gui/${UID} ${join(agents, 'sh.ficus.ficus-api.plist')}`)
    expect(bootoutApi).toBeGreaterThan(-1)
    expect(bootoutWorker).toBeGreaterThan(bootoutApi)
    expect(bootstrapApi).toBeGreaterThan(bootoutWorker)
    for (const plist of oldPlists) expect(existsSync(join(agents, plist))).toBe(false)
    expect(readdirSync(agents).sort()).toEqual(['sh.ficus.ficus-api.plist', 'sh.ficus.ficus-worker.plist'])
    expect([...w.loaded].sort()).toEqual(['sh.ficus.ficus-api', 'sh.ficus.ficus-worker'])
    // The new plists log under the moved home; .env's file-log targets follow them.
    const plist = readFileSync(join(agents, 'sh.ficus.ficus-api.plist'), 'utf8')
    expect(plist).toContain(join(w.home, '.ficus', 'logs', 'ficus-api.log'))
    const env = readFileSync(join(w.root, '.env'), 'utf8')
    expect(env).toContain(`FICUS_LOG_FILE_API=${join(w.home, '.ficus', 'logs', 'ficus-api.log')}\n`)
    expect(env).toContain(`FICUS_LOG_FILE_WORKER=${join(w.home, '.ficus', 'logs', 'ficus-worker.log')}\n`)
    expect(JSON.parse(readFileSync(w.statePath, 'utf8')).instances.ficus.identity).toBe(2)
    // The old plists are gone, so their labels are enabled again: no override is left behind
    // for a later manual bootstrap of the old plists (the rollback fallback) to trip over.
    expect([...w.disabled]).toEqual([])
  })

  it('a failure at step 9 restores the old plists, the .env and the registry, and restarts the old labels', async () => {
    const w = world('launchd')
    const agents = installLegacyLaunchd(w)
    const oldPlists = Object.fromEntries(readdirSync(agents).map((f) => [f, readFileSync(join(agents, f), 'utf8')]))
    w.fail.match = (line) => line.startsWith('launchctl bootstrap') && line.endsWith('sh.ficus.ficus-api.plist')
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/undone/)
    // Old plists are back, byte for byte; the new ones are gone.
    expect(readdirSync(agents).sort()).toEqual(Object.keys(oldPlists).sort())
    for (const [file, text] of Object.entries(oldPlists)) expect(readFileSync(join(agents, file), 'utf8')).toBe(text)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect(lstatSync(join(w.home, LEGACY_HOME_DIR_NAME)).isDirectory()).toBe(true)
    expect(existsSync(join(w.home, '.ficus'))).toBe(false)
    // Restarted under the old labels, after the failure.
    const lines = joined(w.calls)
    const failed = lines.findIndex((l) => l.endsWith('sh.ficus.ficus-api.plist') && l.includes('bootstrap'))
    const restarted = lines.findIndex(
      (l, i) =>
        i > failed &&
        l === `launchctl bootstrap gui/${UID} ${join(agents, `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}.plist`)}`
    )
    expect(restarted).toBeGreaterThan(failed)
    expect([...w.loaded].sort()).toEqual(
      [`${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`, `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.worker}`].sort()
    )
    // The rebase was reversed, and the journal is gone.
    const rebases = w.calls.filter((c) => c[0] === 'bun' && c[1].endsWith('rebase-home.js')).map((c) => c.slice(2))
    expect(rebases.at(-1)).toEqual(['--from', join(w.home, '.ficus'), '--to', join(w.home, LEGACY_HOME_DIR_NAME)])
    expect(existsSync(w.journal())).toBe(false)
  })

  it('keeps the journal when the undo itself fails, and the next run finishes the undo first', async () => {
    const w = world('launchd')
    const agents = installLegacyLaunchd(w)
    const legacyApiPlist = join(agents, `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}.plist`)
    // Step 9 fails, and so does the first attempt to bring the old job back.
    w.fail.match = (line) => line.startsWith('launchctl bootstrap')
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/journal/)
    expect(readRenameJournal(w.journal())?.root).toBe(w.root)
    // While it exists, an interrupted run blocks another rename of this root until it is resolved.
    w.fail.match = undefined
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/interrupted.*undone/)
    expect(existsSync(w.journal())).toBe(false)
    expect(existsSync(legacyApiPlist)).toBe(true)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect(w.loaded.has(`${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`)).toBe(true)
  })

  it('undoes a run that crashed after moving the home before doing anything else', async () => {
    const w = world('launchd')
    installLegacyLaunchd(w)
    // What a run killed right after step 3 leaves behind: the old jobs stopped, the home moved.
    const legacyHome = join(w.home, LEGACY_HOME_DIR_NAME)
    const ficusHome = join(w.home, '.ficus')
    const { renameSync, symlinkSync } = await import('fs')
    renameSync(legacyHome, ficusHome)
    symlinkSync('.ficus', legacyHome)
    for (const label of [...w.loaded]) w.loaded.delete(label)
    writeFileSync(
      join(ficusHome, RENAME_JOURNAL),
      [
        { op: 'begin', root: w.root, supervisor: 'launchd', from: L, to: 'ficus', port: 3900, home: w.home },
        { op: 'stopped' },
        { op: 'home-move', home: w.home },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    )
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/interrupted.*undone/)
    expect(lstatSync(legacyHome).isDirectory()).toBe(true)
    expect(existsSync(ficusHome)).toBe(false)
    expect(existsSync(join(legacyHome, RENAME_JOURNAL))).toBe(false)
    expect(w.loaded.has(`${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`)).toBe(true)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
  })
})

describe('renameIdentity and the local Postgres', () => {
  function stubPostgres() {
    const calls: { fn: string; args: unknown }[] = []
    const ops: Partial<PostgresOps> = {
      plan: async (move) => {
        calls.push({ fn: 'plan', args: move })
        return {
          action: 'rename',
          from: { container: move.legacy.container, volume: move.legacy.volume, running: true },
          to: { container: move.ficus.container, volume: move.ficus.volume },
          port: 5432,
          image: 'sha256:img',
          dataDir: '/var/lib/postgresql',
          database: { from: move.legacy.database, to: move.ficus.database },
        }
      },
      rename: async (_move, _root, _deps, opts) => {
        calls.push({ fn: 'rename', args: opts })
        return 'renamed'
      },
      undo: async (_move, _root, _deps, opts) => {
        calls.push({ fn: 'undo', args: opts })
        return { keptVolume: opts.appStarted ? 'ficus_postgres-data' : undefined }
      },
      finalize: async () => {
        calls.push({ fn: 'finalize', args: null })
        return 'unless-stopped'
      },
    }
    return { ops, calls }
  }

  it('journals the run id before the move and finalizes after the health check', async () => {
    const pg = stubPostgres()
    const w = world('pm2', { postgres: pg.ops })
    await renameIdentity({ root: w.root }, w.deps)
    expect(pg.calls.map((c) => c.fn)).toEqual(['plan', 'rename', 'finalize'])
    const runId = (pg.calls[1].args as { runId: string }).runId
    expect(runId).toMatch(/^[A-Za-z0-9]/)
    const completed = readFileSync(join(w.home, '.ficus', 'rename-identity.ficus.journal'), 'utf8')
    expect(completed).toContain(`"runId":"${runId}"`)
    expect(completed.indexOf('"op":"postgres"')).toBeLessThan(completed.indexOf('"op":"new-identity"'))
  })

  it('a failure before the new identity starts undoes the move with appStarted false', async () => {
    const pg = stubPostgres()
    const w = world('pm2', { postgres: pg.ops })
    // Step 7 finds the ecosystem file edited since the plan: it declares the old api twice now.
    const rename = pg.ops.rename!
    pg.ops.rename = async (...args) => {
      writeFileSync(join(w.root, 'ecosystem.config.js'), LEGACY_ECOSYSTEM + LEGACY_ECOSYSTEM)
      return rename(...args)
    }
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/undone/)
    const undo = pg.calls.find((c) => c.fn === 'undo')
    expect(undo?.args).toEqual({ appStarted: false, runId: (pg.calls[1].args as { runId: string }).runId })
    expect(pg.calls.some((c) => c.fn === 'finalize')).toBe(false)
  })

  it('a failure once the new identity may be running undoes with appStarted true and reports the kept volume', async () => {
    const pg = stubPostgres()
    const w = world('pm2', { postgres: pg.ops })
    w.fail.match = (line) => line.startsWith('bunx pm2 start') && line.includes('ficus-api')
    const error = await renameIdentity({ root: w.root }, w.deps).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(pg.calls.find((c) => c.fn === 'undo')?.args).toMatchObject({ appStarted: true })
    expect((error as Error).message).toContain('ficus_postgres-data')
  })

  it('a rename that throws has already rolled itself back: no undo call for it', async () => {
    const pg = stubPostgres()
    pg.ops.rename = async () => {
      pg.calls.push({ fn: 'rename', args: null })
      throw new Error('ALTER failed')
    }
    const w = world('pm2', { postgres: pg.ops })
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/ALTER failed/)
    expect(pg.calls.some((c) => c.fn === 'undo')).toBe(false)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
    expect([...w.pm2].sort()).toEqual([LEGACY_UNITS.api, LEGACY_UNITS.worker].sort())
  })

  it('dry-run prints the Postgres plan', async () => {
    const pg = stubPostgres()
    const w = world('pm2', { postgres: pg.ops })
    await renameIdentity({ root: w.root, dryRun: true }, w.deps)
    expect(pg.calls.map((c) => c.fn)).toEqual(['plan'])
    expect(w.printed.join('\n')).toContain(`postgres-${L} → postgres-ficus`)
  })
})

describe('supervisor identity switch (systemd-user)', () => {
  it('disables the old units, enables the new ones and removes the old unit files', async () => {
    const w = world('systemd-user')
    const old = supervisorIdentity('systemd-user', L, 1)
    const next = supervisorIdentity('systemd-user', 'ficus', 2)
    const oldCtx = w.deps.supervisorContext(old, w.root)
    const unitDir = join(w.home, '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    for (const c of ['api', 'worker'] as const) writeFileSync(systemdUserNames(oldCtx, c).path, systemdUnit(oldCtx, c))
    const deps = { root: w.root, context: w.deps.supervisorContext }
    await stopSupervisor(old, deps)
    await installSupervisor(next, w.root, deps)
    await removeSupervisorDefinitions(old, w.root, deps)
    const lines = joined(w.calls)
    expect(lines).toContain(`systemctl --user disable --now ${LEGACY_UNITS.api}.service`)
    expect(lines).toContain(`systemctl --user disable --now ${LEGACY_UNITS.worker}.service`)
    expect(lines.indexOf('systemctl --user enable --now ficus-api.service')).toBeGreaterThan(
      lines.indexOf(`systemctl --user disable --now ${LEGACY_UNITS.worker}.service`)
    )
    expect(
      readdirSync(unitDir)
        .filter((f) => f.endsWith('.service'))
        .sort()
    ).toEqual(['ficus-api.service', 'ficus-worker.service'])
  })
})

/** The env a recorded call ran with, for a call matching `prefix`. */
function envOf(w: World, prefix: string, which: 'first' | 'last' = 'first'): Record<string, string | undefined> {
  const indexes = w.calls.flatMap((c, i) => (c.join(' ').startsWith(prefix) ? [i] : []))
  const index = which === 'first' ? indexes[0] : indexes.at(-1)
  if (index === undefined) throw new Error(`no call ${prefix}`)
  return w.options[index].env ?? {}
}

describe('every start reads the checkout .env as it is on disk', () => {
  // The installer-managed database URL, before (legacy database) and after the move.
  const managedUrl = (database: string) => `postgres://postgres:postgres@localhost:5432/${database}`

  /** A Postgres move that rewrites DATABASE_URL the way renameLocalPostgres and its undo do. */
  function movingPostgres(root: string): Partial<PostgresOps> {
    const repoint = (from: string, to: string) => {
      const path = join(root, '.env')
      writeFileSync(path, readFileSync(path, 'utf8').replace(managedUrl(from), managedUrl(to)))
    }
    return {
      plan: async (move) => ({
        action: 'rename',
        from: { container: move.legacy.container, volume: move.legacy.volume, running: true },
        to: { container: move.ficus.container, volume: move.ficus.volume },
        port: 5432,
        image: 'sha256:img',
        dataDir: '/var/lib/postgresql',
        database: { from: move.legacy.database, to: move.ficus.database },
      }),
      rename: async () => {
        repoint(L, 'ficus')
        return 'renamed'
      },
      undo: async () => {
        repoint('ficus', L)
        return { keptVolume: 'ficus_postgres-data' }
      },
      finalize: async () => 'unless-stopped',
    }
  }

  it('pm2 starts the new apps with the rewritten DATABASE_URL, HOME_DIR and label, not the CLI env', async () => {
    const root = join(tmp, 'checkout')
    // What a CLI launched from inside the checkout auto-loaded: the .env as it was before the run.
    const stale = {
      PATH: '/usr/bin',
      DATABASE_URL: managedUrl(L),
      FICUS_INSTANCE: L,
      FICUS_PM2_API_NAME: LEGACY_UNITS.api,
      FICUS_ONLY_IN_THE_OLD_FILE: 'x',
    }
    const w = world('pm2', { postgres: movingPostgres(root), databaseUrl: managedUrl(L), env: stale })
    await renameIdentity({ root: w.root }, w.deps)
    const env = envOf(w, 'bunx pm2 start')
    expect(env.DATABASE_URL).toBe(managedUrl('ficus'))
    expect(env.HOME_DIR).toBe('~/.ficus')
    expect(env.FICUS_INSTANCE).toBe('ficus')
    expect(env.FICUS_PM2_API_NAME).toBe('ficus-api')
    // A key only the process env holds is removed (the runner drops undefined), not inherited.
    expect('FICUS_ONLY_IN_THE_OLD_FILE' in env).toBe(true)
    expect(env.FICUS_ONLY_IN_THE_OLD_FILE).toBeUndefined()
    expect(env.PATH).toBeUndefined()
  })

  it('the undo restarts the old apps with the restored .env, not the CLI env of the undo', async () => {
    const root = join(tmp, 'checkout')
    const w = world('pm2', { postgres: movingPostgres(root), databaseUrl: managedUrl(L) })
    await renameIdentity({ root: w.root }, w.deps)
    // The --undo runs from inside the checkout too: its process env is the renamed .env.
    w.deps.env = { PATH: '/usr/bin', ...parseEnvFile(readFileSync(join(w.root, '.env'), 'utf8')) }
    w.calls.length = 0
    w.options.length = 0
    await renameIdentity({ root: w.root, undo: true }, w.deps)
    const env = envOf(w, 'bunx pm2 start')
    expect(env.DATABASE_URL).toBe(managedUrl(L))
    expect(env.FICUS_INSTANCE).toBe(L)
    expect(env.FICUS_PM2_API_NAME).toBe(LEGACY_UNITS.api)
    // HOME_DIR was added by the run and is gone from the restored file: removed, not inherited.
    expect('HOME_DIR' in env).toBe(true)
    expect(env.HOME_DIR).toBeUndefined()
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
  })

  it('the rebase program gets the file database URL too', async () => {
    const w = world('pm2', { env: { DATABASE_URL: 'postgres://stale@localhost/stale' } })
    await renameIdentity({ root: w.root }, w.deps)
    expect(envOf(w, 'bun ').DATABASE_URL).toBe('postgres://app:secret@db.example.com:5432/app')
  })

  it('launchd plists and systemd units carry no .env value: the app reads the file itself', async () => {
    const w = world('launchd')
    installLegacyLaunchd(w)
    await renameIdentity({ root: w.root }, w.deps)
    const plist = readFileSync(join(w.home, 'Library/LaunchAgents/sh.ficus.ficus-api.plist'), 'utf8')
    for (const key of ['DATABASE_URL', 'HOME_DIR', 'FICUS_']) expect(plist).not.toContain(key)
    const unit = systemdUnit(w.deps.supervisorContext(supervisorIdentity('systemd-user', 'ficus', 2), w.root), 'api')
    for (const key of ['DATABASE_URL', 'HOME_DIR', 'FICUS_']) expect(unit).not.toContain(key)
  })
})

describe('ecosystem.config.js is renamed in place', () => {
  const customized = LEGACY_ECOSYSTEM.replace(
    "      cwd: './',",
    "      cwd: './',\n      max_memory_restart: '4G',\n      env_pinned: { PORT: 62832, WORKER_PORT: 62833 },"
  )

  it('keeps hand edits, swaps only the app names, and --undo restores the original bytes', async () => {
    const w = world('pm2', { ecosystem: customized })
    await renameIdentity({ root: w.root, dryRun: true }, w.deps)
    const dry = w.printed.join('\n')
    expect(dry).toContain(`-       name: '${LEGACY_UNITS.api}',`)
    expect(dry).toContain(`+       name: 'ficus-api',`)
    expect(dry).not.toContain('max_memory_restart')
    await renameIdentity({ root: w.root }, w.deps)
    const renamed = readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')
    expect(renamed).toContain("max_memory_restart: '4G',")
    expect(renamed).toContain('env_pinned: { PORT: 62832, WORKER_PORT: 62833 },')
    expect(renamed).toBe(
      customized
        .replaceAll(`'${LEGACY_UNITS.api}'`, "'ficus-api'")
        .replaceAll(`'${LEGACY_UNITS.worker}'`, "'ficus-worker'")
    )
    await renameIdentity({ root: w.root, undo: true }, w.deps)
    expect(readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')).toBe(customized)
  })

  it('refuses before changing anything when an old app is not declared exactly once', async () => {
    const twice = customized + customized
    const w = world('pm2', { ecosystem: twice })
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/declares the app .* 2 times/)
    expect(w.calls).toEqual([])
    expect(readFileSync(join(w.root, 'ecosystem.config.js'), 'utf8')).toBe(twice)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect(existsSync(w.journal())).toBe(false)
  })
})

describe('nothing comes back by itself mid-run', () => {
  it('launchd: step 2 disables the old jobs after booting them out; the undo enables them again', async () => {
    const w = world('launchd')
    installLegacyLaunchd(w)
    const oldApi = `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`
    w.fail.match = (line) => line.startsWith('launchctl bootstrap') && line.endsWith('sh.ficus.ficus-api.plist')
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/undone/)
    const lines = joined(w.calls)
    expect(lines.indexOf(`launchctl disable gui/${UID}/${oldApi}`)).toBeGreaterThan(
      lines.indexOf(`launchctl bootout gui/${UID}/${oldApi}`)
    )
    // The fake launchd refuses to bootstrap a disabled label: the restart shows it was enabled first.
    expect(w.disabled.has(oldApi)).toBe(false)
    expect(w.loaded.has(oldApi)).toBe(true)
    // The undo stopped (disabled) and removed the new jobs, then enabled their labels again,
    // so a later setup of the `ficus` instance can bootstrap sh.ficus.* at all.
    expect([...w.disabled]).toEqual([])
  })

  it('pm2: after a reboot resurrected the old apps, recovery deletes them before reversing anything', async () => {
    const w = world('pm2')
    const legacyHome = join(w.home, LEGACY_HOME_DIR_NAME)
    const ficusHome = join(w.home, '.ficus')
    // A run killed after step 3: the home moved and rebased; then a reboot, and `pm2 resurrect`
    // brought the old apps back from a dump saved before the run.
    renameSync(legacyHome, ficusHome)
    symlinkSync('.ficus', legacyHome)
    writeFileSync(
      join(ficusHome, RENAME_JOURNAL),
      [
        { op: 'begin', root: w.root, supervisor: 'pm2', from: L, to: 'ficus', port: 3900, home: w.home },
        { op: 'stopped' },
        { op: 'home-move', home: w.home },
        { op: 'home-rebase', from: legacyHome, to: ficusHome },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    )
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/interrupted.*undone/)
    const lines = joined(w.calls)
    const deleted = lines.indexOf(`bunx pm2 delete ${LEGACY_UNITS.api} ${LEGACY_UNITS.worker}`)
    const saved = lines.indexOf('bunx pm2 save --force')
    const reversed = lines.findIndex((l) => l.includes('rebase-home.js') && l.endsWith(`--to ${legacyHome}`))
    expect(deleted).toBeGreaterThan(-1)
    expect(saved).toBeGreaterThan(deleted)
    expect(reversed).toBeGreaterThan(saved)
    expect(lstatSync(legacyHome).isDirectory()).toBe(true)
    expect([...w.pm2].sort()).toEqual([LEGACY_UNITS.api, LEGACY_UNITS.worker].sort())
  })
})

describe('readiness, finishing and refusing', () => {
  it('step 10 waits for /ready, not /health: an API that never gets ready is undone', async () => {
    const w = world('pm2')
    w.ready.status = 503
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/\/ready/)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
    expect([...w.pm2].sort()).toEqual([LEGACY_UNITS.api, LEGACY_UNITS.worker].sort())
  })

  it('a finalize failure keeps the renamed instance and the journal; the next run finishes', async () => {
    let fail = true
    const finalized: string[] = []
    const w = world('pm2', {
      postgres: {
        plan: async (move) => ({
          action: 'rename',
          from: { container: move.legacy.container, volume: move.legacy.volume, running: true },
          to: { container: move.ficus.container, volume: move.ficus.volume },
          port: 5432,
          image: 'sha256:img',
          dataDir: '/var/lib/postgresql',
          database: undefined,
        }),
        rename: async () => 'renamed',
        undo: async () => {
          throw new Error('undo must not run')
        },
        finalize: async (move) => {
          if (fail) throw new Error('docker update failed')
          finalized.push(move.ficus.container)
          return 'unless-stopped'
        },
      },
    })
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/renamed and ready.*journal is kept/)
    expect(JSON.parse(readFileSync(w.statePath, 'utf8')).instances.ficus.identity).toBe(2)
    expect(readRenameJournal(w.journal())?.root).toBe(w.root)
    fail = false
    w.calls.length = 0
    const report = await renameIdentity({ root: w.root }, w.deps)
    expect(report).toMatchObject({ status: 'renamed', resumed: true })
    expect(finalized).toEqual(['postgres-ficus'])
    // The container may have stayed stopped since (it was --restart no until finalize).
    expect(joined(w.calls)).toContain('docker start postgres-ficus')
    expect(existsSync(w.journal())).toBe(false)
  })

  it('--undo checks what it cannot recreate before changing anything', async () => {
    const w = world('pm2')
    await renameIdentity({ root: w.root }, w.deps)
    rmSync(join(w.root, 'apps/core/dist/rebase-home.js'))
    const registry = readFileSync(w.statePath, 'utf8')
    w.calls.length = 0
    await expect(renameIdentity({ root: w.root, undo: true }, w.deps)).rejects.toThrow(
      /rebase-home\.js is missing.*Nothing was changed/
    )
    expect(w.calls).toEqual([])
    expect(readFileSync(w.statePath, 'utf8')).toBe(registry)
    expect([...w.pm2].sort()).toEqual(['ficus-api', 'ficus-worker'])
  })

  it('dry-run warns when the database already holds paths under the new home', async () => {
    const w = world('pm2')
    w.rebasePreview.stdout = 'REBASE_HOME sessions.cwd=3\nREBASE_HOME_TARGET sessions.cwd=2\n'
    await renameIdentity({ root: w.root, dryRun: true }, w.deps)
    expect(w.printed.join('\n')).toMatch(/warning: the database already holds paths under .*\.ficus/)
  })

  it('a torn last journal line is cut off before the next append, so the journal stays readable', async () => {
    const w = world('pm2')
    const journal = join(w.home, LEGACY_HOME_DIR_NAME, RENAME_JOURNAL)
    const begin = { op: 'begin', root: w.root, supervisor: 'pm2', from: L, to: 'ficus', port: 3900, home: w.home }
    // A run killed while appending its fourth line.
    const lines = [begin, { op: 'stopped' }, { op: 'env', edits: [] }].map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(journal, `${lines}\n{"op":"home-mo`)
    // The first recovery appends progress, then fails to restart the old apps: the journal is kept.
    w.fail.match = (line) => line.startsWith('bunx pm2 start')
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/journal .* is kept/)
    expect(readFileSync(journal, 'utf8')).not.toContain('home-mo')
    // …and the next one can still read it.
    w.fail.match = undefined
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/interrupted.*undone/)
    expect(existsSync(journal)).toBe(false)
  })

  it('restores a .env that had no final newline byte for byte', async () => {
    const w = world('pm2', { fetch: async () => new Response('down', { status: 502 }) })
    const text = w.envText.slice(0, -1)
    writeFileSync(join(w.root, '.env'), text)
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/ready/)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(text)
  })

  it('one run at a time: a live lock refuses and names itself; a dead or reused pid is taken over', async () => {
    const w = world('pm2')
    const lock = `${w.journal()}.lock`
    const started = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(process.pid)])
      .stdout.toString()
      .trim()
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started }))
    const error = await renameIdentity({ root: w.root }, w.deps).catch((e: Error) => e)
    expect((error as Error).message).toContain(`another \`ficus server rename-identity\` (pid ${process.pid}`)
    expect((error as Error).message).toContain(lock)
    expect((error as Error).message).toContain(`ps -o lstart=,command= -p ${process.pid}`)
    expect(w.calls).toEqual([])
    // The same pid, but a process started at another time: the pid was reused (a reboot).
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' }))
    await renameIdentity({ root: w.root, dryRun: false }, w.deps)
    expect(existsSync(join(w.home, '.ficus', `${RENAME_JOURNAL}.lock`))).toBe(false)
  })

  it('a lock whose process is gone is taken over', async () => {
    const w = world('pm2')
    writeFileSync(`${w.journal()}.lock`, JSON.stringify({ pid: 2147483646, started: 'x' }))
    await renameIdentity({ root: w.root }, w.deps)
    expect(JSON.parse(readFileSync(w.statePath, 'utf8')).instances.ficus.identity).toBe(2)
  })

  it('every /ready request has its own timeout, so a wedged API cannot stretch the budget', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const w = world('pm2', {
      fetch: (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined)
        return new Response('ok', { status: 200 })
      }) as typeof fetch,
    })
    await renameIdentity({ root: w.root }, w.deps)
    expect(signals.length).toBeGreaterThan(0)
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps a missing final newline when step 4 had nothing to change', async () => {
    // HOME_DIR already names a custom home: step 4 edits nothing, step 6 renames the label.
    const w = world('pm2', { fetch: async () => new Response('down', { status: 502 }), envExtra: 'HOME_DIR=/srv/data' })
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/ready/)
    expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
  })

  it('keeps a complete last journal line that lacks its newline', async () => {
    const w = world('pm2')
    const journal = join(w.home, LEGACY_HOME_DIR_NAME, RENAME_JOURNAL)
    const begin = { op: 'begin', root: w.root, supervisor: 'pm2', from: L, to: 'ficus', port: 3900, home: w.home }
    // A hand edit (or a write torn exactly before its newline): the last entry is whole.
    const lines = [begin, { op: 'stopped' }, { op: 'env', edits: [] }].map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(journal, lines)
    w.fail.match = (line) => line.startsWith('bunx pm2 start')
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/journal .* is kept/)
    const kept = readFileSync(journal, 'utf8')
    expect(kept.startsWith(`${lines}\n`)).toBe(true)
    expect(kept).toContain('"op":"undone","index":2')
  })
})

describe('final-review fixes', () => {
  it('retries rebase-home while the restarted Postgres still refuses connections', async () => {
    const w = world('pm2')
    await renameIdentity({ root: w.root }, w.deps)
    w.calls.length = 0
    // The undo's reverse rebase meets a server that is still starting, twice.
    w.rebaseDown.refusals = 2
    const report = await renameIdentity({ root: w.root, undo: true }, w.deps)
    expect(report.status).toBe('undone')
    const rebases = joined(w.calls).filter((c) => c.includes('rebase-home.js'))
    expect(rebases).toHaveLength(3)
    expect(lstatSync(join(w.home, LEGACY_HOME_DIR_NAME)).isDirectory()).toBe(true)
  })

  it('gives up on rebase-home after a bounded number of refused connections', async () => {
    const w = world('pm2')
    w.rebaseDown.refusals = 100
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/ECONNREFUSED/)
    const attempts = joined(w.calls).filter((c) => c.includes('rebase-home.js') && !c.endsWith('--dry-run'))
    expect(attempts.length).toBeGreaterThan(1)
    expect(attempts.length).toBeLessThanOrEqual(6)
  })

  it('refuses, changing nothing, when the legacy home is a symlink to somewhere else', async () => {
    for (const homeDir of [undefined, `~/${LEGACY_HOME_DIR_NAME}`]) {
      rmSync(join(tmp, 'home'), { recursive: true, force: true })
      rmSync(join(tmp, 'checkout'), { recursive: true, force: true })
      const w = world('pm2', { envExtra: homeDir ? `HOME_DIR=${homeDir}\n` : '' })
      // The home lives on another disk, reached through the legacy name.
      const legacyHome = join(w.home, LEGACY_HOME_DIR_NAME)
      const elsewhere = join(tmp, `external-${homeDir ? 'explicit' : 'unset'}`)
      renameSync(legacyHome, elsewhere)
      symlinkSync(elsewhere, legacyHome)
      const registry = readFileSync(w.statePath, 'utf8')
      for (const dryRun of [true, false]) {
        const error = await renameIdentity({ root: w.root, dryRun }, w.deps).catch((e: Error) => e)
        expect((error as Error).message).toContain(`${legacyHome} is a symlink to ${elsewhere}`)
        expect((error as Error).message).toContain('by hand')
      }
      expect(w.calls).toEqual([])
      expect(readFileSync(join(w.root, '.env'), 'utf8')).toBe(w.envText)
      expect(readFileSync(w.statePath, 'utf8')).toBe(registry)
      expect(existsSync(join(w.home, '.ficus'))).toBe(false)
    }
  })

  it('pins HOME_DIR only when the home moves', async () => {
    // The home already moved (by an earlier rename): the legacy name is the link to .ficus.
    const w = world('pm2')
    const legacyHome = join(w.home, LEGACY_HOME_DIR_NAME)
    renameSync(legacyHome, join(w.home, '.ficus'))
    symlinkSync('.ficus', legacyHome)
    await renameIdentity({ root: w.root }, w.deps)
    expect(parseEnvFile(readFileSync(join(w.root, '.env'), 'utf8')).HOME_DIR).toBeUndefined()
    expect(joined(w.calls).some((c) => c.includes('rebase-home.js'))).toBe(false)
  })

  it('does not start an old identity that was stopped before the run', async () => {
    // pm2: the old apps were stopped and deleted before the run; a failed run leaves them so.
    const w = world('pm2', { pm2Running: false, fetch: async () => new Response('down', { status: 502 }) })
    const error = await renameIdentity({ root: w.root }, w.deps).catch((e: Error) => e)
    expect((error as Error).message).toMatch(/undone/)
    expect((error as Error).message).not.toMatch(/not ready/)
    expect(joined(w.calls).some((c) => c.startsWith(`bunx pm2 start`) && c.includes(LEGACY_UNITS.api))).toBe(false)
    expect(w.pm2.size).toBe(0)
    expect(readFileSync(w.statePath, 'utf8')).toBe(w.registryText)
  })

  it('launchd: restores the plists of an old identity that was not loaded, without loading them', async () => {
    const w = world('launchd')
    const agents = installLegacyLaunchd(w)
    const plists = Object.fromEntries(readdirSync(agents).map((f) => [f, readFileSync(join(agents, f), 'utf8')]))
    for (const label of [...w.loaded]) w.loaded.delete(label) // stopped before the run (`ficus server stop`)
    await renameIdentity({ root: w.root }, w.deps)
    await renameIdentity({ root: w.root, undo: true }, w.deps)
    expect(readdirSync(agents).sort()).toEqual(Object.keys(plists).sort())
    for (const [file, text] of Object.entries(plists)) expect(readFileSync(join(agents, file), 'utf8')).toBe(text)
    expect(w.loaded.size).toBe(0)
    expect(w.disabled.size).toBe(0)
  })

  it('a failed docker start fails the resume, keeping the journal', async () => {
    let finalized = 0
    const w = world('pm2', {
      postgres: {
        plan: async (move) => ({
          action: 'rename',
          from: { container: move.legacy.container, volume: move.legacy.volume, running: true },
          to: { container: move.ficus.container, volume: move.ficus.volume },
          port: 5432,
          image: 'sha256:img',
          dataDir: '/var/lib/postgresql',
          database: undefined,
        }),
        rename: async () => 'renamed',
        finalize: async () => {
          if (finalized++ === 0) throw new Error('docker update failed')
          return 'unless-stopped'
        },
      },
    })
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/journal is kept/)
    w.fail.match = (line) => line === 'docker start postgres-ficus'
    await expect(renameIdentity({ root: w.root }, w.deps)).rejects.toThrow(/docker start postgres-ficus/)
    expect(readRenameJournal(w.journal())?.root).toBe(w.root)
    w.fail.match = undefined
    expect((await renameIdentity({ root: w.root }, w.deps)).status).toBe('renamed')
    expect(existsSync(w.journal())).toBe(false)
  })
})
