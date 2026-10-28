import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { Command } from 'commander'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signalBoxProcess } from '../../../../packages/sandbox-server/src/services/processes'
import { apiPost } from '../client'
import { outputError, outputTable } from '../output'
import { registerSandboxProcessCommands, renderSandboxProcesses } from './sandbox-processes'

afterEach(() => {
  mock.restore()
  ;(apiPost as ReturnType<typeof mock>).mockReset()
})

test('human output uses the same host/local metrics and infrastructure labels', () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  renderSandboxProcesses(
    {
      pressure: {
        cpus: 8,
        load: [35, 20, 10],
        memTotalMb: 16000,
        memAvailableMb: 4000,
        box: {
          cpuPercent: 20,
          sampleMs: 1000,
          cpuPressureSome: { avg10: 65, avg60: 30, avg300: 10 },
          cpuQuotaCpus: 4,
          cpuQuotaPercent: 5,
          cpuThrottledPeriods: 0,
          cpuThrottledUsec: 0,
          memoryHighEvents: 0,
          memoryMaxEvents: 0,
          memoryPressureSome: { avg10: 1, avg60: 1, avg300: 1 },
        },
      },
      processes: [
        {
          pid: 10,
          ppid: 1,
          cpuPercent: 0,
          memRssMb: 20,
          ageSeconds: 300,
          state: 'S',
          command: 'dockerd',
          protected: true,
          protectionReason: 'Docker runtime',
        },
      ],
      containers: { available: true, containers: [] },
    },
    25
  )
  const text = log.mock.calls.flat().join('\n')
  expect(text).toContain('Host overloaded')
  expect(text).toContain('20.0% CPU')
  expect(text).toContain('Host busy with other boxes')
  expect(outputTable).toHaveBeenCalledWith(
    [expect.objectContaining({ PROTECTION: 'Docker runtime' })],
    expect.any(Array)
  )
})

for (const kind of ['agent', 'squad'] as const)
  test(`${kind} sandbox-kill surfaces fresh server refusal, never a success message`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-protected-'))
    const dir = join(root, '42')
    mkdirSync(dir)
    writeFileSync(join(dir, 'stat'), '42 (dockerd) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0\n')
    writeFileSync(join(dir, 'status'), 'Uid:\t30033\t30033\t30033\t30033\n')
    writeFileSync(join(dir, 'cmdline'), '/usr/bin/dockerd\0')
    writeFileSync(join(dir, 'cgroup'), '0::/user.slice/user-30033.slice/user@30033.service/app.slice/docker.service\n')
    const kill = mock(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockImplementation(async (_url, body) =>
      signalBoxProcess(42, body.signal, { procRoot: root, uid: 30033, selfPid: 100, kill })
    )
    try {
      const command = new Command()
      registerSandboxProcessCommands(command, kind)
      await command.parseAsync(['sandbox-kill', 'example', '42', '--signal', 'KILL'], { from: 'user' })
      expect(apiPost).toHaveBeenCalledWith(
        `/api/${kind === 'agent' ? 'agents' : 'squads'}/example/sandbox/processes/42/signal`,
        { signal: 'KILL' }
      )
      expect(outputError).toHaveBeenCalledWith(
        expect.objectContaining({ status: 403, message: 'Process 42: Docker runtime; cannot be signalled' })
      )
      expect(kill).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

test('sandbox-kill sends an optional listed startTicks identity', async () => {
  ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ pid: 42, signal: 'TERM', command: 'build' })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const command = new Command()
  registerSandboxProcessCommands(command, 'squad')
  await command.parseAsync(['sandbox-kill', 'example', '42', '--start-ticks', '900000'], { from: 'user' })
  expect(apiPost).toHaveBeenCalledWith('/api/squads/example/sandbox/processes/42/signal', {
    signal: 'TERM',
    startTicks: 900000,
  })
  log.mockRestore()
})
