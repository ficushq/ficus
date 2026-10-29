import { describe, it, expect, spyOn } from 'bun:test'
import { boxPressureSampler } from './processes'
import { BoxRuntimeHealth, getHealthResponse } from './health'

describe('runtime Docker diagnostics', () => {
  it('shares Docker failure reasons, caches checks, and recovers on a later healthy check', async () => {
    let now = 0
    let available = false
    let probes = 0
    const runtime = new BoxRuntimeHealth({
      now: () => now,
      staleExecReason: () => undefined,
      probeDocker: async () => {
        probes++
        if (!available) throw new Error('Docker is not available in this box')
      },
    })
    await runtime.refresh()
    expect(getHealthResponse({}, runtime)).toMatchObject({
      healthy: true,
      runtimeHealth: { status: 'degraded', reason: 'Docker is not available in this box' },
    })
    await runtime.refresh()
    expect(probes).toBe(1)
    available = true
    now = 30_000
    await runtime.refresh()
    expect(getHealthResponse({}, runtime).runtimeHealth).toEqual({ status: 'ready' })
    expect(probes).toBe(2)
  })

  it('bounds a never-settling Docker probe without blocking health or accumulating clients', async () => {
    let expire!: () => void
    let probes = 0
    let now = 0
    const runtime = new BoxRuntimeHealth({
      now: () => now,
      staleExecReason: () => undefined,
      probeDocker: () => {
        probes++
        return new Promise(() => {})
      },
      scheduleTimeout: (callback) => {
        expire = callback
        return () => {}
      },
    })
    const first = runtime.refresh()
    const second = runtime.refresh()
    expire()
    await Promise.all([first, second])
    expect(runtime.snapshot()).toEqual({ status: 'degraded', reason: 'Docker did not answer within 2s' })
    expect(getHealthResponse({}, runtime)).toMatchObject({
      healthy: true,
      runtimeHealth: { status: 'degraded', reason: 'Docker did not answer within 2s' },
    })
    now = 30_000
    const retry = runtime.refresh()
    // A recovery check is also stuck. Health still serves its latest snapshot.
    expect(getHealthResponse({}, runtime).runtimeHealth.status).toBe('degraded')
    expire()
    await retry
    expect(probes).toBe(1) // Do not accumulate Docker clients while the original is stuck.
  })

  it('does not treat agent boxes without Docker as degraded', async () => {
    const runtime = new BoxRuntimeHealth({
      probeDocker: async () => {},
      staleExecReason: () => undefined,
    })
    runtime.observeContainers({ available: false, reason: 'This box runs no Docker' })
    await runtime.refresh()
    expect(runtime.snapshot()).toEqual({ status: 'ready' })
  })

  it('Processes timeout wins over an older healthy probe and requires a fresh full check to recover', async () => {
    let finish!: () => void
    let stale: string | undefined
    let now = 0
    const runtime = new BoxRuntimeHealth({
      now: () => now,
      staleExecReason: () => stale,
      probeDocker: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const checking = runtime.refresh()
    runtime.observeContainers({ available: false, reason: 'Docker did not answer within 15s' })
    finish()
    await checking
    expect(runtime.snapshot().reason).toBe('Docker did not answer within 15s')
    stale = 'Detached runc exec has been stuck for at least 300s'
    now = 30_000
    await runtime.refresh()
    expect(runtime.snapshot().reason).toBe(stale)
    // Container ps alone cannot clear stale-exec degradation.
    runtime.observeContainers({ available: true, containers: [] })
    expect(runtime.snapshot().status).toBe('degraded')
    stale = undefined
    now = 60_000
    const recovering = runtime.refresh()
    finish()
    await recovering
    expect(runtime.snapshot()).toEqual({ status: 'ready' })
  })
})

describe('getHealthResponse', () => {
  it('should return health info', () => {
    const res = getHealthResponse()
    expect(res.healthy).toBe(true)
    expect(res.version).toBeDefined()
    expect(typeof res.uptimeSeconds).toBe('number')
  })

  it('adds a non-secret runtime contract only for Docker', () => {
    const legacy = getHealthResponse({})
    expect(legacy).not.toHaveProperty('runtimeContract')
    const docker = getHealthResponse({
      EXECUTOR_DOCKER_RUNTIME: '1',
      EXECUTOR_COMMAND_USER: 'ficus',
      EXECUTOR_COMMAND_HOME: '/home/ficus',
      EXECUTOR_COMMAND_UID: '1000',
      EXECUTOR_COMMAND_GID: '1000',
      EXECUTOR_COMMAND_CONTRACT_DIGEST: 'a'.repeat(64),
    })
    expect(docker.runtimeContract).toMatchObject({
      runtime: 'docker',
      version: 1,
      executorProtocol: 1,
      commandIdentity: { user: 'ficus', uid: 1000 },
    })
    expect(JSON.stringify(docker)).not.toContain('TOKEN')
  })
})

it('health forwards the same per-box fields without awaiting sampling or changing liveness', () => {
  const pressure = {
    cpus: 8,
    load: [35, 20, 10] as [number, number, number],
    memTotalMb: 16000,
    memAvailableMb: 4000,
    box: {
      cpuPercent: 20,
      sampleMs: 1000,
      cpuPressureSome: { avg10: 0, avg60: 0, avg300: 0 },
      memoryPressureSome: { avg10: 2, avg60: 1, avg300: 0 },
    },
  }
  const snapshot = spyOn(boxPressureSampler, 'snapshot').mockReturnValue(pressure)
  const refresh = spyOn(boxPressureSampler, 'refresh').mockReturnValue(new Promise(() => {}))
  try {
    const response = getHealthResponse({})
    expect(response.pressure).toBe(pressure)
    expect(response.healthy).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally {
    snapshot.mockRestore()
    refresh.mockRestore()
  }
})
