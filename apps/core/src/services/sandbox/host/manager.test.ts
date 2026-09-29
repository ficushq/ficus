import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HostSandboxManager, setHostStopBeforeFenceHookForTest, whenChildSettles } from './manager'
import { clearHostWorkspaceOverrides, setHostWorkspaceOverride } from './workspace-overrides'

const SQUAD = '11111111-2222-4333-8444-555555555555'

describe('HostSandboxManager', () => {
  let home: string
  let prevHome: string | undefined
  let manager: HostSandboxManager
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ficus-host-mgr-'))
    prevHome = process.env.HOME_DIR
    process.env.HOME_DIR = home
    clearHostWorkspaceOverrides()
    manager = new HostSandboxManager({ baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }) })
  })
  afterEach(async () => {
    await manager.cleanup()
    clearHostWorkspaceOverrides()
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  test('ensureSandbox creates the private dir + squad workspace and tracks the sandbox', async () => {
    const root = await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    expect(root).toBe(join(home, 'workspaces', 'squads', SQUAD))
    expect(existsSync(root)).toBe(true)
    expect(existsSync(join(home, 'private', 'agent_a1'))).toBe(true)
    expect(manager.hasSandbox('agent_a1')).toBe(true)
    expect((await manager.getSandboxStatus('agent_a1')).status).toBe('running')
  })

  test('ensureSandbox installs the ficus + ssh-family shims on the PATH dir', async () => {
    // host/bin is prepended to every agent PATH by buildHostCommandEnv; the
    // ssh/scp/rsync shims there are what make granted remote-host aliases
    // work for plain SSH-family commands (issue #1331).
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    expect(existsSync(join(home, 'host', 'bin', 'ssh'))).toBe(true)
    expect(existsSync(join(home, 'host', 'bin', 'scp'))).toBe(true)
    expect(existsSync(join(home, 'host', 'bin', 'rsync'))).toBe(true)
  })

  test('ensureSandbox honours a workspace override and derives squadId from a squad_ sandbox id', async () => {
    setHostWorkspaceOverride(SQUAD, join(home, 'override-repo'))
    const root = await manager.ensureSandbox(`squad_${SQUAD}`, { workspacePath: '' })
    expect(root).toBe(join(home, 'override-repo'))
    expect(existsSync(root)).toBe(true)
  })

  test('solo sandbox work root is the private dir', async () => {
    const root = await manager.ensureSandbox('system_manager_u1', { workspacePath: '' })
    expect(root).toBe(join(home, 'private', 'system_manager_u1'))
  })

  test('stop/remove drop tracking and never delete disk', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    await manager.stopSandbox('agent_a1')
    expect(manager.hasSandbox('agent_a1')).toBe(false)
    expect((await manager.getSandboxStatus('agent_a1')).status).toBe('not_found')
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    await manager.removeSandbox('agent_a1')
    expect(manager.hasSandbox('agent_a1')).toBe(false)
    expect(existsSync(join(home, 'private', 'agent_a1'))).toBe(true)
    expect(existsSync(join(home, 'workspaces', 'squads', SQUAD))).toBe(true)
  })

  // Stopping/removing a sandbox closes its browser context now instead of
  // waiting for the engine's 15-min idle sweep — and never crashes when no
  // engine was ever built.
  test('stopSandbox/removeSandbox close that sandbox browser context; no engine is fine', async () => {
    const closed: string[] = []
    manager = new HostSandboxManager({
      baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
      createBrowserEngine: () =>
        ({
          forSandbox: () => ({}) as any,
          closeSandboxContext: async (sandboxId: string) => {
            closed.push(sandboxId)
          },
          shutdown: async () => {},
        }) as any,
    })
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    // The engine is built lazily by the first getBrowserBackend — without
    // this call browserEngine is null and stop/remove (correctly) close
    // nothing.
    expect(manager.getBrowserBackend('agent_a1')).not.toBeNull()
    await manager.stopSandbox('agent_a1')
    await manager.removeSandbox('agent_a2')
    expect(closed).toEqual(['agent_a1', 'agent_a2'])

    // And a manager whose engine never started stops/removes fine.
    const bare = new HostSandboxManager({ baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }) })
    await bare.ensureSandbox('agent_b1', { workspacePath: '', squadId: SQUAD })
    await expect(bare.stopSandbox('agent_b1')).resolves.toEqual({ kind: 'stopped' })
    await expect(bare.removeSandbox('agent_b2')).resolves.toBeUndefined()
    await bare.cleanup()
  })

  test('a stale generation stop cannot delete a re-ensured host sandbox or browser backend', async () => {
    const backend = {} as any
    manager = new HostSandboxManager({
      baseEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
      createBrowserEngine: () => ({ forSandbox: () => backend, shutdown: async () => {} }) as any,
    })
    const stopEntered = Promise.withResolvers<void>()
    const releaseStop = Promise.withResolvers<void>()
    setHostStopBeforeFenceHookForTest(async () => {
      stopEntered.resolve()
      await releaseStop.promise
    })
    try {
      await manager.ensureSandbox('agent_a1', { workspacePath: '', lifecycleGeneration: 'generation-a' })
      expect(manager.getBrowserBackend('agent_a1')).toBe(backend)
      const staleStop = manager.stopSandbox('agent_a1', { lifecycleGeneration: 'generation-a' })
      await stopEntered.promise

      await manager.ensureSandbox('agent_a1', { workspacePath: '', lifecycleGeneration: 'generation-b' })
      releaseStop.resolve()
      await staleStop

      expect(manager.hasSandbox('agent_a1')).toBe(true)
      expect(manager.getBrowserBackend('agent_a1')).toBe(backend)
      expect(await manager.execStatus('agent_a1', ['true'])).toBe(0)
    } finally {
      releaseStop.resolve()
      setHostStopBeforeFenceHookForTest(undefined)
    }
  })

  test('null stops only unstamped legacy state while an unfenced stop remains manual cleanup', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', lifecycleGeneration: 'generation-b' })
    await manager.stopSandbox('agent_a1', { lifecycleGeneration: null })
    expect(manager.hasSandbox('agent_a1')).toBe(true)
    await manager.stopSandbox('agent_a1')
    expect(manager.hasSandbox('agent_a1')).toBe(false)

    await manager.ensureSandbox('agent_a1', { workspacePath: '' })
    await manager.stopSandbox('agent_a1', { lifecycleGeneration: null })
    expect(manager.hasSandbox('agent_a1')).toBe(false)
  })

  test('exec runs argv in the work root with the host env, not the worker env', async () => {
    const canary = `CANARY_${Date.now()}`
    process.env[canary] = 'leaked'
    try {
      await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
      const out = await manager.exec('agent_a1', ['bash', '-c', `pwd; echo "canary=\${${canary}:-absent}"`])
      expect(out.toString()).toBe(`${join(home, 'workspaces', 'squads', SQUAD)}\ncanary=absent\n`)
    } finally {
      delete process.env[canary]
    }
  })

  test('exec returns stdout only, not stderr', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    const out = await manager.exec('agent_a1', ['bash', '-c', 'echo out; echo err >&2'])
    expect(out.toString()).toBe('out\n')
  })

  test('exec rejects on non-zero exit; execStatus returns the code', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    await expect(manager.exec('agent_a1', ['bash', '-c', 'echo boom >&2; exit 3'])).rejects.toThrow('exit code 3')
    expect(await manager.execStatus('agent_a1', ['bash', '-c', 'exit 7'])).toBe(7)
    expect(await manager.execStatus('agent_a1', ['true'])).toBe(0)
  })

  test('exec on an untracked sandbox rejects; execStatus on an untracked sandbox returns 1', async () => {
    await expect(manager.exec('agent_nope', ['true'])).rejects.toThrow('No host sandbox tracked')
    expect(await manager.execStatus('agent_nope', ['true'])).toBe(1)
  })

  test('streamExec streams stdout and cancel kills the process tree', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    const chunks: string[] = []
    const handle = manager.streamExec!('agent_a1', ['bash', '-c', 'echo first; sleep 31.7; echo never'], (c) =>
      chunks.push(c.toString())
    )
    await new Promise((r) => setTimeout(r, 300))
    await handle.cancelAndWait!()
    expect(chunks.join('')).toBe('first\n')
    // The `sleep 31.7` child must be gone: no process from our group survives.
    // The bracket around one digit (`3[1].7`) keeps the pattern from matching this
    // probe's OWN `pgrep -f` argv on Linux, where /proc cmdline literally contains it.
    // `command -v pgrep` first: without it, a machine lacking pgrep would exit 1
    // from the `pgrep` failure... and the `|| exit 0` would report "no survivor",
    // passing this test while proving nothing.
    const alive = await manager.execStatus('agent_a1', [
      'bash',
      '-c',
      'command -v pgrep >/dev/null || exit 2; pgrep -f "sleep 3[1].7" >/dev/null && exit 1 || exit 0',
    ])
    expect(alive).toBe(0)
  })

  test('cancelAndWait returns when a grandchild outlives the leader and holds the pipes', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    // The leader backgrounds a sleeper and exits immediately. That is killTree's
    // early-return guard verbatim — `child.exitCode !== null`, so it kills nothing
    // — while the sleeper keeps the stdout/stderr pipes it inherited. Node's
    // 'close' waits on those pipes, so it never fires: awaiting it hung forever.
    // 'exit' already fired, so cancelAndWait must return regardless.
    const handle = manager.streamExec!('agent_a1', ['bash', '-c', 'echo up; sleep 27.9 & exit 0'], () => {})
    await new Promise((r) => setTimeout(r, 300))
    // Bound it here rather than leaning on the suite timeout: a regression must
    // name itself ("did not return") instead of reappearing as an opaque timeout,
    // which is the exact failure mode this test exists to retire.
    await Promise.race([
      handle.cancelAndWait!(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancelAndWait did not return while a grandchild held the pipes')), 2000)
      ),
    ])
    // The guard left the sleeper alive by design; do not strand it for 27.9s.
    await manager.execStatus('agent_a1', ['bash', '-c', 'pkill -f "sleep 2[7].9" >/dev/null 2>&1; exit 0'])
  })

  test('spawnShell returns a pty running a shell in the work root', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    const pty = manager.spawnShell('agent_a1', 80, 24)
    expect(pty).not.toBeNull()
    let data = ''
    pty!.onData((d) => (data += d))
    pty!.write('pwd; exit\r')
    await new Promise<void>((resolve) => pty!.onExit(() => resolve()))
    expect(data).toContain(join(home, 'workspaces', 'squads', SQUAD))
  })

  test('spawnShell on an untracked sandbox returns null', () => {
    expect(manager.spawnShell('agent_nope', 80, 24)).toBeNull()
  })

  test('query surface', async () => {
    await manager.ensureSandbox('agent_a1', { workspacePath: '', squadId: SQUAD })
    expect(manager.getSandboxRuntime('agent_a1')).toBe('host')
    expect(manager.toContainerPath('agent_a1', '/x/y')).toBe('/x/y')
    expect(await manager.getSandboxMachineId!('agent_a1')).toBe('host')
    expect(await manager.getLocalDeploymentTarget!('agent_a1', 3000)).toEqual({ host: '127.0.0.1', port: 3000 })
    expect(manager.getSpawnHook('agent_a1', '')).toBeNull()
    expect(manager.getWorkspaceLayout({ squadId: SQUAD, sandboxId: 'agent_a1' }).privateMount).toBe(
      join(home, 'private', 'agent_a1')
    )
    expect(manager.streamLogs).toBeUndefined()
    expect(manager.reconcileToolchain).toBeUndefined()
    expect(manager.recreateSandbox).toBeUndefined()
  })
})

describe('whenChildSettles', () => {
  // Mimics the state captured from a real hung run: reaped, exitCode recorded,
  // both streams ended and destroyed, and NEITHER 'exit' nor 'close' emitted.
  const fakeChild = (over: Partial<Record<string, unknown>> = {}) => {
    const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
    emitter.exitCode = null
    emitter.signalCode = null
    emitter.stdout = { readableEnded: false, destroyed: false }
    emitter.stderr = { readableEnded: false, destroyed: false }
    Object.assign(emitter, over)
    return emitter as unknown as Parameters<typeof whenChildSettles>[0]
  }

  const settlesWithin = async (p: Promise<void>, ms: number) =>
    Promise.race([p.then(() => 'settled' as const), Bun.sleep(ms).then(() => 'pending' as const)])

  // Drives the child into the observed state AFTER the wait has begun, so only
  // the polled backstop can resolve it. Building a child that is already
  // finished would hit the constructor-time fast path and prove nothing.
  const finishWithoutEmitting = (child: ReturnType<typeof fakeChild>, over: Record<string, unknown>) =>
    Object.assign(child as unknown as Record<string, unknown>, {
      stdout: { readableEnded: true, destroyed: true },
      stderr: { readableEnded: true, destroyed: true },
      ...over,
    })

  test('settles when the child was reaped but the event was never emitted', async () => {
    const child = fakeChild()
    const settled = settlesWithin(whenChildSettles(child, 'close'), 2000)
    await Bun.sleep(20)
    finishWithoutEmitting(child, { exitCode: 0 }) // no emit() anywhere
    expect(await settled).toBe('settled')
  })

  test('settles for an exit waiter when the signal kill is never announced', async () => {
    const child = fakeChild()
    const settled = settlesWithin(whenChildSettles(child, 'exit'), 2000)
    await Bun.sleep(20)
    finishWithoutEmitting(child, { signalCode: 'SIGKILL' })
    expect(await settled).toBe('settled')
  })

  test('resolves immediately for a child already finished at handover', async () => {
    const child = fakeChild({
      exitCode: 0,
      stdout: { readableEnded: true, destroyed: true },
      stderr: { readableEnded: true, destroyed: true },
    })
    expect(await settlesWithin(whenChildSettles(child, 'close'), 1000)).toBe('settled')
  })

  test('a close waiter does NOT settle while a survivor still holds the pipes', async () => {
    // Leader reaped, streams still open — a grandchild inherited them. Settling
    // here would hand the caller truncated output, so the backstop must hold.
    const child = fakeChild()
    const held = settlesWithin(whenChildSettles(child, 'close'), 400)
    await Bun.sleep(20)
    Object.assign(child as unknown as Record<string, unknown>, { exitCode: 0 }) // streams stay open
    expect(await held).toBe('pending')
    // ...and an exit waiter, which makes no output promise, must settle.
    expect(await settlesWithin(whenChildSettles(child, 'exit'), 1000)).toBe('settled')
  })

  test('settles on error for a child that never spawned and is never reaped', async () => {
    const child = fakeChild()
    const settled = settlesWithin(whenChildSettles(child, 'close'), 1000)
    ;(child as unknown as EventEmitter).emit('error', new Error('ENOENT'))
    expect(await settled).toBe('settled')
  })

  test('still settles from the real event when Bun does emit it', async () => {
    const child = fakeChild()
    const settled = settlesWithin(whenChildSettles(child, 'close'), 1000)
    ;(child as unknown as EventEmitter).emit('close', 0)
    expect(await settled).toBe('settled')
  })
})
