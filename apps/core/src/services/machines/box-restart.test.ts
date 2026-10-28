import { describe, expect, test } from 'bun:test'
import * as boxes from './box-manager'
import { boxUnixUser } from './box-paths'
import type { Machine, MachineBox } from './queries'

function fixture() {
  const box = {
    sandboxId: 'squad_restart',
    machineId: 'machine-1',
    unixUser: boxUnixUser('squad_restart'),
    port: 50123,
    status: 'ready',
    authToken: 'keep-token',
    updatedAt: new Date(),
  } as MachineBox
  const machine = { id: box.machineId, status: 'ready', name: 'test-host' } as Machine
  const commands: Array<{ machineId: string; command: string; timeoutMs?: number }> = []
  const states: string[] = []
  let claimed = true
  const deps = {
    getMachineBox: async () => box,
    getMachine: async () => machine,
    beginBoxRestart: async (expected: MachineBox) => {
      expect(expected).toBe(box)
      if (claimed) states.push('restarting')
      return claimed
    },
    finishBoxRestart: async (expected: MachineBox, status: string) => {
      expect(expected).toBe(box)
      states.push(status)
      return true
    },
    runner: {
      run: async (host: Machine, command: string, opts?: { timeoutMs?: number }) => {
        commands.push({ machineId: host.id, command, timeoutMs: opts?.timeoutMs })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    tunnels: {
      ensureMaster: async () => {},
      addForward: async () => 60123,
      removeForward: async () => {},
      endpointFor: () => null,
      checkHealth: async () => true,
    },
    fetch: async () => new Response('{}'),
  }
  return {
    box,
    machine,
    commands,
    states,
    deps,
    loseClaim: () => {
      claimed = false
    },
  }
}

describe('box unit restart', () => {
  test('restarts only the recorded box unit on its recorded host, preserving its identity and data', async () => {
    const f = fixture()
    await boxes.restartBox(f.box.sandboxId, f.deps)
    expect(f.commands).toHaveLength(1)
    expect(f.commands[0].machineId).toBe(f.box.machineId)
    expect(f.commands[0].command).toContain(`--machine=${f.box.unixUser}@.host --user`)
    expect(f.commands[0].command).toContain('restart ficus-sandbox-server.service')
    expect(f.commands[0].command).not.toMatch(/box-provision|rm |docker |reboot|kill/)
    expect(f.commands[0].timeoutMs).toBe(30_000)
    expect(f.states).toEqual(['restarting', 'ready'])
    expect(f.box.authToken).toBe('keep-token')
  })

  test('does not restart when identity, machine state or lifecycle ownership conflicts', async () => {
    for (const conflict of ['missing', 'identity', 'machine', 'migration', 'ensuring', 'stopped', 'lost-claim']) {
      const f = fixture()
      if (conflict === 'missing') f.deps.getMachineBox = async () => null as any
      if (conflict === 'identity') f.box.unixUser = 'other-user'
      if (conflict === 'machine') f.machine.status = 'reaping'
      if (conflict === 'migration') f.box.migrating = true
      if (conflict === 'ensuring' || conflict === 'stopped') f.box.status = conflict
      if (conflict === 'lost-claim') f.loseClaim()
      await expect(boxes.restartBox(f.box.sandboxId, f.deps)).rejects.toThrow()
      expect(f.commands).toEqual([])
      expect(f.states).toEqual([])
    }
  })

  test('marks failures explicitly instead of claiming readiness, and allows recovery retry', async () => {
    const f = fixture()
    f.box.status = 'restart_failed'
    f.deps.runner.run = async () => {
      throw new Error('SSH deadline')
    }
    await expect(boxes.restartBox(f.box.sandboxId, f.deps)).rejects.toThrow('SSH deadline')
    expect(f.states).toEqual(['restarting', 'restart_failed'])
    expect(
      (
        await boxes.boxChainHealth(f.box.sandboxId, {
          ...f.deps,
          getMachineBox: async () => ({ ...f.box, status: 'restart_failed' }),
        })
      ).status
    ).toBe('failed')
  })

  test('waits for health before ready and bounds a failed health check', async () => {
    const f = fixture()
    let now = 0
    const operation = boxes.restartBox(f.box.sandboxId, {
      ...f.deps,
      fetch: async () => new Response('', { status: 503 }),
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    })
    await expect(operation).rejects.toThrow('did not become healthy')
    expect(now).toBeLessThanOrEqual(17_000)
    expect(f.states).toEqual(['restarting', 'restart_failed'])
  })
})

test('cross-request status reports restart pending without trusting old listening readiness', async () => {
  const f = fixture()
  f.box.status = 'restarting'
  f.box.lastListeningAt = new Date()
  const status = await boxes.boxChainHealth(f.box.sandboxId, f.deps)
  expect(status.status).toBe('starting')
  expect(status.restartPending).toBe(true)
})

test('an interrupted restart stops showing pending and can be recovered after its deadline', async () => {
  const f = fixture()
  f.box.status = 'restarting'
  f.box.updatedAt = new Date(Date.now() - 121_000)
  const status = await boxes.boxChainHealth(f.box.sandboxId, f.deps)
  expect(status.status).toBe('failed')
  expect(status.restartPending).not.toBe(true)
  await boxes.restartBox(f.box.sandboxId, f.deps)
  expect(f.states).toEqual(['restarting', 'ready'])
})
