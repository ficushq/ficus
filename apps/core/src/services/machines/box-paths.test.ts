import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOX_DOT_DIR,
  LEGACY_BOX_DOT_DIR,
  LEGACY_BOX_UNIT_PREFIX,
  LEGACY_USER_UNIT_PREFIX,
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
    expect(ctl.legacy.unit).toBe(`${LEGACY_BOX_UNIT_PREFIX}-${unixUser}.service`)
    expect(ctl.legacy.allUnits).toBe(
      `${LEGACY_BOX_UNIT_PREFIX}-${unixUser}.socket ${LEGACY_BOX_UNIT_PREFIX}-${unixUser}-proxy.service ${LEGACY_BOX_UNIT_PREFIX}-${unixUser}.service`
    )
  })

  it('puts squad and unknown boxes on ficus-sandbox-server user units', () => {
    for (const sandboxId of ['squad_s1', 'system_manager_u1', 'sb-legacy']) {
      const ctl = boxUnitControl({ sandboxId, unixUser: boxUnixUser(sandboxId) })
      expect(ctl.mode).toBe('user')
      expect(ctl.unit).toBe('ficus-sandbox-server.service')
      expect(ctl.socket).toBe('ficus-sandbox-server.socket')
      expect(ctl.proxy).toBe('ficus-sandbox-server-proxy.service')
      expect(ctl.legacy.unit).toBe(`${LEGACY_USER_UNIT_PREFIX}.service`)
    }
  })

  it('reads the journal of both names while the bridge lasts', () => {
    const unixUser = boxUnixUser('agent_x')
    const ctl = boxUnitControl({ sandboxId: 'agent_x', unixUser })
    expect(ctl.journalctl).toBe(`sudo journalctl -u ${ctl.unit} -u ${ctl.legacy.unit}`)
  })

  it('legacyIsActiveCommand probes the legacy system unit AND the legacy user unit of an agent box', () => {
    const unixUser = boxUnixUser('agent_x')
    const probe = boxUnitControl({ sandboxId: 'agent_x', unixUser }).legacyIsActiveCommand?.()
    expect(probe).toBeDefined()
    expect(probe).toContain(`sudo systemctl is-active ${LEGACY_BOX_UNIT_PREFIX}-${unixUser}.socket`)
    expect(probe).toContain(`${LEGACY_BOX_UNIT_PREFIX}-${unixUser}.service`)
    expect(probe).toContain(`systemctl --user is-active ${LEGACY_USER_UNIT_PREFIX}.service`)
  })

  it('the box HOME dot dir is .ficus, and the legacy name is a separate bridge constant', () => {
    expect(BOX_DOT_DIR).toBe('.ficus')
    expect(boxDotDir('/home/box_0123456789ab')).toBe('/home/box_0123456789ab/.ficus')
    expect(LEGACY_BOX_DOT_DIR).not.toBe(BOX_DOT_DIR)
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
      expect(await run(stop, { LOADED: `${ctl.unit} ${ctl.legacy.unit}` })).toBe(ran(ctl.allUnits))
    })

    it(`${ctl.mode} mode: drives the legacy units of a box not re-provisioned since the rename`, async () => {
      expect(await run(stop, { LOADED: ctl.legacy.unit })).toBe(ran(ctl.legacy.allUnits))
    })

    it(`${ctl.mode} mode: defaults to the Ficus units when neither is loaded`, async () => {
      expect(await run(stop, { LOADED: '' })).toBe(ran(ctl.allUnits))
    })
  }

  it('the legacy probe prints one live state when any legacy shape is active, else nothing', async () => {
    const unixUser = boxUnixUser('agent_x')
    const ctl = boxUnitControl({ sandboxId: 'agent_x', unixUser })
    const probe = ctl.legacyIsActiveCommand!()
    expect(await run(probe, { ACTIVE: `${LEGACY_USER_UNIT_PREFIX}.service` })).toBe('active')
    expect(await run(probe, { ACTIVE: `${LEGACY_BOX_UNIT_PREFIX}-${unixUser}.socket` })).toBe('active')
    expect(await run(probe, { ACTIVE: '' })).toBe('')
  })
})
