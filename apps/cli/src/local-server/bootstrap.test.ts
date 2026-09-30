import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEGACY_HOME_DIR_NAME } from '@ficus/shared/node'
import { bootstrap, defaultInstallDir, type BootstrapDeps } from './bootstrap'
import { SetupOptionsError } from './options'
import { recordingRunner } from './runner'
import { upsertInstance } from './state'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ficus-boot-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function deps(overrides: Partial<BootstrapDeps> = {}) {
  const rec = recordingRunner({ 'bun --version': { stdout: '1.3.8\n' } })
  const lines: string[] = []
  const d: BootstrapDeps = {
    runner: rec.runner,
    which: (cmd) => (['git', 'bun', 'curl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    env: {},
    home: tmp,
    log: (l) => lines.push(l),
    ...overrides,
  }
  return { d, calls: rec.calls, lines }
}
const joined = (calls: { command: string[] }[]) => calls.map((c) => c.command.join(' '))

describe('bootstrap', () => {
  it('defaults the install dir to ~/.ficus/ficus when no instance is registered', () => {
    expect(defaultInstallDir(tmp, join(tmp, 'no-registry.json'))).toBe(join(tmp, '.ficus', 'ficus'))
  })
  it('puts the checkout in a legacy CLI home that has not moved yet', () => {
    mkdirSync(join(tmp, LEGACY_HOME_DIR_NAME))
    expect(defaultInstallDir(tmp, join(tmp, 'no-registry.json'))).toBe(join(tmp, LEGACY_HOME_DIR_NAME, 'ficus'))
  })
  it("reuses the registered default instance's root, whatever its directory is called", () => {
    const statePath = join(tmp, 'state.json')
    const existing = join(tmp, 'some', 'checkout')
    const record = (root: string) => ({ root, port: 3000, supervisor: 'pm2' as const, createdAt: 't', updatedAt: 't' })
    upsertInstance('lab', record(join(tmp, 'lab')), {}, statePath)
    upsertInstance('main', record(existing), { makeDefault: true }, statePath)
    expect(defaultInstallDir(tmp, statePath)).toBe(existing)
  })
  it('clones, installs and execs the checkout setup with pass-through args', async () => {
    const root = join(tmp, 'ficus')
    // simulate `git clone` creating a checkout, on top of a plain recording runner
    const rec = recordingRunner({ 'bun --version': { stdout: '1.3.8\n' } })
    const d: BootstrapDeps = {
      runner: async (command, options) => {
        const r = await rec.runner(command, options)
        if (command[0] === 'git' && command[1] === 'clone') {
          mkdirSync(join(root, '.git'), { recursive: true })
          writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
          writeFileSync(join(root, '.bun-version'), '1.3.8\n')
        }
        return r
      },
      which: (cmd) => (['git', 'bun', 'curl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      env: {},
      home: tmp,
      log: () => {},
    }
    await bootstrap({ root, repo: 'https://example/ficus.git', ref: 'main', setupArgs: ['--runtime', 'host'] }, d)
    expect(joined(rec.calls)).toEqual([
      `git clone --recurse-submodules --branch main https://example/ficus.git ${root}`,
      'bun --version',
      'bun install --frozen-lockfile',
      `bun run setup -- --root ${root} --runtime host`,
    ])
    expect(rec.calls[3].options.cwd).toBe(root)
    expect(rec.calls[3].options.inherit).toBe(true)
  })
  it('reuses an existing checkout without cloning', async () => {
    const root = join(tmp, 'ficus')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
    writeFileSync(join(root, '.bun-version'), '1.3.8\n')
    const { d, calls } = deps()
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    expect(joined(calls)).toEqual(['bun --version', 'bun install --frozen-lockfile', `bun run setup -- --root ${root}`])
  })
  it('refuses a non-empty directory that is not a checkout', async () => {
    const root = join(tmp, 'ficus')
    mkdirSync(root)
    writeFileSync(join(root, 'file'), 'x')
    const { d } = deps()
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/not a Ficus checkout/)
  })
  it('refuses a root that is a regular file (not just a non-empty non-checkout dir)', async () => {
    const root = join(tmp, 'ficus')
    writeFileSync(root, 'not a directory')
    const { d } = deps()
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/not a Ficus checkout/)
  })
  it('propagates the checkout setup exit code', async () => {
    const root = join(tmp, 'ficus')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
    writeFileSync(join(root, '.bun-version'), '1.3.8\n')
    const rec = recordingRunner({ 'bun --version': { stdout: '1.3.8' }, 'bun run setup': { code: 2 } })
    const d: BootstrapDeps = {
      runner: rec.runner,
      which: (cmd) => (['git', 'bun', 'curl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      env: {},
      home: tmp,
      log: () => {},
    }
    let error: unknown
    try {
      await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SetupOptionsError)
    expect((error as SetupOptionsError).exitCode).toBe(2)
  })
  function checkout(version = '1.4.2') {
    const root = join(tmp, 'ficus')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ficus' }))
    writeFileSync(join(root, '.bun-version'), version)
    return root
  }

  for (const present of [false, true]) {
    it(`installs the checkout pin when Bun is ${present ? 'a different version' : 'missing'}`, async () => {
      const root = checkout()
      const installedBun = join(tmp, '.bun', 'bin', 'bun')
      const rec = recordingRunner({
        'bun --version': { stdout: '1.3.8' },
        [`${installedBun} --version`]: { stdout: '1.4.2\n' },
      })
      const { d } = deps({
        runner: rec.runner,
        which: (cmd) => (!present && cmd === 'bun' ? null : `/usr/bin/${cmd}`),
      })
      await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
      const installer = rec.calls.find((c) => c.command[0] === 'bash')!
      expect(installer.command).toEqual([
        'bash',
        '-o',
        'pipefail',
        '-c',
        'curl -fsSL https://bun.sh/install | bash -s -- "$1"',
        'ficus-bun-bootstrap',
        'bun-v1.4.2',
      ])
      expect(joined(rec.calls).slice(-3)).toEqual([
        `${installedBun} --version`,
        `${installedBun} install --frozen-lockfile`,
        `${installedBun} run setup -- --root ${root}`,
      ])
      expect(installer.options.env?.BUN_INSTALL).toBe(join(tmp, '.bun'))
      expect(rec.calls.at(-1)?.options.env?.PATH).toBe(join(tmp, '.bun', 'bin'))
    })
  }

  it('uses the cloned ref pin and honors BUN_INSTALL for installation and setup', async () => {
    const root = join(tmp, 'ficus')
    const installDir = join(tmp, 'custom bun')
    const installedBun = join(installDir, 'bin', 'bun')
    const rec = recordingRunner({ [`${installedBun} --version`]: { stdout: '1.4.2' } })
    const { d } = deps({
      runner: async (command, options) => {
        const result = await rec.runner(command, options)
        if (command[0] === 'git') checkout('1.4.2')
        return result
      },
      which: (cmd) => (cmd === 'bun' ? null : `/usr/bin/${cmd}`),
      env: { BUN_INSTALL: installDir, PATH: '/usr/bin' },
    })
    await bootstrap({ root, repo: 'x', ref: 'release', setupArgs: [] }, d)
    expect(rec.calls[0].command).toEqual(['git', 'clone', '--recurse-submodules', '--branch', 'release', 'x', root])
    expect(rec.calls[1].command.at(-1)).toBe('bun-v1.4.2')
    expect(rec.calls.at(-1)?.command[0]).toBe(installedBun)
    expect(rec.calls.at(-1)?.options.env?.PATH).toBe(`${join(installDir, 'bin')}:/usr/bin`)
  })

  for (const failure of ['installer', 'wrong version', 'probe failure']) {
    it(`stops before installing dependencies on ${failure}`, async () => {
      const root = checkout()
      const installedBun = join(tmp, '.bun', 'bin', 'bun')
      const rec = recordingRunner({
        bash: { code: failure === 'installer' ? 1 : 0 },
        [`${installedBun} --version`]: { code: failure === 'probe failure' ? 1 : 0, stdout: '1.3.8' },
      })
      const { d } = deps({ runner: rec.runner, which: (cmd) => (cmd === 'bun' ? null : `/usr/bin/${cmd}`) })
      await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/failed/)
      expect(rec.calls.some((c) => c.command[1] === 'install' || c.command[1] === 'run')).toBe(false)
    })
  }

  for (const pin of [null, '', 'latest', '1.4.2; touch unexpected']) {
    it(`rejects a missing or invalid checkout pin: ${JSON.stringify(pin)}`, async () => {
      const root = checkout(pin ?? '')
      if (pin === null) rmSync(join(root, '.bun-version'))
      const { d, calls } = deps()
      await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/Bun version/)
      expect(calls).toHaveLength(0)
    })
  }

  it('requires unzip only when the required Bun version must be installed', async () => {
    const root = checkout('1.3.8')
    // No apt-get on this host: nothing to try, so the operator gets the hint.
    const missingBoth = deps({
      which: (cmd) => (cmd === 'bun' || cmd === 'unzip' || cmd === 'apt-get' ? null : `/usr/bin/${cmd}`),
    })
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, missingBoth.d)).rejects.toThrow(
      /unzip.*apt install unzip/
    )
    expect(missingBoth.calls).toHaveLength(0)
    const bunPresent = deps({ which: (cmd) => (cmd === 'unzip' ? null : `/usr/bin/${cmd}`) })
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, bunPresent.d)
    expect(joined(bunPresent.calls)[0]).toBe('bun --version')
  })
  it('installs unzip itself on an apt host where sudo works without a prompt', async () => {
    const root = checkout('1.3.8')
    let unzipInstalled = false
    const rec = recordingRunner({ [`${join(tmp, '.bun', 'bin', 'bun')} --version`]: { stdout: '1.3.8\n' } })
    const lines: string[] = []
    const d: BootstrapDeps = {
      runner: async (command, options) => {
        const r = await rec.runner(command, options)
        if (command.join(' ') === 'sudo -n apt-get install -y -q unzip') unzipInstalled = true
        return r
      },
      which: (cmd) => {
        if (cmd === 'bun') return null
        if (cmd === 'unzip') return unzipInstalled ? '/usr/bin/unzip' : null
        return ['git', 'curl', 'bash', 'apt-get', 'sudo'].includes(cmd) ? `/usr/bin/${cmd}` : null
      },
      env: {},
      home: tmp,
      log: (l) => lines.push(l),
      uid: 1000,
    }
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    expect(joined(rec.calls).slice(0, 2)).toEqual(['sudo -n true', 'sudo -n apt-get install -y -q unzip'])
    expect(rec.calls[1].options.env?.DEBIAN_FRONTEND).toBe('noninteractive')
    expect(lines.some((l) => l.includes('installing it with apt-get'))).toBe(true)
    // …and then carries on to the Bun install.
    expect(joined(rec.calls).some((c) => c.includes('bun.sh/install'))).toBe(true)
  })
  it('skips sudo for the unzip install when already root', async () => {
    const root = checkout('1.3.8')
    let unzipInstalled = false
    const rec = recordingRunner({ [`${join(tmp, '.bun', 'bin', 'bun')} --version`]: { stdout: '1.3.8\n' } })
    const d: BootstrapDeps = {
      runner: async (command, options) => {
        const r = await rec.runner(command, options)
        if (command.join(' ') === 'apt-get install -y -q unzip') unzipInstalled = true
        return r
      },
      which: (cmd) =>
        cmd === 'bun' ? null : cmd === 'unzip' ? (unzipInstalled ? '/usr/bin/unzip' : null) : `/usr/bin/${cmd}`,
      env: {},
      home: tmp,
      log: () => {},
      uid: 0,
    }
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    expect(joined(rec.calls)[0]).toBe('apt-get install -y -q unzip')
  })
  it('keeps the hint when sudo would prompt or apt cannot install unzip', async () => {
    const root = checkout('1.3.8')
    const prompting = deps({
      which: (cmd) => (cmd === 'bun' || cmd === 'unzip' ? null : `/usr/bin/${cmd}`),
      uid: 1000,
      runner: async (command) => ({ code: command.join(' ') === 'sudo -n true' ? 1 : 0, stdout: '', stderr: '' }),
    })
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, prompting.d)).rejects.toThrow(
      /apt install unzip/
    )
    const failing = deps({
      which: (cmd) => (cmd === 'bun' || cmd === 'unzip' ? null : `/usr/bin/${cmd}`),
      uid: 1000,
      runner: async (command) => ({ code: command.includes('install') ? 100 : 0, stdout: '', stderr: '' }),
    })
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, failing.d)).rejects.toThrow(
      /apt install unzip/
    )
  })
  it('requires git', async () => {
    const { d } = deps({ which: (cmd) => (cmd === 'git' ? null : `/usr/bin/${cmd}`) })
    await expect(bootstrap({ root: join(tmp, 'ficus'), repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(
      /git/
    )
  })
})
