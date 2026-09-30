import { describe, it, expect, afterEach } from 'bun:test'
import { waitForDockerReady, dockerRuntimeMode, verifyRootlessDocker } from './docker'

const originalRole = process.env.FICUS_SANDBOX_ROLE
const originalBoxHome = process.env.FICUS_BOX_HOME
const originalDockerHost = process.env.DOCKER_HOST

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore('FICUS_SANDBOX_ROLE', originalRole)
  restore('FICUS_BOX_HOME', originalBoxHome)
  restore('DOCKER_HOST', originalDockerHost)
})

describe('waitForDockerReady', () => {
  it('is a no-op on agent boxes (never spawns dockerd, resolves false fast)', async () => {
    process.env.FICUS_SANDBOX_ROLE = 'agent'
    const start = performance.now()
    const ready = await waitForDockerReady(5_000)
    const elapsedMs = performance.now() - start
    expect(ready).toBe(false)
    // Must short-circuit immediately, not wait on the cap or spawn a daemon.
    expect(elapsedMs).toBeLessThan(1_000)
  })
})

describe('dockerRuntimeMode', () => {
  it("is 'sysbox' when FICUS_BOX_HOME is unset (k8s/local — path byte-identical to pre-box)", () => {
    delete process.env.FICUS_BOX_HOME
    expect(dockerRuntimeMode()).toBe('sysbox')
  })

  it("is 'rootless-box' when FICUS_BOX_HOME is set (vm box)", () => {
    process.env.FICUS_BOX_HOME = '/home/box_abc123'
    expect(dockerRuntimeMode()).toBe('rootless-box')
  })
})

describe('verifyRootlessDocker (vm box path)', () => {
  it('returns false and never probes when DOCKER_HOST is unset (nothing to verify, never spawns)', async () => {
    process.env.FICUS_BOX_HOME = '/home/box_abc123'
    delete process.env.DOCKER_HOST
    let probed = false
    const ready = await verifyRootlessDocker({
      isReady: () => {
        probed = true
        return true
      },
      wait: async () => {
        probed = true
        return true
      },
    })
    expect(ready).toBe(false)
    expect(probed).toBe(false)
  })

  it('returns true immediately when the rootless socket is already ready (no spawn, no wait)', async () => {
    process.env.FICUS_BOX_HOME = '/home/box_abc123'
    process.env.DOCKER_HOST = 'unix:///run/user/4321/docker.sock'
    let waited = false
    const ready = await verifyRootlessDocker({
      isReady: () => true,
      wait: async () => {
        waited = true
        return true
      },
    })
    expect(ready).toBe(true)
    expect(waited).toBe(false)
  })

  it('waits for the daemon to finish its own start, then reports ready', async () => {
    process.env.FICUS_BOX_HOME = '/home/box_abc123'
    process.env.DOCKER_HOST = 'unix:///run/user/4321/docker.sock'
    const ready = await verifyRootlessDocker({
      isReady: () => false,
      wait: async () => true,
    })
    expect(ready).toBe(true)
  })

  it('reports not-ready when the socket never comes up within the wait budget', async () => {
    process.env.FICUS_BOX_HOME = '/home/box_abc123'
    process.env.DOCKER_HOST = 'unix:///run/user/4321/docker.sock'
    const ready = await verifyRootlessDocker({
      isReady: () => false,
      wait: async () => false,
    })
    expect(ready).toBe(false)
  })
})
