import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MachineBox } from './queries'
import { boxUnixUser } from './box-paths'
import {
  createReprovisionJournal,
  validateMaintenanceEvidence,
  REPROVISION_ALLOW_START,
  REPROVISION_GUARD_NAME,
  captureRuntimeCommand,
  readReprovisionEnvCommand,
  runningReprovisionProbeCommand,
} from './box-reprovision-runtime'
import type { ReprovisionJournal } from './box-reprovision'

const sandboxId = 'agent_fixture'
const box = { sandboxId, unixUser: boxUnixUser(sandboxId), port: 50111 } as MachineBox

describe('offline reprovision maintenance guard', () => {
  const guard = `/run/systemd/system/ficus-api.service.d/${REPROVISION_GUARD_NAME}`
  const props = `LoadState=loaded\nActiveState=inactive\nDropInPaths=${guard}\n`
  const conditions = { type: 'a(sbbsi)', data: [['ConditionPathExists', false, false, REPROVISION_ALLOW_START, -1]] }
  it('accepts real systemd 255 busctl JSON for the effective non-trigger, non-negated condition', () => {
    expect(() => validateMaintenanceEvidence(props, conditions, guard)).not.toThrow()
  })
  it('refuses a live process, missing effective dropin, absent/reset condition, or negated/trigger guard', () => {
    expect(() => validateMaintenanceEvidence(props.replace('inactive', 'active'), conditions, guard)).toThrow()
    expect(() => validateMaintenanceEvidence(props.replace(guard, ''), conditions, guard)).toThrow()
    for (const data of [
      [],
      [['ConditionPathExists', false, true, REPROVISION_ALLOW_START, -1]],
      [['ConditionPathExists', true, false, REPROVISION_ALLOW_START, -1]],
      [['ConditionPathExists', false, false, '/different', -1]],
    ])
      expect(() => validateMaintenanceEvidence(props, { data }, guard)).toThrow()
  })
})

describe('durable reprovision journal', () => {
  it('atomically preserves original intent without storing env or bearer tokens', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'box-reprovision-journal-'))
    try {
      const root = join(temp, 'private')
      const journal = createReprovisionJournal(root)
      expect(await journal.read(sandboxId)).toBeNull()
      const value: ReprovisionJournal = {
        version: 1,
        identity: 'fixed identity plus token digest',
        done: false,
        runtime: {
          server: false,
          socket: false,
          proxy: false,
          docker: false,
          manager: false,
          linger: false,
          serverEnabled: false,
          socketEnabled: true,
          dockerEnabled: false,
        },
      }
      await journal.write(sandboxId, value)
      expect(await journal.read(sandboxId)).toEqual(value)
      expect((await stat(root)).mode & 0o077).toBe(0)
      const [name] = await readdir(root)
      expect((await stat(join(root, name!))).mode & 0o077).toBe(0)
      await journal.write(sandboxId, { ...value, done: true })
      expect((await journal.read(sandboxId))?.done).toBe(true)
      expect((await readdir(root)).length).toBe(1)
      expect(await readFile(join(root, name!), 'utf8')).not.toContain('authToken')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})

describe('reprovision remote commands', () => {
  it('reads only the expected nonsymlink env file and does not source it', () => {
    const command = readReprovisionEnvCommand(box)
    expect(command).toContain('realpath -e')
    expect(command).toContain('[ ! -L "$file" ]')
    expect(command).not.toContain('source ')
    expect(command).not.toContain('. "$file"')
  })
  it('puts show before the unit argument for both system and user controllers', () => {
    expect(captureRuntimeCommand(box)).toContain('"$controller" show --property=ActiveState --value "$target"')
  })
  it('probes an active server over its Unix socket without waking the TCP proxy', () => {
    const command = runningReprovisionProbeCommand(box)
    expect(command).toContain('--unix-socket "$sock"')
    expect(command).toContain(`/run/ficus-box-${box.unixUser}/server.sock`)
    expect(command).not.toContain(`127.0.0.1:${box.port}`)
    expect(command).toContain('--config -')
  })
})
