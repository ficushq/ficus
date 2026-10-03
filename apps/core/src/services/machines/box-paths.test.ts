import { foreignUnits, FOREIGN_BOX_UNIT_PREFIX, FOREIGN_USER_UNIT_PREFIX } from './foreign-unit.fixture'
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureRuntimeCommand,
  readReprovisionEnvCommand,
  restoreRuntimeCommand,
  verifyInstalledCommand,
} from './box-reprovision-runtime'
import type { MachineBox } from './queries'
import {
  BOX_DOT_DIR,
  boxDotDir,
  boxUnitControl,
  boxUnixUser,
} from './box-paths'

describe('box unit names', () => {
  it('puts an agent_* box on ficus-box-<user> system units', () => {
    const unixUser = boxUnixUser('agent_x')
    const ctl = boxUnitControl({ sandboxId: 'agent_x', unixUser })
    expect(ctl.mode).toBe('system')
    expect(ctl.unit).toBe(`ficus-box-${unixUser}.service`)
    expect(ctl.socket).toBe(`ficus-box-${unixUser}.socket`)
    expect(ctl.proxy).toBe(`ficus-box-${unixUser}-proxy.service`)
    expect(ctl.allUnits).toBe(`${ctl.socket} ${ctl.proxy} ${ctl.unit}`)
    expect(foreignUnits(ctl).unit).toBe(`${FOREIGN_BOX_UNIT_PREFIX}-${unixUser}.service`)
    expect(foreignUnits(ctl).allUnits).toBe(
      `${FOREIGN_BOX_UNIT_PREFIX}-${unixUser}.socket ${FOREIGN_BOX_UNIT_PREFIX}-${unixUser}-proxy.service ${FOREIGN_BOX_UNIT_PREFIX}-${unixUser}.service`
    )
  })

  it('puts squad and unknown boxes on ficus-sandbox-server user units', () => {
    for (const sandboxId of ['squad_s1', 'system_manager_u1', 'sb-legacy']) {
      const ctl = boxUnitControl({ sandboxId, unixUser: boxUnixUser(sandboxId) })
      expect(ctl.mode).toBe('user')
      expect(ctl.unit).toBe('ficus-sandbox-server.service')
      expect(ctl.socket).toBe('ficus-sandbox-server.socket')
      expect(ctl.proxy).toBe('ficus-sandbox-server-proxy.service')
      expect(foreignUnits(ctl).unit).toBe(`${FOREIGN_USER_UNIT_PREFIX}.service`)
    }
  })

  it('reads only the canonical journal after finalization', () => {
    const unixUser = boxUnixUser('agent_x')
    const ctl = boxUnitControl({ sandboxId: 'agent_x', unixUser })
    expect(ctl.journalctl).toBe(`sudo journalctl -u ${ctl.unit}`)
  })

  it('has no runtime fallback probe for old system or user units', () => {
    const ctl = boxUnitControl({ sandboxId: 'agent_x', unixUser: boxUnixUser('agent_x') })
    expect('legacyIsActiveCommand' in ctl).toBe(false)
  })

  it('the box HOME dot dir is .ficus', () => {
    expect(BOX_DOT_DIR).toBe('.ficus')
    expect(boxDotDir('/home/box_0123456789ab')).toBe('/home/box_0123456789ab/.ficus')
  })
})

/**
 * `onHost` and the legacy probe are REMOTE SHELL PROGRAMS: run them through
 * real bash with systemctl stubbed, so a program that picks the wrong unit set
 * fails here rather than on a live box.
 */
describe('box unit commands on the host (executed)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** `systemctl show -p LoadState --value <unit>` answers `loaded` for every
   *  unit in $LOADED (space-separated); every other verb echoes its argv. */
  function stubs(): string {
    const dir = mkdtempSync(join(tmpdir(), 'box-paths-stub-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'sudo'), '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"\n')
    writeFileSync(
      join(dir, 'systemctl'),
      [
        '#!/bin/sh',
        'last=""; for a in "$@"; do last="$a"; done',
        'case " $* " in',
        '  *" show "*) case " $LOADED " in *" $last "*) echo loaded ;; *) echo not-found ;; esac ;;',
        '  *" is-active "*) for a in "$@"; do case " $ACTIVE " in *" $a "*) echo active ;; esac; done; echo inactive ;;',
        '  *) echo "RAN $*" ;;',
        'esac',
        '',
      ].join('\n')
    )
    chmodSync(join(dir, 'sudo'), 0o755)
    chmodSync(join(dir, 'systemctl'), 0o755)
    return dir
  }

  async function run(command: string, env: Record<string, string>): Promise<string> {
    const proc = Bun.spawn(['bash', '-c', command], {
      env: { PATH: `${stubs()}:/usr/bin:/bin`, uid: '1000', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  }

  for (const sandboxId of ['agent_x', 'squad_s1']) {
    const ctl = boxUnitControl({ sandboxId, unixUser: boxUnixUser(sandboxId) })
    const stop = ctl.onHost((names) => `${ctl.systemctl} stop ${names.allUnits}`)
    // What the stub prints for a non-probe verb: its own argv.
    const ran = (units: string) => `RAN ${`${ctl.systemctl} stop ${units}`.replace(/^sudo systemctl /, '')}`

    it(`${ctl.mode} mode: drives the Ficus units when they are loaded`, async () => {
      expect(await run(stop, { LOADED: `${ctl.unit} ${foreignUnits(ctl).unit}` })).toBe(ran(ctl.allUnits))
    })

    it(`${ctl.mode} mode: does not adopt a legacy-only unit set`, async () => {
      expect(await run(stop, { LOADED: foreignUnits(ctl).unit })).toBe(ran(ctl.allUnits))
    })

    it(`${ctl.mode} mode: defaults to the Ficus units when neither is loaded`, async () => {
      expect(await run(stop, { LOADED: '' })).toBe(ran(ctl.allUnits))
    })
  }

  it('the generated maintenance scripts parse for both managers without executing host operations', async () => {
    const dir = stubs()
    writeFileSync(
      join(dir, 'sudo'),
      '#!/bin/sh\n[ "$1" = -n ] || exit 91\nshift\n[ "$1" = bash ] || exit 92\nshift\nexec bash -n "$@"\n'
    )
    const state = {
      server: false,
      socket: false,
      proxy: false,
      docker: false,
      manager: false,
      linger: false,
      serverEnabled: false,
      socketEnabled: false,
      dockerEnabled: false,
    }
    for (const sandboxId of ['agent_fixture', 'squad_fixture']) {
      const box = { sandboxId, unixUser: boxUnixUser(sandboxId) } as MachineBox
      for (const command of [
        readReprovisionEnvCommand(box),
        captureRuntimeCommand(box),
        restoreRuntimeCommand(box, state),
        verifyInstalledCommand(box),
      ]) {
        const child = Bun.spawn(['bash', '-c', command], {
          env: { PATH: `${dir}:/usr/bin:/bin` },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ stdout, stderr, code }).toEqual({ stdout: '', stderr: '', code: 0 })
      }
    }
  })

  it('commands never probe or invoke legacy names even if those units are active', () => {
    for (const sandboxId of ['agent_x', 'squad_x']) {
      const ctl = boxUnitControl({ sandboxId, unixUser: boxUnixUser(sandboxId) })
      const command = ctl.onHost((u) => `${ctl.systemctl} restart ${u.unit}`)
      expect(command).not.toContain(foreignUnits(ctl).unit)
      expect(command).not.toContain('LoadState')
    }
  })
})
