import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Machine } from './queries'
import { LEGACY_BOX_UNIT_PREFIX, LEGACY_USER_UNIT_PREFIX, LEGACY_BOX_DOT_DIR } from './box-paths'
import {
  LEGACY_BROWSER_NAME,
  LEGACY_MACHINE_ROOT,
  MACHINE_LAYOUT_PREFLIGHT_PROGRAM,
  machineLayoutPreflightCommand,
  requiresMachineLayoutMigration,
} from './machine-layout-preflight'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ficus-layout-preflight-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const put = (path: string, content = '') => {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  put('bin/sudo', '#!/bin/sh\n[ "$1" = -n ] || exit 90\nshift\nexec "$@"\n')
  put(
    'bin/getent',
    '#!/bin/sh\n[ -z "${PROBE_GETENT_FAIL:-}" ] || exit "$PROBE_GETENT_FAIL"\ngrep -qx "$1:$2" "$PROBE_ACCOUNTS" && exit 0\nexit 2\n'
  )
  chmodSync(join(bin, 'sudo'), 0o755)
  chmodSync(join(bin, 'getent'), 0o755)
  put('accounts')
  return {
    root,
    put,
    async run(extra: Record<string, string> = {}) {
      const proc = Bun.spawn(['bash', '-c', machineLayoutPreflightCommand(root)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROBE_ACCOUNTS: join(root, 'accounts'), ...extra },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    },
  }
}

const ready = 'FICUS_MACHINE_LAYOUT=ready\n'
const required = 'FICUS_MACHINE_LAYOUT=operator-required\n'

describe('machine layout automatic-bootstrap preflight', () => {
  it('keeps both standalone privileged guards byte-identical to the executed Core probe', () => {
    for (const name of ['bootstrap.sh', 'box-provision.sh']) {
      const script = readFileSync(join(import.meta.dir, '../../../../../scripts/machine', name), 'utf8')
      const embedded = script.split("<<'FICUS_LAYOUT_PREFLIGHT'\n")[1]?.split('\nFICUS_LAYOUT_PREFLIGHT')[0]
      expect(embedded).toBe(MACHINE_LAYOUT_PREFLIGHT_PROGRAM)
    }
  })

  it('allows a fresh host without creating any machine paths', async () => {
    const f = fixture()
    expect(await f.run()).toEqual({ exitCode: 0, stdout: ready, stderr: '' })
  })

  it('allows the migrated root and browser alias, completed and reversed journals', async () => {
    const f = fixture()
    f.put('opt/ficus/prebaked')
    symlinkSync('ficus', join(f.root, LEGACY_MACHINE_ROOT))
    f.put('etc/systemd/system/ficus-browser.service')
    symlinkSync('ficus-browser.service', join(f.root, `etc/systemd/system/${LEGACY_BROWSER_NAME}.service`))
    f.put('accounts', 'passwd:ficus-browser\ngroup:ficus-browser\n')
    for (const done of ['DONE', 'REVERSED']) {
      f.put(`var/backups/ficus-host-migrate/machine-${done}/STEPS`, 'S3\n')
      f.put(`var/backups/ficus-host-migrate/machine-${done}/${done}`)
    }
    expect(await f.run()).toEqual({ exitCode: 0, stdout: ready, stderr: '' })
  })

  for (const [name, path] of [
    ['real old root', `${LEGACY_MACHINE_ROOT}/prebaked`],
    ['old browser unit', `etc/systemd/system/${LEGACY_BROWSER_NAME}.service`],
    ['old AppArmor profile', `etc/apparmor.d/${LEGACY_BROWSER_NAME}-chromium`],
    ['old program inside new root', `opt/ficus/browser/service/${LEGACY_BROWSER_NAME}.js`],
    ['interrupted journal', 'var/backups/ficus-host-migrate/machine-pending/STEPS'],
    ['legacy system box unit', `etc/systemd/system/${LEGACY_BOX_UNIT_PREFIX}-box_0123456789ab.service`],
    ['legacy user box unit', `home/box_0123456789ab/.config/systemd/user/${LEGACY_USER_UNIT_PREFIX}.service`],
    ['real legacy box home', `home/box_0123456789ab/${LEGACY_BOX_DOT_DIR}/server.env`],
  ]) {
    it(`defers a host with ${name}`, async () => {
      const f = fixture()
      f.put(path)
      expect(await f.run()).toEqual({ exitCode: 0, stdout: required, stderr: '' })
    })
  }

  for (const db of ['passwd', 'group']) {
    it(`defers a renameable browser ${db} entry even without an old root`, async () => {
      const f = fixture()
      f.put('accounts', `${db}:${LEGACY_BROWSER_NAME}\n`)
      expect((await f.run()).stdout).toBe(required)
    })
  }

  it('allows duplicate old accounts only when no migration step would rename them', async () => {
    const f = fixture()
    f.put(
      'accounts',
      `passwd:${LEGACY_BROWSER_NAME}\npasswd:ficus-browser\ngroup:${LEGACY_BROWSER_NAME}\ngroup:ficus-browser\n`
    )
    expect((await f.run()).stdout).toBe(ready)
  })

  it('does not declare readiness when the privileged shell cannot start', async () => {
    const f = fixture()
    f.put('bin/sudo', '#!/bin/sh\nexit 77\n')
    expect(await f.run()).toEqual({ exitCode: 77, stdout: '', stderr: '' })
  })

  it('does not declare readiness when account lookup fails unexpectedly', async () => {
    const f = fixture()
    expect((await f.run({ PROBE_GETENT_FAIL: '3' })).exitCode).toBe(3)
  })

  it('interprets only explicit successful probe results; SSH and malformed results fail closed', async () => {
    const machine = { id: 'fixture' } as Machine
    for (const [stdout, expected] of [
      [ready, false],
      [required, true],
    ] as const) {
      expect(
        await requiresMachineLayoutMigration(machine, {
          run: async (_machine, command, opts) => {
            expect(command).toStartWith('sudo -n bash -c ')
            expect(opts?.timeoutMs).toBe(30_000)
            return { exitCode: 0, stdout, stderr: '' }
          },
        })
      ).toBe(expected)
    }
    for (const result of [
      { exitCode: 255, stdout: ready, stderr: 'SSH failed' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: `${required}${ready}`, stderr: '' },
    ]) {
      await expect(requiresMachineLayoutMigration(machine, { run: async () => result })).rejects.toThrow('preflight')
    }
    await expect(
      requiresMachineLayoutMigration(machine, {
        run: async () => {
          throw new Error('timeout')
        },
      })
    ).rejects.toThrow('timeout')
  })
})
