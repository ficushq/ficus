import { describe, test, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DockerSandboxManager,
  buildManagedToolchainDirPrefix,
  waitForDockerExec,
  isSysboxAvailable,
  isSocketModeAvailable,
  selectRuntime,
  getRuntimeInfo,
  clearRuntimeCache,
  parseDockerExitCode,
  buildDockerLogsArgs,
  resolveDockerApiUrl,
  terminalApiUrlArgs,
  resolveReclaimableNixStorePath,
  reclaimAgentNixStore,
  ensureNixStore,
  ensureNixBase,
  computeDockerSpecHash,
  DOCKER_SANDBOX_SHM_SIZE,
  SPEC_HASH_LABEL,
  type SandboxRuntime,
} from './manager'
import { computeDockerSpecDigest } from './runtime-contract'
import { buildBashrcContent } from '../bashrc'
import type { SandboxOptions } from '../types'
import { observeSandboxSetupProgress, type SandboxSetupProgressEvent } from '../setup-progress'

describe('DockerSandboxManager generation-fenced stop', () => {
  test('preserves generation B from stale A and stops only exact B', async () => {
    const state = { sandboxId: 'agent_x', containerId: 'requested-b' }
    const sandboxes = new Map([['agent_x', state]])
    const lifecycleCalls: string[][] = []
    const self = {
      sandboxes,
      containerName: () => 'tau-sandbox-agent_x',
      proveContainerOwnership: () => 'immutable-b',
      getContainerLabel: () => 'generation-b',
      releaseSandboxState: () => sandboxes.delete('agent_x'),
      runLifecycleDocker: (args: string[]) => {
        lifecycleCalls.push(args)
        return { exitCode: 0, stderr: Buffer.alloc(0) }
      },
      inspectContainerRunning: () => 'stopped',
    }

    await expect(
      DockerSandboxManager.prototype.stopSandbox.call(self as any, 'agent_x', {
        lifecycleGeneration: 'generation-a',
      })
    ).resolves.toEqual({ kind: 'generation-mismatch', actualLifecycleGeneration: 'generation-b' })
    expect(lifecycleCalls).toEqual([])
    expect(sandboxes.has('agent_x')).toBe(true)

    await expect(
      DockerSandboxManager.prototype.stopSandbox.call(self as any, 'agent_x', {
        lifecycleGeneration: 'generation-b',
      })
    ).resolves.toEqual({ kind: 'stopped' })
    expect(lifecycleCalls).toHaveLength(1)
    expect(sandboxes.has('agent_x')).toBe(false)
  })
})

describe('buildDockerLogsArgs', () => {
  test('defaults to 500 tail lines and follow', () => {
    expect(buildDockerLogsArgs('tau-sandbox-x', {})).toEqual(['logs', '--tail', '500', '-f', 'tau-sandbox-x'])
  })
  test('clamps tail lines into [1, 5000]', () => {
    expect(buildDockerLogsArgs('c', { tailLines: 99999 })).toEqual(['logs', '--tail', '5000', '-f', 'c'])
    expect(buildDockerLogsArgs('c', { tailLines: 0 })).toEqual(['logs', '--tail', '1', '-f', 'c'])
  })
  test('omits -f when follow is false', () => {
    expect(buildDockerLogsArgs('c', { tailLines: 10, follow: false })).toEqual(['logs', '--tail', '10', 'c'])
  })
})

describe('resolveReclaimableNixStorePath', () => {
  const originalHomeDir = process.env.HOME_DIR
  let homeDir: string

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ficus-nix-home-'))
    process.env.HOME_DIR = homeDir
  })

  afterEach(() => {
    if (originalHomeDir === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = originalHomeDir
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it('resolves only canonical personal agent Nix stores', () => {
    const id = crypto.randomUUID()
    expect(resolveReclaimableNixStorePath(`agent_${id}`)).toBe(path.join(homeDir, 'nix', `agent_${id}`))

    for (const protectedId of ['squad_abc', 'system_manager_abc', 'agent_../squad_abc', 'agent_not-a-uuid']) {
      expect(() => resolveReclaimableNixStorePath(protectedId)).toThrow()
    }
  })
})

describe('ensureNixStore (shared base + clone)', () => {
  const originalHomeDir = process.env.HOME_DIR
  let homeDir: string
  let dockerCalls: string[][]

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ficus-nix-seed-'))
    process.env.HOME_DIR = homeDir
    dockerCalls = []
  })

  afterEach(() => {
    if (originalHomeDir === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = originalHomeDir
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  // docker commands are simulated (the `docker cp` writes a marker file into
  // its target so the seeded base has real content); everything else (cp/chown)
  // runs for real so the clone strategy is exercised on the actual filesystem.
  const spawnSync = (args: string[]) => {
    if (args[0] === 'docker') {
      dockerCalls.push(args)
      if (args[1] === 'cp') {
        const target = args[3]!
        fs.mkdirSync(path.join(target, 'store'), { recursive: true })
        fs.writeFileSync(path.join(target, 'store', 'seed-marker'), 'base-content')
      }
      return { exitCode: 0, stderr: Buffer.alloc(0) }
    }
    const real = Bun.spawnSync(args, { stdout: 'ignore', stderr: 'pipe' })
    return { exitCode: real.exitCode, stderr: real.stderr }
  }

  it('seeds the shared base once and clones it into each sandbox store', () => {
    const a = `agent_${crypto.randomUUID()}`
    const b = `agent_${crypto.randomUUID()}`

    const pathA = ensureNixStore(a, { spawnSync })
    expect(fs.readFileSync(path.join(pathA, 'store', 'seed-marker'), 'utf-8')).toBe('base-content')
    expect(fs.existsSync(path.join(homeDir, 'nix', '.base', 'store', 'seed-marker'))).toBe(true)
    const dockerAfterFirst = dockerCalls.length
    expect(dockerCalls.some((c) => c[1] === 'cp')).toBe(true)

    const pathB = ensureNixStore(b, { spawnSync })
    expect(fs.readFileSync(path.join(pathB, 'store', 'seed-marker'), 'utf-8')).toBe('base-content')
    // Second sandbox reuses the seeded base: zero additional docker work.
    expect(dockerCalls.length).toBe(dockerAfterFirst)
  })

  it('shares file inodes with the base on linux (hardlink clone)', () => {
    if (process.platform !== 'linux') return // darwin uses APFS clones (new inode, shared blocks)
    const store = ensureNixStore(`agent_${crypto.randomUUID()}`, { spawnSync })
    const baseIno = fs.statSync(path.join(homeDir, 'nix', '.base', 'store', 'seed-marker')).ino
    const cloneIno = fs.statSync(path.join(store, 'store', 'seed-marker')).ino
    expect(cloneIno).toBe(baseIno)
  })

  it('isolates mutable Nix state while sharing immutable store content', () => {
    ensureNixStore(`agent_${crypto.randomUUID()}`, { spawnSync })
    const baseMutable = path.join(homeDir, 'nix', '.base', 'var', 'nix', 'db.sqlite')
    fs.mkdirSync(path.dirname(baseMutable), { recursive: true })
    fs.writeFileSync(baseMutable, 'base-state')

    const a = ensureNixStore(`agent_${crypto.randomUUID()}`, { spawnSync })
    const b = ensureNixStore(`agent_${crypto.randomUUID()}`, { spawnSync })
    fs.writeFileSync(path.join(a, 'var', 'nix', 'db.sqlite'), 'sandbox-a-state')

    expect(fs.readFileSync(baseMutable, 'utf-8')).toBe('base-state')
    expect(fs.readFileSync(path.join(b, 'var', 'nix', 'db.sqlite'), 'utf-8')).toBe('base-state')
  })

  it('cleans partial mutable state when its copy fails', () => {
    const base = path.join(homeDir, 'nix', '.base')
    const store = path.join(homeDir, 'nix', `agent_${crypto.randomUUID()}`)
    fs.mkdirSync(path.join(base, 'store'), { recursive: true })
    fs.writeFileSync(path.join(base, 'store', 'seed'), 'store')
    fs.mkdirSync(path.join(base, 'var'), { recursive: true })
    fs.writeFileSync(path.join(base, 'var', 'state'), 'mutable')
    fs.mkdirSync(store, { recursive: true })

    expect(() =>
      ensureNixStore(path.basename(store), {
        copySync: () => {
          fs.writeFileSync(path.join(store, 'partial'), 'partial')
          throw new Error('disk full')
        },
      })
    ).toThrow('disk full')
    expect(fs.existsSync(store)).toBe(false)

    expect(ensureNixStore(path.basename(store), { spawnSync })).toBe(store)
    expect(fs.readFileSync(path.join(store, 'store', 'seed'), 'utf-8')).toBe('store')
    expect(fs.readFileSync(path.join(store, 'var', 'state'), 'utf-8')).toBe('mutable')
  })

  it('cleans a failed clone so a later initialization retry succeeds', () => {
    const id = `agent_${crypto.randomUUID()}`
    const store = path.join(homeDir, 'nix', id)
    const failingClone = (args: string[]) => {
      if (args[0] === 'cp') return { exitCode: 1, stderr: Buffer.from('clone failed') }
      return spawnSync(args)
    }

    expect(() => ensureNixStore(id, { spawnSync: failingClone })).toThrow('Failed to clone immutable Nix store')
    expect(fs.existsSync(store)).toBe(false)

    expect(ensureNixStore(id, { spawnSync })).toBe(store)
    expect(fs.readFileSync(path.join(store, 'store', 'seed-marker'), 'utf-8')).toBe('base-content')
  })

  it('leaves an already-initialized store untouched', () => {
    const id = `agent_${crypto.randomUUID()}`
    const store = path.join(homeDir, 'nix', id)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'existing'), 'keep')

    const resolved = ensureNixStore(id, { spawnSync })
    expect(resolved).toBe(store)
    expect(dockerCalls).toEqual([])
    expect(fs.readFileSync(path.join(store, 'existing'), 'utf-8')).toBe('keep')
  })

  it('re-seeds a base that exists but is empty', () => {
    fs.mkdirSync(path.join(homeDir, 'nix', '.base'), { recursive: true })
    ensureNixBase({ spawnSync })
    expect(fs.existsSync(path.join(homeDir, 'nix', '.base', 'store', 'seed-marker'))).toBe(true)
  })

  it('the shared base is never reclaimable', () => {
    expect(() => resolveReclaimableNixStorePath('.base')).toThrow()
  })
})

describe('reclaimAgentNixStore', () => {
  const originalHomeDir = process.env.HOME_DIR
  let homeDir: string
  let nixRoot: string
  let sandboxId: string

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ficus-nix-home-'))
    nixRoot = path.join(homeDir, 'nix')
    sandboxId = `agent_${crypto.randomUUID()}`
    process.env.HOME_DIR = homeDir
  })

  afterEach(() => {
    if (originalHomeDir === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = originalHomeDir
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  const result = (exitCode = 0, stdout = '', stderr = '') => ({
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  })

  it('does nothing when the exact store is missing', () => {
    const commands: string[][] = []
    reclaimAgentNixStore(sandboxId, {
      spawnSync: (args) => {
        commands.push(args)
        return result()
      },
    })
    expect(commands).toEqual([])
  })

  it('refuses a symlinked store without invoking Docker', () => {
    fs.mkdirSync(nixRoot, { recursive: true })
    fs.symlinkSync(os.tmpdir(), path.join(nixRoot, sandboxId))
    const commands: string[][] = []

    expect(() => reclaimAgentNixStore(sandboxId, { spawnSync: (args) => (commands.push(args), result()) })).toThrow(
      'symlink'
    )
    expect(commands).toEqual([])
  })

  it('refuses storage reclamation when the container is running', () => {
    const store = path.join(nixRoot, sandboxId)
    fs.mkdirSync(store, { recursive: true })
    const commands: string[][] = []

    expect(() =>
      reclaimAgentNixStore(sandboxId, { spawnSync: (args) => (commands.push(args), result(0, 'true\n')) })
    ).toThrow('running')
    expect(commands).toEqual([['docker', 'inspect', '-f', '{{.State.Running}}', `tau-sandbox-${sandboxId}`]])
  })

  it('refuses storage reclamation when container state is unknown', () => {
    const store = path.join(nixRoot, sandboxId)
    fs.mkdirSync(store, { recursive: true })

    expect(() => reclaimAgentNixStore(sandboxId, { spawnSync: () => result(1, '', 'Docker unavailable') })).toThrow(
      'state is unknown'
    )
  })

  it('uses one exact-path root helper for an absent container and removes the emptied store', () => {
    const store = path.join(nixRoot, sandboxId)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'owned-by-root'), 'content')
    const commands: string[][] = []

    reclaimAgentNixStore(sandboxId, {
      spawnSync: (args) => {
        commands.push(args)
        if (args[1] === 'inspect') return result(1, '', 'No such object')
        fs.rmSync(path.join(store, 'owned-by-root'))
        return result()
      },
    })

    expect(commands).toEqual([
      ['docker', 'inspect', '-f', '{{.State.Running}}', `tau-sandbox-${sandboxId}`],
      [
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        '/bin/sh',
        '--user',
        '0',
        '-v',
        `${store}:/target`,
        'tau-sandbox:latest',
        '-c',
        'find /target -mindepth 1 -delete',
      ],
    ])
    expect(fs.existsSync(store)).toBe(false)
  })

  it('uses the helper for a stopped container and is a no-op after success', () => {
    const store = path.join(nixRoot, sandboxId)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'content'), 'content')
    const commands: string[][] = []
    const spawnSync = (args: string[]) => {
      commands.push(args)
      if (args[1] === 'inspect') return result(0, 'false')
      fs.rmSync(path.join(store, 'content'))
      return result()
    }

    reclaimAgentNixStore(sandboxId, { spawnSync })
    reclaimAgentNixStore(sandboxId, { spawnSync })

    expect(commands).toHaveLength(2)
    expect(commands[0]).toEqual(['docker', 'inspect', '-f', '{{.State.Running}}', `tau-sandbox-${sandboxId}`])
    expect(commands[1]?.[1]).toBe('run')
  })

  it('propagates helper failures and leaves the store intact', () => {
    const store = path.join(nixRoot, sandboxId)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'content'), 'content')

    expect(() =>
      reclaimAgentNixStore(sandboxId, {
        spawnSync: (args) => (args[1] === 'inspect' ? result(0, 'false') : result(1, '', 'permission denied')),
      })
    ).toThrow('permission denied')
    expect(fs.existsSync(store)).toBe(true)
  })
})

describe('computeDockerSpecHash', () => {
  const original = process.env.FICUS_SANDBOX_RUNTIME

  beforeEach(() => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    clearRuntimeCache()
  })

  afterEach(() => {
    if (original === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = original
    clearRuntimeCache()
  })

  const baseOpts: SandboxOptions = {
    workspacePath: '/host/ws',
    privateVolumePath: '/host/private/agent_x',
    volumes: ['/a:/a:ro', '/b:/b', '/c:/c:ro'],
    env: { FICUS_API_URL: 'http://host.docker.internal:3000', GITHUB_TOKEN: 'tok-1' },
  }

  it('is stable and identical across reordered keys AND reordered volumes AND changed env (anti-loop)', () => {
    const reordered: SandboxOptions = {
      // keys in a different order
      env: { GITHUB_TOKEN: 'tok-2-DIFFERENT', FICUS_API_URL: 'http://host.docker.internal:9999-DIFFERENT' },
      volumes: ['/c:/c:ro', '/a:/a:ro', '/b:/b'], // reordered
      privateVolumePath: '/host/private/agent_x',
      workspacePath: '/host/ws',
      // Policy input, not a spec input — must NOT affect the hash (else the
      // deferred-recreate gate would itself churn the container).
      hasActiveSession: true,
    }
    // Env churn (dynamic Core port, GitHub token) and volume/key ordering must
    // NOT change the hash — otherwise the stamped label never matches the next
    // ensure and containers recreate forever.
    expect(computeDockerSpecHash(reordered)).toBe(computeDockerSpecHash(baseOpts))
  })

  it('changes when a volume mount changes', () => {
    const mutated: SandboxOptions = { ...baseOpts, volumes: ['/a:/a:ro', '/b:/b', '/c:/c:rw'] }
    expect(computeDockerSpecHash(mutated)).not.toBe(computeDockerSpecHash(baseOpts))
  })

  it('changes when the lifecycle resource generation changes', () => {
    expect(computeDockerSpecHash({ ...baseOpts, lifecycleGeneration: 'generation-b' })).not.toBe(
      computeDockerSpecHash({ ...baseOpts, lifecycleGeneration: 'generation-a' })
    )
  })

  it('changes when the workspace or private mount changes', () => {
    expect(computeDockerSpecHash({ ...baseOpts, workspacePath: '/host/other' })).not.toBe(
      computeDockerSpecHash(baseOpts)
    )
    expect(computeDockerSpecHash({ ...baseOpts, privateVolumePath: '/host/private/other' })).not.toBe(
      computeDockerSpecHash(baseOpts)
    )
  })

  it('is a full digest and changes when a mutable tag resolves to a new immutable image', () => {
    const first = {
      imageReference: 'tau-sandbox:latest',
      imageId: `sha256:${'a'.repeat(64)}`,
      runtimeContractVersion: 1 as const,
      executorProtocolVersion: 1 as const,
    }
    const rebuilt = { ...first, imageId: `sha256:${'b'.repeat(64)}` }
    expect(computeDockerSpecHash(baseOpts, first)).toMatch(/^[0-9a-f]{64}$/)
    expect(computeDockerSpecHash(baseOpts, first)).not.toBe(computeDockerSpecHash(baseOpts, rebuilt))
  })
})

describe('docker --shm-size=512m (browser parity, Phase 2)', () => {
  const managerSrc = fs.readFileSync(path.join(import.meta.dir, 'manager.ts'), 'utf8')

  function funcBody(name: string): string {
    const start = managerSrc.indexOf(`private async ${name}(`)
    if (start === -1) throw new Error(`could not find ${name} in manager.ts`)
    // Body runs up to the next private-method declaration (good enough to scope
    // the create-arg array to this one function).
    const rest = managerSrc.slice(start + name.length)
    const next = rest.indexOf('\n  private ')
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('the shm-size constant is 512m', () => {
    expect(DOCKER_SANDBOX_SHM_SIZE).toBe('512m')
  })

  // Chromium needs a bigger /dev/shm than Docker's 64 MB default, so both
  // container-create paths must pass --shm-size=<the constant>.
  it('createSysboxContainer passes --shm-size', () => {
    const body = funcBody('createSysboxContainer')
    expect(body).toContain('--shm-size=${DOCKER_SANDBOX_SHM_SIZE}')
  })

  it('createSocketContainer passes --shm-size', () => {
    const body = funcBody('createSocketContainer')
    expect(body).toContain('--shm-size=${DOCKER_SANDBOX_SHM_SIZE}')
  })

  // The shm size is a create-immutable input: an existing container that lacks
  // it must drift-recreate, so it MUST fold into computeDockerSpecDigest.
  it('shmSize is part of the hashed spec digest (drift recreates)', () => {
    const base = {
      imageReference: 'tau-sandbox:latest',
      imageId: `sha256:${'a'.repeat(64)}`,
      runtimeContractVersion: 1 as const,
      executorProtocolVersion: 1 as const,
      commandIdentityFingerprint: 'image:image',
      runtime: 'docker-socket',
      workspacePath: '/host/ws',
      privateVolumePath: null,
      squadId: null,
      volumes: [],
    }
    expect(computeDockerSpecDigest({ ...base, shmSize: '512m' })).not.toBe(
      computeDockerSpecDigest({ ...base, shmSize: '64m' })
    )
  })
})

describe('ensureSandbox spec-hash drift detection', () => {
  const original = process.env.FICUS_SANDBOX_RUNTIME

  beforeEach(() => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    clearRuntimeCache()
  })

  afterEach(() => {
    if (original === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = original
    clearRuntimeCache()
  })

  const opts: SandboxOptions = {
    workspacePath: '/host/ws',
    volumes: ['/cli:/usr/local/bin/ficus:ro'],
    env: { FICUS_API_URL: 'http://host.docker.internal:3000' },
  }

  // A minimal fake `this` covering only the seams ensureSandbox touches on the
  // reuse/recreate decision. Docker CLI calls (create/remove) are recorded, not
  // executed; createSocketContainer throws a sentinel so the post-create tail
  // (git/devbox/setup) never runs.
  function fakeManager(overrides: Record<string, unknown>) {
    const created: string[] = []
    const removed: string[] = []
    const base = {
      sandboxes: new Map<string, unknown>(),
      containerName: (id: string) => `tau-sandbox-${id}`,
      isContainerRunning: () => true,
      getExistingContainer: () => null,
      resolveImageContract: () => ({
        imageReference: 'tau-sandbox:latest',
        imageId: 'unresolved:tau-sandbox:latest',
        runtimeContractVersion: 1,
        executorProtocolVersion: 1,
        commandContractVersion: 1,
      }),
      resetStaleSandboxStatus: async () => {},
      tryAcquireSandboxLock: async () => true,
      waitForSandboxReady: async () => {},
      ensureBashrc: () => {},
      connectExecutor: async () => {},
      connectActiveDrift: async () => {},
      markSandboxReady: async () => {},
      removeSandbox: async (id: string) => {
        removed.push(id)
      },
      createSocketContainer: async () => {
        created.push('socket')
        throw new Error('CREATE_SENTINEL')
      },
      createSysboxContainer: async () => {
        created.push('sysbox')
        throw new Error('CREATE_SENTINEL')
      },
    }
    return { self: { ...base, ...overrides }, created, removed }
  }

  const ensure = (self: unknown, id: string, o: SandboxOptions) =>
    DockerSandboxManager.prototype.ensureSandbox.call(self as DockerSandboxManager, id, o)

  it('(a) reuses an in-memory container with matching spec-hash — no recreate', async () => {
    const hash = computeDockerSpecHash(opts)
    const { self, created, removed } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1' }]]),
      getContainerSpecHash: () => hash,
    })

    await expect(ensure(self, 's', opts)).resolves.toBe('c1')
    expect(created).toEqual([])
    expect(removed).toEqual([])
  })

  it('does not report setup for a running connected container with a matching spec', async () => {
    const hash = computeDockerSpecHash(opts)
    const { self } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1', client: {} }]]),
      getContainerSpecHash: () => hash,
    })
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))

    await ensure(self, 's', opts)

    expect(events).toEqual([])
  })

  it('reports failed spec reconciliation when drift recreation fails', async () => {
    const staleHash = computeDockerSpecHash({ ...opts, volumes: ['/old:/old:ro'] })
    const { self } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1', client: {} }]]),
      getContainerSpecHash: () => staleHash,
    })
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))

    await expect(ensure(self, 's', opts)).rejects.toThrow('CREATE_SENTINEL')

    expect(events.map((event) => event.type)).toEqual(['started', 'finished'])
    expect(events[0]).toMatchObject({ reason: 'spec_reconcile' })
    expect(events[1]).toMatchObject({ outcome: 'failed' })
  })

  it('reports failed runtime_start when cold container creation fails', async () => {
    const { self } = fakeManager({})
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))

    await expect(ensure(self, 's', opts)).rejects.toThrow('CREATE_SENTINEL')

    expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_start' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'failed' })
  })

  it('reports reconnect when a matching running container is missing its client', async () => {
    const hash = computeDockerSpecHash(opts)
    let connects = 0
    const { self } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1' }]]),
      getContainerSpecHash: () => hash,
      connectExecutor: async () => void connects++,
    })
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))

    await expect(ensure(self, 's', opts)).resolves.toBe('c1')

    expect(connects).toBe(1)
    expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_reconnect' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  it('(b) recreates an in-memory container whose spec drifted (volume changed)', async () => {
    const staleHash = computeDockerSpecHash({ ...opts, volumes: ['/old:/old:ro'] })
    const { self, created, removed } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1' }]]),
      getContainerSpecHash: () => staleHash,
    })
    // Sanity: the desired hash really differs from the stale stamp.
    expect(staleHash).not.toBe(computeDockerSpecHash(opts))

    await expect(ensure(self, 's', opts)).rejects.toThrow('CREATE_SENTINEL')
    expect(removed).toEqual(['s'])
    expect(created).toEqual(['socket'])
  })

  it('(c) recreates a discovered container with a missing spec-hash label (pre-upgrade)', async () => {
    const { self, created, removed } = fakeManager({
      getExistingContainer: () => 'oldc',
      getContainerSpecHash: () => null, // pre-upgrade container: no label
    })

    await expect(ensure(self, 's', opts)).rejects.toThrow('CREATE_SENTINEL')
    expect(removed).toEqual(['s'])
    expect(created).toEqual(['socket'])
  })

  it('adopts a discovered container whose spec-hash matches — no recreate', async () => {
    const hash = computeDockerSpecHash(opts)
    const { self, created, removed } = fakeManager({
      getExistingContainer: () => 'okc',
      getContainerSpecHash: () => hash,
    })
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))

    await expect(ensure(self, 's', opts)).resolves.toBe('okc')
    expect(created).toEqual([])
    expect(removed).toEqual([])
    expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_reconnect' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  it('starts and adopts a stopped matching container as runtime_start', async () => {
    const hash = computeDockerSpecHash(opts)
    const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 0 } as any)
    const { self } = fakeManager({
      getExistingContainer: () => 'stopped',
      getContainerSpecHash: () => hash,
      isContainerRunning: () => false,
    })
    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))
    try {
      await expect(ensure(self, 's', opts)).resolves.toBe('stopped')
      expect(spawn).toHaveBeenCalledWith(['docker', 'start', 'stopped'], expect.anything())
      expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_start' })
      expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
    } finally {
      spawn.mockRestore()
    }
  })

  it('no-create attachment adopts an existing container and never creates an absent one', async () => {
    const existing = fakeManager({ getExistingContainer: () => 'existing' })
    const memberOpts = { ...opts, squadId: 'squad-1', privateVolumePath: '/host/private/agent-1' }
    await expect(
      DockerSandboxManager.prototype.attachExistingSandbox.call(
        existing.self as unknown as DockerSandboxManager,
        'agent-1',
        memberOpts
      )
    ).resolves.toBe(true)
    expect(existing.created).toEqual([])
    expect((existing.self.sandboxes as Map<string, any>).get('agent-1')).toMatchObject({
      squadId: 'squad-1',
      privateVolumePath: '/host/private/agent-1',
    })

    const start = spyOn(Bun, 'spawnSync')
    const stopped = fakeManager({ getExistingContainer: () => 'stopped', isContainerRunning: () => false })
    await expect(
      DockerSandboxManager.prototype.attachExistingSandbox.call(
        stopped.self as unknown as DockerSandboxManager,
        'stopped',
        opts
      )
    ).resolves.toBe(false)
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()

    const absent = fakeManager({ getExistingContainer: () => null })
    await expect(
      DockerSandboxManager.prototype.attachExistingSandbox.call(
        absent.self as unknown as DockerSandboxManager,
        's',
        opts
      )
    ).resolves.toBe(false)
    expect(absent.created).toEqual([])
  })

  it('the create-time label uses computeDockerSpecHash so stamp and check agree', () => {
    // The label the create path stamps and the value ensure compares against are
    // one function over one config — the anti-loop invariant, by construction.
    expect(SPEC_HASH_LABEL).toBe('tau.spec-hash')
    expect(computeDockerSpecHash(opts)).toBe(computeDockerSpecHash({ ...opts }))
  })

  // Idle/session gate (parity with the k8s drift-recreate gate in ensure.ts):
  // on hash drift, an active session DEFERS the recreate and reuses the box;
  // recreation happens on a later ensure once idle.
  it('(d) defers recreate on in-memory drift when a session is active — reuses, no recreate', async () => {
    const staleHash = computeDockerSpecHash({ ...opts, volumes: ['/old:/old:ro'] })
    const { self, created, removed } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1', client: {} }]]),
      getContainerSpecHash: () => staleHash,
    })

    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))
    await expect(ensure(self, 's', { ...opts, hasActiveSession: true })).resolves.toBe('c1')
    expect(created).toEqual([])
    expect(removed).toEqual([])
    expect(events).toEqual([])
  })

  it('(e) defers recreate on a discovered drifted container when a session is active — adopts', async () => {
    const staleHash = computeDockerSpecHash({ ...opts, volumes: ['/old:/old:ro'] })
    const { self, created, removed } = fakeManager({
      getExistingContainer: () => 'driftc',
      getContainerSpecHash: () => staleHash,
    })

    const events: SandboxSetupProgressEvent[] = []
    observeSandboxSetupProgress(self as any, 's', (event) => events.push(event))
    await expect(ensure(self, 's', { ...opts, hasActiveSession: true })).resolves.toBe('driftc')
    expect(created).toEqual([])
    expect(removed).toEqual([])
    expect(events[0]).toMatchObject({ type: 'started', reason: 'runtime_reconnect' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
  })

  it('(f) stale-hash + active defers, then a later idle ensure recreates', async () => {
    const staleHash = computeDockerSpecHash({ ...opts, volumes: ['/old:/old:ro'] })
    const { self, created, removed } = fakeManager({
      sandboxes: new Map([['s', { containerId: 'c1' }]]),
      getContainerSpecHash: () => staleHash,
    })

    // Active session: defer the recreate, reuse the drifted box.
    await expect(ensure(self, 's', { ...opts, hasActiveSession: true })).resolves.toBe('c1')
    expect(removed).toEqual([])
    expect(created).toEqual([])

    // Idle (no active session): the deferred drift is now reconciled.
    await expect(ensure(self, 's', { ...opts, hasActiveSession: false })).rejects.toThrow('CREATE_SENTINEL')
    expect(removed).toEqual(['s'])
    expect(created).toEqual(['socket'])
  })
})

describe('ensureSandbox: a container created without the /usr/local/bin/ficus mount', () => {
  const original = process.env.FICUS_SANDBOX_RUNTIME
  beforeEach(() => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
    clearRuntimeCache()
  })
  afterEach(() => {
    if (original === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = original
    clearRuntimeCache()
  })

  // What ensure.ts asks for now, and the stamp of a container a pre-ficus Core created (its CLI
  // mount lived elsewhere, so the ficus mount is absent from the stamped volume list).
  const desired: SandboxOptions = {
    workspacePath: '/host/ws',
    volumes: ['/core/apps/cli/dist/ficus.js:/usr/local/bin/ficus:ro', '/ext:/ext:ro'],
  }
  const staleStamp = computeDockerSpecHash({
    ...desired,
    volumes: ['/core/apps/cli/dist/old.js:/usr/local/bin/old:ro', '/ext:/ext:ro'],
  })

  function fake(existing: { tracked?: boolean }) {
    const created: string[] = []
    const removed: string[] = []
    const self = {
      sandboxes: new Map<string, unknown>(existing.tracked ? [['s', { containerId: 'old', client: {} }]] : []),
      containerName: (id: string) => `sandbox-${id}`,
      isContainerRunning: () => true,
      getExistingContainer: () => (existing.tracked ? null : 'old'),
      getContainerSpecHash: () => staleStamp,
      resolveImageContract: () => ({
        imageReference: 'sandbox:latest',
        imageId: 'unresolved:sandbox:latest',
        runtimeContractVersion: 1,
        executorProtocolVersion: 1,
        commandContractVersion: 1,
      }),
      resetStaleSandboxStatus: async () => {},
      tryAcquireSandboxLock: async () => true,
      waitForSandboxReady: async () => {},
      ensureBashrc: () => {},
      connectExecutor: async () => {},
      connectActiveDrift: async () => {},
      markSandboxReady: async () => {},
      removeSandbox: async (id: string) => void removed.push(id),
      createSocketContainer: async () => {
        created.push('socket')
        throw new Error('CREATE_SENTINEL')
      },
      createSysboxContainer: async () => {
        created.push('sysbox')
        throw new Error('CREATE_SENTINEL')
      },
    }
    return { self, created, removed }
  }
  const ensure = (self: unknown, o: SandboxOptions) =>
    DockerSandboxManager.prototype.ensureSandbox.call(self as DockerSandboxManager, 's', o)

  it('(g) is recreated with the ficus mount when idle (tracked or discovered after a Core restart)', async () => {
    expect(staleStamp).not.toBe(computeDockerSpecHash(desired))
    for (const tracked of [true, false]) {
      const { self, created, removed } = fake({ tracked })
      await expect(ensure(self, { ...desired, hasActiveSession: false })).rejects.toThrow('CREATE_SENTINEL')
      expect(removed).toEqual(['s'])
      expect(created).toEqual(['socket'])
    }
  })

  it('(g) is kept as-is while a session is running, then recreated on the next idle ensure', async () => {
    for (const tracked of [true, false]) {
      const { self, created, removed } = fake({ tracked })
      await expect(ensure(self, { ...desired, hasActiveSession: true })).resolves.toBe('old')
      expect(removed).toEqual([])
      expect(created).toEqual([])
    }
    const { self, created, removed } = fake({ tracked: true })
    await ensure(self, { ...desired, hasActiveSession: true })
    await expect(ensure(self, { ...desired, hasActiveSession: false })).rejects.toThrow('CREATE_SENTINEL')
    expect(removed).toEqual(['s'])
    expect(created).toEqual(['socket'])
  })
})

describe('managed Docker execution safety', () => {
  it('kills and classifies a process that exceeds its deadline', async () => {
    let resolveExit!: (code: number) => void
    let killed = false
    const proc = {
      exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      kill: () => {
        killed = true
        resolveExit(143)
      },
    }
    expect(await waitForDockerExec(proc, 1)).toEqual({ exitCode: 124, timedOut: true })
    expect(killed).toBe(true)
  })

  it('rejects a real ancestor-directory symlink before creating managed files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-ancestor-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-outside-'))
    fs.symlinkSync(outside, path.join(root, '.tau'))
    const command = `${buildManagedToolchainDirPrefix(root)}touch .ready`
    const result = Bun.spawnSync(['bash', '-lc', command], { stdout: 'ignore', stderr: 'ignore' })
    expect(result.exitCode).not.toBe(0)
    expect(fs.existsSync(path.join(outside, 'toolchain'))).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('docker-sandbox-manager', () => {
  const manager = new DockerSandboxManager()

  describe('managed toolchain reconciliation', () => {
    const sandboxId = 'toolchain-test'
    let workspacePath: string
    let originalExecStatus: typeof manager.execStatus
    let originalExecToolchainStatus: typeof manager.execToolchainStatus
    let originalEnsureBashrc: (...args: any[]) => void

    beforeEach(() => {
      workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-toolchain-'))
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-socket',
        workspaceMount: '/workspace',
      })
      originalExecStatus = manager.execStatus.bind(manager)
      originalExecToolchainStatus = manager.execToolchainStatus.bind(manager)
      originalEnsureBashrc = (manager as any).ensureBashrc
      ;(manager as any).ensureBashrc = () => {}
    })

    afterEach(() => {
      manager.execStatus = originalExecStatus
      manager.execToolchainStatus = originalExecToolchainStatus
      ;(manager as any).ensureBashrc = originalEnsureBashrc
      ;(manager as any).sandboxes.delete(sandboxId)
      fs.rmSync(workspacePath, { recursive: true, force: true })
    })

    it('classifies a bounded install expiry as timeout without publishing readiness', async () => {
      manager.execToolchainStatus = async (_id, args) => {
        const command = args.join(' ')
        if (command.includes('cat --')) return { exitCode: 1, timedOut: false }
        if (command.includes('devbox install')) return { exitCode: 124, timedOut: true }
        return { exitCode: 0, timedOut: false }
      }
      await expect(
        manager.reconcileToolchain(
          sandboxId,
          { workspacePath },
          {
            config: { packages: ['python3@latest'] },
            fingerprint: 'a'.repeat(64),
            devboxJson: '{}',
            reportStage: async () => {},
          }
        )
      ).rejects.toMatchObject({ code: 'timeout' })
    })

    it('reports failed toolchain reconciliation when activation fails', async () => {
      const commands: string[] = []
      const progress: SandboxSetupProgressEvent[] = []
      const unsubscribe = observeSandboxSetupProgress(manager, sandboxId, (event) => progress.push(event))
      manager.execToolchainStatus = async (_id, args) => {
        const command = args.join(' ')
        commands.push(command)
        if (command.includes('cat --')) return { exitCode: 1, timedOut: false }
        if (command.includes('devbox shellenv')) return { exitCode: 1, timedOut: false }
        return { exitCode: 0, timedOut: false }
      }
      await expect(
        manager.reconcileToolchain(
          sandboxId,
          { workspacePath },
          {
            config: { packages: ['python3@latest'] },
            fingerprint: 'a'.repeat(64),
            devboxJson: '{"packages":["python3@latest"]}',
            reportStage: async () => {},
          }
        )
      ).rejects.toMatchObject({ code: 'activation_failed' })
      expect(fs.existsSync(path.join(workspacePath, '.tau', 'toolchain', '.ready'))).toBe(false)
      expect(commands.some((command) => command.includes('devbox install'))).toBe(true)
      expect(commands.at(-1)).toContain('devbox shellenv')
      expect(progress[0]).toMatchObject({ type: 'started', reason: 'toolchain_reconcile' })
      expect(progress.at(-1)).toMatchObject({ type: 'finished', outcome: 'failed' })
      unsubscribe()
    })

    it('emits no progress for a current fingerprint and reports drift through completion', async () => {
      let markerCurrent = true
      const progress: SandboxSetupProgressEvent[] = []
      const unsubscribe = observeSandboxSetupProgress(manager, sandboxId, (event) => progress.push(event))
      manager.execToolchainStatus = async (_id, args) => {
        const command = args.join(' ')
        if (command.includes('test "$(cat -- .ready')) {
          return { exitCode: markerCurrent ? 0 : 1, timedOut: false }
        }
        return { exitCode: 0, timedOut: false }
      }
      const request = {
        config: { packages: ['python3@latest'] },
        fingerprint: 'a'.repeat(64),
        devboxJson: '{}',
        reportStage: async () => {},
      }

      await expect(manager.reconcileToolchain(sandboxId, { workspacePath }, request)).resolves.toBe('unchanged')
      expect(progress).toEqual([])

      markerCurrent = false
      await expect(manager.reconcileToolchain(sandboxId, { workspacePath }, request)).resolves.toBe('applied')
      expect(progress[0]).toMatchObject({ type: 'started', reason: 'toolchain_reconcile' })
      expect(progress.at(-1)).toMatchObject({ type: 'finished', outcome: 'ready' })
      unsubscribe()
    })

    it('refreshes activation for an unchanged fingerprint and clears without mutating project devbox files', async () => {
      const dir = path.join(workspacePath, '.tau', 'toolchain')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '.ready'), `${'a'.repeat(64)}\n`)
      fs.writeFileSync(path.join(workspacePath, 'devbox.json'), 'project-owned')
      manager.execToolchainStatus = async (_id, args) => {
        const command = args.join(' ')
        if (command.includes('cat --')) return { exitCode: 0, timedOut: false }
        if (command.includes('devbox install')) throw new Error('unchanged and clear must not install Devbox')
        if (command.includes('devbox shellenv')) return { exitCode: 0, timedOut: false }
        return { exitCode: 0, timedOut: false }
      }
      expect(
        await manager.reconcileToolchain(
          sandboxId,
          { workspacePath },
          {
            config: { packages: ['python3@latest'] },
            fingerprint: 'a'.repeat(64),
            devboxJson: '{}',
            reportStage: async () => {},
          }
        )
      ).toBe('unchanged')
      expect(
        await manager.reconcileToolchain(
          sandboxId,
          { workspacePath },
          {
            reportStage: async () => {},
          }
        )
      ).toBe('cleared')
      expect(fs.readFileSync(path.join(workspacePath, 'devbox.json'), 'utf8')).toBe('project-owned')
      // The fake container command does not mutate the host fixture; verify only
      // that project-owned configuration was never touched by Core.
      expect(fs.readFileSync(path.join(dir, '.ready'), 'utf8')).toBe(`${'a'.repeat(64)}\n`)
    })

    it('never follows sandbox-controlled managed-file symlinks on the host', async () => {
      const dir = path.join(workspacePath, '.tau', 'toolchain')
      const outside = path.join(workspacePath, '..', `outside-${Date.now()}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(outside, 'do-not-overwrite')
      fs.symlinkSync(outside, path.join(dir, 'devbox.json'))
      const commands: string[] = []
      manager.execToolchainStatus = async (_id, args) => {
        const command = args.join(' ')
        commands.push(command)
        return { exitCode: command.includes('cat --') ? 1 : 0, timedOut: false }
      }

      await manager.reconcileToolchain(
        sandboxId,
        { workspacePath },
        {
          config: { packages: ['python3@latest'] },
          fingerprint: 'b'.repeat(64),
          devboxJson: '{"packages":["python3@latest"]}',
          reportStage: async () => {},
        }
      )

      expect(fs.readFileSync(outside, 'utf8')).toBe('do-not-overwrite')
      expect(commands.some((command) => command.includes('mv -fT'))).toBe(true)
      fs.rmSync(outside, { force: true })
    })
  })

  describe('parseDockerExitCode', () => {
    it('parses integer exit codes', () => {
      expect(parseDockerExitCode('137\n')).toBe(137)
      expect(parseDockerExitCode('0')).toBe(0)
    })

    it('returns undefined for empty or non-integer output', () => {
      expect(parseDockerExitCode('')).toBeUndefined()
      expect(parseDockerExitCode('not-a-number')).toBeUndefined()
    })
  })

  describe('toContainerPath', () => {
    const sandboxId = 'test-path-translation'
    const workspacePath = '/home/user/.tau/data/workspaces/abc123'

    beforeEach(async () => {
      // Manually inject a fake sandbox entry for path translation tests
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: '/workspace',
      })
    })

    afterEach(() => {
      ;(manager as any).sandboxes.delete(sandboxId)
    })

    it('should translate workspace root to /workspace', () => {
      expect(manager.toContainerPath(sandboxId, workspacePath)).toBe('/workspace')
    })

    it('should translate a file inside workspace', () => {
      expect(manager.toContainerPath(sandboxId, `${workspacePath}/src/index.ts`)).toBe('/workspace/src/index.ts')
    })

    it('should translate nested paths', () => {
      expect(manager.toContainerPath(sandboxId, `${workspacePath}/a/b/c/d.txt`)).toBe('/workspace/a/b/c/d.txt')
    })

    it('should reject paths outside workspace', () => {
      expect(() => manager.toContainerPath(sandboxId, '/etc/passwd')).toThrow('outside workspace')
    })

    it('should reject parent traversal', () => {
      expect(() => manager.toContainerPath(sandboxId, `${workspacePath}/../other`)).toThrow('outside workspace')
    })

    it('should throw for unknown sandbox', () => {
      expect(() => manager.toContainerPath('nonexistent', workspacePath)).toThrow('No sandbox found')
    })
  })

  describe('getLocalDeploymentTarget', () => {
    const sandboxId = 'test-local-deployment-target'
    const workspacePath = '/home/user/.tau/data/workspaces/abc123'

    afterEach(() => {
      ;(manager as any).sandboxes.delete(sandboxId)
    })

    it('throws for unknown sandbox', async () => {
      await expect(manager.getLocalDeploymentTarget('nonexistent', 5173)).rejects.toThrow('No sandbox found')
    })

    it('returns the container IP and requested port', async () => {
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: '/workspace',
      })
      ;(manager as any).getContainerIp = () => '172.18.0.42'

      await expect(manager.getLocalDeploymentTarget(sandboxId, 5173)).resolves.toEqual({
        host: '172.18.0.42',
        port: 5173,
      })
    })
  })

  describe('getSandboxRuntime', () => {
    const sandboxId = 'test-runtime'
    const workspacePath = '/home/user/.tau/data/workspaces/abc123'

    afterEach(() => {
      ;(manager as any).sandboxes.delete(sandboxId)
    })

    it('should return null for unknown sandbox', () => {
      expect(manager.getSandboxRuntime('nonexistent')).toBe(null)
    })

    it('should return the runtime for a known sandbox', () => {
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-sysbox' as SandboxRuntime,
        workspaceMount: '/workspace',
      })
      expect(manager.getSandboxRuntime(sandboxId)).toBe('docker-sysbox')
    })
  })

  describe('runtime detection', () => {
    const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    beforeEach(() => {
      clearRuntimeCache()
    })

    afterEach(() => {
      clearRuntimeCache()
      // Clean up env vars
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    })

    /**
     * Force `isSysboxAvailable()` to report "not installed" regardless of the
     * host running the suite: on Linux the probe shells out to `docker info`,
     * so a non-zero exit is the honest "no sysbox here" answer; on macOS the
     * platform check short-circuits before the spawn.
     */
    function pretendSysboxMissing(): () => void {
      const spy = spyOn(Bun, 'spawnSync').mockImplementation(
        () => ({ exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }) as any
      )
      clearRuntimeCache()
      return () => spy.mockRestore()
    }

    it('isSysboxAvailable returns false on non-Linux', () => {
      // This test will pass on macOS/Windows and may vary on Linux
      // depending on whether sysbox is installed
      const result = isSysboxAvailable()
      expect(typeof result).toBe('boolean')
    })

    it('isSocketModeAvailable checks if Docker is running', () => {
      const result = isSocketModeAvailable()
      expect(typeof result).toBe('boolean')
    })

    it('selectRuntime respects FICUS_SANDBOX_RUNTIME=docker-socket', () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      clearRuntimeCache()
      expect(selectRuntime()).toBe('docker-socket')
    })

    it('selectRuntime throws for docker-sysbox when sysbox is not installed (no silent socket fallback)', () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-sysbox'
      const restore = pretendSysboxMissing()
      try {
        expect(() => selectRuntime()).toThrow(
          'docker-sysbox requested but the sysbox runtime is not installed on this host'
        )
      } finally {
        restore()
      }
    })

    it('selectRuntime throws on an unknown runtime value instead of auto-detecting', () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'unknown-runtime'
      clearRuntimeCache()
      expect(() => selectRuntime()).toThrow(
        'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host (got "unknown-runtime")'
      )
    })

    it('selectRuntime throws for the legacy "socket" spelling, naming the replacement', () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'socket'
      clearRuntimeCache()
      expect(() => selectRuntime()).toThrow('Use docker-socket.')
    })

    it('selectRuntime throws when FICUS_SANDBOX_RUNTIME is unset', () => {
      delete process.env.FICUS_SANDBOX_RUNTIME
      clearRuntimeCache()
      expect(() => selectRuntime()).toThrow(
        'FICUS_SANDBOX_RUNTIME must be one of docker-sysbox, docker-socket, k8s, vm, host (is unset)'
      )
    })

    it('getRuntimeInfo returns platform info', () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      clearRuntimeCache()
      const info = getRuntimeInfo()
      expect(info).toHaveProperty('runtime')
      expect(info).toHaveProperty('sysboxAvailable')
      expect(info).toHaveProperty('platform')
      expect(info.runtime).toBe('docker-socket')
      expect(typeof info.sysboxAvailable).toBe('boolean')
      expect(typeof info.platform).toBe('string')
    })

    it('clearRuntimeCache resets cached values', () => {
      process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
      // First call caches the value
      expect(selectRuntime()).toBe('docker-socket')
      // A changed env var is ignored until the cache is cleared
      process.env.FICUS_SANDBOX_RUNTIME = 'bogus'
      expect(selectRuntime()).toBe('docker-socket')
      clearRuntimeCache()
      expect(() => selectRuntime()).toThrow('FICUS_SANDBOX_RUNTIME must be one of')
    })
  })

  describe('workspaceMount seam', () => {
    const sandboxId = 'test-workspace-mount-seam'
    const workspacePath = '/host/ws'

    beforeEach(() => {
      // Inject a sandbox state with a non-default workspaceMount to prove
      // consumers follow the per-sandbox stored value, not the global constant.
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: '/custom-mount',
      })
    })

    afterEach(() => {
      ;(manager as any).sandboxes.delete(sandboxId)
    })

    it('toContainerPath uses per-sandbox workspaceMount, not the global constant', () => {
      // With workspaceMount: '/custom-mount', the container path should be
      // '/custom-mount/sub/file.ts', NOT '/workspace/sub/file.ts'
      expect(manager.toContainerPath(sandboxId, `${workspacePath}/sub/file.ts`)).toBe('/custom-mount/sub/file.ts')
    })

    it('buildBashrcContent interpolates the provided workspaceMount for .env sourcing', () => {
      // workspacePath has no devbox.json so the function only emits the .env line
      const content = buildBashrcContent(workspacePath, '/custom-mount')
      expect(content).toContain('/custom-mount/.tau/.env')
      expect(content).not.toContain('/workspace/.tau/.env')
    })
  })

  describe('getSpawnHook working-dir seam', () => {
    const spawnHookSandboxId = 'test-spawn-hook-seam'
    const spawnHookWorkspaceMount = '/custom-mount'
    let tmpWorkspacePath: string

    beforeEach(() => {
      tmpWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ficus-hook-test-'))
      ;(manager as any).sandboxes.set(spawnHookSandboxId, {
        containerId: 'fake-container',
        workspacePath: tmpWorkspacePath,
        sandboxId: spawnHookSandboxId,
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: spawnHookWorkspaceMount,
      })
    })

    afterEach(() => {
      ;(manager as any).sandboxes.delete(spawnHookSandboxId)
      fs.rmSync(tmpWorkspacePath, { recursive: true, force: true })
    })

    it('uses sandbox.workspaceMount as -w arg, not the global WORKSPACE_MOUNT constant', () => {
      const hook = manager.getSpawnHook(spawnHookSandboxId, tmpWorkspacePath)
      expect(hook).not.toBeNull()
      const result = hook!({ command: 'echo hello', cwd: tmpWorkspacePath, env: {} })
      // The docker exec command must carry the per-sandbox mount, not /workspace.
      expect(result.command).toContain(`-w ${spawnHookWorkspaceMount}`)
      expect(result.command).not.toContain('-w /workspace')
    })

    it('injects the live Core URL so the `tau` CLI survives a Core port change', () => {
      const hook = manager.getSpawnHook(spawnHookSandboxId, tmpWorkspacePath)
      const result = hook!({ command: 'ficus whoami', cwd: tmpWorkspacePath, env: {} })
      expect(result.command).toContain(`-e FICUS_API_URL=${resolveDockerApiUrl()}`)
    })

    it('gives the interactive terminal the live Core URL under the FICUS_ name only', () => {
      expect(terminalApiUrlArgs('http://host.docker.internal:3000')).toBe(
        '-e FICUS_API_URL=http://host.docker.internal:3000'
      )
    })

    it('injects the FICUS_ identity names only', () => {
      const hook = manager.getSpawnHook(spawnHookSandboxId, tmpWorkspacePath, 'ficus_agent_x')
      const result = hook!({ command: 'ficus whoami', cwd: tmpWorkspacePath, env: {} })
      expect(result.command).toContain('-e FICUS_TOKEN=ficus_agent_x')
      expect(result.command).not.toMatch(/-e [A-Z]+_TOKEN=ficus_agent_x.*-e [A-Z]+_TOKEN=/)
    })
  })

  describe('squad workspace namespacing', () => {
    let squadWorkspacePath: string

    beforeEach(() => {
      squadWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ficus-squad-test-'))
    })

    afterEach(() => {
      ;(manager as any).sandboxes.delete('squad_sq1')
      fs.rmSync(squadWorkspacePath, { recursive: true, force: true })
    })

    it('namespaces a squad sandbox workspace + carries memoryMount', () => {
      const manager = new DockerSandboxManager()
      ;(manager as any).sandboxes.set('squad_sq1', {
        containerId: 'c1',
        workspacePath: squadWorkspacePath,
        sandboxId: 'squad_sq1',
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: '/workspace/sq1',
        memoryMount: '/memory/sq1',
        squadId: 'sq1',
      })
      const hook = manager.getSpawnHook('squad_sq1', squadWorkspacePath)
      const result = hook!({ command: 'echo hi', cwd: squadWorkspacePath, env: {} })
      expect(result.command).toContain('-w /workspace/sq1')
      expect(result.command).not.toContain('-w /workspace ')
      // The script written to disk (inside workspaceMount/.tmp/) sources the squad-namespaced .env
      const tmpDir = path.join(squadWorkspacePath, '.tmp')
      const scripts = fs.readdirSync(tmpDir)
      const scriptContent = fs.readFileSync(path.join(tmpDir, scripts[0]!), 'utf-8')
      expect(scriptContent).toContain('/workspace/sq1/.tau/.env')
    })
  })

  describe('SandboxState squadId and privateVolumePath fields', () => {
    // NOTE: The -v mount and identity args run through Bun.spawnSync (no mock),
    // so we cannot assert the Docker CLI args without a real daemon.
    // These tests verify state-level storage and that existing methods still work
    // when the new fields are present or absent.
    const sandboxId = 'test-state-private-fields'
    const workspacePath = '/home/user/.tau/data/workspaces/state-test'

    afterEach(() => {
      ;(manager as any).sandboxes.delete(sandboxId)
    })

    it('carries squadId and privateVolumePath when provided', () => {
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: '/workspace',
        squadId: 'test-squad-id',
        privateVolumePath: '/host/private/agent_engineer_abc',
      })
      const state = (manager as any).sandboxes.get(sandboxId)
      expect(state.squadId).toBe('test-squad-id')
      expect(state.privateVolumePath).toBe('/host/private/agent_engineer_abc')
      // State-reading methods continue to work with the new fields present
      // (hasSandbox is not usable here — it calls isContainerRunning which needs Docker)
      expect(manager.getSandboxRuntime(sandboxId)).toBe('docker-socket')
    })

    it('leaves squadId and privateVolumePath absent when not provided', () => {
      ;(manager as any).sandboxes.set(sandboxId, {
        containerId: 'fake-container',
        workspacePath,
        sandboxId,
        runtime: 'docker-socket' as SandboxRuntime,
        workspaceMount: '/workspace',
      })
      const state = (manager as any).sandboxes.get(sandboxId)
      expect(state.squadId).toBeUndefined()
      expect(state.privateVolumePath).toBeUndefined()
      // State-reading methods still work when optional fields are absent
      expect(manager.getSandboxRuntime(sandboxId)).toBe('docker-socket')
    })
  })
})
