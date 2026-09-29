import { describe, expect, it } from 'bun:test'
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
import { LAUNCH_PATH_FILE } from '../sandbox/launch-path'
import { LAUNCHER_SCRIPT, LocalDeploymentProcessSupervisor } from './local-deployment-process-supervisor'

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
  it('uses root FICUS_APP_BASE_PATH in hosted mode without changing launch inputs', async () => {
    const previousAppsDomain = process.env.FICUS_APPS_DOMAIN
    process.env.FICUS_APPS_DOMAIN = 'hiretau.app'

    try {
      const manager = new FakeSandboxManager()
      const supervisor = new LocalDeploymentProcessSupervisor(manager)
      await supervisor.startManagedLocalDeployment({
        localDeploymentId: 'abcdef12-1234-1234-1234-123456789abc',
        sandboxId: 'squad_1',
        command: "bun run dev -- --title 'Ficus app'",
        cwd: '/workspace/1/my app',
        port: 5173,
      })

      const command = manager.execCalls[0].args[2]
      const tmuxPrefix = "tmux new-session -d -s 'tau-local-deployment-abcdef12' "
      const tmuxInvocation = command.split('\n').at(-1)!
      expect(tmuxInvocation.startsWith(tmuxPrefix)).toBe(true)

      const encodedLaunchCommand = tmuxInvocation.slice(tmuxPrefix.length)
      expect(encodedLaunchCommand.startsWith("'")).toBe(true)
      expect(encodedLaunchCommand.endsWith("'")).toBe(true)
      const launchCommand = encodedLaunchCommand.slice(1, -1).replaceAll(`'"'"'`, "'")
      expect(launchCommand).toBe(
        [
          "FICUS_LOCAL_DEPLOYMENT_ID='abcdef12-1234-1234-1234-123456789abc'",
          "FICUS_LOCAL_DEPLOYMENT_PORT='5173'",
          "PORT='5173'",
          "FICUS_APP_BASE_PATH='/'",
          "FICUS_LOCAL_DEPLOYMENT_CWD='/workspace/1/my app'",
          "FICUS_LOCAL_DEPLOYMENT_DIR='/workspace/1/.tau/local-deployments/abcdef12-1234-1234-1234-123456789abc'",
          `FICUS_LOCAL_DEPLOYMENT_COMMAND='bun run dev -- --title '"'"'Ficus app'"'"''`,
          // One release (Ficus rename): user apps still get the legacy TAU_ spellings.
          "TAU_APP_BASE_PATH='/'",
          "TAU_LOCAL_DEPLOYMENT_ID='abcdef12-1234-1234-1234-123456789abc'",
          "TAU_LOCAL_DEPLOYMENT_PORT='5173'",
          "TAU_LOCAL_DEPLOYMENT_CWD='/workspace/1/my app'",
          "TAU_LOCAL_DEPLOYMENT_DIR='/workspace/1/.tau/local-deployments/abcdef12-1234-1234-1234-123456789abc'",
          `TAU_LOCAL_DEPLOYMENT_COMMAND='bun run dev -- --title '"'"'Ficus app'"'"''`,
          "bash '/workspace/1/.tau/local-deployments/abcdef12-1234-1234-1234-123456789abc/run.sh'",
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
        localDeploymentId: 'abcdef12-1234-1234-1234-123456789abc',
        sandboxId: 'squad_1',
        command: 'bun run dev',
        port: 5173,
      })

      const command = manager.execCalls[0].args.join(' ')
      expect(command).toContain('FICUS_APP_BASE_PATH=')
      expect(command).toContain('/api/app/abcdef12-1234-1234-1234-123456789abc/')
    } finally {
      if (previousAppsDomain === undefined) delete process.env.FICUS_APPS_DOMAIN
      else process.env.FICUS_APPS_DOMAIN = previousAppsDomain
    }
  })

  it('writes a launcher script under /workspace/.tau/local-deployments/<id>/run.sh', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: '12345678-1234-1234-1234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      cwd: '/workspace/app',
      port: 5173,
    })

    const command = manager.execCalls[0].args.join(' ')
    expect(command).toContain('mkdir -p /workspace/1/.tau/local-deployments/12345678-1234-1234-1234-123456789abc/logs')
    expect(command).toContain('cat > /workspace/1/.tau/local-deployments/12345678-1234-1234-1234-123456789abc/run.sh')
    expect(command).toContain('FICUS_LOCAL_DEPLOYMENT_DIR/logs/current.log')
  })

  it('captures exit status even when localDeployment command fails', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: '12345678-1234-1234-1234-123456789abc',
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
      localDeploymentId: 'abcdef12-1234-1234-1234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev',
      port: 5173,
    })

    const command = manager.execCalls[0].args[2]
    expect(command).toContain("tmux kill-session -t 'tau-local-deployment-abcdef12' 2>/dev/null || true")
    expect(command).toContain("tmux has-session -t 'tau-local-deployment-abcdef12' 2>/dev/null || break")
    expect(command).toContain("tmux new-session -d -s 'tau-local-deployment-abcdef12'")
  })

  it('records the caller PATH beside run.sh before starting the tmux session', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-1234-1234-123456789abc',
      sandboxId: 'squad_1',
      command: 'node server.cjs',
      port: 5173,
    })

    const command = manager.execCalls[0].args[2]
    const record = command.indexOf(
      `printf '%s\\n' "$PATH" > '/workspace/1/.tau/local-deployments/abcdef12-1234-1234-1234-123456789abc/${LAUNCH_PATH_FILE}'`
    )
    expect(record).toBeGreaterThan(-1)
    expect(record).toBeLessThan(command.indexOf('tmux new-session'))
  })

  it('starts managed localDeployments in tmux session tau-local-deployment-<short-id>', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    const result = await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-1234-1234-123456789abc',
      sandboxId: 'squad_1',
      command: 'bun run dev -- --host 0.0.0.0',
      port: 5173,
    })

    const command = manager.execCalls[0].args.join(' ')
    expect(result.processId).toBe('tau-local-deployment-abcdef12')
    expect(command).toContain("tmux new-session -d -s 'tau-local-deployment-abcdef12'")
    // The launch command is itself single-quoted for tmux, so each quote is escaped.
    expect(command).toContain(`FICUS_LOCAL_DEPLOYMENT_PORT='"'"'5173'"'"'`)
    expect(command).toContain(`TAU_LOCAL_DEPLOYMENT_PORT='"'"'5173'"'"'`)
  })

  it('kills the tmux session when stopping', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.stopLocalDeployment('squad_1', 'tau-local-deployment-abcdef12')

    expect(manager.execCalls[0]).toEqual({
      sandboxId: 'squad_1',
      args: ['bash', '-lc', "tmux kill-session -t 'tau-local-deployment-abcdef12' || true"],
    })
  })

  it('tails persisted log file without leaking missing-file errors', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)
    manager.statuses.set("test -f '/workspace/1/.tau/local-deployments/localDeployment-1/logs/current.log'", 1)

    const logs = await supervisor.tailLogs('squad_1', 'localDeployment-1', 100)

    expect(logs).toEqual([])
    expect(manager.execCalls).toHaveLength(0)
  })

  it('detects tmux session existence with execStatus', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)
    manager.statuses.set("tmux has-session -t 'tau-local-deployment-abcdef12'", 1)

    await expect(supervisor.hasSession('squad_1', 'tau-local-deployment-abcdef12')).resolves.toBe(false)
    expect(manager.execStatusCalls[0]).toEqual({
      sandboxId: 'squad_1',
      args: ['bash', '-lc', "tmux has-session -t 'tau-local-deployment-abcdef12'"],
    })
  })

  it('defaults FICUS_LOCAL_DEPLOYMENT_CWD to the squad workspace mount when cwd is omitted', async () => {
    const manager = new FakeSandboxManager()
    const supervisor = new LocalDeploymentProcessSupervisor(manager)

    await supervisor.startManagedLocalDeployment({
      localDeploymentId: 'abcdef12-1234-1234-1234-123456789abc',
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
      localDeploymentId: 'aabbccdd-1234-1234-1234-123456789abc',
      sandboxId: 'squad_2',
      command: 'bun run start',
      port: 3000,
    })

    const command = manager.execCalls[0].args.join(' ')
    expect(command).toContain('mkdir -p /workspace/2/.tau/local-deployments/aabbccdd-1234-1234-1234-123456789abc/logs')
    expect(command).toContain('cat > /workspace/2/.tau/local-deployments/aabbccdd-1234-1234-1234-123456789abc/run.sh')
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
