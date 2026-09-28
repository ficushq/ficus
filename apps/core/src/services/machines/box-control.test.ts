import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { boxUnitControl, boxUnixUser } from './box-paths'
import {
  boxKillCommand,
  boxProcessesCommand,
  buildBoxControlCommand,
  parseBoxControlRequest,
  runBoxControl,
} from './box-control'
import type { Machine, MachineBox } from './queries'

describe('parseBoxControlRequest', () => {
  test('defaults to read-only status and accepts every unit action and processes', () => {
    expect(parseBoxControlRequest({ FICUS_BC_SANDBOX_ID: 'squad_a' })).toEqual({
      sandboxId: 'squad_a',
      action: 'status',
    })
    for (const action of ['status', 'stop', 'start', 'restart', 'processes'] as const)
      expect(parseBoxControlRequest({ FICUS_BC_SANDBOX_ID: 'squad_a', FICUS_BC_ACTION: action }).action).toBe(action)
  })

  test('kill needs a real pid and one of TERM, INT or KILL (TERM by default)', () => {
    expect(parseBoxControlRequest({ FICUS_BC_SANDBOX_ID: 's', FICUS_BC_ACTION: 'kill', FICUS_BC_PID: '4242' })).toEqual(
      {
        sandboxId: 's',
        action: 'kill',
        pid: 4242,
        signal: 'TERM',
      }
    )
    expect(
      parseBoxControlRequest({
        FICUS_BC_SANDBOX_ID: 's',
        FICUS_BC_ACTION: 'kill',
        FICUS_BC_PID: '9',
        FICUS_BC_SIGNAL: 'kill',
      })
    ).toMatchObject({ signal: 'KILL' })
    for (const pid of [undefined, '', '1', '0', '-5', '12;reboot', '1.5'])
      expect(() =>
        parseBoxControlRequest({ FICUS_BC_SANDBOX_ID: 's', FICUS_BC_ACTION: 'kill', FICUS_BC_PID: pid })
      ).toThrow('invalid pid')
    expect(() =>
      parseBoxControlRequest({
        FICUS_BC_SANDBOX_ID: 's',
        FICUS_BC_ACTION: 'kill',
        FICUS_BC_PID: '9',
        FICUS_BC_SIGNAL: 'HUP',
      })
    ).toThrow('invalid signal')
  })

  test('rejects unknown actions and sandbox ids that could escape a shell', () => {
    expect(() => parseBoxControlRequest({ FICUS_BC_SANDBOX_ID: 's', FICUS_BC_ACTION: 'reboot' })).toThrow(
      'invalid action'
    )
    for (const id of ['', "a'b", 'a b', 'a;rm', '$(id)'])
      expect(() => parseBoxControlRequest({ FICUS_BC_SANDBOX_ID: id })).toThrow('invalid sandboxId')
  })
})

describe('buildBoxControlCommand', () => {
  test("uses Core's own unit layout: stop takes every unit down, other verbs target the server", () => {
    for (const sandboxId of ['squad_4ea8b934-a90a-42d1-b6fe-483a2ab9a18b', 'agent_60cb57e6']) {
      const ctl = boxUnitControl({ sandboxId, unixUser: boxUnixUser(sandboxId) })
      expect(buildBoxControlCommand({ sandboxId, action: 'stop' })).toBe(`${ctl.systemctl} stop ${ctl.allUnits}`)
      expect(buildBoxControlCommand({ sandboxId, action: 'restart' })).toBe(`${ctl.systemctl} restart ${ctl.unit}`)
    }
  })

  test("processes reads current CPU from top's second sample and bounds the rootless docker query", () => {
    const command = boxProcessesCommand('box_e49af02f8b45')
    expect(command).toContain("U='box_e49af02f8b45'")
    expect(command).toContain('top -b -n 2')
    expect(command).toContain('n==2')
    expect(command).toContain('timeout 20 docker ps')
    expect(command).not.toMatch(/\bkill\b/)
  })
})

describe('boxKillCommand', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // Run the generated script for real, with `sudo` shimmed to run its command
  // directly, against a process this test owns.
  async function runKill(unixUser: string, pid: number) {
    const dir = mkdtempSync(join(tmpdir(), 'box-control-kill-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'sudo'), '#!/bin/sh\nexec "$@"\n')
    chmodSync(join(dir, 'sudo'), 0o755)
    const proc = Bun.spawn(['/bin/sh', '-c', boxKillCommand(unixUser, pid, 'TERM')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }

  test("signals a process the box's user owns", async () => {
    const target = Bun.spawn(['sleep', '60'])
    try {
      const result = await runKill(userInfo().username, target.pid)
      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.stdout).toContain(`sent SIGTERM to ${target.pid}`)
      expect(await target.exited).not.toBe(0)
    } finally {
      target.kill()
    }
  })

  test('refuses a process owned by anyone else, leaving it running', async () => {
    const target = Bun.spawn(['sleep', '60'])
    try {
      const result = await runKill('box_000000000000', target.pid)
      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain('refused')
      expect(target.killed || target.exitCode !== null).toBe(false)
    } finally {
      target.kill()
    }
  })
})

describe('runBoxControl', () => {
  const machine = { id: 'm1' } as Machine
  test("resolves the box's machine and runs the command there", async () => {
    const calls: Array<{ machine: Machine; command: string }> = []
    const result = await runBoxControl(
      { sandboxId: 'squad_x', action: 'status' },
      {
        getMachineBox: async () => ({ machineId: 'm1' }) as MachineBox,
        getMachine: async (id) => (id === 'm1' ? machine : null),
        runner: {
          run: async (target, command) => {
            calls.push({ machine: target, command })
            return { exitCode: 0, stdout: 'active\n', stderr: '' }
          },
        },
      }
    )
    expect(result.stdout).toBe('active\n')
    expect(calls).toEqual([{ machine, command: buildBoxControlCommand({ sandboxId: 'squad_x', action: 'status' }) }])
  })

  test('explains an unregistered box instead of running anything', async () => {
    await expect(
      runBoxControl(
        { sandboxId: 'squad_gone', action: 'processes' },
        {
          getMachineBox: async () => null,
          getMachine: async () => machine,
          runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
        }
      )
    ).rejects.toThrow('box not registered on any machine: squad_gone')
  })
})
