import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { chmodSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { SandboxClient } from '../k8s/http-client'
import { computeDockerSpecDigest, parseDockerImageContract } from './runtime-contract'
import { removeOwnedDockerContainers, runOwnedDocker } from './docker-test-runtime'
const enabled = process.env.FICUS_DOCKER_RUNTIME_INTEGRATION === '1'
const owner = process.env.FICUS_DOCKER_TEST_OWNER ?? 'disabled'
const image = process.env.FICUS_SANDBOX_IMAGE ?? 'tau-sandbox:latest'

function startArgs(name: string, extra: string[] = []): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `tau.test-owner=${owner}`,
    '-p',
    '127.0.0.1::50051',
    '-e',
    'FICUS_HOST_UID=12345',
    '-e',
    'FICUS_HOST_GID=12346',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    ...extra,
    image,
  ]
}

async function startReady(name: string): Promise<{ token: string; port: string; health: any }> {
  expect(runOwnedDocker(startArgs(name), owner).exitCode).toBe(0)
  let token = ''
  let port = ''
  let health: Response | undefined
  for (let attempt = 0; attempt < 150; attempt++) {
    token = runOwnedDocker(['exec', name, 'cat', '/run/tau/executor-token'], owner).stdout.toString().trim()
    port =
      runOwnedDocker(['port', name, '50051/tcp'], owner)
        .stdout.toString()
        .trim()
        .match(/127\.0\.0\.1:(\d+)$/)?.[1] ?? ''
    if (port) health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)
    if (token && health?.ok) break
    await Bun.sleep(100)
  }
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(port).toMatch(/^\d+$/)
  expect(health?.ok).toBe(true)
  return { token, port, health: await health!.json() }
}

async function expectExited(name: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const running = runOwnedDocker(['inspect', '-f', '{{.State.Running}}', name], owner)
    if (running.exitCode === 0 && running.stdout.toString().trim() === 'false') return
    await Bun.sleep(100)
  }
  throw new Error(`owned fixture ${name} did not exit`)
}

describe.skipIf(!enabled)('Docker runtime identity integration', () => {
  afterEach(() => removeOwnedDockerContainers(owner))

  test('fresh image negotiates exact identity, auth, proxy, and Bun contract', async () => {
    const name = `tau-runtime-${owner}`
    const upstreamBefore = runOwnedDocker(['exec', name, 'true'], owner) // command shape sanity before fixture exists
    expect(upstreamBefore.exitCode).not.toBe(0)
    const ready = await startReady(name)
    expect(runOwnedDocker(['exec', name, 'bun', '--version'], owner).stdout.toString().trim()).toBe('1.3.8')
    const inspect = runOwnedDocker(['inspect', '-f', '{{json .Config.Env}}', name], owner)
    expect(inspect.stdout.toString()).not.toContain('EXECUTOR_AUTH_TOKEN=')
    expect(ready.health).toMatchObject({
      runtimeContract: { runtime: 'docker', commandIdentity: { user: 'tau', uid: 12345, gid: 12346, source: 'host' } },
    })
    expect(
      runOwnedDocker(['exec', name, 'stat', '-c', '%a:%U:%G', '/run/tau-docker/docker.sock'], owner)
        .stdout.toString()
        .trim()
    ).toBe('600:tau:tau')
    expect(
      runOwnedDocker(
        ['exec', name, 'su-exec', 'nobody', 'docker', '-H', 'unix:///run/tau-docker/docker.sock', 'info'],
        owner
      ).exitCode
    ).not.toBe(0)
    const first = new SandboxClient(`127.0.0.1:${ready.port}`, ready.token)
    const adopted = new SandboxClient(`127.0.0.1:${ready.port}`, ready.token)
    expect((await first.health()).runtimeContract?.commandIdentity.uid).toBe(12345)
    expect((await adopted.health()).runtimeContract?.commandIdentity.source).toBe('host')
    first.close()
    adopted.close()
  }, 120_000)

  test('identity collision fails closed before executor/token creation', async () => {
    const name = `tau-collision-${owner}`
    expect(runOwnedDocker(startArgs(name, ['-e', 'FICUS_HOST_GID=20']), owner).exitCode).toBe(0)
    await expectExited(name)
    expect(
      runOwnedDocker(['logs', name], owner).stderr.toString() + runOwnedDocker(['logs', name], owner).stdout.toString()
    ).toContain('collides with the image')
    expect(runOwnedDocker(['exec', name, 'test', '-e', '/run/tau/executor-token'], owner).exitCode).not.toBe(0)
  }, 30_000)

  test.each([['socat'], ['executor']])(
    '%s death terminates the supervised container',
    async (child) => {
      const name = `tau-death-${child}-${owner}`
      await startReady(name)
      const pidFile = child === 'socat' ? '/run/tau/proxy.pid' : '/run/tau/executor.pid'
      const pid = runOwnedDocker(['exec', name, 'cat', pidFile], owner).stdout.toString().trim()
      expect(pid).toMatch(/^[1-9][0-9]*$/)
      const killed = runOwnedDocker(['exec', name, 'kill', '-TERM', pid], owner)
      expect(killed.exitCode).toBe(0)
      await expectExited(name)
    },
    30_000
  )

  test('old/missing executor fixture has no token or health endpoint', async () => {
    const name = `tau-old-${owner}`
    const started = runOwnedDocker(
      ['run', '-d', '--name', name, '--label', `tau.test-owner=${owner}`, '--entrypoint', 'sleep', image, '60'],
      owner
    )
    expect(started.exitCode).toBe(0)
    expect(runOwnedDocker(['exec', name, 'test', '-e', '/run/tau/executor-token'], owner).exitCode).not.toBe(0)
    expect(runOwnedDocker(['port', name, '50051/tcp'], owner).stdout.toString().trim()).toBe('')
  })

  test('real wrong-label image fails and same-tag immutable rebuild changes the spec', () => {
    const name = `tau-image-drift-${owner}`
    const tag = `tau-runtime-drift:${owner}`
    let wrongId = ''
    try {
      expect(
        runOwnedDocker(
          ['run', '-d', '--name', name, '--label', `tau.test-owner=${owner}`, '--entrypoint', 'sleep', image, '60'],
          owner
        ).exitCode
      ).toBe(0)
      expect(
        runOwnedDocker(
          [
            'commit',
            '--change',
            `LABEL tau.test-owner=${owner}`,
            '--change',
            'LABEL io.hiretau.sandbox.runtime-contract=0',
            name,
            tag,
          ],
          owner
        ).exitCode
      ).toBe(0)
      const wrongInspect = JSON.parse(runOwnedDocker(['image', 'inspect', tag], owner).stdout.toString())
      expect(() => parseDockerImageContract(tag, wrongInspect)).toThrow(
        expect.objectContaining({ code: 'IMAGE_REBUILD_REQUIRED' })
      )
      wrongId = wrongInspect[0].Id as string
      expect(
        runOwnedDocker(
          [
            'commit',
            '--change',
            `LABEL tau.test-owner=${owner}`,
            '--change',
            'LABEL io.hiretau.sandbox.runtime-contract=1',
            name,
            tag,
          ],
          owner
        ).exitCode
      ).toBe(0)
      const currentInspect = JSON.parse(runOwnedDocker(['image', 'inspect', tag], owner).stdout.toString())
      const current = parseDockerImageContract(tag, currentInspect)
      const base = {
        imageReference: tag,
        imageId: wrongId,
        runtimeContractVersion: 1 as const,
        executorProtocolVersion: 1 as const,
        commandIdentityFingerprint: 'identity',
        runtime: 'docker-socket',
        workspacePath: '/workspace',
        privateVolumePath: null,
        squadId: null,
        volumes: [],
        shmSize: '512m',
      }
      expect(computeDockerSpecDigest(base)).not.toBe(computeDockerSpecDigest({ ...base, imageId: current.imageId }))
    } finally {
      runOwnedDocker(['image', 'rm', '-f', tag], owner)
      if (wrongId) {
        runOwnedDocker(['image', 'rm', '-f', wrongId], owner)
        expect(runOwnedDocker(['image', 'inspect', wrongId], owner).exitCode).not.toBe(0)
      }
    }
  }, 120_000)

  test('manager recreates same-tag immutable drift, restart-adopts, and fails closed on lifecycle faults', async () => {
    const mutableTag = `tau-manager-drift:${owner}`
    const sandboxId = `agent_${randomUUID()}`
    const workspace = mkdtempSync(path.join(tmpdir(), 'tau-manager-runtime-'))
    chmodSync(workspace, 0o777)
    const containerName = `tau-sandbox-${sandboxId}`
    let firstImageId = ''
    let secondImageId = ''
    let cleanupManager: any
    const prepare = (manager: any) => {
      manager.tryAcquireSandboxLock = async () => true
      manager.markSandboxReady = async () => {}
      manager.resetStaleSandboxStatus = async () => {}
    }
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    try {
      expect(runOwnedDocker(['image', 'tag', image, mutableTag], owner).exitCode).toBe(0)
      process.env.FICUS_SANDBOX_IMAGE = mutableTag
      const { DockerSandboxManager } = await import('./manager')
      const first = new DockerSandboxManager()
      cleanupManager = first
      prepare(first)
      const firstContainer = await first.ensureSandbox(sandboxId, { workspacePath: workspace })
      firstImageId = runOwnedDocker(['image', 'inspect', '-f', '{{.Id}}', mutableTag], owner).stdout.toString().trim()

      expect(
        runOwnedDocker(['commit', '--change', `LABEL tau.test-owner=${owner}`, firstContainer, mutableTag], owner)
          .exitCode
      ).toBe(0)
      secondImageId = runOwnedDocker(['image', 'inspect', '-f', '{{.Id}}', mutableTag], owner).stdout.toString().trim()
      expect(secondImageId).not.toBe(firstImageId)

      const recreated = new DockerSandboxManager()
      prepare(recreated)
      const recreatedId = await recreated.ensureSandbox(sandboxId, { workspacePath: workspace })
      expect(recreatedId).not.toBe(firstContainer)
      expect(runOwnedDocker(['inspect', '-f', '{{.Image}}', recreatedId], owner).stdout.toString().trim()).toBe(
        secondImageId
      )

      const restarted = new DockerSandboxManager() as any
      prepare(restarted)
      expect(await restarted.ensureSandbox(sandboxId, { workspacePath: workspace })).toBe(recreatedId)

      const actualRun = restarted.runLifecycleDocker.bind(restarted)
      restarted.runLifecycleDocker = (args: string[]) =>
        args[0] === 'stop'
          ? { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('injected stop') }
          : actualRun(args)
      await expect(restarted.stopSandbox(sandboxId)).rejects.toMatchObject({ code: 'STOP_FAILED' })
      expect(restarted.sandboxes.has(sandboxId)).toBe(true)

      restarted.runLifecycleDocker = (args: string[]) =>
        args[0] === 'rm' ? { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : actualRun(args)
      await expect(restarted.removeSandbox(sandboxId)).rejects.toMatchObject({ code: 'REMOVE_FAILED' })
      expect(restarted.sandboxes.has(sandboxId)).toBe(true)

      restarted.runLifecycleDocker = actualRun
      await restarted.removeSandbox(sandboxId)
      expect(runOwnedDocker(['inspect', containerName], owner).exitCode).not.toBe(0)
    } finally {
      runOwnedDocker(['rm', '-f', containerName], owner)
      cleanupManager?.reclaimSandboxStorage(sandboxId)
      runOwnedDocker(['image', 'rm', '-f', mutableTag], owner)
      // firstImageId is the gate's base image and remains owned by the outer fixture.
      if (secondImageId) runOwnedDocker(['image', 'rm', '-f', secondImageId], owner)
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 90_000)

  test('exact owner cleanup leaves a real neighbor alive', () => {
    const neighborOwner = `${owner}-neighbor`
    const name = `tau-neighbor-${owner}`
    try {
      expect(
        runOwnedDocker(
          [
            'run',
            '-d',
            '--name',
            name,
            '--label',
            `tau.test-owner=${neighborOwner}`,
            '--entrypoint',
            'sleep',
            image,
            '60',
          ],
          neighborOwner
        ).exitCode
      ).toBe(0)
      removeOwnedDockerContainers(owner)
      expect(
        runOwnedDocker(['inspect', '-f', '{{.State.Running}}', name], neighborOwner).stdout.toString().trim()
      ).toBe('true')
    } finally {
      removeOwnedDockerContainers(neighborOwner)
    }
  })
})
