import { describe, expect, it } from 'bun:test'
import { LEGACY_LOCAL_INSTANCE } from '@ficus/shared/node'
import type { SupervisorContext } from './supervisor'
import { systemdUnit, systemdUserNames } from './systemd-user'

const context: SupervisorContext = {
  supervisor: 'systemd-user',
  root: '/home/me/Ficus repo% “x”',
  label: 'Smoke',
  home: '/home/me',
  bunPath: '/home/me/bin/bun',
  pathEnv: '/home/me/a"b:/usr/bin',
  platform: 'linux',
  arch: 'x64',
  uid: 1000,
  username: 'me',
  runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  which: () => null,
  log: () => {},
}

describe('systemdUnit', () => {
  it('renders a safe user unit with file logs and no service user or dependencies', () => {
    expect(systemdUserNames(context, 'api')).toEqual({
      process: 'ficus-smoke-api',
      unit: 'ficus-smoke-api.service',
      path: '/home/me/.config/systemd/user/ficus-smoke-api.service',
      log: '/home/me/.ficus/logs/ficus-smoke-api.log',
    })
    expect(systemdUserNames({ ...context, identity: 1 }, 'api').unit).toBe(`${LEGACY_LOCAL_INSTANCE}-smoke-api.service`)
    const unit = systemdUnit(context, 'api')
    expect(unit).toContain('WorkingDirectory=/home/me/Ficus\\x20repo%%\\x20“x”')
    expect(unit).toContain('ExecStart="/home/me/bin/bun" "run" "apps/core/dist/index.js"')
    expect(unit).toContain('Environment="PATH=/home/me/a\\"b:/usr/bin"')
    expect(unit).toContain('StandardOutput=append:"/home/me/.ficus/logs/ficus-smoke-api.log"')
    expect(unit).toContain('UMask=0077')
    expect(unit).not.toMatch(/^User=/m)
    expect(unit).not.toContain('network-online.target')
  })

  it('rejects control characters and every relative native path', () => {
    expect(() => systemdUnit({ ...context, pathEnv: '/bin\nno' }, 'worker')).toThrow(/control/i)
    expect(() => systemdUnit({ ...context, root: 'relative' }, 'worker')).toThrow(/absolute/i)
    expect(() => systemdUnit({ ...context, bunPath: 'bun' }, 'worker')).toThrow(/absolute/i)
    expect(() => systemdUnit({ ...context, home: 'relative-home' }, 'worker')).toThrow(/absolute/i)
    expect(() => systemdUserNames({ ...context, xdgConfigHome: 'relative-config' }, 'worker')).toThrow(/absolute/i)
  })
})

import { ensureSystemdLinger } from './systemd-user'

describe('systemd linger', () => {
  it('does nothing when linger is already enabled', async () => {
    const calls: string[] = []
    const ctx = {
      ...context,
      which: () => '/bin/loginctl',
      runner: async (cmd: string[]) => {
        calls.push(cmd.join(' '))
        return { code: 0, stdout: 'yes\n', stderr: '' }
      },
    }
    await ensureSystemdLinger(ctx)
    expect(calls).toEqual(['loginctl show-user me --property=Linger --value'])
  })

  it('tries unprivileged enable once and warns without ever invoking sudo when denied', async () => {
    const calls: string[] = []
    const logs: string[] = []
    const ctx = {
      ...context,
      which: () => '/bin/loginctl',
      log: (line: string) => logs.push(line),
      runner: async (cmd: string[]) => {
        calls.push(cmd.join(' '))
        return { code: cmd[1] === 'enable-linger' ? 1 : 0, stdout: 'no\n', stderr: '' }
      },
    }
    await ensureSystemdLinger(ctx)
    expect(calls).toEqual(['loginctl show-user me --property=Linger --value', 'loginctl enable-linger me'])
    expect(calls.some((line) => line.startsWith('sudo '))).toBe(false)
    expect(logs).toEqual([
      'warning: systemd linger is not enabled; services stop at the last logout. Run: sudo loginctl enable-linger me',
    ])
  })

  it('prints the same guidance when loginctl is missing', async () => {
    const logs: string[] = []
    await ensureSystemdLinger({ ...context, which: () => null, log: (line) => logs.push(line) })
    expect(logs[0]).toContain('sudo loginctl enable-linger me')
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { LEGACY_HOME_DIR_NAME } from '@ficus/shared/node'
import { tmpdir } from 'os'
import { join } from 'path'
import { systemdUserSupervisor } from './systemd-user'

describe('systemd definition replacement', () => {
  it('keeps both installed definitions and loaded jobs untouched when pair validation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-systemd-pair-'))
    const home = join(root, 'home')
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty.so'), '')
    let failValidation = false
    const calls: string[] = []
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      pathEnv: '/bin',
      which: (command) => (command === 'systemd-analyze' ? '/bin/systemd-analyze' : null),
      runner: async (command) => {
        calls.push(command.join(' '))
        if (failValidation && command[0] === 'systemd-analyze') return { code: 1, stdout: '', stderr: 'bad unit' }
        return { code: 0, stdout: command[0] === 'loginctl' ? 'yes\n' : '', stderr: '' }
      },
    }
    try {
      await systemdUserSupervisor.start(ctx)
      const paths = (['worker', 'api'] as const).map((component) => systemdUserNames(ctx, component).path)
      const before = paths.map((path) => readFileSync(path, 'utf8'))
      calls.length = 0
      failValidation = true
      await expect(systemdUserSupervisor.start(ctx)).rejects.toThrow(/systemd-analyze/i)
      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
      expect(calls.some((call) => /systemctl --user (stop|enable)/.test(call))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('systemd log directory', () => {
  it('creates the logs under ~/.ficus when it exists, and never creates a legacy home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-systemd-logs-'))
    const home = join(root, 'home')
    mkdirSync(join(home, '.ficus'), { recursive: true })
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty.so'), '')
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      pathEnv: '/bin',
      which: (command) => (command === 'systemd-analyze' ? '/bin/systemd-analyze' : null),
      runner: async (command) => ({ code: 0, stdout: command[0] === 'loginctl' ? 'yes\n' : '', stderr: '' }),
    }
    try {
      await systemdUserSupervisor.start(ctx)
      for (const component of ['worker', 'api'] as const) {
        const log = systemdUserNames(ctx, component).log
        expect(log.startsWith(join(home, '.ficus', 'logs') + '/')).toBe(true)
        expect(existsSync(log)).toBe(true)
      }
      expect(existsSync(join(home, LEGACY_HOME_DIR_NAME))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('systemd staging filenames', () => {
  it('verifies temp units under unit-suffixed names systemd-analyze accepts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ficus-systemd-stage-'))
    const home = join(root, 'home')
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(join(root, 'node_modules/bun-pty/rust-pty/target/release/librust_pty.so'), '')
    const verified: string[][] = []
    const ctx: SupervisorContext = {
      ...context,
      root,
      home,
      pathEnv: '/bin',
      which: (command) => (command === 'systemd-analyze' ? '/bin/systemd-analyze' : null),
      runner: async (command) => {
        if (command[0] === 'systemd-analyze') verified.push(command.slice(3))
        return { code: 0, stdout: command[0] === 'loginctl' ? 'yes\n' : '', stderr: '' }
      },
    }
    try {
      await systemdUserSupervisor.start(ctx)
      expect(verified[0]?.every((path) => /\.service$/.test(path) && !path.includes('.tmp'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('native status vocabulary', () => {
  it('reports online for an active running unit and preserves other states verbatim', async () => {
    const show =
      'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nFragmentPath=/home/me/.config/systemd/user/ficus-smoke-api.service\n'
    const calls: { cmd: string; stdout: string }[] = []
    const ctx: SupervisorContext = {
      ...context,
      runner: async (command) => {
        calls.push({ cmd: command.join(' '), stdout: show })
        return { code: 0, stdout: show, stderr: '' }
      },
    }
    const rows = await systemdUserSupervisor.status(ctx)
    expect(rows.find((row) => row.name === 'ficus-smoke-api')?.status).toBe('online')
    expect(rows.every((row) => row.pid === 42 || row.status === 'not registered')).toBe(true)
  })

  it('reports a successfully queried missing unit as not registered', async () => {
    const show = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nFragmentPath=\n'
    const rows = await systemdUserSupervisor.status({
      ...context,
      runner: async () => ({ code: 0, stdout: show, stderr: '' }),
    })
    expect(rows.every((row) => row.status === 'not registered')).toBe(true)
  })

  it('throws when systemctl show itself fails instead of calling the unit absent', async () => {
    await expect(
      systemdUserSupervisor.status({
        ...context,
        runner: async (command) =>
          command.includes('show-environment')
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 1, stdout: '', stderr: 'Failed to connect to bus' },
      })
    ).rejects.toThrow(/Failed to connect to bus/)
  })
})
