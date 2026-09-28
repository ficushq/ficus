import { describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Machine } from './queries'
import {
  buildServerBundle,
  currentBundleVersionCached,
  ensureServerBundle,
  memoizeBuild,
  resolveRepoRoot,
  serverArtifact,
} from './server-bundle'
import type { SshResult, SshRunner } from './ssh'

describe('resolveRepoRoot', () => {
  const SERVER_ENTRY = 'packages/k8s-sandbox/src/server.ts'

  it('resolves a repo root that actually contains the server entry (source layout)', () => {
    const root = resolveRepoRoot(import.meta.dir, undefined)
    expect(existsSync(join(root, SERVER_ENTRY))).toBe(true)
  })

  it('resolves the SAME root from the production dist depth (…/apps/core/dist)', () => {
    // The bug: run from the bundled dist, a hardcoded "../../../../../" overshot
    // to "/" and the entry became "/packages/k8s-sandbox/src/server.ts". Walking
    // up from the deeper source path and the shallower dist path must both land
    // on the real repo root.
    const realRoot = resolveRepoRoot(import.meta.dir, undefined)
    const fromDist = resolveRepoRoot(join(realRoot, 'apps/core/dist'), undefined)
    expect(fromDist).toBe(realRoot)
    expect(existsSync(join(fromDist, SERVER_ENTRY))).toBe(true)
    expect(fromDist.startsWith('/packages')).toBe(false)
  })

  it('honors FICUS_REPO_ROOT override when it contains the entry', () => {
    const realRoot = resolveRepoRoot(import.meta.dir, undefined)
    expect(resolveRepoRoot('/nowhere/at/all', realRoot)).toBe(realRoot)
  })

  it('expands a leading ~ in the FICUS_REPO_ROOT override', async () => {
    // The override is only honoured when it actually contains the server
    // entry, so the fixture has to be a real tree under the (fake) home —
    // which expandTilde's optional home parameter threads straight through
    // resolveRepoRoot, so nothing is ever written under the real one.
    // Bun's os.homedir() DOES honor an inherited $HOME (set before process
    // start); only mutating process.env.HOME in-process after start is not
    // picked up. So the test passes the home explicitly instead of rewriting
    // $HOME.
    const homeRoot = await mkdtemp(join(tmpdir(), 'tau-repo-root-home-'))
    const fixture = join(homeRoot, '.tau-repo-root-fixture')
    try {
      await mkdir(join(fixture, 'packages/k8s-sandbox/src'), { recursive: true })
      await writeFile(join(fixture, SERVER_ENTRY), '// fixture')
      const asTilde = '~/.tau-repo-root-fixture'
      expect(resolveRepoRoot('/nowhere/at/all', asTilde, homeRoot)).toBe(fixture)
    } finally {
      await rm(homeRoot, { recursive: true, force: true })
    }
  })

  it('ignores a bogus override that lacks the entry (falls back to the walk)', () => {
    const realRoot = resolveRepoRoot(import.meta.dir, undefined)
    expect(resolveRepoRoot(import.meta.dir, '/tmp')).toBe(realRoot)
  })
})

const SERVER_REMOTE_PATH = '/opt/tau/server/server.js'
const SERVER_LIB_REMOTE_PATH = '/opt/tau/server/librust_pty.so'

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'bundle-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.9',
    sshPort: 22,
    sshUser: 'tau',
    sshKeyId: 'secret-key',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    bootstrapVersion: 'boot-v1',
    artifactVersions: {},
    lastSeenAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Machine
}

interface RecordedCall {
  command: string
  stdin?: string | Uint8Array
}

function makeFakeRunner(handler: (command: string) => SshResult | Error): {
  runner: SshRunner
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const runner: SshRunner = {
    async run(_machine, command, opts): Promise<SshResult> {
      calls.push({ command, stdin: opts?.stdin })
      const reply = handler(command)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  return { runner, calls }
}

const ok = (): SshResult => ({ exitCode: 0, stdout: '', stderr: '' })

describe('buildServerBundle', () => {
  it('bundles the real k8s-sandbox server into a single non-empty file', async () => {
    const { content, version } = await buildServerBundle()
    expect(content.length).toBeGreaterThan(0)
    // The bundle inlines the server entry + its services/ modules; a known
    // startup string proves it is the actual server, not an empty/stub file.
    const text = new TextDecoder().decode(content)
    expect(text).toContain('Starting sandbox')
    expect(text).toContain('/healthz')
    // version is a sha256 hex digest of the bundle content + native lib.
    expect(version).toMatch(/^[0-9a-f]{64}$/)
  })

  it('captures the linux-x64 bun-pty native lib the server dlopens at boot', async () => {
    // The bundled shell/PTY path resolves librust_pty.so at module-load; without
    // it the box server crashes on startup. The bundle must ship the arch-matched
    // (linux-x64) lib alongside server.js — bun-pty publishes every prebuild in
    // its single npm package, so the .so is present even on a darwin build host.
    const { lib } = await buildServerBundle()
    expect(lib.length).toBeGreaterThan(0)
    // ELF magic (0x7f 'E' 'L' 'F') proves it is the LINUX object, never a darwin
    // .dylib (Mach-O) — shipping a darwin lib to Ubuntu would crash the server.
    expect(Array.from(lib.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46])
  })

  it('produces a stable version across two builds of identical input', async () => {
    const a = await buildServerBundle()
    const b = await buildServerBundle()
    expect(b.version).toBe(a.version)
  })

  it('folds the native lib into the version hash (a lib change re-stamps)', async () => {
    // Guards the re-push contract: since the version stamps server.js AND the lib,
    // recomputing the hash over the SAME server.js with a mutated lib must differ,
    // so a lib bump alone re-pushes to every machine.
    const { content, lib, version } = await buildServerBundle()
    const mutatedLib = new Uint8Array(lib)
    mutatedLib[0] ^= 0xff
    const rehashed = createHash('sha256').update(content).update(mutatedLib).digest('hex')
    expect(rehashed).not.toBe(version)
  })
})

describe('buildServerBundle prebuilt fallback', () => {
  // A shipped core artifact carries the sandbox-server prebuilt under
  // <root>/machine and NO packages/k8s-sandbox source; runtime must READ the
  // bundle from disk (same sha256(server.js || lib) stamp) and never `bun
  // build`. `spawn` throws here to prove the build path is not taken.
  const throwingSpawn = (() => {
    throw new Error('buildServerBundle must not spawn a build when a prebuilt bundle is present')
  }) as unknown as typeof Bun.spawn

  it('reads server.js + librust_pty.so from the prebuilt dir and hashes them (no build)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-prebuilt-server-'))
    try {
      const server = new TextEncoder().encode('// prebuilt server.js fixture\n')
      const lib = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4])
      await writeFile(join(dir, 'server.js'), server)
      await writeFile(join(dir, 'librust_pty.so'), lib)

      const { content, lib: gotLib, version } = await buildServerBundle({ prebuiltDir: dir, spawn: throwingSpawn })

      expect(content).toEqual(server)
      expect(gotLib).toEqual(lib)
      // EXACT same version contract as the source path — the combined sha256.
      expect(version).toBe(createHash('sha256').update(server).update(lib).digest('hex'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws when a prebuilt server.js is present but its native lib is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-prebuilt-server-nolib-'))
    try {
      await writeFile(join(dir, 'server.js'), new Uint8Array([1, 2, 3]))
      await expect(buildServerBundle({ prebuiltDir: dir, spawn: throwingSpawn })).rejects.toThrow(
        /librust_pty\.so missing/
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('with no prebuiltDir, a git checkout never reads a prebuilt bundle (source build runs, no default <root>/machine dir)', async () => {
    // Pre-refactor, buildServerBundle defaulted prebuiltDir to
    // `<MONOREPO_ROOT>/machine` and read it unconditionally — a stray
    // `machine/` dir in a dev checkout would silently be treated as prebuilt.
    // Post-refactor, `deps.prebuiltDir` passes straight through to the shared
    // reader's explicit `dir`; when omitted, the reader falls to its
    // artifact-mode gate, which is false in this git checkout, so it must
    // ALWAYS return null here regardless of anything on disk at
    // `<root>/machine` — proving the source build is reached with no dir arg.
    const calls: string[][] = []
    const recordingSpawn = ((cmd: string[]) => {
      calls.push(cmd)
      return { stderr: '', exited: Promise.reject(new Error('SOURCE_BUILD_REACHED')) }
    }) as unknown as typeof Bun.spawn
    await expect(buildServerBundle({ spawn: recordingSpawn })).rejects.toThrow('SOURCE_BUILD_REACHED')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('build')
  })

  it('falls through to the source build when no prebuilt bundle exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tau-prebuilt-server-empty-'))
    const calls: string[][] = []
    // Record the build spawn and reject its exit so the fallthrough is provable
    // without depending on the real k8s-sandbox source / bun-pty lib being
    // present in this checkout.
    const recordingSpawn = ((cmd: string[]) => {
      calls.push(cmd)
      return { stderr: '', exited: Promise.reject(new Error('SOURCE_BUILD_REACHED')) }
    }) as unknown as typeof Bun.spawn
    try {
      await expect(buildServerBundle({ prebuiltDir: dir, spawn: recordingSpawn })).rejects.toThrow(
        'SOURCE_BUILD_REACHED'
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('build')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('currentBundleVersionCached', () => {
  it('memoizes the build (same promise on repeat calls)', async () => {
    const first = currentBundleVersionCached()
    const second = currentBundleVersionCached()
    expect(second).toBe(first)
    const { version } = await first
    expect(version).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('memoizeBuild', () => {
  it('memoizes a successful build (same promise on repeat calls, build runs once)', async () => {
    let calls = 0
    const build = memoizeBuild(async () => {
      calls += 1
      return { content: new Uint8Array(), version: `v${calls}` }
    })
    const first = build()
    const second = build()
    expect(second).toBe(first)
    const { version } = await first
    expect(version).toBe('v1')
    expect(calls).toBe(1)
  })

  it('does not poison the cache on a failed build — the next call retries and can succeed', async () => {
    let calls = 0
    const build = memoizeBuild(async () => {
      calls += 1
      if (calls === 1) throw new Error('build boom')
      return { content: new Uint8Array(), version: `v${calls}` }
    })

    await expect(build()).rejects.toThrow('build boom')
    expect(calls).toBe(1)

    const { version } = await build()
    expect(version).toBe('v2')
    expect(calls).toBe(2)
  })
})

describe('serverArtifact', () => {
  it('is named "server" and builds the exact production files: server.js + native lib, both 0755, combined-hash version', async () => {
    expect(serverArtifact.name).toBe('server')
    const { files, version } = await serverArtifact.build()
    const bundle = await currentBundleVersionCached()
    expect(files).toHaveLength(2)
    expect(files[0]).toEqual({ remotePath: SERVER_REMOTE_PATH, bytes: bundle.content, mode: '0755' })
    expect(files[1]).toEqual({ remotePath: SERVER_LIB_REMOTE_PATH, bytes: bundle.lib, mode: '0755' })
    // The version is the SAME combined sha256 (server.js + lib) the pre-refactor
    // pipeline stamped — pre-existing machines' recorded versions stay valid.
    expect(version).toBe(bundle.version)
    expect(version).toBe(createHash('sha256').update(bundle.content).update(bundle.lib).digest('hex'))
  })

  it('reuses the per-process memoized bundle (no rebuild per ensure)', async () => {
    const a = await serverArtifact.build()
    const b = await serverArtifact.build()
    // Same underlying bytes object — build() reuses currentBundleVersionCached,
    // so ensuring N machines never re-runs `bun build`.
    expect(b.files[0].bytes).toBe(a.files[0].bytes)
    expect(b.version).toBe(a.version)
  })
})

describe('ensureServerBundle', () => {
  // The wrapper delegates to ensureArtifact with the REAL memoized build; the
  // tests below pin the same delivery behavior the pre-refactor pipeline had
  // (paths, modes, skip-if-match, stamp-only-after-both).
  function makeFakeStamp(): {
    stamp: (machineId: string, name: string, version: string) => Promise<void>
    stamps: Array<[string, string, string]>
  } {
    const stamps: Array<[string, string, string]> = []
    return {
      stamp: async (machineId, name, version) => {
        stamps.push([machineId, name, version])
      },
      stamps,
    }
  }

  it('skips push + stamp when the machine already has the current version under artifactVersions.server', async () => {
    const { version } = await serverArtifact.build()
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    await ensureServerBundle(makeMachine({ artifactVersions: { server: version } }), {
      runner,
      stampArtifactVersion: stamp,
    })
    expect(calls).toEqual([])
    expect(stamps).toEqual([])
  })

  it('pushes both the bundle and native lib to the exact production paths (0755) and stamps when it differs', async () => {
    const bundle = await currentBundleVersionCached()
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    const machine = makeMachine({ artifactVersions: { server: 'stale' } })
    await ensureServerBundle(machine, { runner, stampArtifactVersion: stamp })
    // Two pushes: server.js then the native lib (both mode 0755, same
    // root-owned /opt/tau/server destinations as the pre-refactor push), each
    // staged beside its destination and renamed in (atomic; see
    // machine-artifacts.ts's buildSudoInstallCommand).
    expect(calls).toHaveLength(2)
    // The staging name carries a per-attempt token (machine-artifacts.ts's
    // stagingPathFor) so concurrent pushes cannot share it, hence shape rather
    // than an exact string: install into a unique '<dest>.tau-new.<token>',
    // then rename THAT path onto the destination.
    const stagedThenRenamed = (command: string, dest: string): boolean => {
      const staging = command.match(/install -D -m 0755 \/dev\/stdin '([^']+)' &&/)?.[1]
      return (
        !!staging &&
        staging.startsWith(`${dest}.tau-new.`) &&
        command.includes(`mv -f '${staging}' '${dest}'`) &&
        !command.includes(`/dev/stdin '${dest}'`)
      )
    }
    expect(stagedThenRenamed(calls[0].command, SERVER_REMOTE_PATH)).toBe(true)
    expect(calls[0].stdin).toBe(bundle.content)
    expect(stagedThenRenamed(calls[1].command, SERVER_LIB_REMOTE_PATH)).toBe(true)
    expect(calls[1].stdin).toBe(bundle.lib)
    // Stamped under 'server', only after BOTH pushes succeed.
    expect(stamps).toEqual([[machine.id, 'server', bundle.version]])
  })

  it('does NOT stamp when the native lib push fails (bundle pushed, lib rejected)', async () => {
    // server.js push succeeds, the lib push fails → the whole ensure throws and
    // leaves the recorded version unchanged so the next ensure retries both.
    const { runner } = makeFakeRunner((command) =>
      command.includes('librust_pty.so') ? { exitCode: 1, stdout: '', stderr: 'lib push denied' } : ok()
    )
    const { stamp, stamps } = makeFakeStamp()
    await expect(
      ensureServerBundle(makeMachine({ artifactVersions: { server: 'stale' } }), {
        runner,
        stampArtifactVersion: stamp,
      })
    ).rejects.toThrow(/lib push denied/)
    expect(stamps).toEqual([])
  })

  it('pushes on a fresh machine (no server entry in artifactVersions)', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    await ensureServerBundle(makeMachine({ artifactVersions: {} }), {
      runner,
      stampArtifactVersion: stamp,
    })
    // Both server.js and the native lib are pushed on a fresh machine.
    expect(calls).toHaveLength(2)
    expect(stamps).toHaveLength(1)
  })

  it('throws and does NOT stamp when the push fails', async () => {
    const { runner } = makeFakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'permission denied' }))
    const { stamp, stamps } = makeFakeStamp()
    await expect(
      ensureServerBundle(makeMachine({ artifactVersions: { server: 'stale' } }), {
        runner,
        stampArtifactVersion: stamp,
      })
    ).rejects.toThrow(/permission denied/)
    expect(stamps).toEqual([])
  })
})
