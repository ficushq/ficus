import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_HOME_DIR_NAME, LEGACY_LAUNCHD_PREFIX, LEGACY_LOCAL_INSTANCE, LEGACY_UNITS } from '@ficus/shared/node'
import { launchdDefinition, launchdNames, launchdSupervisor, nativeLogPath } from './launchd'
import type { SupervisorContext } from './supervisor'

const context: SupervisorContext = {
  supervisor: 'launchd',
  root: '/tmp/Ficus & <repo> “one”',
  label: 'Smoke',
  home: '/Users/me',
  bunPath: '/Users/me/My Bun/bin/bun',
  pathEnv: '/usr/local/bin:/usr/bin',
  platform: 'darwin',
  arch: 'arm64',
  uid: 501,
  username: 'me',
  runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  which: () => null,
  log: () => {},
}

describe('launchdDefinition', () => {
  it('renders safe worker arguments, environment, lifecycle, ownership, and one private log target', () => {
    const names = launchdNames(context, 'worker')
    expect(names).toEqual({
      process: 'ficus-smoke-worker',
      label: 'sh.ficus.ficus-smoke-worker',
      plist: '/Users/me/Library/LaunchAgents/sh.ficus.ficus-smoke-worker.plist',
      log: '/Users/me/.ficus/logs/ficus-smoke-worker.log',
    })
    const xml = launchdDefinition(context, 'worker')
    expect(xml).toContain('<string>sh.ficus.ficus-smoke-worker</string>')
    expect(xml).toContain('<string>/Users/me/My Bun/bin/bun</string>')
    expect(xml).toContain('<string>apps/core/dist/worker.js</string>')
    expect(xml).toContain('/tmp/Ficus &amp; &lt;repo&gt; “one”')
    expect(xml).toContain('/node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib')
    expect(xml.match(/\/Users\/me\/\.ficus\/logs\/ficus-smoke-worker\.log/g)?.length).toBe(2)
    for (const key of ['RunAtLoad', 'KeepAlive', 'ThrottleInterval', 'ProcessType', 'Umask'])
      expect(xml).toContain(`<key>${key}</key>`)
    expect(xml).not.toContain('FORCE_COLOR')
  })

  it('keeps the pre-rename label and process names for an identity-1 instance', () => {
    const L = LEGACY_LOCAL_INSTANCE
    expect(launchdNames({ ...context, identity: 1 }, 'api')).toEqual({
      process: `${L}-smoke-api`,
      label: `${LEGACY_LAUNCHD_PREFIX}.${L}-smoke-api`,
      plist: `/Users/me/Library/LaunchAgents/${LEGACY_LAUNCHD_PREFIX}.${L}-smoke-api.plist`,
      log: `/Users/me/.ficus/logs/${L}-smoke-api.log`,
    })
    expect(launchdNames({ ...context, label: L, identity: 1 }, 'worker').label).toBe(
      `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.worker}`
    )
  })

  it('rejects control characters in rendered fields', () => {
    expect(() => launchdDefinition({ ...context, root: '/bad\nroot' }, 'api')).toThrow(/control/i)
    expect(() => launchdDefinition({ ...context, bunPath: '/bad\0bun' }, 'api')).toThrow(/control/i)
    expect(() => launchdDefinition({ ...context, bunPath: 'bun' }, 'api')).toThrow(/absolute/i)
    expect(() => launchdDefinition({ ...context, arch: 'ia32' }, 'api')).toThrow(/architecture/i)
  })
})

describe('nativeLogPath', () => {
  it('keeps logs in a legacy CLI home that has not moved yet', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-launchd-home-')))
    try {
      mkdirSync(join(home, LEGACY_HOME_DIR_NAME))
      expect(nativeLogPath({ home, label: 'Smoke' }, 'worker')).toBe(
        join(home, LEGACY_HOME_DIR_NAME, 'logs', launchdNames({ home, label: 'Smoke' }, 'worker').process + '.log')
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('launchd lifecycle', () => {
  it('validates both definitions before bootstrapping worker first and API last', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-launchd-unit-'))
    const home = join(root, 'home')
    const calls: string[] = []
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      label: 'smoke',
      runner: async (command) => {
        calls.push(command.join(' '))
        const servicePrint = command[0] === 'launchctl' && command[1] === 'print' && command[2]?.split('/').length === 3
        return { code: servicePrint ? 113 : 0, stdout: '', stderr: '' }
      },
    }
    try {
      await launchdSupervisor.start(ctx)
      const bootstraps = calls.filter((call) => call.includes('launchctl bootstrap'))
      expect(bootstraps[0]).toEndWith('sh.ficus.ficus-smoke-worker.plist')
      expect(bootstraps[1]).toEndWith('sh.ficus.ficus-smoke-api.plist')
      expect(calls.filter((call) => call.startsWith('plutil -lint'))).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the logs under ~/.ficus when it exists, and never creates a legacy home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-launchd-logs-'))
    const home = join(root, 'home')
    mkdirSync(join(home, '.ficus'), { recursive: true })
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      label: 'smoke',
      runner: async (command) => {
        const servicePrint = command[0] === 'launchctl' && command[1] === 'print' && command[2]?.split('/').length === 3
        return { code: servicePrint ? 113 : 0, stdout: '', stderr: '' }
      },
    }
    try {
      await launchdSupervisor.start(ctx)
      for (const component of ['worker', 'api'] as const) {
        const log = nativeLogPath(ctx, component)
        expect(log.startsWith(join(home, '.ficus', 'logs') + '/')).toBe(true)
        expect(existsSync(log)).toBe(true)
      }
      expect(existsSync(join(home, LEGACY_HOME_DIR_NAME))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not replace either prior definition or touch jobs when the second validation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-launchd-pair-'))
    const home = join(root, 'home')
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
    let failValidation = false
    const calls: string[] = []
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      runner: async (command) => {
        calls.push(command.join(' '))
        if (failValidation && command[0] === 'plutil' && command.join(' ').includes('api.plist'))
          return { code: 1, stdout: '', stderr: 'bad' }
        const servicePrint = command[0] === 'launchctl' && command[1] === 'print' && command[2]?.split('/').length === 3
        if (servicePrint && failValidation) {
          const component = command[2]?.endsWith('-worker') ? 'worker' : 'api'
          return {
            code: 0,
            stdout: printOf(ctx.bunPath, launchdNames(ctx, component).log, ctx.root),
            stderr: '',
          }
        }
        return { code: servicePrint ? 113 : 0, stdout: '', stderr: '' }
      },
    }
    try {
      await launchdSupervisor.start(ctx)
      const paths = (['worker', 'api'] as const).map((component) => launchdNames(ctx, component).plist)
      const before = paths.map((path) => readFileSync(path, 'utf8'))
      calls.length = 0
      failValidation = true
      await expect(launchdSupervisor.start(ctx)).rejects.toThrow(/validation/i)
      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
      expect(calls.some((call) => call.includes('bootout') || call.includes('bootstrap'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not inspect or mutate loaded jobs when prerequisites or destination ownership fail', async () => {
    for (const failure of ['missing-library', 'foreign-plist'] as const) {
      const root = mkdtempSync(join(tmpdir(), `ficus-launchd-${failure}-`))
      const home = join(root, 'home')
      const calls: string[] = []
      if (failure !== 'missing-library') {
        mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
        writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
        const plist = launchdNames({ ...context, root, home }, 'worker').plist
        mkdirSync(join(plist, '..'), { recursive: true })
        writeFileSync(plist, '<!-- foreign definition -->')
      }
      const ctx: SupervisorContext = {
        ...context,
        root,
        home,
        runner: async (command) => {
          calls.push(command.join(' '))
          return { code: 0, stdout: '', stderr: '' }
        },
      }
      try {
        await expect(launchdSupervisor.start(ctx)).rejects.toThrow(/missing|not owned/i)
        expect(
          calls.some(
            (call) => call.includes('bootout') || call.includes('kickstart') || call.includes('bootstrap gui/')
          )
        ).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
})

describe('launchd loaded-job provenance', () => {
  // Real `launchctl print` shape: `program =` line, separate `arguments = {`
  // block, then working directory and stderr path.
  const printOf = (program: string, log: string, root = context.root) =>
    `program = ${program}\n\targuments = {\n\t\t${program}\n\t\trun\n\t\tapps/core/dist/worker.js\n\t}\n\tworking directory = ${root}\n\tstderr path = ${log}\n`

  it('mutation-red: refuses to kickstart a loaded job that came from another definition', async () => {
    const calls: string[] = []
    const ctx: SupervisorContext = {
      ...context,
      runner: async (command) => {
        calls.push(command.join(' '))
        if (command[0] === 'launchctl' && command[1] === 'print' && command[2] === 'gui/501')
          return { code: 0, stdout: '', stderr: '' }
        if (command[0] === 'launchctl' && command[1] === 'print')
          return { code: 0, stdout: printOf('/other/bun', '/Users/me/.ficus/logs/tau-smoke-worker.log'), stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    await expect(launchdSupervisor.restart(ctx)).rejects.toThrow(/loaded from another definition|another checkout/)
    expect(calls.some((call) => call.includes('kickstart'))).toBe(false)
  })

  it('allows a positively verified loaded job, including an absolute bun path with spaces', async () => {
    const calls: string[] = []
    const ctx: SupervisorContext = {
      ...context,
      runner: async (command) => {
        calls.push(command.join(' '))
        if (command[0] === 'launchctl' && command[1] === 'print' && command[2] === 'gui/501')
          return { code: 0, stdout: '', stderr: '' }
        if (command[0] === 'launchctl' && command[1] === 'print') {
          const component = command[2]?.endsWith('-worker') ? 'worker' : 'api'
          return { code: 0, stdout: printOf(ctx.bunPath, launchdNames(ctx, component).log), stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    await launchdSupervisor.restart(ctx)
    expect(calls.filter((call) => call.includes('kickstart'))).toHaveLength(2)
  })

  it('verifies a job loaded before the CLI home moved: its log path reaches the same file through the link', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-launchd-moved-')))
    mkdirSync(join(home, '.ficus', 'logs'), { recursive: true })
    symlinkSync('.ficus', join(home, LEGACY_HOME_DIR_NAME))
    const calls: string[] = []
    const ctx: SupervisorContext = {
      ...context,
      home,
      runner: async (command) => {
        calls.push(command.join(' '))
        if (command[0] === 'launchctl' && command[1] === 'print' && command[2] === 'gui/501')
          return { code: 0, stdout: '', stderr: '' }
        if (command[0] === 'launchctl' && command[1] === 'print') {
          const component = command[2]?.endsWith('-worker') ? 'worker' : 'api'
          const log = join(home, LEGACY_HOME_DIR_NAME, 'logs', launchdNames(ctx, component).process + '.log')
          return { code: 0, stdout: printOf(ctx.bunPath, log), stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    try {
      expect(launchdNames(ctx, 'api').log).toBe(join(home, '.ficus', 'logs', 'ficus-smoke-api.log'))
      await launchdSupervisor.restart(ctx)
      expect(calls.filter((call) => call.includes('kickstart'))).toHaveLength(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.each(['start', 'stop', 'restart', 'uninstall'] as const)(
    'mutation-red: %s does not mutate a stale-root job even when bun and log match',
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), 'ficus-launchd-stale-root-'))
      const home = join(root, 'home')
      mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
      writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
      const calls: string[] = []
      const ctx: SupervisorContext = {
        ...context,
        root,
        home,
        runner: async (command) => {
          calls.push(command.join(' '))
          if (command[0] === 'launchctl' && command[1] === 'print' && command[2] === 'gui/501')
            return { code: 0, stdout: '', stderr: '' }
          if (command[0] === 'launchctl' && command[1] === 'print') {
            const component = command[2]?.endsWith('-worker') ? 'worker' : 'api'
            return {
              code: 0,
              stdout: printOf(
                ctx.bunPath,
                launchdNames(ctx, component).log,
                component === (operation === 'restart' ? 'api' : 'worker') ? '/foreign/stale/root' : ctx.root
              ),
              stderr: '',
            }
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      }

      try {
        await expect(launchdSupervisor[operation](ctx)).rejects.toThrow(/another definition|working directory/)
        expect(
          calls.some(
            (call) => call.includes('bootout') || call.includes('kickstart') || call.includes('bootstrap gui/')
          )
        ).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('mutation-red: refuses to mutate a loaded job when provenance output is unparseable', async () => {
    const calls: string[] = []
    const ctx: SupervisorContext = {
      ...context,
      runner: async (command) => {
        calls.push(command.join(' '))
        if (command[0] === 'launchctl' && command[1] === 'print' && command[2] === 'gui/501')
          return { code: 0, stdout: '', stderr: '' }
        if (command[0] === 'launchctl' && command[1] === 'print')
          return { code: 0, stdout: 'state = running\npid = 42\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    await expect(launchdSupervisor.restart(ctx)).rejects.toThrow(/could not verify|boot it out by hand/)
    expect(calls.some((call) => call.includes('kickstart') || call.includes('bootout'))).toBe(false)
  })

  it('mutation-red: refuses to uninstall a foreign loaded job and keeps the definitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-launchd-foreign-'))
    const home = join(root, 'home')
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib'), '')
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      runner: async (command) => {
        if (command[0] === 'launchctl' && command[1] === 'print' && command.length === 3)
          return { code: 0, stdout: printOf(context.bunPath, '/Users/me/.tau/logs/foreign-worker.log'), stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const definitions = (['worker', 'api'] as const).map((component) => launchdNames(ctx, component).plist)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    for (const [index, component] of (['worker', 'api'] as const).entries()) {
      writeFileSync(definitions[index], launchdDefinition(ctx, component))
    }
    const before = definitions.map((path) => readFileSync(path, 'utf8'))
    try {
      await expect(launchdSupervisor.uninstall(ctx)).rejects.toThrow(/loaded from another definition|another checkout/)
      expect(definitions.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('launchd status vocabulary', () => {
  it('maps a running service to online', async () => {
    const stdout = '\tstate = running\n\tpid = 77\n'
    const ctx: SupervisorContext = {
      ...context,
      runner: async (command) => ({
        code: 0,
        stdout: command[1] === 'print' && command[2]?.split('/').length === 3 ? stdout : '',
        stderr: '',
      }),
    }
    const rows = await launchdSupervisor.status(ctx)
    expect(rows.every((row) => row.status === 'online' && row.pid === 77)).toBe(true)
  })
})
