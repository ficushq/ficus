import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'bun-pty'
import type { ISandboxManager, SandboxOptions, SandboxRuntime, SpawnHook } from '../sandbox'
import {
  buildResolveAttachedLogPathCommand,
  buildStreamAttachedLogCommand,
  LocalDeploymentLogPathOutsideWorkspaceError,
} from './local-deployment-log-path'
import { SandboxClient } from '../sandbox/client/http-client'
import { LAUNCH_PATH_FILE } from '../sandbox/launch-path'
import { setTmuxCandidatesForTesting, TMUX_UNREACHABLE_EXIT_CODE, TmuxServerUnreachableError } from '../sandbox/tmux'
import { createFakeTmuxBox, type FakeTmuxBox } from '../sandbox/tmux-fake.test-helper'
import {
  LAUNCHER_SCRIPT,
  LocalDeploymentLaunchFailedError,
  LocalDeploymentProcessSupervisor,
} from './local-deployment-process-supervisor'

class FakeSandboxManager implements ISandboxManager {
  execCalls: Array<{ sandboxId: string; args: string[] }> = []
  execStatusCalls: Array<{ sandboxId: string; args: string[] }> = []
  streamExecCalls: Array<{ sandboxId: string; args: string[] }> = []
  outputs = new Map<string, Buffer>()
  statuses = new Map<string, number>()

  async ensureSandbox(_sandboxId: string, _opts: SandboxOptions): Promise<string> {
    return 'fake-container'
  }

  async stopSandbox(_sandboxId: string) {
    return { kind: 'stopped' as const }
  }
  async removeSandbox(_sandboxId: string): Promise<void> {}
  async cleanup(): Promise<void> {}
  getSpawnHook(_sandboxId: string, _workspacePath: string): SpawnHook | null {
    return null
  }

  async exec(sandboxId: string, args: string[]): Promise<Buffer> {
    this.execCalls.push({ sandboxId, args })
    return this.outputs.get(args[2] ?? args.join(' ')) ?? Buffer.from('')
  }

  async execStatus(sandboxId: string, args: string[]): Promise<number> {
    this.execStatusCalls.push({ sandboxId, args })
    return this.statuses.get(args[2] ?? args.join(' ')) ?? 0
  }

  streamExec(
    sandboxId: string,
    args: string[],
    _onStdout: (chunk: Buffer) => void,
    _onStderr?: (chunk: Buffer) => void
  ): { cancel: () => void } {
    this.streamExecCalls.push({ sandboxId, args })
    return { cancel: () => {} }
  }

  spawnShell(_sandboxId: string, _cols: number, _rows: number, _workspacePath?: string): IPty | null {
    return null
  }

  hasSandbox(_sandboxId: string): boolean {
    return true
  }

  toContainerPath(_sandboxId: string, hostPath: string): string {
    return hostPath
  }

  getWorkspaceLayout(_ctx: { squadId?: string; sandboxId?: string }) {
    return { workspaceMount: '/workspace', memoryMount: '/memory', cwd: '/workspace', privateMount: '/private' }
  }

  getSandboxRuntime(_sandboxId: string): SandboxRuntime | null {
    return 'k8s'
  }
}

describe('LocalDeploymentProcessSupervisor', () => {
  it('cancels and drains a blackholed read invocation at observation abort', async () => {
    let bashCalls = 0
    let cancelCalls = 0
    const entered = Promise.withResolvers<void>()
    const client = new SandboxClient('fixture:1', undefined, {
      fetch: async (input, init) => {
        if (String(input).endsWith('/bash/cancel')) {
          cancelCalls++
          return Response.json({ remainingPids: [] })
        }
        bashCalls++
        entered.resolve()
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
            once: true,
          })
        })
      },
    })
    const manager = Object.assign(new FakeSandboxManager(), { getClientForSandbox: () => client })
    const supervisor = new LocalDeploymentProcessSupervisor(manager)
    const controller = new AbortController()
    const read = supervisor.hasSession('squad_fixture', 'fixture-session', controller.signal).catch((error) => error)
    try {
      await Promise.race([entered.promise, read])
      expect(bashCalls).toBe(1)
      controller.abort()
      expect(await read).toBeInstanceOf(Error)
      expect(cancelCalls).toBe(1)
    } finally {
      controller.abort()
      await read
      client.close()
    }
  })

  for (const alive of [false, true]) {
    it(`reaps the manager-owned session read stream after its result, alive=${alive}`, async () => {
      let reaped = 0
      const manager = Object.assign(new FakeSandboxManager(), {
        streamExec: (_id: string, args: string[], stdout: (chunk: Buffer) => void) => {
          expect(args[2]).toContain("ficus_tmux_has 'owned-session'")
          expect(args[2]).not.toContain("ficus_tmux_kill '")
          queueMicrotask(() => stdout(Buffer.from(`FICUS_SESSION_${alive ? 'ALIVE' : 'MISSING'}\n`)))
          return {
            cancel: () => {},
            cancelAndWait: async () => {
              reaped++
            },
          }
        },
      })
      expect(
        await new LocalDeploymentProcessSupervisor(manager).hasSession(
          'squad_fixture',
          'owned-session',
          new AbortController().signal
        )
      ).toBe(alive)
      expect(reaped).toBe(1)
    })
  }

  it('classifies a reported terminal launch exit without exposing command output', async () => {
    const manager = new FakeSandboxManager()
    manager.exec = async () => {
      throw new Error('Command failed with exit code 1: secret-like fixture output')
    }
    const launch = new LocalDeploymentProcessSupervisor(manager).startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_fixture',
      command: 'fixture',
      port: 5173,
    })
    await expect(launch).rejects.toBeInstanceOf(LocalDeploymentLaunchFailedError)
    await expect(launch).rejects.not.toThrow('secret-like')
  })

  it('uses root FICUS_APP_BASE_PATH in hosted mode without changing launch inputs', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    process.env.FICUS_APPS_DOMAIN = 'ficus.app'

    try {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)
      await supervisor.startManagedLocalDeployment({
        localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
        sandboxId: 'squad_1',
        command: "bun run dev -- --title 'Ficus app'",
        cwd: '/workspace/1/my app',
        port: 5173,
      })

      const command = manager.execCalls[0].args[2]
      const tmuxPrefix = "ficus_tmux_status=0; ficus_tmux_new 'ficus-local-deployment-abcdef12' "
      const tmuxSuffix = ' || ficus_tmux_status=$?'
      const tmuxInvocation = command.split('\n').find((line) => line.startsWith(tmuxPrefix))!
      expect(tmuxInvocation.endsWith(tmuxSuffix)).toBe(true)

      const encodedLaunchCommand = tmuxInvocation.slice(tmuxPrefix.length, -tmuxSuffix.length)
      expect(encodedLaunchCommand.startsWith("'")).toBe(true)
      expect(encodedLaunchCommand.endsWith("'")).toBe(true)
      const launchCommand = encodedLaunchCommand.slice(1, -1).replaceAll(`'"'"'`, "'")
      expect(launchCommand).toBe(
        [
          "FICUS_LOCAL_DEPLOYMENT_ID='abcdef12-1234-4234-8234-123456789abc'",
          "FICUS_LOCAL_DEPLOYMENT_PORT='5173'",
          "PORT='5173'",
          "FICUS_APP_BASE_PATH='/'",
          "FICUS_LOCAL_DEPLOYMENT_CWD='/workspace/1/my app'",
          "FICUS_LOCAL_DEPLOYMENT_DIR='/workspace/1/.ficus/local-deployments/abcdef12-1234-4234-8234-123456789abc'",
          `FICUS_LOCAL_DEPLOYMENT_COMMAND='bun run dev -- --title '"'"'Ficus app'"'"''`,
          "bash '/workspace/1/.ficus/local-deployments/abcdef12-1234-4234-8234-123456789abc/run.sh'",
        ].join(' ')
      )
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
    }
  })

  it('retains the full deployment path in FICUS_APP_BASE_PATH when hosted mode is unset', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    delete process.env.FICUS_APPS_DOMAIN

    try {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)
      await supervisor.startManagedLocalDeployment({
        localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
        sandboxId: 'squad_1',
        command: 'bun run dev',
        port: 5173,
      })

      const command = manager.execCalls[0].args.join(' ')
      expect(command).toContain('FICUS_APP_BASE_PATH=')
      expect(command).toContain('/api/app/abcdef12-1234-4234-8234-123456789abc/')
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
    }
  })

  it('writes a launcher script under /workspace/.ficus/local-deployments/<id>/run.sh', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: '12345678-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      cwd: '/workspace/app',
      port: 5173,
    })

    const command = manager.execCalls[0].args.join(' ')
    expect(command).toContain(
      'mkdir -p /workspace/1/.ficus/local-deployments/12345678-1234-4234-8234-123456789abc/logs'
    )
    expect(command).toContain('cat > /workspace/1/.ficus/local-deployments/12345678-1234-4234-8234-123456789abc/run.sh')
    expect(command).toContain('FICUS_LOCAL_DEPLOYMENT_DIR/logs/current.log')
  })

  it('captures exit status even when localDeployment command fails', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: '12345678-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      port: 5173,
    })

    const command = manager.execCalls[0].args.join(' ')
    const disableExitOnError = command.indexOf('set +e')
    const localDeploymentPipeline = command.indexOf('} 2>&1 | tee -a "$FICUS_LOCAL_DEPLOYMENT_DIR/logs/current.log"')
    const statusCapture = command.indexOf('status=${PIPESTATUS[0]}')
    expect(disableExitOnError).toBeGreaterThan(-1)
    expect(localDeploymentPipeline).toBeGreaterThan(disableExitOnError)
    expect(statusCapture).toBeGreaterThan(localDeploymentPipeline)
  })

  it('waits for an old tmux session to exit before starting managed localDeployments', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      port: 5173,
    })

    const command = manager.execCalls[0].args[2]
    const kill = command.indexOf("ficus_tmux_kill 'ficus-local-deployment-abcdef12' || ficus_tmux_unreachable")
    const wait = command.indexOf("ficus_tmux_has 'ficus-local-deployment-abcdef12' || ficus_tmux_status=$?")
    const start = command.indexOf("ficus_tmux_new 'ficus-local-deployment-abcdef12'")
    expect(kill).toBeGreaterThan(-1)
    expect(wait).toBeGreaterThan(kill)
    expect(start).toBeGreaterThan(wait)
  })

  it('records the caller PATH beside run.sh before starting the tmux session', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'node server.cjs',
      port: 5173,
    })

    const command = manager.execCalls[0].args[2]
    const record = command.indexOf(
      `printf '%s\\n' "$PATH" > '/workspace/1/.ficus/local-deployments/abcdef12-1234-4234-8234-123456789abc/${LAUNCH_PATH_FILE}'`
    )
    expect(record).toBeGreaterThan(-1)
    expect(record).toBeLessThan(command.indexOf("ficus_tmux_new '"))
  })

  it('starts managed localDeployments in tmux session ficus-local-deployment-<short-id>', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    const result = await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev -- --host 0.0.0.0',
      port: 5173,
    })

    const command = manager.execCalls[0].args.join(' ')
    expect(result.processId).toBe('ficus-local-deployment-abcdef12')
    expect(command).toContain("ficus_tmux_new 'ficus-local-deployment-abcdef12'")
    // The launch command is itself single-quoted for tmux, so each quote is escaped.
    expect(command).toContain(`FICUS_LOCAL_DEPLOYMENT_PORT='"'"'5173'"'"'`)
  })

  it('restarts an existing app with its recorded session identity', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)
    const processId = 'tau-local-deployment-persisted' // Existing recorded identity, not a new writer.
    const result = await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'echo ready',
      port: 5173,
      processId,
    })
    expect(result.processId).toBe(processId)
    const command = manager.execCalls[0].args.join(' ')
    expect(command).toContain(`ficus_tmux_kill '${processId}'`)
    expect(command).toContain(`ficus_tmux_new '${processId}'`)
    expect(command).not.toContain('ficus-local-deployment-abcdef12')
  })

  it('kills the tmux session when stopping', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.stopLocalDeployment('squad_1', 'tau-local-deployment-abcdef12')

    expect(manager.execCalls[0].sandboxId).toBe('squad_1')
    expect(manager.execCalls[0].args[2]).toEndWith(
      "\nficus_tmux_kill 'tau-local-deployment-abcdef12' || ficus_tmux_unreachable"
    )
  })

  it('tails persisted log file without leaking missing-file errors', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)
    manager.statuses.set("test -f '/workspace/1/.ficus/local-deployments/localDeployment-1/logs/current.log'", 1)

    const logs = await supervisor.tailLogs('squad_1', 'localDeployment-1', 100)

    expect(logs).toEqual([])
    expect(manager.execCalls).toHaveLength(0)
  })

  it('detects tmux session existence with execStatus', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)
    manager.execStatus = async (sandboxId, args) => {
      manager.execStatusCalls.push({ sandboxId, args })
      return 1
    }

    await expect(supervisor.hasSession('squad_1', 'tau-local-deployment-abcdef12')).resolves.toBe(false)
    expect(manager.execStatusCalls[0].sandboxId).toBe('squad_1')
    expect(manager.execStatusCalls[0].args[2]).toContain("ficus_tmux_has 'tau-local-deployment-abcdef12'")
  })

  it('reports an unreachable tmux server from has-session as an error, not as a missing session', async () => {
    const manager = new FakeSandboxManager()
    manager.execStatus = async () => TMUX_UNREACHABLE_EXIT_CODE
    await expect(
      new LocalDeploymentProcessSupervisor(manager).hasSession('squad_1', 'ficus-local-deployment-abcdef12')
    ).rejects.toBeInstanceOf(TmuxServerUnreachableError)
  })

  it('reports an unreachable tmux server at launch as that, not as a failed launch', async () => {
    const manager = new FakeSandboxManager()
    manager.exec = async () => {
      throw new Error(
        'Command failed with exit code 86: FICUS_TMUX_UNREACHABLE /usr/bin/tmux: server exited unexpectedly'
      )
    }
    const launch = new LocalDeploymentProcessSupervisor(manager).startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      port: 5173,
    })
    await expect(launch).rejects.toBeInstanceOf(TmuxServerUnreachableError)
    await expect(launch).rejects.toThrow('server exited unexpectedly')
  })

  it('defaults FICUS_LOCAL_DEPLOYMENT_CWD to the squad workspace mount when cwd is omitted', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-4234-8234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      port: 5173,
    })

    const command = manager.execCalls[0].args.join(' ')
    // FICUS_LOCAL_DEPLOYMENT_CWD is embedded in the shell-quoted launch command, so single-quotes
    // around the path get escaped; use a regex to verify the value regardless of quoting.
    expect(command).toMatch(/FICUS_LOCAL_DEPLOYMENT_CWD.*\/workspace\/1/)
  })

  it('uses /workspace/2 mount for squad_2 sandbox', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'aabbccdd-1234-4234-8234-123456789abc',
      sandboxId: 'squad_2',
      command: 'bun run start',
      port: 3000,
    })

    const command = manager.execCalls[0].args.join(' ')
    expect(command).toContain(
      'mkdir -p /workspace/2/.ficus/local-deployments/aabbccdd-1234-4234-8234-123456789abc/logs'
    )
    expect(command).toContain('cat > /workspace/2/.ficus/local-deployments/aabbccdd-1234-4234-8234-123456789abc/run.sh')
    expect(command).toMatch(/FICUS_LOCAL_DEPLOYMENT_CWD.*\/workspace\/2/)
  })
  describe('attached log paths', () => {
    const LOG_PATH = '/workspace/1/my-app/app.log'

    it('tailAttachedLogs resolves then tails the resolved path', async () => {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)
      manager.outputs.set(
        buildResolveAttachedLogPathCommand('/workspace/1', LOG_PATH),
        Buffer.from(`EXISTS\n${LOG_PATH}\n`)
      )
      manager.outputs.set(`tail -n 100 '${LOG_PATH}'`, Buffer.from('line-one\nline-two\n'))

      const lines = await supervisor.tailAttachedLogs('squad_1', LOG_PATH, 100)

      expect(lines).toEqual({ kind: 'lines', lines: ['line-one', 'line-two'] })
      expect(manager.execCalls[0].args[2]).toContain('realpath')
      expect(manager.execCalls[1].args[2]).toBe(`tail -n 100 '${LOG_PATH}'`)
    })

    it('tailAttachedLogs reports unavailable when the log file is missing', async () => {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)
      manager.outputs.set(
        buildResolveAttachedLogPathCommand('/workspace/1', LOG_PATH),
        Buffer.from(`MISSING\n${LOG_PATH}\n`)
      )

      const result = await supervisor.tailAttachedLogs('squad_1', LOG_PATH, 100)

      expect(result).toEqual({ kind: 'unavailable' })
      expect(manager.execCalls).toHaveLength(1) // no tail was attempted
    })

    it('resolveAttachedLogPath throws a typed error when resolution escapes the workspace', async () => {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)
      manager.outputs.set(buildResolveAttachedLogPathCommand('/workspace/1', '/etc/passwd'), Buffer.from('OUTSIDE\n'))

      await expect(supervisor.resolveAttachedLogPath('squad_1', '/etc/passwd')).rejects.toBeInstanceOf(
        LocalDeploymentLogPathOutsideWorkspaceError
      )
    })

    it('streamAttachedLogs tails the resolved path with -F and an inline guard', () => {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)

      const handle = supervisor.streamAttachedLogs(
        'squad_1',
        LOG_PATH,
        10,
        () => {},
        () => {}
      )

      expect(manager.streamExecCalls[0].args[2]).toBe(buildStreamAttachedLogCommand('/workspace/1', LOG_PATH, 10))
      expect(manager.streamExecCalls[0].args[2]).toContain('tail -n 10 -F')
      expect(manager.streamExecCalls[0].args[2]).toContain('realpath -m -- "$w"')
      expect(manager.streamExecCalls[0].args[2]).toContain('"$w"/*)')
      handle.cancel()
    })
  })
})

describe('local deployment launcher', () => {
  // tmux hands a session the tmux SERVER's environment, which may lack the box
  // toolchain entirely. Run the real launcher with only system dirs on PATH; the
  // tool has a name no host login profile can put on PATH.
  function runLauncher(command: string, launchPath: string | null) {
    const root = mkdtempSync(join(tmpdir(), 'ficus-launcher-'))
    try {
      const dir = join(root, 'deployment')
      const toolchain = join(root, 'toolchain-bin')
      mkdirSync(dir, { recursive: true })
      mkdirSync(toolchain)
      writeFileSync(join(toolchain, 'ficus-test-node'), '#!/bin/sh\necho "toolchain node $*"\n')
      chmodSync(join(toolchain, 'ficus-test-node'), 0o755)
      if (launchPath !== null) writeFileSync(join(dir, LAUNCH_PATH_FILE), launchPath.replace('<toolchain>', toolchain))
      const script = join(dir, 'run.sh')
      writeFileSync(script, LAUNCHER_SCRIPT)

      const result = Bun.spawnSync(['/bin/bash', script], {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          FICUS_LOCAL_DEPLOYMENT_ID: 'abcdef12',
          FICUS_LOCAL_DEPLOYMENT_PORT: '5173',
          FICUS_LOCAL_DEPLOYMENT_CWD: root,
          FICUS_LOCAL_DEPLOYMENT_DIR: dir,
          FICUS_LOCAL_DEPLOYMENT_COMMAND: command,
        },
      })
      return {
        exitCode: result.exitCode,
        log: readFileSync(join(dir, 'logs', 'current.log'), 'utf8'),
        recordedExit: readFileSync(join(dir, 'exitCode'), 'utf8').trim(),
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('runs a bare command from the PATH the start command recorded', () => {
    const run = runLauncher('ficus-test-node server.cjs', '<toolchain>:/usr/bin:/bin\n')
    expect(run.log).toContain('toolchain node server.cjs')
    expect(run.exitCode).toBe(0)
    expect(run.recordedExit).toBe('0')
  })

  it('keeps the recorded PATH out of the app environment', () => {
    const run = runLauncher('echo "leak=${FICUS_LAUNCH_PATH-unset}"', '<toolchain>\n')
    expect(run.log).toContain('leak=unset')
  })

  it('still runs the command when no PATH was recorded', () => {
    const run = runLauncher('echo started; ficus-test-node server.cjs', null)
    expect(run.log).toContain('started')
    expect(run.log).toContain('ficus-test-node: command not found')
    expect(run.recordedExit).toBe('127')
  })
})

/**
 * The exact commands the supervisor builds, run by real bash against a fake
 * tmux (see tmux-fake.test-helper.ts) with ANOTHER tmux first on PATH, as on a
 * box whose devbox profile carries its own tmux.
 */
describe('LocalDeploymentProcessSupervisor with the pinned tmux', () => {
  const SQUAD = '0f0e0d0c-1111-4222-8333-444455556666'
  const SANDBOX = `squad_${SQUAD}`
  const ID = 'abcdef12-1234-4234-8234-123456789abc'
  const SESSION = 'ficus-local-deployment-abcdef12'
  let root: string
  let box: FakeTmuxBox
  let systemTmux: string
  let prevRuntime: string | undefined
  let prevHome: string | undefined

  class BashSandboxManager extends FakeSandboxManager {
    private env() {
      return {
        PATH: `${join(root, 'devbox-bin')}:${join(root, 'user-bin')}:/usr/bin:/bin`,
        HOME: root,
        FAKE_TMUX_STATE: box.state,
      }
    }
    private run(args: string[]) {
      const result = Bun.spawnSync(['/bin/bash', ...args.slice(1)], { env: this.env() })
      return {
        exitCode: result.exitCode,
        out: result.stdout.toString() + result.stderr.toString(),
        stdout: result.stdout,
      }
    }
    override async exec(_sandboxId: string, args: string[]): Promise<Buffer> {
      const result = this.run(args)
      if (result.exitCode !== 0) throw new Error(`Command failed with exit code ${result.exitCode}: ${result.out}`)
      return result.stdout
    }
    override async execStatus(_sandboxId: string, args: string[]): Promise<number> {
      return this.run(args).exitCode
    }
    override streamExec(_sandboxId: string, args: string[], onStdout: (chunk: Buffer) => void) {
      const result = this.run(args)
      queueMicrotask(() => onStdout(result.stdout))
      return { cancel: () => {}, cancelAndWait: async () => {} }
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ficus-pinned-tmux-'))
    box = createFakeTmuxBox(root)
    systemTmux = box.install(join(root, 'system-bin', 'tmux'), '3.4')
    box.install(join(root, 'devbox-bin', 'tmux'), '3.7')
    mkdirSync(join(root, 'user-bin'))
    writeFileSync(join(root, 'user-bin', 'ficus-user-tool'), '#!/bin/sh\necho "user tool ran"\n')
    chmodSync(join(root, 'user-bin', 'ficus-user-tool'), 0o755)
    setTmuxCandidatesForTesting([systemTmux])
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    prevHome = process.env.HOME_DIR
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.HOME_DIR = root
  })

  afterEach(() => {
    setTmuxCandidatesForTesting(null)
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  const deploymentDir = () => join(root, 'workspaces', 'squads', SQUAD, '.ficus', 'local-deployments', ID)
  const start = (supervisor: LocalDeploymentProcessSupervisor, processId?: string) =>
    supervisor.startManagedLocalDeployment({
      localDeploymentId: ID,
      sandboxId: SANDBOX,
      command:
        'echo "$PATH" > "$FICUS_LOCAL_DEPLOYMENT_DIR/app-path"; ficus-user-tool > "$FICUS_LOCAL_DEPLOYMENT_DIR/app-out"',
      port: 5173,
      processId,
    })

  it('launches, observes and stops with the pinned tmux; the app still gets the caller PATH', async () => {
    const supervisor = new LocalDeploymentProcessSupervisor(new BashSandboxManager())
    expect(await start(supervisor)).toEqual({ processId: SESSION })
    expect(box.hasSession('ficus', SESSION)).toBe(true)
    expect(await supervisor.hasSession(SANDBOX, SESSION)).toBe(true)
    expect(await supervisor.hasSession(SANDBOX, SESSION, new AbortController().signal)).toBe(true)
    await supervisor.stopLocalDeployment(SANDBOX, SESSION)
    expect(await supervisor.hasSession(SANDBOX, SESSION)).toBe(false)
    expect(await supervisor.hasSession(SANDBOX, SESSION, new AbortController().signal)).toBe(false)

    // The devbox tmux first on PATH was never run.
    expect(new Set(box.callers())).toEqual(new Set([systemTmux]))
    // The fake tmux hands the session only /usr/bin:/bin; the launcher restored the caller's PATH.
    expect(readFileSync(join(deploymentDir(), 'app-out'), 'utf8')).toBe('user tool ran\n')
    expect(readFileSync(join(deploymentDir(), 'app-path'), 'utf8')).toContain(join(root, 'user-bin'))
  })

  it('finds a session started on the default socket before the upgrade, and restarts it onto the Ficus socket', async () => {
    box.seedSession('default', '3.4', SESSION)
    const supervisor = new LocalDeploymentProcessSupervisor(new BashSandboxManager())
    expect(await supervisor.hasSession(SANDBOX, SESSION)).toBe(true)
    expect(await supervisor.hasSession(SANDBOX, SESSION, new AbortController().signal)).toBe(true)

    await start(supervisor, SESSION)
    expect(box.hasSession('default', SESSION)).toBe(false)
    expect(box.hasSession('ficus', SESSION)).toBe(true)
  })

  it('reports a stale server of another version as unreachable on every call, never as gone or as a failed launch', async () => {
    box.seedSession('default', '3.7', SESSION)
    const supervisor = new LocalDeploymentProcessSupervisor(new BashSandboxManager())

    await expect(supervisor.hasSession(SANDBOX, SESSION)).rejects.toBeInstanceOf(TmuxServerUnreachableError)
    await expect(supervisor.hasSession(SANDBOX, SESSION, new AbortController().signal)).rejects.toThrow(
      'server exited unexpectedly'
    )
    await expect(supervisor.stopLocalDeployment(SANDBOX, SESSION)).rejects.toBeInstanceOf(TmuxServerUnreachableError)
    const launch = start(supervisor, SESSION)
    await expect(launch).rejects.toBeInstanceOf(TmuxServerUnreachableError)
    await expect(launch).rejects.toThrow('server exited unexpectedly')
    // The possibly-running old session is left alone and no second copy was started.
    expect(box.hasSession('default', SESSION)).toBe(true)
    expect(box.serverVersion('ficus')).toBeNull()
  })

  it('stops a stale session of another version when the tmux that started it is installed', async () => {
    setTmuxCandidatesForTesting([systemTmux, join(root, 'devbox-bin', 'tmux')])
    box.seedSession('default', '3.7', SESSION)
    const supervisor = new LocalDeploymentProcessSupervisor(new BashSandboxManager())
    expect(await supervisor.hasSession(SANDBOX, SESSION)).toBe(true)
    await start(supervisor, SESSION)
    expect(box.hasSession('default', SESSION)).toBe(false)
    // The new session runs on Ficus's own server, started by the pinned binary.
    expect(box.serverVersion('ficus')).toBe('3.4')
  })
})
