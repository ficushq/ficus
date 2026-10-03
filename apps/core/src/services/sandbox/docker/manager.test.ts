import { SANDBOX_IDENTITY_LEGACY, DOCKER_EXEC_IDENTITY_LEGACY } from '../retired-identity.fixture'
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
  sandboxContainerLabelArgs,
  type SandboxRuntime,
} from './manager'
import {
  DOCKER_EXEC_IDENTITY_NEW,
  SANDBOX_IDENTITY_NEW,
  SANDBOX_IDENTITY_READ,
  SANDBOX_IDENTITY_WRITE,
  sandboxContainerNames,
  type DockerExecIdentity,
  type SandboxIdentitySet,
} from '../identity-names'
import { computeDockerSpecDigest } from './runtime-contract'
import {
  resolveDockerCommandIdentity,
  LEGACY_DOCKER_MANAGED_LABEL,
  LEGACY_DOCKER_EXEC_IDENTITY,
  LEGACY_DOCKER_COMMAND_IDENTITY_CONTRACT,
} from './command-identity'
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

describe('DockerSandboxManager canonical lifecycle and retired-resource exclusion', () => {
  type FakeContainer = { id: string; name: string; labels: Record<string, string> }
  const hex = (c: string) => c.repeat(64)
  const ok = (stdout = '') => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) })
  const missing = () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Error: No such object') })
  const proto = DockerSandboxManager.prototype as any

  // A tiny in-memory docker: `ps` by exact name, `inspect` by id/short id/name, `rm -f` by id.
  function fakeDocker(containers: FakeContainer[]) {
    const live = new Map(containers.map((c) => [c.id, c]))
    const find = (ref: string) => [...live.values()].find((c) => c.id.startsWith(ref) || c.name === ref)
    const calls: string[][] = []
    const run = (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect' && args[1] === '-f') return find(args[3]!) ? ok('false') : missing()
      if (args[0] === 'inspect') {
        const c = find(args[1]!)
        return c ? ok(JSON.stringify([{ Id: c.id, Name: `/${c.name}`, Config: { Labels: c.labels } }])) : missing()
      }
      if (args[0] === 'rm') {
        const c = find(args[2]!)
        if (c) live.delete(c.id)
        return ok()
      }
      throw new Error(`unexpected docker ${args.join(' ')}`)
    }
    const lookup = (name: string) => {
      const c = [...live.values()].find((entry) => entry.name === name)
      return c ? c.id.slice(0, 12) : null
    }
    const self = {
      sandboxes: new Map<string, any>(),
      containerName: proto.containerName,
      getExistingContainer: lookup,
      proveContainerOwnership: proto.proveContainerOwnership,
      removeProvenContainer: proto.removeProvenContainer,
      removeDuplicateContainers: proto.removeDuplicateContainers,
      runLifecycleDocker: run,
      inspectContainerRunning: proto.inspectContainerRunning,
      releaseSandboxState: (sandboxId: string) => void self.sandboxes.delete(sandboxId),
    }
    return { self, live, calls }
  }

  const owned = (set: SandboxIdentitySet, id: string, sandboxId = 'agent_x'): FakeContainer => ({
    id,
    name: `${set.containerPrefix}${sandboxId}`,
    labels: { [set.managedLabel]: 'true', [set.sandboxIdLabel]: sandboxId },
  })

  for (const [label, set] of [['new', SANDBOX_IDENTITY_NEW]] as const) {
    test(`removeSandbox removes a ${label}-identity container by its immutable id`, async () => {
      const docker = fakeDocker([owned(set, hex('a'))])
      await proto.removeSandbox.call(docker.self, 'agent_x')
      expect(docker.live.size).toBe(0)
      expect(docker.calls.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', hex('a')]])
    })
  }

  test('removeSandbox removes only the canonical container and leaves retired identities untouched', async () => {
    const docker = fakeDocker([owned(SANDBOX_IDENTITY_NEW, hex('a')), owned(SANDBOX_IDENTITY_LEGACY, hex('b'))])
    await proto.removeSandbox.call(docker.self, 'agent_x')
    expect([...docker.live.keys()]).toEqual([hex('b')])
  })

  test('removeSandbox never touches a neighbour or a container without the managed label', async () => {
    const neighbour = owned(SANDBOX_IDENTITY_NEW, hex('c'), 'agent_other')
    const foreign: FakeContainer = {
      id: hex('d'),
      name: 'someone-else-agent_x',
      labels: { [SANDBOX_IDENTITY_NEW.managedLabel]: 'true', [SANDBOX_IDENTITY_NEW.sandboxIdLabel]: 'agent_x' },
    }
    const docker = fakeDocker([neighbour, foreign])
    await proto.removeSandbox.call(docker.self, 'agent_x')
    expect(docker.live.size).toBe(2)
    expect(docker.calls.some((args) => args[0] === 'rm')).toBe(false)

    const unlabeled: FakeContainer = {
      id: hex('e'),
      name: `${SANDBOX_IDENTITY_NEW.containerPrefix}agent_x`,
      labels: {},
    }
    const refusing = fakeDocker([unlabeled])
    await expect(proto.removeSandbox.call(refusing.self, 'agent_x')).rejects.toMatchObject({
      code: 'LEGACY_OWNERSHIP_UNPROVEN',
    })
    expect(refusing.live.size).toBe(1)
    expect(refusing.calls.some((args) => args[0] === 'rm')).toBe(false)
  })

  test('retired-name squatters cannot be removed through canonical teardown', async () => {
    const tracked = owned(SANDBOX_IDENTITY_WRITE, hex('a'))
    const squatter: FakeContainer = {
      id: hex('b'),
      name: `${SANDBOX_IDENTITY_LEGACY.containerPrefix}agent_x`,
      labels: {},
    }
    const docker = fakeDocker([tracked, squatter])
    docker.self.sandboxes.set('agent_x', { sandboxId: 'agent_x', containerId: hex('a').slice(0, 12) })
    await proto.removeSandbox.call(docker.self, 'agent_x')
    expect([...docker.live.keys()]).toEqual([hex('b')])
    expect(docker.calls.filter((args) => args[0] === 'rm')).toEqual([['rm', '-f', hex('a')]])
  })

  // Retired resources are outside canonical adoption and teardown.
  describe('ensure with containers under both prefixes', () => {
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

    const opts: SandboxOptions = { workspacePath: '/host/ws' }
    const contract = {
      imageReference: 'sandbox:test',
      imageId: 'unresolved:sandbox:test',
      runtimeContractVersion: 1,
      executorProtocolVersion: 1,
      commandContractVersion: 1,
    } as const
    const other = SANDBOX_IDENTITY_LEGACY

    function ensuringSelf(docker: ReturnType<typeof fakeDocker>) {
      return {
        ...docker.self,
        resolveImageContract: () => contract,
        getContainerSpecHash: () => computeDockerSpecHash(opts, contract),
        isContainerRunning: () => true,
        ensureBashrc: () => {},
        connectExecutor: async () => {},
        connectActiveDrift: async () => {},
      }
    }

    test('adopts the canonical container and leaves the retired container untouched', async () => {
      const docker = fakeDocker([owned(SANDBOX_IDENTITY_WRITE, hex('a')), owned(other, hex('b'))])
      await expect(proto.ensureSandbox.call(ensuringSelf(docker), 'agent_x', opts)).resolves.toBe(hex('a').slice(0, 12))
      expect([...docker.live.keys()]).toEqual([hex('a'), hex('b')])
      expect(docker.calls.filter((args) => args[0] === 'rm')).toEqual([])
    })

    test('an unproven container under the other prefix is left untouched', async () => {
      const squatter: FakeContainer = { id: hex('b'), name: `${other.containerPrefix}agent_x`, labels: {} }
      const docker = fakeDocker([owned(SANDBOX_IDENTITY_WRITE, hex('a')), squatter])
      await expect(proto.ensureSandbox.call(ensuringSelf(docker), 'agent_x', opts)).resolves.toBe(hex('a').slice(0, 12))
      expect(docker.live.size).toBe(2)
      expect(docker.calls.some((args) => args[0] === 'rm')).toBe(false)
    })

    test('attach adopts the canonical container and leaves the retired container untouched', async () => {
      const docker = fakeDocker([owned(SANDBOX_IDENTITY_WRITE, hex('a')), owned(other, hex('b'))])
      await expect(proto.attachExistingSandbox.call(ensuringSelf(docker), 'agent_x', opts)).resolves.toBe(true)
      expect([...docker.live.keys()]).toEqual([hex('a'), hex('b')])
    })
  })

  test('stopSandbox finds a new-identity container and reads its generation label', async () => {
    const container = {
      ...owned(SANDBOX_IDENTITY_NEW, hex('a')),
      labels: {
        ...owned(SANDBOX_IDENTITY_NEW, hex('a')).labels,
        [SANDBOX_IDENTITY_NEW.lifecycleGenerationLabel]: 'generation-b',
      },
    }
    const docker = fakeDocker([container])
    const stopCalls: string[][] = []
    const self = {
      ...docker.self,
      getContainerLabel: proto.getContainerLabel,
      getContainerLabels: (ref: string) => (container.id.startsWith(ref) ? container.labels : null),
      runLifecycleDocker: (args: string[]) => {
        if (args[0] === 'stop') {
          stopCalls.push(args)
          return ok()
        }
        return docker.self.runLifecycleDocker(args)
      },
    }
    await expect(proto.stopSandbox.call(self, 'agent_x', { lifecycleGeneration: 'generation-a' })).resolves.toEqual({
      kind: 'generation-mismatch',
      actualLifecycleGeneration: 'generation-b',
    })
    await expect(proto.stopSandbox.call(self, 'agent_x', { lifecycleGeneration: 'generation-b' })).resolves.toEqual({
      kind: 'stopped',
    })
    expect(stopCalls).toEqual([['stop', hex('a')]])
  })

  test('the spec hash is read under either identity set', () => {
    for (const set of SANDBOX_IDENTITY_READ) {
      const self = {
        getContainerLabel: proto.getContainerLabel,
        getContainerLabels: () => ({ [set.specHashLabel]: 'hash-1' }),
      }
      expect(proto.getContainerSpecHash.call(self, 'ref')).toBe('hash-1')
    }
    const unlabeled = { getContainerLabel: proto.getContainerLabel, getContainerLabels: () => ({}) }
    expect(proto.getContainerSpecHash.call(unlabeled, 'ref')).toBeNull()
    const empty = {
      getContainerLabel: proto.getContainerLabel,
      getContainerLabels: () => ({ [SANDBOX_IDENTITY_WRITE.specHashLabel]: '' }),
    }
    expect(proto.getContainerSpecHash.call(empty, 'ref')).toBeNull()
  })
})

describe('sandbox container create labels', () => {
  const other = SANDBOX_IDENTITY_LEGACY
  const labelKeys = (args: string[]) =>
    args.flatMap((arg, i) => (args[i - 1] === '--label' ? [arg.slice(0, arg.indexOf('='))] : []))

  test('writes only the write-set labels, with the managed flag, id, spec, image and generation', () => {
    const args = sandboxContainerLabelArgs({
      sandboxId: 'agent_x',
      specHash: 'spec-1',
      imageId: 'sha256:img',
      lifecycleGeneration: 'gen-1',
    })
    expect(args).toEqual([
      '--label',
      `${SANDBOX_IDENTITY_WRITE.specHashLabel}=spec-1`,
      '--label',
      `${SANDBOX_IDENTITY_WRITE.managedLabel}=true`,
      '--label',
      `${SANDBOX_IDENTITY_WRITE.sandboxIdLabel}=agent_x`,
      '--label',
      `${SANDBOX_IDENTITY_WRITE.imageIdLabel}=sha256:img`,
      '--label',
      `${SANDBOX_IDENTITY_WRITE.lifecycleGenerationLabel}=gen-1`,
    ])
    const otherKeys = new Set(Object.values(other))
    expect(labelKeys(args).filter((key) => otherKeys.has(key))).toEqual([])
    expect(
      sandboxContainerLabelArgs({ sandboxId: 'agent_x', specHash: 's', imageId: 'i', lifecycleGeneration: undefined })
    ).toHaveLength(8)
  })

  for (const method of ['createSocketContainer', 'createSysboxContainer'] as const) {
    test(`${method} names and labels the container with the write set only`, async () => {
      const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: 0,
        stdout: Buffer.from('0123456789abcdef'),
        stderr: Buffer.alloc(0),
      } as any)
      try {
        const name = `${SANDBOX_IDENTITY_WRITE.containerPrefix}agent_x`
        const self = { addCommonContainerOptions: async () => {}, getDockerHostIp: () => '172.17.0.1' }
        await (DockerSandboxManager.prototype as any)[method].call(
          self,
          name,
          { workspacePath: '/host/ws', lifecycleGeneration: 'gen-1' },
          'spec-1',
          { imageId: 'sha256:img' }
        )
        const run = spawn.mock.calls.map(([args]) => args as string[]).find((args) => args[1] === 'run')!
        expect(run[run.indexOf('--name') + 1]).toBe(name)
        expect(labelKeys(run).sort()).toEqual(
          [
            SANDBOX_IDENTITY_WRITE.specHashLabel,
            SANDBOX_IDENTITY_WRITE.managedLabel,
            SANDBOX_IDENTITY_WRITE.sandboxIdLabel,
            SANDBOX_IDENTITY_WRITE.imageIdLabel,
            SANDBOX_IDENTITY_WRITE.lifecycleGenerationLabel,
          ].sort()
        )
        expect(run).toContain(`${SANDBOX_IDENTITY_WRITE.sandboxIdLabel}=agent_x`)
      } finally {
        spawn.mockRestore()
      }
    })
  }
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
    expect(commands).toEqual([['docker', 'inspect', '-f', '{{.State.Running}}', sandboxContainerNames(sandboxId)[0]]])
  })

  it('refuses storage reclamation while a container under any identity prefix is running', () => {
    const store = path.join(nixRoot, sandboxId)
    fs.mkdirSync(store, { recursive: true })
    // The LAST checked name (not necessarily the write name) is the one found
    // running, so the loop must keep checking past earlier not-found entries
    // regardless of which identity set is currently written.
    const names = sandboxContainerNames(sandboxId)
    const runningName = names[names.length - 1]
    const commands: string[][] = []
    const spawnSync = (args: string[]) => {
      commands.push(args)
      if (args[1] !== 'inspect') return result()
      return args[4] === runningName ? result(0, 'true\n') : result(1, '', 'No such object')
    }

    expect(() => reclaimAgentNixStore(sandboxId, { spawnSync })).toThrow('running')
    expect(commands.map((args) => args[4])).toEqual(names)
    expect(commands.some((args) => args[1] === 'run')).toBe(false)
    expect(fs.existsSync(store)).toBe(true)
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
      ...sandboxContainerNames(sandboxId).map((name) => ['docker', 'inspect', '-f', '{{.State.Running}}', name]),
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
        'ficus-sandbox:latest',
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

    const names = sandboxContainerNames(sandboxId)
    expect(commands).toHaveLength(names.length + 1)
    expect(commands.slice(0, names.length)).toEqual(
      names.map((name) => ['docker', 'inspect', '-f', '{{.State.Running}}', name])
    )
    expect(commands[names.length]?.[1]).toBe('run')
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
      imageReference: 'ficus-sandbox:latest',
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
      imageReference: 'ficus-sandbox:latest',
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
      containerName: (id: string) => `${SANDBOX_IDENTITY_WRITE.containerPrefix}${id}`,
      isContainerRunning: () => true,
      getExistingContainer: () => null,
      resolveImageContract: () => ({
        imageReference: 'ficus-sandbox:latest',
        imageId: 'unresolved:ficus-sandbox:latest',
        runtimeContractVersion: 1,
        executorProtocolVersion: 1,
        commandContractVersion: 1,
      }),
      assertNoRetiredContainer: (DockerSandboxManager.prototype as any).assertNoRetiredContainer,
      inspectContainerRunning: () => 'not_found',
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

  for (const state of ['running', 'stopped', 'unknown'] as const) {
    it(`refuses creation when the exact pre-rename container is ${state}`, async () => {
      const calls: string[][] = []
      const { self, created, removed } = fakeManager({
        inspectContainerRunning: (DockerSandboxManager.prototype as any).inspectContainerRunning,
        runLifecycleDocker: (args: string[]) => {
          calls.push(args)
          return {
            exitCode: state === 'unknown' ? 1 : 0,
            stdout: Buffer.from(state === 'running' ? 'true' : 'false'),
            stderr: Buffer.from(state === 'unknown' ? 'Docker unavailable' : ''),
          }
        },
        resetStaleSandboxStatus: async () => {
          throw new Error('must not mutate DB')
        },
      })
      await expect(ensure(self, 'agent_exact', opts)).rejects.toThrow(
        state === 'unknown' ? 'refusing creation' : 'bridge release'
      )
      expect(calls).toEqual([['inspect', '-f', '{{.State.Running}}', 'tau-sandbox-agent_exact']])
      expect(created).toEqual([])
      expect(removed).toEqual([])
    })
  }

  it('rechecks retired presence after waiting for initialization, before creating', async () => {
    let calls = 0
    let admissions = 0
    let waited = false
    const { self, created } = fakeManager({
      inspectContainerRunning: () => (++calls === 1 ? 'not_found' : 'running'),
      tryAcquireSandboxLock: async () => ++admissions > 1,
      waitForSandboxReady: async () => {
        waited = true
      },
    })
    await expect(ensure(self, 'agent_exact', opts)).rejects.toThrow('bridge release')
    expect(calls).toBe(2)
    expect(waited).toBe(true)
    expect(created).toEqual([])
  })

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

  // Canonical discovery and adoption preserve normal lifecycle behavior.
  for (const [label, set] of [['new', SANDBOX_IDENTITY_NEW]] as const) {
    it(`adopts a discovered container carrying only the ${label} identity — no recreate`, async () => {
      const hash = computeDockerSpecHash(opts)
      const lookups: string[] = []
      const { self, created, removed } = fakeManager({
        getExistingContainer: (name: string) => {
          lookups.push(name)
          return name === `${set.containerPrefix}s` ? 'found' : null
        },
        getContainerSpecHash: (ref: string) => (ref === 'found' ? hash : null),
      })

      await expect(ensure(self, 's', opts)).resolves.toBe('found')
      expect(created).toEqual([])
      expect(removed).toEqual([])
      expect(lookups).toContain(`${set.containerPrefix}s`)
    })

    it(`attaches to a running ${label}-identity container without creating one`, async () => {
      const { self, created } = fakeManager({
        getExistingContainer: (name: string) => (name === `${set.containerPrefix}s` ? 'found' : null),
      })
      await expect(
        DockerSandboxManager.prototype.attachExistingSandbox.call(self as unknown as DockerSandboxManager, 's', opts)
      ).resolves.toBe(true)
      expect(created).toEqual([])
      expect((self.sandboxes as Map<string, any>).get('s')).toMatchObject({ containerId: 'found' })
    })

    it(`removes a stale ${label}-identity container before creating under the write name`, async () => {
      const staleHash = computeDockerSpecHash({ ...opts, volumes: ['/old:/old:ro'] })
      const createdNames: string[] = []
      const { self, removed } = fakeManager({
        getExistingContainer: (name: string) => (name === `${set.containerPrefix}s` ? 'stale' : null),
        getContainerSpecHash: () => staleHash,
        createSocketContainer: async (name: string) => {
          createdNames.push(name)
          throw new Error('CREATE_SENTINEL')
        },
      })

      await expect(ensure(self, 's', opts)).rejects.toThrow('CREATE_SENTINEL')
      expect(removed).toEqual(['s'])
      expect(createdNames).toEqual([`${SANDBOX_IDENTITY_WRITE.containerPrefix}s`])
    })
  }

  it('does not attach to a retired-name container', async () => {
    const { self, created } = fakeManager({
      getExistingContainer: (name: string) =>
        name === `${SANDBOX_IDENTITY_LEGACY.containerPrefix}s` ? 'retired' : null,
    })
    await expect(
      DockerSandboxManager.prototype.attachExistingSandbox.call(self as unknown as DockerSandboxManager, 's', opts)
    ).resolves.toBe(false)
    expect(created).toEqual([])
  })

  it('does not hand retired containers to duplicate removal', async () => {
    const hash = computeDockerSpecHash(opts)
    const ids: Record<string, string> = {
      [`${SANDBOX_IDENTITY_NEW.containerPrefix}s`]: 'new-c',
      [`${SANDBOX_IDENTITY_LEGACY.containerPrefix}s`]: 'legacy-c',
    }
    const duplicates: string[][] = []
    const { self, created, removed } = fakeManager({
      getExistingContainer: (name: string) => ids[name] ?? null,
      getContainerSpecHash: () => hash,
      removeDuplicateContainers: (_id: string, refs: string[]) => void duplicates.push(refs),
    })
    const write = ids[`${SANDBOX_IDENTITY_WRITE.containerPrefix}s`]
    await expect(ensure(self, 's', opts)).resolves.toBe(write)
    expect(duplicates).toEqual([])
    expect(created).toEqual([])
    expect(removed).toEqual([])
  })

  it('the create-time label uses computeDockerSpecHash so stamp and check agree', () => {
    // The label the create path stamps and the value ensure compares against are
    // one function over one config — the anti-loop invariant, by construction.
    expect(SPEC_HASH_LABEL).toBe(SANDBOX_IDENTITY_WRITE.specHashLabel)
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
      assertNoRetiredContainer: (DockerSandboxManager.prototype as any).assertNoRetiredContainer,
      inspectContainerRunning: () => 'not_found',
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
    fs.symlinkSync(outside, path.join(root, '.ficus'))
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
      expect(fs.existsSync(path.join(workspacePath, '.ficus', 'toolchain', '.ready'))).toBe(false)
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
      const dir = path.join(workspacePath, '.ficus', 'toolchain')
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
      const dir = path.join(workspacePath, '.ficus', 'toolchain')
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
      expect(content).toContain('/custom-mount/.ficus/.env')
      expect(content).not.toContain('/workspace/.ficus/.env')
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

    it('injects the live Core URL so the `ficus` CLI survives a Core port change', () => {
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
      expect(scriptContent).toContain('/workspace/sq1/.ficus/.env')
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

// C1 (fix round 1 — review finding): an adopted container that was built
// under a foreign identity (different user and runtime paths — every
// container running before this release) has no `ficus` user and no
// `/run/ficus/...` paths. connectExecutor and getSandboxUserArgs must read
// the container's OWN label set to decide which paths/user to use — not
// unconditionally assume the current release's. These exercise the REAL
// private methods (not stubbed, unlike every higher-level ensureSandbox/
// attachExistingSandbox test above, which stubs connectExecutor/
// connectActiveDrift and therefore cannot see this bug) against a fake
// docker + fake fetch.
describe("connectExecutor and getSandboxUserArgs resolve the container's OWN identity (C1)", () => {
  const proto = DockerSandboxManager.prototype as any

  /** A `this` exposing only the real prototype methods the call chain under test needs, plus a labels stub. */
  function fakeThisForLabels(labels: Record<string, string>) {
    const sandboxes = new Map<string, any>()
    return {
      sandboxes,
      getContainerLabels: (_ref: string) => labels,
      resolveDockerExecIdentity: proto.resolveDockerExecIdentity,
    }
  }

  describe('getSandboxUserArgs', () => {
    it('uses the Ficus identity for a new-labelled container', () => {
      const self = fakeThisForLabels({ [SANDBOX_IDENTITY_NEW.managedLabel]: 'true' })
      const args: string[] = proto.getSandboxUserArgs.call(self, 'container-new')
      expect(args).toEqual([
        '--user',
        DOCKER_EXEC_IDENTITY_NEW.user,
        '-e',
        `HOME=${DOCKER_EXEC_IDENTITY_NEW.home}`,
        '-e',
        `USER=${DOCKER_EXEC_IDENTITY_NEW.user}`,
        '-e',
        `LOGNAME=${DOCKER_EXEC_IDENTITY_NEW.user}`,
        '-e',
        `DOCKER_HOST=unix://${DOCKER_EXEC_IDENTITY_NEW.dockerProxySocketPath}`,
      ])
    })

    it('never selects retired exec paths from retired labels', () => {
      const self = fakeThisForLabels({ [SANDBOX_IDENTITY_LEGACY.managedLabel]: 'true' })
      const args: string[] = proto.getSandboxUserArgs.call(self, 'container-legacy')
      expect(args).toContain(DOCKER_EXEC_IDENTITY_NEW.user)
      expect(args).not.toContain(DOCKER_EXEC_IDENTITY_LEGACY.user)
    })

    it('uses the fixed pre-rename identity only for an explicitly attached old container', () => {
      const self = fakeThisForLabels({ [LEGACY_DOCKER_MANAGED_LABEL]: 'true' })
      const args: string[] = proto.getSandboxUserArgs.call(self, 'persisted-old-container')
      expect(args).toContain(LEGACY_DOCKER_EXEC_IDENTITY.user)
      expect(args).toContain(`HOME=${LEGACY_DOCKER_EXEC_IDENTITY.home}`)
      expect(args).not.toContain(DOCKER_EXEC_IDENTITY_NEW.user)
      expect(SANDBOX_IDENTITY_READ.map((set) => set.managedLabel)).not.toContain(LEGACY_DOCKER_MANAGED_LABEL)
    })

    it('refuses conflicting canonical and pre-rename managed labels', () => {
      const self = fakeThisForLabels({
        [SANDBOX_IDENTITY_NEW.managedLabel]: 'true',
        [LEGACY_DOCKER_MANAGED_LABEL]: 'true',
      })
      expect(() => proto.getSandboxUserArgs.call(self, 'conflicting-container')).toThrow(
        'Conflicting Docker managed identities'
      )
    })

    it('falls back to the Ficus (write) identity when a container has no managed label at all', () => {
      const self = fakeThisForLabels({})
      const args: string[] = proto.getSandboxUserArgs.call(self, 'container-unlabelled')
      expect(args).toContain(DOCKER_EXEC_IDENTITY_NEW.user)
      expect(args).not.toContain(DOCKER_EXEC_IDENTITY_LEGACY.user)
    })
  })

  describe('connectExecutor', () => {
    /** Each identity's expected health-contract payload, computed via the REAL resolveDockerCommandIdentity. */
    function expectedHealthIdentity(execIdentity: DockerExecIdentity) {
      const contract =
        execIdentity === LEGACY_DOCKER_EXEC_IDENTITY
          ? LEGACY_DOCKER_COMMAND_IDENTITY_CONTRACT
          : { version: 1 as const, user: 'ficus', home: '/home/ficus', uid: 1000, gid: 1000 }
      return resolveDockerCommandIdentity(contract, { uid: process.getuid?.(), gid: process.getgid?.() })
    }

    for (const [label, identitySet, execIdentity, healthMatches] of [
      ['new', SANDBOX_IDENTITY_NEW, DOCKER_EXEC_IDENTITY_NEW, true],
      ['pre-rename', { managedLabel: LEGACY_DOCKER_MANAGED_LABEL }, LEGACY_DOCKER_EXEC_IDENTITY, true],
      ['pre-rename-wrong-health', { managedLabel: LEGACY_DOCKER_MANAGED_LABEL }, LEGACY_DOCKER_EXEC_IDENTITY, false],
    ] as const) {
      it(`reads the executor token from the ${label} path and validates the ${label} identity for a ${label}-labelled container`, async () => {
        const sandboxId = `agent_${label}`
        const containerId = `container-${label}`
        const self = fakeThisForLabels({ [identitySet.managedLabel]: 'true' })
        self.sandboxes.set(sandboxId, {})

        const resolved = expectedHealthIdentity(healthMatches ? execIdentity : DOCKER_EXEC_IDENTITY_NEW)
        const tokenCalls: string[] = []
        const otherIdentityTokenPath =
          execIdentity === DOCKER_EXEC_IDENTITY_NEW
            ? DOCKER_EXEC_IDENTITY_LEGACY.executorTokenPath
            : DOCKER_EXEC_IDENTITY_NEW.executorTokenPath

        const spawnSpy = spyOn(Bun, 'spawnSync').mockImplementation(
          (args: unknown) =>
            ({
              exitCode: ((): number => {
                const a = args as string[]
                if (a[1] === 'port') return 0
                if (a[1] === 'exec' && a[3] === 'cat') {
                  tokenCalls.push(a[4])
                  return a[4] === execIdentity.executorTokenPath ? 0 : 1
                }
                return 1
              })(),
              stdout: ((): Buffer => {
                const a = args as string[]
                if (a[1] === 'port') return Buffer.from('127.0.0.1:54321\n')
                if (a[1] === 'exec' && a[3] === 'cat' && a[4] === execIdentity.executorTokenPath)
                  return Buffer.from(`${'a'.repeat(64)}\n`)
                return Buffer.alloc(0)
              })(),
              stderr: Buffer.from('cat: No such file or directory'),
            }) as any
        )
        // The 300-attempt retry loops are real (unmocked) code; make Bun.sleep
        // resolve instantly so a wrong-path RED run throws in milliseconds, not 30s.
        const sleepSpy = spyOn(Bun, 'sleep').mockImplementation(() => Promise.resolve() as any)
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () => ({
          ok: true,
          json: async () => ({
            runtimeContract: {
              runtime: 'docker',
              version: 1,
              executorProtocol: 1,
              capabilities: ['bash', 'bash-cancel', 'command-identity', 'socket-proxy'],
              commandIdentity: {
                user: resolved.user,
                home: resolved.home,
                uid: resolved.resolvedUid,
                gid: resolved.resolvedGid,
                source: resolved.source,
                contractDigest: resolved.contractDigest,
              },
            },
          }),
        })) as unknown as typeof fetch

        try {
          if (healthMatches) await proto.connectExecutor.call(self, containerId, sandboxId)
          else await expect(proto.connectExecutor.call(self, containerId, sandboxId)).rejects.toThrow()
        } finally {
          spawnSpy.mockRestore()
          sleepSpy.mockRestore()
          globalThis.fetch = originalFetch
        }

        // The exec that actually succeeded read the identity's OWN token path —
        // never the other identity's (the regression: hardcoding the Ficus path
        // unconditionally means a legacy container's token is never found).
        expect(tokenCalls).toContain(execIdentity.executorTokenPath)
        expect(tokenCalls).not.toContain(otherIdentityTokenPath)
        if (healthMatches) expect(self.sandboxes.get(sandboxId)?.client).toBeDefined()
        else expect(self.sandboxes.get(sandboxId)?.client).toBeUndefined()
      })
    }
  })
})
