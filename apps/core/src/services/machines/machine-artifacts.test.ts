import { createHash } from 'crypto'
import { describe, expect, it } from 'bun:test'
import boxProvisionScript from '../../../../../scripts/machine/box-provision.sh' with { type: 'text' }
import { BOX_PROVISION_REMOTE_PATH, boxProvisionArtifact } from './box-provision-artifact'
import { cliArtifact } from './cli-bundle'
import { ensureArtifact } from './machine-artifacts'
import type { ArtifactFile, MachineArtifact } from './machine-artifacts'
import { ensureMachineArtifacts, MACHINE_ARTIFACTS } from './machine-artifacts-registry'
import type { Machine } from './queries'
import { serverArtifact } from './server-bundle'
import type { SshResult, SshRunner } from './ssh'

/**
 * True when `command` stages into a UNIQUE '<dest>.ficus-new.<token>' path and then
 * renames that same path onto `dest` — the contract that makes concurrent pushes
 * of one artifact to one host independent (see stagingPathFor).
 */
function stagedThenRenamed(command: string, dest: string): boolean {
  const match = command.match(/install -D -m [0-7]{3,4} \/dev\/stdin '([^']+)' &&/)
  if (!match) return false
  const staging = match[1]!
  if (staging === dest || !staging.startsWith(`${dest}.ficus-new.`)) return false
  // The destination is only ever a rename target, never an install target.
  return command.includes(`mv -f '${staging}' '${dest}'`) && !command.includes(`/dev/stdin '${dest}'`)
}

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'artifact-test',
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

/** Recording fake for the stamp seam — ensureArtifact must never touch the DB. */
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

const fileA: ArtifactFile = {
  remotePath: '/opt/tau/x/a.js',
  bytes: new TextEncoder().encode('A-BYTES'),
  mode: '0755',
}
const fileB: ArtifactFile = {
  remotePath: '/opt/tau/x/b.so',
  bytes: new TextEncoder().encode('B-BYTES'),
  mode: '0644',
}

function makeArtifact(overrides: Partial<MachineArtifact> = {}): MachineArtifact {
  return {
    name: 'x',
    build: async () => ({ files: [fileA, fileB], version: 'v1' }),
    ...overrides,
  }
}

describe('ensureArtifact', () => {
  it('skips push + stamp when the machine already carries the current version', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    await ensureArtifact(makeMachine({ artifactVersions: { x: 'v1' } }), makeArtifact(), {
      runner,
      stampArtifactVersion: stamp,
    })
    expect(calls).toEqual([])
    expect(stamps).toEqual([])
  })

  it('pushes every file ATOMICALLY (temp path + rename) and stamps ONCE when the version differs', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    const machine = makeMachine({ artifactVersions: { x: 'stale' } })
    await ensureArtifact(machine, makeArtifact(), { runner, stampArtifactVersion: stamp })

    expect(calls).toHaveLength(2)
    // `install /dev/stdin <final>` TRUNCATES the destination in place. That is
    // survivable for a binary blob nothing is reading, and not survivable for
    // box-provision.sh: bash reads a script incrementally, so a re-push landing
    // while a provision/teardown is mid-execution rewrites the file under the
    // running interpreter. So every artifact file is staged next to its
    // destination and moved in — `mv` within a directory is rename(2), which is
    // atomic and leaves any already-open inode intact for its reader to finish.
    // -D still creates missing parent dirs, so a fresh artifact directory needs
    // no separate mkdir step.
    // The staging name carries a per-attempt token (see stagingPathFor), so
    // assert the SHAPE: install into a unique '<dest>.ficus-new.<token>' beside
    // the destination, then rename that exact path onto the destination.
    expect(calls[0].command).toMatch(
      /^sudo install -D -m 0755 \/dev\/stdin '\/opt\/tau\/x\/a\.js\.ficus-new\.[0-9a-f]{8}' && /
    )
    expect(stagedThenRenamed(calls[0].command, '/opt/tau/x/a.js')).toBe(true)
    expect(calls[0].stdin).toBe(fileA.bytes)
    expect(calls[1].command).toMatch(
      /^sudo install -D -m 0644 \/dev\/stdin '\/opt\/tau\/x\/b\.so\.ficus-new\.[0-9a-f]{8}' && /
    )
    expect(stagedThenRenamed(calls[1].command, '/opt/tau/x/b.so')).toBe(true)
    expect(calls[1].stdin).toBe(fileB.bytes)
    // The final path is never itself an `install` target — that is the whole
    // point of the staging step.
    for (const call of calls) {
      expect(call.command).not.toContain(`install -D -m 0755 /dev/stdin '/opt/tau/x/a.js'`)
      expect(call.command).not.toContain(`install -D -m 0644 /dev/stdin '/opt/tau/x/b.so'`)
    }
    // Stamped exactly once, after all files pushed.
    expect(stamps).toEqual([[machine.id, 'x', 'v1']])
  })

  it('concurrent pushes of one artifact never share a staging path (the mv-cannot-stat race)', async () => {
    // ensureArtifact runs on EVERY box ensure, and the keepalive sweep warms
    // every box on a machine at once — so N concurrent pushes of the same
    // artifact to one host are routine. With a shared staging name they
    // collided: each install overwrote the one path, the first mv consumed it,
    // and every loser died with
    //     mv: cannot stat '<path>.ficus-new': No such file or directory
    // surfacing to the operator as a failed agent execution (observed live).
    //
    // Model that host: a staging path may be renamed exactly ONCE. Any second
    // mv of the same path is the real `mv` failure. With unique staging names
    // no pusher can consume another's file, so all of them must succeed.
    const staged = new Set<string>()
    const consumed = new Set<string>()
    const { runner, calls } = makeFakeRunner((command) => {
      const install = command.match(/install -D -m [0-7]{3,4} \/dev\/stdin '([^']+)' &&/)
      if (install) staged.add(install[1]!)
      const mv = command.match(/mv -f '([^']+)' '([^']+)'/)
      if (mv) {
        const from = mv[1]!
        if (consumed.has(from) || !staged.has(from)) {
          return { exitCode: 1, stdout: '', stderr: `mv: cannot stat '${from}': No such file or directory` }
        }
        consumed.add(from)
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    const artifact = {
      name: 'cli',
      build: async () => ({ files: [fileA], version: 'v-concurrent' }),
    }
    const machine = makeMachine({ artifactVersions: {} })

    // Ten simultaneous ensures, exactly as a warm sweep produces.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        ensureArtifact(machine, artifact, { runner, stampArtifactVersion: async () => {} })
      )
    )

    expect(calls).toHaveLength(10)
    // Every push staged its OWN path, and every one of them was renamed.
    const stagingPaths = calls.map((c) => c.command.match(/\/dev\/stdin '([^']+)'/)![1]!)
    expect(new Set(stagingPaths).size).toBe(10)
    expect(consumed.size).toBe(10)
  })

  it('pushes on a machine that has never seen the artifact (no map entry)', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    await ensureArtifact(makeMachine({ artifactVersions: {} }), makeArtifact(), {
      runner,
      stampArtifactVersion: stamp,
    })
    expect(calls).toHaveLength(2)
    expect(stamps).toHaveLength(1)
  })

  it('throws and does NOT stamp when a push fails', async () => {
    const { runner } = makeFakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'permission denied' }))
    const { stamp, stamps } = makeFakeStamp()
    await expect(
      ensureArtifact(makeMachine({ artifactVersions: { x: 'stale' } }), makeArtifact(), {
        runner,
        stampArtifactVersion: stamp,
      })
    ).rejects.toThrow(/permission denied/)
    expect(stamps).toEqual([])
  })

  it('multi-file: a failure on file 2 leaves file 1 pushed but NO stamp (retry re-pushes both)', async () => {
    const { runner, calls } = makeFakeRunner((command) =>
      command.includes('b.so') ? { exitCode: 1, stdout: '', stderr: 'b push denied' } : ok()
    )
    const { stamp, stamps } = makeFakeStamp()
    await expect(
      ensureArtifact(makeMachine({ artifactVersions: { x: 'stale' } }), makeArtifact(), {
        runner,
        stampArtifactVersion: stamp,
      })
    ).rejects.toThrow(/b push denied/)
    // File 1 went out before the failure — but with no stamp the recorded
    // version is unchanged, so the next ensure re-pushes both files.
    expect(calls).toHaveLength(2)
    expect(stamps).toEqual([])
  })
})

/** Swap the registry's contents for `entries` while `fn` runs, then restore the
 *  real registrations (the server artifact) — length=0 alone would wipe them. */
async function withRegistry(entries: MachineArtifact[], fn: () => Promise<void>): Promise<void> {
  const saved = MACHINE_ARTIFACTS.splice(0, MACHINE_ARTIFACTS.length, ...entries)
  try {
    await fn()
  } finally {
    MACHINE_ARTIFACTS.splice(0, MACHINE_ARTIFACTS.length, ...saved)
  }
}

describe('ensureMachineArtifacts', () => {
  it('registers box-provision.sh, the server artifact, then the ficus CLI (registry order = ensure order)', () => {
    // box-provision.sh comes FIRST: it is what every per-box operation shells
    // out to, so it must land even if the (much larger) server-bundle push
    // fails on this pass.
    expect(MACHINE_ARTIFACTS).toEqual([boxProvisionArtifact, serverArtifact, cliArtifact])
  })

  it('is a no-op with an empty registry', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    await withRegistry([], async () => {
      await ensureMachineArtifacts(makeMachine(), { runner, stampArtifactVersion: stamp })
    })
    expect(calls).toEqual([])
    expect(stamps).toEqual([])
  })

  it('ensures every registered artifact in registry order', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    const machine = makeMachine()
    const first = makeArtifact({
      name: 'first',
      build: async () => ({ files: [fileA], version: 'v-first' }),
    })
    const second = makeArtifact({
      name: 'second',
      build: async () => ({ files: [fileB], version: 'v-second' }),
    })
    await withRegistry([first, second], async () => {
      await ensureMachineArtifacts(machine, { runner, stampArtifactVersion: stamp })
    })
    expect(calls).toHaveLength(2)
    expect(stagedThenRenamed(calls[0].command, '/opt/tau/x/a.js')).toBe(true)
    expect(stagedThenRenamed(calls[1].command, '/opt/tau/x/b.so')).toBe(true)
    expect(stamps).toEqual([
      [machine.id, 'first', 'v-first'],
      [machine.id, 'second', 'v-second'],
    ])
  })

  it('every artifact is REQUIRED: a failure propagates and later artifacts are not attempted', async () => {
    const { runner, calls } = makeFakeRunner((command) =>
      command.includes('a.js') ? { exitCode: 1, stdout: '', stderr: 'first push denied' } : ok()
    )
    const { stamp, stamps } = makeFakeStamp()
    const first = makeArtifact({
      name: 'first',
      build: async () => ({ files: [fileA], version: 'v-first' }),
    })
    const second = makeArtifact({
      name: 'second',
      build: async () => ({ files: [fileB], version: 'v-second' }),
    })
    await withRegistry([first, second], async () => {
      await expect(ensureMachineArtifacts(makeMachine(), { runner, stampArtifactVersion: stamp })).rejects.toThrow(
        /first push denied/
      )
    })
    expect(calls).toHaveLength(1)
    expect(stamps).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// box-provision.sh as a machine artifact.
//
// Every per-box operation (provision, remove, restore, --restore-stream) shells
// out to this script on the machine. Before it was an artifact it was pushed
// ONLY by bootstrapMachine — at provisioning or an explicit re-bootstrap — so a
// newly-added script MODE (like --restore-stream) was rejected by every machine
// already in the fleet until each was re-bootstrapped by hand. As an artifact it
// rides `ensureMachineArtifacts`, which migrate already runs on the destination
// BEFORE the streamed restore, so rollout is automatic.
// ---------------------------------------------------------------------------
describe('boxProvisionArtifact', () => {
  it('pushes the CHECKED-IN script to /opt/tau/bin/box-provision.sh, executable', async () => {
    const { files } = await boxProvisionArtifact.build()

    expect(boxProvisionArtifact.name).toBe('box-provision')
    expect(files).toHaveLength(1)
    expect(files[0].remotePath).toBe(BOX_PROVISION_REMOTE_PATH)
    expect(BOX_PROVISION_REMOTE_PATH).toBe('/opt/tau/bin/box-provision.sh')
    expect(files[0].mode).toBe('0755')
    // Byte-identical to the repo's script — not a re-rendered or trimmed copy.
    expect(new TextDecoder().decode(files[0].bytes)).toBe(boxProvisionScript)
    // The mode that survives ensureArtifact's octal guard.
    expect(files[0].mode).toMatch(/^[0-7]{3,4}$/)
  })

  it('versions by CONTENT, so an edited script re-pushes and an unchanged one does not', async () => {
    const first = await boxProvisionArtifact.build()
    const second = await boxProvisionArtifact.build()

    expect(first.version).toBe(second.version)
    expect(first.version).toBe(createHash('sha256').update(boxProvisionScript).digest('hex'))
  })

  it('is a no-op when the machine already carries this exact version', async () => {
    const { version } = await boxProvisionArtifact.build()
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()

    await ensureArtifact(makeMachine({ artifactVersions: { 'box-provision': version } }), boxProvisionArtifact, {
      runner,
      stampArtifactVersion: stamp,
    })

    expect(calls).toEqual([])
    expect(stamps).toEqual([])
  })

  it('pushes + stamps a machine whose recorded version is stale (the fleet-wide rollout case)', async () => {
    const { runner, calls } = makeFakeRunner(() => ok())
    const { stamp, stamps } = makeFakeStamp()
    const machine = makeMachine({ artifactVersions: { 'box-provision': 'from-an-older-script' } })

    await ensureArtifact(machine, boxProvisionArtifact, { runner, stampArtifactVersion: stamp })

    // Staged + renamed, never installed over the live path: this artifact is a
    // shell script bash may be reading INCREMENTALLY on the far side.
    expect(calls).toHaveLength(1)
    expect(stagedThenRenamed(calls[0].command, '/opt/tau/bin/box-provision.sh')).toBe(true)
    const { version } = await boxProvisionArtifact.build()
    expect(stamps).toEqual([[machine.id, 'box-provision', version]])
  })

  it('carries the --restore-stream mode a streamed migration needs', async () => {
    // The rollout blocker in one assertion: the bytes ensureMachineArtifacts
    // delivers are the ones that understand the flag box-manager sends.
    const { files } = await boxProvisionArtifact.build()
    expect(new TextDecoder().decode(files[0].bytes)).toContain('--restore-stream')
  })
})
