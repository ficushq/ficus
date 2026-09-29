import { describe, expect, test } from 'bun:test'
import type { Subprocess } from 'bun'
import { PortForwardManager, buildKubectlPortForwardArgs, EXECUTOR_PORT } from './port-forward'

interface FakeProc {
  exitCode: number | null
  exited: Promise<number>
  resolveExit(code: number): void
  killed: boolean
  kill(): void
}

function makeFakeProc(overrides: Partial<FakeProc> = {}): FakeProc {
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => (resolveExit = resolve))
  const proc: FakeProc = {
    exitCode: null,
    exited,
    resolveExit(code) {
      proc.exitCode = code
      resolveExit(code)
    },
    killed: false,
    kill() {
      proc.killed = true
      proc.resolveExit(137)
    },
    ...overrides,
  }
  return proc
}

interface Harness {
  manager: PortForwardManager
  spawned: { args: string[]; proc: FakeProc }[]
}

function makeManager(
  opts: { ports?: number[]; procs?: FakeProc[]; probeReady?: (spawned: Harness['spawned']) => Promise<boolean> } = {}
): Harness {
  const spawned: { args: string[]; proc: FakeProc }[] = []
  let portIndex = 0
  const ports = opts.ports ?? [50100, 50101, 50102, 50103]
  const manager = new PortForwardManager('tau-sandboxes-test', {
    spawn: (args) => {
      const proc = opts.procs?.[spawned.length] ?? makeFakeProc()
      spawned.push({ args, proc })
      return proc as unknown as Subprocess
    },
    findFreePort: async () => ports[portIndex++]!,
    probeReady: () => (opts.probeReady ?? (async () => true))(spawned),
    retryDelayMs: 1,
    readyTimeoutMs: 250,
    probeIntervalMs: 1,
  })
  return { manager, spawned }
}

describe('buildKubectlPortForwardArgs', () => {
  test('pins local port-forward to the configured kube context', () => {
    expect(buildKubectlPortForwardArgs('tau-sandboxes-dev', 'tau-sb-test', 50123, 'k3d-tau-dev-token')).toEqual([
      'kubectl',
      '--context',
      'k3d-tau-dev-token',
      'port-forward',
      '-n',
      'tau-sandboxes-dev',
      'pod/tau-sb-test',
      `50123:${EXECUTOR_PORT}`,
    ])
  })

  test('supports arbitrary app target ports', () => {
    expect(buildKubectlPortForwardArgs('tau-sandboxes-dev', 'tau-sb-test', 50123, 'k3d-tau-dev-token', 5173)).toEqual([
      'kubectl',
      '--context',
      'k3d-tau-dev-token',
      'port-forward',
      '-n',
      'tau-sandboxes-dev',
      'pod/tau-sb-test',
      '50123:5173',
    ])
  })

  test('omits context outside local dev', () => {
    expect(buildKubectlPortForwardArgs('tau-sandboxes', 'tau-sb-test', 50123, null)).toEqual([
      'kubectl',
      'port-forward',
      '-n',
      'tau-sandboxes',
      'pod/tau-sb-test',
      `50123:${EXECUTOR_PORT}`,
    ])
  })
})

describe('PortForwardManager', () => {
  test('ensureExecutorForward spawns kubectl for the executor port and returns the local port', async () => {
    const { manager, spawned } = makeManager()

    const port = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')

    expect(port).toBe(50100)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.args).toContain(`50100:${EXECUTOR_PORT}`)
    expect(spawned[0]!.args).toContain('pod/tau-sb-squad-abc')
  })

  test('deduplicates concurrent ensures for the same forward', async () => {
    let releaseProbe!: () => void
    const probeBarrier = new Promise<void>((resolve) => (releaseProbe = resolve))
    const { manager, spawned } = makeManager({ probeReady: async () => (await probeBarrier, true) })

    const first = manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    const second = manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    await Promise.resolve()
    releaseProbe()

    expect(await first).toBe(await second)
    expect(spawned).toHaveLength(1)
  })

  test('serializes a replacement pod behind an in-flight forward', async () => {
    let releaseProbe!: () => void
    const probeBarrier = new Promise<void>((resolve) => (releaseProbe = resolve))
    let probes = 0
    const { manager, spawned } = makeManager({
      probeReady: async () => {
        probes++
        if (probes === 1) await probeBarrier
        return true
      },
    })

    const oldPod = manager.ensureExecutorForward('squad_abc', 'tau-sb-old')
    while (spawned.length === 0) await Promise.resolve()
    const newPod = manager.ensureExecutorForward('squad_abc', 'tau-sb-new')
    await Promise.resolve()
    await Promise.resolve()
    expect(spawned).toHaveLength(1)
    releaseProbe()

    expect(await oldPod).toBe(50100)
    expect(await newPod).toBe(50101)
    expect(spawned).toHaveLength(2)
    expect(spawned[0]!.proc.killed).toBe(true)
  })

  test('does not publish a forward stopped before spawn', async () => {
    let releasePort!: (port: number) => void
    const portBarrier = new Promise<number>((resolve) => (releasePort = resolve))
    const spawned: FakeProc[] = []
    let portRequested = false
    const manager = new PortForwardManager('tau-sandboxes-test', {
      findFreePort: () => {
        portRequested = true
        return portBarrier
      },
      spawn: () => {
        const proc = makeFakeProc()
        spawned.push(proc)
        return proc as unknown as Subprocess
      },
      probeReady: async () => true,
    })

    const ensuring = manager.ensureExecutorForward('squad_abc', 'tau-sb-old')
    while (!portRequested) await Promise.resolve()
    manager.stopForSandbox('squad_abc')
    releasePort(50100)

    await expect(ensuring).rejects.toThrow('stopped')
    expect(spawned).toHaveLength(0)
    expect(manager.getDiagnostics()).toEqual({ tracked: 0, live: 0, starting: 0, admissionOwners: 0 })
  })

  test('stopAll invalidates a forward still waiting to spawn', async () => {
    let releasePort!: (port: number) => void
    const portBarrier = new Promise<number>((resolve) => (releasePort = resolve))
    const spawned: FakeProc[] = []
    let portRequested = false
    const manager = new PortForwardManager('tau-sandboxes-test', {
      findFreePort: () => {
        portRequested = true
        return portBarrier
      },
      spawn: () => {
        const proc = makeFakeProc()
        spawned.push(proc)
        return proc as unknown as Subprocess
      },
      probeReady: async () => true,
    })

    const ensuring = manager.ensureExecutorForward('squad_abc', 'tau-sb-old')
    while (!portRequested) await Promise.resolve()
    manager.stopAll()
    releasePort(50100)

    await expect(ensuring).rejects.toThrow('stopped')
    expect(spawned).toHaveLength(0)
    expect(manager.getDiagnostics()).toEqual({ tracked: 0, live: 0, starting: 0, admissionOwners: 0 })
  })

  test('reaps a naturally exited forward', async () => {
    const { manager, spawned } = makeManager()
    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')

    spawned[0]!.proc.resolveExit(0)
    await spawned[0]!.proc.exited
    await Promise.resolve()

    expect(manager.getDiagnostics()).toEqual({ tracked: 0, live: 0, starting: 0, admissionOwners: 0 })
  })

  test('releases admission owners after many normally completed ensures', async () => {
    const { manager } = makeManager({ ports: Array.from({ length: 25 }, (_, index) => 50100 + index) })

    for (let index = 0; index < 25; index++) {
      await manager.ensureExecutorForward(`squad_${index}`, `tau-sb-${index}`)
    }

    expect(manager.getDiagnostics().admissionOwners).toBe(0)
  })

  test('releases admission owners after normally failed ensures', async () => {
    const procs = Array.from({ length: 15 }, () => makeFakeProc({ exitCode: 1 }))
    const { manager } = makeManager({
      ports: Array.from({ length: 15 }, (_, index) => 50200 + index),
      procs,
    })

    for (let index = 0; index < 5; index++) {
      await expect(manager.ensureExecutorForward(`failed_${index}`, `ficus-failed-${index}`)).rejects.toThrow()
    }

    expect(manager.getDiagnostics().admissionOwners).toBe(0)
  })

  test('keeps concurrent app and executor admissions cancellable as one sandbox owner', async () => {
    let releasePort!: (port: number) => void
    const portBarrier = new Promise<number>((resolve) => (releasePort = resolve))
    let portRequests = 0
    const manager = new PortForwardManager('tau-sandboxes-test', {
      findFreePort: () => {
        portRequests++
        return portBarrier
      },
      spawn: () => makeFakeProc() as unknown as Subprocess,
      probeReady: async () => true,
    })

    const executor = manager.ensureExecutorForward('squad_abc', 'tau-sb-abc')
    const app = manager.ensureAppForward('squad_abc', 'tau-sb-abc', 5173)
    for (let attempt = 0; attempt < 100 && portRequests === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(portRequests).toBeGreaterThan(0)
    expect(manager.getDiagnostics().admissionOwners).toBe(1)
    manager.stopForSandbox('squad_abc')
    const settled = Promise.allSettled([executor, app])
    releasePort(50300)

    const results = await settled
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    for (const result of results) {
      if (result.status === 'rejected') expect(String(result.reason)).toContain('stopped')
    }
    expect(manager.getDiagnostics()).toEqual({ tracked: 0, live: 0, starting: 0, admissionOwners: 0 })
  })

  test('reuses a live forward instead of spawning a second process', async () => {
    const { manager, spawned } = makeManager()

    const first = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    const second = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')

    expect(second).toBe(first)
    expect(spawned).toHaveLength(1)
  })

  test('re-spawns when the previous forward process has died', async () => {
    const { manager, spawned } = makeManager()

    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    spawned[0]!.proc.exitCode = 1

    const port = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')

    expect(spawned).toHaveLength(2)
    expect(port).toBe(50101)
  })

  test('retries with a fresh port when an attempt fails, killing the failed process', async () => {
    const dead = makeFakeProc({ exitCode: 1 })
    const { manager, spawned } = makeManager({ procs: [dead, makeFakeProc()] })

    const port = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')

    expect(spawned).toHaveLength(2)
    expect(port).toBe(50101)
  })

  test('kills a still-running process whose forward never becomes ready, then retries', async () => {
    const stuck = makeFakeProc()
    const { manager, spawned } = makeManager({
      procs: [stuck, makeFakeProc()],
      // First attempt never becomes ready (times out); second succeeds.
      probeReady: async (procs) => procs.length >= 2,
    })

    const port = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')

    expect(stuck.killed).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(port).toBe(50101)
  })

  test('throws after exhausting attempts and leaves no tracked forward behind', async () => {
    const procs = [makeFakeProc({ exitCode: 1 }), makeFakeProc({ exitCode: 1 }), makeFakeProc({ exitCode: 1 })]
    const { manager } = makeManager({ procs })

    await expect(manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')).rejects.toThrow('exited with code 1')
    expect(manager.getActiveExecutorPort('squad_abc')).toBeNull()
  })

  test('executor and app forwards for the same sandbox coexist under separate keys', async () => {
    const { manager, spawned } = makeManager()

    const executorPort = await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    const appPort = await manager.ensureAppForward('squad_abc', 'tau-sb-squad-abc', 5173)

    expect(spawned).toHaveLength(2)
    expect(executorPort).toBe(50100)
    expect(appPort).toBe(50101)
    expect(spawned[1]!.args).toContain('50101:5173')
  })

  test('stopForSandbox kills executor and app forwards for that sandbox only', async () => {
    const { manager, spawned } = makeManager()

    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    await manager.ensureAppForward('squad_abc', 'tau-sb-squad-abc', 5173)
    await manager.ensureExecutorForward('squad_xyz', 'tau-sb-squad-xyz')

    manager.stopForSandbox('squad_abc')

    expect(spawned[0]!.proc.killed).toBe(true)
    expect(spawned[1]!.proc.killed).toBe(true)
    expect(spawned[2]!.proc.killed).toBe(false)
    expect(manager.getActiveExecutorPort('squad_abc')).toBeNull()
    expect(manager.getActiveExecutorPort('squad_xyz')).toBe(50102)
  })

  test('stopForSandbox does not stop forwards of a sandbox sharing an id prefix', async () => {
    const { manager, spawned } = makeManager()

    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    await manager.ensureExecutorForward('squad_abcdef', 'tau-sb-squad-abcdef')

    manager.stopForSandbox('squad_abc')

    expect(spawned[0]!.proc.killed).toBe(true)
    expect(spawned[1]!.proc.killed).toBe(false)
  })

  test('stopAll kills every forward', async () => {
    const { manager, spawned } = makeManager()

    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    await manager.ensureAppForward('squad_xyz', 'tau-sb-squad-xyz', 8080)

    manager.stopAll()

    expect(spawned.every((s) => s.proc.killed)).toBe(true)
    expect(manager.getActiveExecutorPort('squad_abc')).toBeNull()
  })

  test('getActiveExecutorPort returns null once the process dies', async () => {
    const { manager, spawned } = makeManager()

    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    expect(manager.getActiveExecutorPort('squad_abc')).toBe(50100)

    spawned[0]!.proc.exitCode = 1
    expect(manager.getActiveExecutorPort('squad_abc')).toBeNull()
  })

  test('findActiveExecutorPortByPod matches only live executor forwards for that pod', async () => {
    const { manager, spawned } = makeManager()

    await manager.ensureAppForward('squad_abc', 'tau-sb-squad-abc', 5173)
    expect(manager.findActiveExecutorPortByPod('tau-sb-squad-abc')).toBeNull()

    await manager.ensureExecutorForward('squad_abc', 'tau-sb-squad-abc')
    expect(manager.findActiveExecutorPortByPod('tau-sb-squad-abc')).toBe(50101)

    spawned[1]!.proc.exitCode = 1
    expect(manager.findActiveExecutorPortByPod('tau-sb-squad-abc')).toBeNull()
  })
})
