import { describe, expect, it } from 'bun:test'
import { CommandRunner } from './command-runner'
import type { PlannedCommand } from './types'

describe('CommandRunner', () => {
  it('runs commands sequentially and records success', async () => {
    const calls: string[][] = []
    const runner = new CommandRunner({
      cwd: '/repo',
      runProcess: async (cmd) => {
        calls.push(cmd)
        return { exitCode: 0, output: cmd.join(' ') }
      },
    })
    const commands = [
      { task: 'web' as const, command: ['one'], status: 'pending' as import('./types').CommandStatus },
      { task: 'core' as const, command: ['two'], status: 'pending' as import('./types').CommandStatus },
    ]
    await runner.runAll(commands)
    expect(calls).toEqual([['one'], ['two']])
    expect(commands.map((c) => c.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('notifies when command status and output changes', async () => {
    const snapshots: string[] = []
    const commands: PlannedCommand[] = [{ task: 'web', command: ['stream'], status: 'pending' }]
    const runner = new CommandRunner({
      cwd: '/repo',
      onUpdate: () => snapshots.push(`${commands[0].status}:${commands[0].outputTail ?? ''}`),
      runProcess: async (_cmd, _cwd, _timeout, onOutput) => {
        onOutput?.('chunk')
        return { exitCode: 0, output: 'chunk' }
      },
    })

    await runner.runAll(commands)

    expect(snapshots).toEqual(['running:', 'running:chunk', 'succeeded:chunk'])
  })

  it('streams command output into the planned command while it is running', async () => {
    const runner = new CommandRunner({
      cwd: '/repo',
      runProcess: async (_cmd, _cwd, _timeout, onOutput) => {
        onOutput?.('first')
        onOutput?.(' second')
        return { exitCode: 0, output: 'first second' }
      },
    })
    const commands: PlannedCommand[] = [{ task: 'web', command: ['stream'], status: 'pending' }]

    await runner.runAll(commands)

    expect(commands[0].outputTail).toBe('first second')
  })

  it('dispatches API reload without waiting for the process that is about to restart', async () => {
    const snapshots: string[] = []
    const dispatched: string[][] = []
    const commands: PlannedCommand[] = [{ task: 'core', command: ['bun', 'run', 'reload:api'], status: 'pending' }]
    const runner = new CommandRunner({
      cwd: '/repo',
      onUpdate: () => snapshots.push(`${commands[0].status}:${commands[0].outputTail ?? ''}`),
      dispatchProcess: (cmd) => {
        dispatched.push(cmd)
      },
      runProcess: async () => {
        throw new Error('reload:api should not be awaited')
      },
    })

    await runner.runAll(commands)

    expect(dispatched).toEqual([['bun', 'run', 'reload:api']])
    expect(commands[0]).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      outputTail: 'API restart handed off; process is restarting.',
    })
    expect(snapshots).toEqual(['running:', 'succeeded:API restart handed off; process is restarting.'])
  })

  it('records a failed systemd API restart instead of dispatching it blindly', async () => {
    const dispatched: string[][] = []
    const commands: PlannedCommand[] = [
      { task: 'core', command: ['sudo', '-n', 'systemctl', 'restart', 'ficus-api'], status: 'pending' },
    ]
    const runner = new CommandRunner({
      cwd: '/repo',
      dispatchProcess: (cmd) => dispatched.push(cmd),
      runProcess: async () => ({ exitCode: 1, output: 'sudo: a password is required' }),
    })

    await expect(runner.runAll(commands)).rejects.toThrow('systemctl restart ficus-api')

    expect(dispatched).toEqual([])
    expect(commands[0]).toMatchObject({
      status: 'failed',
      exitCode: 1,
      outputTail: 'sudo: a password is required',
    })
  })

  it('hands off a launchd API kickstart but awaits systemd-user acceptance', async () => {
    const dispatched: string[][] = []
    const launchd: PlannedCommand[] = [
      {
        task: 'core',
        command: ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.ficus-smoke-api'],
        status: 'pending',
      },
    ]
    const handoff = new CommandRunner({
      cwd: '/repo',
      dispatchProcess: (cmd) => dispatched.push(cmd),
      runProcess: async (command) => {
        if (command[0] === 'launchctl' && command[1] === 'print') {
          return { exitCode: 0, output: 'working directory = /repo\n' }
        }
        throw new Error('launchd API kickstart must be handed off')
      },
    })
    await handoff.runAll(launchd)
    expect(dispatched).toEqual([launchd[0].command])
    expect(launchd[0].status).toBe('succeeded')

    const systemd: PlannedCommand[] = [
      {
        task: 'core',
        command: ['systemctl', '--user', '--no-block', 'restart', 'ficus-smoke-api.service'],
        status: 'pending',
      },
    ]
    const observed = new CommandRunner({
      cwd: '/repo',
      runProcess: async () => ({ exitCode: 1, output: 'user bus unavailable' }),
    })
    await expect(observed.runAll(systemd)).rejects.toThrow(/systemctl/)
    expect(systemd[0].status).toBe('failed')
  })

  it('proves every launchd target root before worker kickstart and API handoff', async () => {
    const calls: string[][] = []
    const dispatched: string[][] = []
    const commands: PlannedCommand[] = [
      {
        task: 'core',
        command: ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.ficus-smoke-worker'],
        status: 'pending',
      },
      {
        task: 'core',
        command: ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.ficus-smoke-api'],
        status: 'pending',
      },
    ]
    const runner = new CommandRunner({
      cwd: '/repo',
      dispatchProcess: (command) => dispatched.push(command),
      runProcess: async (command) => {
        calls.push(command)
        if (command[1] === 'print') return { exitCode: 0, output: 'working directory = /repo\n' }
        return { exitCode: 0, output: 'restarted' }
      },
    })

    await runner.runAll(commands)

    expect(calls.slice(0, 2).every((command) => command[1] === 'print')).toBe(true)
    expect(calls[2]).toEqual(commands[0].command)
    expect(dispatched).toEqual([commands[1].command])
  })

  it('performs no launchd kickstart when a later target has stale or unparseable provenance', async () => {
    for (const output of ['working directory = /foreign/root\n', 'state = running\npid = 42\n']) {
      const calls: string[][] = []
      const dispatched: string[][] = []
      const commands: PlannedCommand[] = [
        {
          task: 'core',
          command: ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.ficus-worker'],
          status: 'pending',
        },
        {
          task: 'core',
          command: ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.ficus-api'],
          status: 'pending',
        },
      ]
      const runner = new CommandRunner({
        cwd: '/repo',
        dispatchProcess: (command) => dispatched.push(command),
        runProcess: async (command) => {
          calls.push(command)
          return {
            exitCode: 0,
            output: command.at(-1)?.endsWith('-worker') ? 'working directory = /repo\n' : output,
          }
        },
      })

      await expect(runner.runAll(commands)).rejects.toThrow(/kickstart/)
      expect(calls.every((command) => command[1] === 'print')).toBe(true)
      expect(dispatched).toEqual([])
      expect(commands[1].status).toBe('failed')
    }
  })

  it('records a failed launchctl provenance probe and never dispatches the restart', async () => {
    const dispatched: string[][] = []
    const commands: PlannedCommand[] = [
      {
        task: 'core',
        command: ['launchctl', 'kickstart', '-k', 'gui/501/sh.ficus.ficus-api'],
        status: 'pending',
      },
    ]
    const runner = new CommandRunner({
      cwd: '/repo',
      dispatchProcess: (command) => dispatched.push(command),
      runProcess: async () => ({ exitCode: 113, output: 'service not found' }),
    })

    await expect(runner.runAll(commands)).rejects.toThrow(/kickstart/)
    expect(commands[0]).toMatchObject({ status: 'failed', exitCode: 113, outputTail: 'service not found' })
    expect(dispatched).toEqual([])
  })

  it('persists systemd API restart success before the restart can kill this process', async () => {
    const observations: string[] = []
    const commands: PlannedCommand[] = [
      {
        task: 'core',
        command: ['systemctl', '--user', '--no-block', 'restart', 'ficus-api.service'],
        status: 'pending',
      },
    ]
    const runner = new CommandRunner({
      cwd: '/repo',
      runProcess: async (_cmd, _cwd, _timeout, onOutput) => {
        // Observed from inside the child call: the accepted outcome must
        // already be persisted, because systemd may stop this process the
        // instant the queued restart job executes — any later write races.
        observations.push(commands[0].status)
        onOutput?.('queued')
        return { exitCode: 0, output: 'queued' }
      },
    })

    await runner.runAll(commands)

    expect(observations).toEqual(['succeeded'])
    expect(commands[0]).toMatchObject({ status: 'succeeded', exitCode: 0 })
  })

  it('treats a systemd API restart child killed by SIGTERM as the restart beginning, not failing', async () => {
    // `systemctl --no-block restart <api>` returns once the job is queued, but systemd can
    // start stopping the unit — and kill this whole cgroup, child included — before it
    // returns. The child then exits 143, which is the restart working, not a rejection.
    const commands: PlannedCommand[] = [
      {
        task: 'core',
        command: ['systemctl', '--user', '--no-block', 'restart', 'ficus-api.service'],
        status: 'pending',
      },
    ]
    const runner = new CommandRunner({
      cwd: '/repo',
      dispatchProcess: () => {
        throw new Error('systemd restarts are awaited, never dispatched')
      },
      runProcess: async () => ({ exitCode: 143, output: '' }),
    })

    await runner.runAll(commands)

    expect(commands[0]).toMatchObject({
      status: 'succeeded',
      exitCode: 143,
      outputTail: 'API restart accepted by systemd; this process was stopped before systemctl returned.',
    })
  })

  it('still records a systemd manager rejection of the API restart', async () => {
    const commands: PlannedCommand[] = [
      {
        task: 'core',
        command: ['systemctl', '--user', '--no-block', 'restart', 'ficus-api.service'],
        status: 'pending',
      },
    ]
    const runner = new CommandRunner({
      cwd: '/repo',
      runProcess: async () => ({ exitCode: 1, output: 'Unit ficus-api.service not loaded' }),
    })

    await expect(runner.runAll(commands)).rejects.toThrow(/restart ficus-api.service/)
    expect(commands[0]).toMatchObject({
      status: 'failed',
      exitCode: 1,
      outputTail: 'Unit ficus-api.service not loaded',
    })
  })

  it('stops after the first failing command', async () => {
    const calls: string[][] = []
    const runner = new CommandRunner({
      cwd: '/repo',
      runProcess: async (cmd) => {
        calls.push(cmd)
        return { exitCode: calls.length === 1 ? 1 : 0, output: 'boom' }
      },
    })
    await expect(
      runner.runAll([
        { task: 'web', command: ['bad'], status: 'pending' },
        { task: 'web', command: ['later'], status: 'pending' },
      ])
    ).rejects.toThrow('bad')
    expect(calls).toEqual([['bad']])
  })
})
