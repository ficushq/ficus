import { describe, test, expect, spyOn } from 'bun:test'
import { EventEmitter } from 'events'
import * as factory from '../factory'
import {
  syncBoxFiles,
  resolveBoxApiUrl,
  resolveBoxApiTransport,
  isValidHttpUrl,
  pushSquadSshToBox,
  type SyncBoxFilesDeps,
  type PushSquadSshToBoxDeps,
} from './file-sync'
import { boxUnixUser } from '../../machines/box-manager'
import type { Machine, MachineBox } from '../../machines/queries'
import type { SandboxOptions } from '../types'
import { BashOutcomeUnknownError } from '../k8s/http-client'

// ---------------------------------------------------------------------------
// Fake SandboxClient — records /write and /bash calls in order.
// ---------------------------------------------------------------------------

type WriteCall = { kind: 'write'; path: string; content: string; createDirs?: boolean; mode?: string }
type BashCall = { kind: 'bash'; command: string }
type Call = WriteCall | BashCall

function makeBashStream(exitCode: number) {
  const stream = new EventEmitter() as any
  stream.cancel = () => {}
  queueMicrotask(() => {
    stream.emit('data', { exitCode })
    stream.emit('end')
  })
  return stream
}

class FakeClient {
  calls: Call[] = []
  bashExit = 0
  /** When set, `write` throws for any path the predicate matches (models a
   *  mid-sync push failure to exercise the secret-cleanup path). */
  throwOnWrite: ((path: string) => boolean) | null = null

  async write(req: { path: string; content: string; createDirs?: boolean; mode?: string }) {
    if (this.throwOnWrite?.(req.path)) throw new Error(`write failed for ${req.path}`)
    this.calls.push({ kind: 'write', path: req.path, content: req.content, createDirs: req.createDirs, mode: req.mode })
    return { bytesWritten: Buffer.from(req.content, 'base64').length }
  }

  bash(req: { command: string }) {
    this.calls.push({ kind: 'bash', command: req.command })
    return makeBashStream(this.bashExit)
  }

  writes(): WriteCall[] {
    return this.calls.filter((c): c is WriteCall => c.kind === 'write')
  }
  bashes(): BashCall[] {
    return this.calls.filter((c): c is BashCall => c.kind === 'bash')
  }
  writePaths(): string[] {
    return this.writes().map((c) => c.path)
  }
  /** The octal mode passed to `/write` for `path` (first match). */
  modeAt(path: string): string | undefined {
    return this.writes().find((c) => c.path === path)?.mode
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = (id: string) => `/home/${boxUnixUser(id)}`

/** deps that provide every artifact; individual tests null out what they don't want. */
function fullDeps(over: Partial<SyncBoxFilesDeps> = {}): SyncBoxFilesDeps {
  return {
    // Intentionally unsorted so the order assertion proves deterministic sorting.
    listSkillFiles: async () => [
      { relPath: 'skill-b/SKILL.md', content: Buffer.from('B') },
      { relPath: 'skill-a/SKILL.md', content: Buffer.from('A') },
      { relPath: 'skill-a/ref/x.md', content: Buffer.from('X') },
    ],
    readSquadEnv: () => 'export FOO=bar\n',
    readIdentityPem: () => '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    listMemoryFiles: async () => [
      { relPath: 'map.md', content: Buffer.from('# map') },
      { relPath: 'context.md', content: Buffer.from('# ctx') },
    ],
    materializeSquadRemoteHosts: async () => {},
    listSquadSshFiles: async () => [
      { relPath: 'ficus_remote_prod', content: Buffer.from('PRIVATE') },
      { relPath: 'ficus_remote_prod.pub', content: Buffer.from('PUBLIC') },
      { relPath: 'config', content: Buffer.from('Host prod\n') },
      { relPath: 'known_hosts', content: Buffer.from('prod ssh-ed25519 AAA') },
    ],
    ...over,
  }
}

const squadOpts: SandboxOptions = {
  workspacePath: '/x',
  squadId: '11111111-1111-4111-8111-111111111111',
  k8s: { sandboxType: 'squad' },
}
const soloAgentOpts: SandboxOptions = { workspacePath: '/x', k8s: { sandboxType: 'agent' } }
const squadAgentOpts: SandboxOptions = {
  workspacePath: '/x',
  squadId: '11111111-1111-4111-8111-111111111111',
  k8s: { sandboxType: 'agent' },
}

function makeMachine(): Machine {
  return { id: 'm1', name: 'm1' } as Machine
}

// ---------------------------------------------------------------------------
// syncBoxFiles
// ---------------------------------------------------------------------------

describe('syncBoxFiles', () => {
  test('squad box: skills + squad .env + memory; NO identity; deterministic order', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())

    expect(client.writePaths()).toEqual([
      `${home}/.tau/skills/skill-a/SKILL.md`,
      `${home}/.tau/skills/skill-a/ref/x.md`,
      `${home}/.tau/skills/skill-b/SKILL.md`,
      `${home}/workspace/.tau/.env`,
      `${home}/memory/context.md`,
      `${home}/memory/map.md`,
      `${home}/.ssh/config`,
      `${home}/.ssh/ficus_remote_prod`,
      `${home}/.ssh/ficus_remote_prod.pub`,
      `${home}/.ssh/known_hosts`,
    ])
    // Squad boxes are shared → no per-agent identity key pushed.
    expect(client.writePaths().some((p) => p.includes('identity.pem'))).toBe(false)
  })

  test('every /write creates parent dirs', async () => {
    const client = new FakeClient()
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())
    for (const w of client.writes()) expect(w.createDirs).toBe(true)
  })

  test('no CLI push: never writes ~/bin/tau (the machine-level /usr/local/bin/ficus supersedes it)', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())

    expect(client.writePaths()).not.toContain(`${home}/bin/tau`)
  })

  test('best-effort removes the stale ~/bin/tau shadow on the box-ensure sync', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())

    // Existing boxes carry a stale per-box CLI at ~/bin/tau which shadowed the
    // machine-level CLI on PATH — the ensure sync still clears it.
    expect(client.bashes().map((b) => b.command)).toContain(`rm -f '${home}/bin/tau'`)
  })

  test('a ~/bin/tau removal failure does NOT fail the sync (best-effort)', async () => {
    const client = new FakeClient()
    client.bashExit = 1
    // Solo agent with no artifacts: the only /bash issued is the rm -f, so the
    // nonzero exit exercises exactly the removal's failure path.
    await syncBoxFiles(
      client as any,
      'agent_a1',
      soloAgentOpts,
      fullDeps({
        listSkillFiles: async () => [],
        readIdentityPem: () => null,
      })
    )
    expect(client.bashes().map((b) => b.command)).toContain(`rm -f '${HOME('agent_a1')}/bin/tau'`)
  })

  test('secret-bearing artifacts (squad .env, identity.pem) are created 0600 via /write mode (no chmod window)', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    await syncBoxFiles(client as any, 'agent_a1', squadAgentOpts, fullDeps())

    expect(client.modeAt(`${home}/workspace/.tau/.env`)).toBe('0600')
    expect(client.modeAt(`${home}/.private/identity.pem`)).toBe('0600')
    // No chmod-over-bash follow-ups — the mode lands at creation.
    expect(client.bashes().some((b) => b.command.startsWith('chmod'))).toBe(false)
  })

  test('memory replica is content-push only (no chmod) — read-only convention', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())
    expect(client.bashes().some((b) => b.command.includes(`${home}/memory/`))).toBe(false)
  })

  test('squad ssh dir: key files 0600, config/known_hosts/*.pub 0644, ~/.ssh created 0700', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())

    expect(client.modeAt(`${home}/.ssh/ficus_remote_prod`)).toBe('0600')
    expect(client.modeAt(`${home}/.ssh/ficus_remote_prod.pub`)).toBe('0644')
    expect(client.modeAt(`${home}/.ssh/config`)).toBe('0644')
    expect(client.modeAt(`${home}/.ssh/known_hosts`)).toBe('0644')
    expect(client.bashes().map((b) => b.command)).toContain(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`)
  })

  test('squad ssh dir is skipped cleanly when the squad has no ssh dir yet (no writes, no /bash)', async () => {
    const client = new FakeClient()
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({ listSquadSshFiles: async () => [] })
    )

    expect(client.writePaths().some((p) => p.includes('/.ssh/'))).toBe(false)
    expect(client.bashes().some((b) => b.command.includes('.ssh'))).toBe(false)
  })

  test('squad ssh dir re-materializes before reading it', async () => {
    const client = new FakeClient()
    const calls: string[] = []
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        materializeSquadRemoteHosts: async (squadId: string) => {
          calls.push(`materialize:${squadId}`)
        },
        listSquadSshFiles: async (squadId: string) => {
          calls.push(`list:${squadId}`)
          return []
        },
      })
    )
    expect(calls).toEqual([
      'materialize:11111111-1111-4111-8111-111111111111',
      'list:11111111-1111-4111-8111-111111111111',
    ])
  })

  test('a failure during the ssh push best-effort removes only the private key files written (not config/known_hosts)', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    client.throwOnWrite = (p) => p === `${home}/.ssh/ficus_remote_prod.pub`
    await expect(
      syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())
    ).rejects.toThrow()

    // config and the key ('ficus_remote_prod', sorted before its failing .pub
    // sibling) were written before the throw, so the key gets cleaned up but
    // the non-secret config/known_hosts do not.
    const bashCmds = client.bashes().map((b) => b.command)
    expect(bashCmds).toContain(`rm -f '${home}/.ssh/ficus_remote_prod'`)
    expect(bashCmds.some((c) => c.includes('known_hosts') && c.startsWith('rm -f'))).toBe(false)
    expect(bashCmds.some((c) => c === `rm -f '${home}/.ssh/config'`)).toBe(false)
  })

  test('agent-role box without a squad: no ssh push, no materialize call', async () => {
    const client = new FakeClient()
    let materializeCalled = false
    await syncBoxFiles(
      client as any,
      'agent_a1',
      soloAgentOpts,
      fullDeps({ materializeSquadRemoteHosts: async () => void (materializeCalled = true) })
    )

    expect(materializeCalled).toBe(false)
    expect(client.writePaths().some((p) => p.includes('/.ssh/'))).toBe(false)
  })

  test('solo agent box: skills + identity; NO squad .env, NO memory, NO ssh', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    await syncBoxFiles(client as any, 'agent_a1', soloAgentOpts, fullDeps())

    const paths = client.writePaths()
    expect(paths).toContain(`${home}/.tau/skills/skill-a/SKILL.md`)
    expect(paths).toContain(`${home}/.private/identity.pem`)
    expect(paths.some((p) => p.endsWith('/workspace/.tau/.env'))).toBe(false)
    expect(paths.some((p) => p.includes('/memory/'))).toBe(false)
    expect(paths.some((p) => p.includes('/.ssh/'))).toBe(false)
  })

  test('squad-member agent box: skills + squad .env + identity + ssh; NO memory replica', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    await syncBoxFiles(client as any, 'agent_a1', squadAgentOpts, fullDeps())

    const paths = client.writePaths()
    expect(paths).toContain(`${home}/.tau/skills/skill-a/SKILL.md`)
    expect(paths).toContain(`${home}/workspace/.tau/.env`)
    expect(paths).toContain(`${home}/.private/identity.pem`)
    expect(paths).toContain(`${home}/.ssh/ficus_remote_prod`)
    // Squad memory's canonical vm root is the SQUAD box's ~/memory; a replica
    // on a member box would be an orphan no layout/acceptedRoots references.
    expect(paths.some((p) => p.includes('/memory/'))).toBe(false)
  })

  test('absent artifacts are skipped cleanly (no writes; only the ~/bin/tau shadow removal runs)', async () => {
    const client = new FakeClient()
    await syncBoxFiles(
      client as any,
      'agent_a1',
      squadAgentOpts,
      fullDeps({
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        readIdentityPem: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [],
      })
    )
    expect(client.writes()).toHaveLength(0)
    expect(client.bashes().map((b) => b.command)).toEqual([`rm -f '${HOME('agent_a1')}/bin/tau'`])
  })

  test('a failing /write surfaces as an error', async () => {
    const client = new FakeClient()
    client.throwOnWrite = (p) => p.includes('/.tau/skills/')
    await expect(
      syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())
    ).rejects.toThrow()
  })

  test('per-asset secret cleanup: a failing asset removes only ITS OWN partial secret, not a complete sibling', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    // Fail on identity.pem — which runs AFTER the .env secret pushed fully. Each
    // asset owns its cleanup (mirroring ensureArtifact's all-or-nothing), so the
    // failing identity asset removes its own partial while the already-complete
    // .env is left intact (removing a complete stamped secret would skip-starve
    // the next ensure).
    client.throwOnWrite = (p) => p === `${home}/.private/identity.pem`
    await expect(syncBoxFiles(client as any, 'agent_a1', squadAgentOpts, fullDeps())).rejects.toThrow()

    const bashCmds = client.bashes().map((b) => b.command)
    expect(bashCmds).toContain(`rm -f '${home}/.private/identity.pem'`)
    expect(bashCmds).not.toContain(`rm -f '${home}/workspace/.tau/.env'`)
  })
})

// ---------------------------------------------------------------------------
// syncBoxFiles — content-hash skip
// ---------------------------------------------------------------------------

/** A box row shape carrying the per-asset content-hash stamps. */
function syncBox(syncedHashes: Record<string, unknown> = {}): {
  machineId: string
  syncedHashes: Record<string, unknown>
} {
  return { machineId: 'm1', syncedHashes }
}

/** A recording stamp seam: captures every (name → hash) so a follow-up sync can
 *  replay them as the box's syncedHashes. */
function recordingStamp() {
  const stamped: Record<string, unknown> = {}
  return {
    stamped,
    fn: async (_machineId: string, _sandboxId: string, name: string, hash: string, files?: string[]) =>
      void (stamped[name] = files ? { hash, files } : hash),
  }
}

describe('syncBoxFiles content-hash skip', () => {
  test('a second sync with UNCHANGED fixtures pushes NOTHING except the ~/bin/tau shadow removal', async () => {
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')

    // First sync: fresh stamps, everything pushed.
    const first = new FakeClient()
    const stamp = recordingStamp()
    await syncBoxFiles(
      first as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({ box: syncBox(), stampBoxSyncedHash: stamp.fn })
    )
    expect(first.writes().length).toBeGreaterThan(0)
    // Every asset present for a squad box got a stamp.
    expect(Object.keys(stamp.stamped).sort()).toEqual(['memory', 'skills', 'squad-env', 'squad-ssh'])

    // Second sync: the box now carries those stamps → every asset skips.
    const second = new FakeClient()
    const progress: string[] = []
    await syncBoxFiles(
      second as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ ...stamp.stamped }),
        stampBoxSyncedHash: async () => {},
        trackSetupWork: async (operation) => {
          progress.push('started')
          const result = await operation()
          progress.push('finished')
          return result
        },
      })
    )
    expect(second.writes()).toHaveLength(0)
    // materialize/list still ran (ssh hash needs its output), but no ssh mkdir.
    expect(second.bashes().map((b) => b.command)).toEqual([`rm -f '${home}/bin/tau'`])
    expect(progress).toEqual([])
  })

  test('#788 self-heal: an absent identity.pem is never stamped, so its later appearance on the host always pushes', async () => {
    // Regression coverage gap: the existing 'absent artifacts are skipped
    // cleanly' test above (no box/stamp threaded) can't prove "absent ⇒ no
    // stamp" — stamp() is never called there for ANY asset, present or absent.
    // Thread deps.box + a recording stamp so a real stamp-skip is observable.
    const home = HOME('agent_a1')

    // First sync: identity absent on the host (e.g. an agent that never hit
    // ensure.ts's identity-generation before this fix). Box already carries
    // stamps for the assets that DO exist.
    const stamp = recordingStamp()
    const first = new FakeClient()
    await syncBoxFiles(
      first as any,
      'agent_a1',
      squadAgentOpts,
      fullDeps({ readIdentityPem: () => null, box: syncBox(), stampBoxSyncedHash: stamp.fn })
    )
    expect(first.writePaths()).not.toContain(`${home}/.private/identity.pem`)
    // Absent asset is skipped BEFORE syncAsset/stamp() ever runs for it.
    expect(stamp.stamped.identity).toBeUndefined()

    // Second sync: identity.pem now exists on the host (the ensure-path fix
    // generated it). Nothing was stamped for 'identity' on the first sync, so
    // it is NOT skipped — it pushes even though every other asset's stamp
    // still matches and skips.
    const second = new FakeClient()
    const identityProgress: string[] = []
    await syncBoxFiles(
      second as any,
      'agent_a1',
      squadAgentOpts,
      fullDeps({
        box: syncBox({ ...stamp.stamped }),
        stampBoxSyncedHash: async () => {},
        trackSetupWork: async (operation) => {
          identityProgress.push('started')
          const result = await operation()
          identityProgress.push('finished')
          return result
        },
      })
    )
    expect(second.writePaths()).toEqual([`${home}/.private/identity.pem`])
    expect(identityProgress).toEqual(['started', 'finished'])
  })

  test('changing ONE asset re-pushes only that asset (its stamp updates); the others stay skipped', async () => {
    // Baseline stamps from a first sync.
    const stamp = recordingStamp()
    await syncBoxFiles(
      new FakeClient() as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({ box: syncBox(), stampBoxSyncedHash: stamp.fn })
    )
    const baseline = { ...stamp.stamped }

    // Second sync: change the skills bytes only; box carries the baseline stamps.
    const client = new FakeClient()
    const restamp = recordingStamp()
    const progress: string[] = []
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ ...baseline }),
        stampBoxSyncedHash: restamp.fn,
        trackSetupWork: async (operation) => {
          progress.push('started')
          try {
            const result = await operation()
            progress.push('finished:ready')
            return result
          } catch (error) {
            progress.push('finished:failed')
            throw error
          }
        },
        listSkillFiles: async () => [{ relPath: 'skill-a/SKILL.md', content: Buffer.from('CHANGED') }],
      })
    )

    // Only the skills asset re-pushed (+ re-stamped); env/memory/ssh skipped.
    expect(client.writePaths()).toEqual([`${home}/.tau/skills/skill-a/SKILL.md`])
    expect(Object.keys(restamp.stamped)).toEqual(['skills'])
    expect(restamp.stamped.skills).not.toBe(baseline.skills)
    expect(progress).toEqual(['started', 'finished:ready'])
  })

  test('removes a disappeared managed single file before stamping the empty manifest', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    const stamp = recordingStamp()
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-env': { hash: 'old', files: ['.tau/.env'] } }),
        stampBoxSyncedHash: stamp.fn,
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [],
      })
    )
    expect(client.writePaths()).toEqual([])
    expect(client.bashes().map((b) => b.command)).toContain(`rm -f -- '${home}/workspace/.tau/.env'`)
    expect(stamp.stamped['squad-env']).toMatchObject({ files: [] })
  })

  test('removes only a revoked SSH key from the prior managed manifest', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    const stamp = recordingStamp()
    const sshProgress: string[] = []
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-ssh': { hash: 'old', files: ['config', 'ficus_remote_prod', 'ficus_remote_staging'] } }),
        stampBoxSyncedHash: stamp.fn,
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [
          { relPath: 'config', content: Buffer.from('Host prod') },
          { relPath: 'ficus_remote_prod', content: Buffer.from('KEY') },
        ],
        trackSetupWork: async (operation) => {
          sshProgress.push('started')
          const result = await operation()
          sshProgress.push('finished')
          return result
        },
      })
    )
    const prune = client
      .bashes()
      .map((b) => b.command)
      .find((command) => command.startsWith('rm -f --') && command.includes('/.ssh/'))
    expect(prune).toBe(`rm -f -- '${home}/.ssh/ficus_remote_staging'`)
    expect(stamp.stamped['squad-ssh']).toMatchObject({ files: ['config', 'ficus_remote_prod'] })
    expect(sshProgress).toEqual(['started', 'finished'])
  })

  test('prunes pre-rename tau_remote_ key files from the prior manifest once ficus_remote_ replaces them', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    const stamp = recordingStamp()
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-ssh': { hash: 'old', files: ['config', 'tau_remote_prod'] } }),
        stampBoxSyncedHash: stamp.fn,
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [
          { relPath: 'config', content: Buffer.from('Host prod') },
          { relPath: 'ficus_remote_prod', content: Buffer.from('KEY') },
        ],
      })
    )
    const prune = client
      .bashes()
      .map((b) => b.command)
      .find((command) => command.startsWith('rm -f --') && command.includes('/.ssh/'))
    expect(prune).toBe(`rm -f -- '${home}/.ssh/tau_remote_prod'`)
    expect(stamp.stamped['squad-ssh']).toMatchObject({ files: ['config', 'ficus_remote_prod'] })
  })

  test('legacy SSH tree cleanup removes both ficus_remote_ and pre-rename tau_remote_ key files (K2)', async () => {
    const client = new FakeClient()
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-ssh': 'legacy-hash' }),
        stampBoxSyncedHash: async () => {},
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod', content: Buffer.from('NEW') }],
      })
    )
    const cleanup =
      client
        .bashes()
        .map((b) => b.command)
        .find((command) => command.includes('-delete') && command.includes('/.ssh')) ?? ''
    expect(cleanup).toContain("-name 'ficus_remote_*'")
    expect(cleanup).toContain("-name 'tau_remote_*'")
  })

  test('removes prior squad-scoped secrets when an agent loses squad scope', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    const stamps = recordingStamp()
    await syncBoxFiles(
      client as any,
      'agent_a1',
      soloAgentOpts,
      fullDeps({
        box: syncBox({
          'squad-env': { hash: 'old', files: ['.tau/.env'] },
          'squad-ssh': { hash: 'old', files: ['config', 'ficus_remote_prod'] },
        }),
        stampBoxSyncedHash: stamps.fn,
        listSkillFiles: async () => [],
        readIdentityPem: () => null,
      })
    )
    const commands = client.bashes().map((b) => b.command)
    expect(commands).toContain(`rm -f -- '${home}/workspace/.tau/.env'`)
    expect(commands).toContain(`rm -f -- '${home}/.ssh/config' '${home}/.ssh/ficus_remote_prod'`)
    expect(stamps.stamped['squad-env']).toMatchObject({ files: [] })
    expect(stamps.stamped['squad-ssh']).toMatchObject({ files: [] })
  })

  test('legacy tree hash mismatch clears only the declared Ficus-managed root before rewriting', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    await syncBoxFiles(
      client as any,
      'agent_a1',
      soloAgentOpts,
      fullDeps({
        box: syncBox({ skills: 'legacy-hash' }),
        stampBoxSyncedHash: async () => {},
        readIdentityPem: () => null,
        listSkillFiles: async () => [{ relPath: 'current/SKILL.md', content: Buffer.from('new') }],
      })
    )
    const clearIndex = client.calls.findIndex(
      (call) => call.kind === 'bash' && call.command === `find '${home}/.tau/skills' -mindepth 1 -delete`
    )
    const writeIndex = client.calls.findIndex((call) => call.kind === 'write')
    expect(clearIndex).toBeGreaterThan(-1)
    expect(clearIndex).toBeLessThan(writeIndex)
    expect(
      client
        .bashes()
        .map((b) => b.command)
        .join(' ')
    ).not.toContain(`${home}/workspace`)
  })

  test('legacy SSH hash cleanup removes only Ficus-managed names before rewriting current hosts', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-ssh': 'legacy-hash' }),
        stampBoxSyncedHash: async () => {},
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod', content: Buffer.from('NEW') }],
      })
    )
    const cleanup =
      client
        .bashes()
        .map((b) => b.command)
        .find((command) => command.includes("-name 'ficus_remote_*'")) ?? ''
    expect(cleanup).toContain("-name 'ficus_remote_*'")
    expect(cleanup).toContain(`rm -f -- '${home}/.ssh/config'`)
    expect(cleanup).not.toContain('known_hosts')
    expect(cleanup).not.toContain('id_rsa')
  })

  test('generic secret cleanup publishes and retains its durable fence on ambiguous Bash', async () => {
    const client = new FakeClient()
    client.throwOnWrite = (path) => path.endsWith('/identity.pem')
    const events: string[] = []
    client.bash = ((req: { command: string; invocationId: string }) => {
      client.calls.push({ kind: 'bash', command: req.command })
      const stream = new EventEmitter()
      queueMicrotask(() => stream.emit('error', new BashOutcomeUnknownError(req.invocationId, 'socket_closed')))
      return stream
    }) as any
    await expect(
      syncBoxFiles(
        client as any,
        'agent_a1',
        soloAgentOpts,
        fullDeps({
          listSkillFiles: async () => [],
          readIdentityPem: () => 'SECRET',
          bashFence: {
            before: async (id) => {
              events.push(`before:${id}`)
            },
            after: async (id) => {
              events.push(`after:${id}`)
            },
          },
        })
      )
    ).rejects.toBeInstanceOf(BashOutcomeUnknownError)
    expect(events).toHaveLength(1)
    expect(events[0]).toStartWith('before:')
    expect(client.bashes()).toHaveLength(1)
  })

  test('a permission-only change (mode) re-pushes: the mode is folded into the hash', async () => {
    // squad-ssh: a file that flips from a key (0600) to a *.pub-style 0644 name
    // changes the hash even with identical bytes → re-push.
    const stamp = recordingStamp()
    await syncBoxFiles(
      new FakeClient() as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox(),
        stampBoxSyncedHash: stamp.fn,
        listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod', content: Buffer.from('X') }],
      })
    )
    const client = new FakeClient()
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-ssh': stamp.stamped['squad-ssh'] }),
        stampBoxSyncedHash: async () => {},
        // Same bytes, but now a 0644 (`.pub`) mode → different hash.
        listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod.pub', content: Buffer.from('X') }],
      })
    )
    expect(client.writePaths().some((p) => p.includes('/.ssh/'))).toBe(true)
  })

  test('stamp is written ONLY after all of an asset’s files pushed: a mid-asset failure leaves no stamp', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    const stamp = recordingStamp()
    const progress: string[] = []
    // Fail on the SECOND skill file (sorted): skill-a/ref/x.md.
    client.throwOnWrite = (p) => p === `${home}/.tau/skills/skill-a/ref/x.md`
    await expect(
      syncBoxFiles(
        client as any,
        'squad_11111111-1111-4111-8111-111111111111',
        squadOpts,
        fullDeps({
          box: syncBox(),
          stampBoxSyncedHash: stamp.fn,
          trackSetupWork: async (operation) => {
            progress.push('started')
            try {
              return await operation()
            } catch (error) {
              progress.push('finished:failed')
              throw error
            }
          },
        })
      )
    ).rejects.toThrow()
    // The skills asset failed mid-push → NOT stamped, so the next ensure re-pushes it.
    expect(stamp.stamped).not.toHaveProperty('skills')
    expect(progress).toEqual(['started', 'finished:failed'])
  })

  test('squad-ssh: a newly granted host (materialize OUTPUT changes) re-pushes despite a matching PRIOR stamp', async () => {
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    // First sync with one host → capture its squad-ssh stamp.
    const stamp = recordingStamp()
    const oneHost = fullDeps({
      box: syncBox(),
      stampBoxSyncedHash: stamp.fn,
      listSkillFiles: async () => [],
      readSquadEnv: () => null,
      listMemoryFiles: async () => [],
      listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod', content: Buffer.from('P1') }],
    })
    await syncBoxFiles(new FakeClient() as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, oneHost)

    // Second sync: box carries the one-host stamp, but the materializer now emits
    // a SECOND host → the post-materialize output (and thus the hash) differs → re-push.
    const client = new FakeClient()
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({
        box: syncBox({ 'squad-ssh': stamp.stamped['squad-ssh'] }),
        stampBoxSyncedHash: async () => {},
        listSkillFiles: async () => [],
        readSquadEnv: () => null,
        listMemoryFiles: async () => [],
        listSquadSshFiles: async () => [
          { relPath: 'ficus_remote_prod', content: Buffer.from('P1') },
          { relPath: 'ficus_remote_staging', content: Buffer.from('P2') },
        ],
      })
    )
    expect(client.writePaths()).toContain(`${home}/.ssh/ficus_remote_staging`)
  })

  test('no box row (legacy call shape) pushes everything and stamps nothing', async () => {
    // Byte-identity guard: with no box threaded, behavior is the pre-skip
    // every-ensure push (the golden-master suite above relies on this).
    const client = new FakeClient()
    let stampCalls = 0
    await syncBoxFiles(
      client as any,
      'squad_11111111-1111-4111-8111-111111111111',
      squadOpts,
      fullDeps({ stampBoxSyncedHash: async () => void stampCalls++ })
    )
    expect(client.writes().length).toBeGreaterThan(0)
    expect(stampCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// syncBoxFiles — GOLDEN MASTER
//
// Locks the EXACT ordered sequence of /write and /bash calls syncBoxFiles emits
// for every box role, plus the two failure-cleanup paths. This is the byte-for-
// byte safety net for the manifest refactor: the transport's push order,
// resolved paths, base64 content, and /write mode must not move by a single
// byte. Every assertion below records CURRENT behavior — do not relax it.
// ---------------------------------------------------------------------------

describe('syncBoxFiles golden master', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  /** An expected /write call, mirroring FakeClient's recorded shape exactly
   *  (createDirs is always true; mode is undefined for content-tree assets). */
  const W = (path: string, content: string, mode?: string) => ({
    kind: 'write' as const,
    path,
    content: b64(content),
    createDirs: true,
    mode,
  })
  const B = (command: string) => ({ kind: 'bash' as const, command })

  const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'

  test('squad box: full ordered push sequence (skills, squad .env, memory, ssh; NO identity)', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    await syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())

    expect(client.calls).toEqual([
      B(`rm -f '${home}/bin/tau'`),
      // skills — sorted by relPath, content-only (no /write mode)
      W(`${home}/.tau/skills/skill-a/SKILL.md`, 'A'),
      W(`${home}/.tau/skills/skill-a/ref/x.md`, 'X'),
      W(`${home}/.tau/skills/skill-b/SKILL.md`, 'B'),
      // squad .env — secret, created 0600
      W(`${home}/workspace/.tau/.env`, 'export FOO=bar\n', '0600'),
      // memory replica — sorted, content-only (no mode)
      W(`${home}/memory/context.md`, '# ctx'),
      W(`${home}/memory/map.md`, '# map'),
      // squad ssh — mkdir/chmod 0700 first, then sorted files with per-file mode
      B(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`),
      W(`${home}/.ssh/config`, 'Host prod\n', '0644'),
      W(`${home}/.ssh/ficus_remote_prod`, 'PRIVATE', '0600'),
      W(`${home}/.ssh/ficus_remote_prod.pub`, 'PUBLIC', '0644'),
      W(`${home}/.ssh/known_hosts`, 'prod ssh-ed25519 AAA', '0644'),
    ])
  })

  test('solo agent box: full ordered push sequence (skills + identity only)', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    await syncBoxFiles(client as any, 'agent_a1', soloAgentOpts, fullDeps())

    expect(client.calls).toEqual([
      B(`rm -f '${home}/bin/tau'`),
      W(`${home}/.tau/skills/skill-a/SKILL.md`, 'A'),
      W(`${home}/.tau/skills/skill-a/ref/x.md`, 'X'),
      W(`${home}/.tau/skills/skill-b/SKILL.md`, 'B'),
      // identity key — secret, created 0600 (no squad .env / memory / ssh for a solo agent)
      W(`${home}/.private/identity.pem`, PEM, '0600'),
    ])
  })

  test('squad-member agent box: full ordered push sequence (skills, .env, identity, ssh; NO memory)', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    await syncBoxFiles(client as any, 'agent_a1', squadAgentOpts, fullDeps())

    expect(client.calls).toEqual([
      B(`rm -f '${home}/bin/tau'`),
      W(`${home}/.tau/skills/skill-a/SKILL.md`, 'A'),
      W(`${home}/.tau/skills/skill-a/ref/x.md`, 'X'),
      W(`${home}/.tau/skills/skill-b/SKILL.md`, 'B'),
      // .env before identity (secrets-last, in manifest order); no memory replica on a member box
      W(`${home}/workspace/.tau/.env`, 'export FOO=bar\n', '0600'),
      W(`${home}/.private/identity.pem`, PEM, '0600'),
      B(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`),
      W(`${home}/.ssh/config`, 'Host prod\n', '0644'),
      W(`${home}/.ssh/ficus_remote_prod`, 'PRIVATE', '0600'),
      W(`${home}/.ssh/ficus_remote_prod.pub`, 'PUBLIC', '0644'),
      W(`${home}/.ssh/known_hosts`, 'prod ssh-ed25519 AAA', '0644'),
    ])
  })

  // MERGE NOTE (asset-manifest × content-hash-skip): this test originally
  // locked the pre-hash-skip OUTER cross-asset cleanup (an ssh failure also
  // removed the earlier COMPLETE .env). Under per-asset all-or-nothing
  // stamping, removing a complete (stamped) sibling's secret would skip-starve
  // the next ensure — the stamp says present while the file is gone — so
  // cleanup is now scoped to the failing asset only (see the per-asset secret
  // cleanup test above). The expectation was updated accordingly; every byte
  // BEFORE the cleanup tail is unchanged.
  test('mid-ssh failure: inner key cleanup removes only the ssh asset’s own written key (squad box)', async () => {
    const client = new FakeClient()
    const home = HOME('squad_11111111-1111-4111-8111-111111111111')
    // Fail on the .pub write — ficus_remote_prod (its 0600 sibling) is written first.
    client.throwOnWrite = (p) => p === `${home}/.ssh/ficus_remote_prod.pub`
    await expect(
      syncBoxFiles(client as any, 'squad_11111111-1111-4111-8111-111111111111', squadOpts, fullDeps())
    ).rejects.toThrow()

    expect(client.calls).toEqual([
      B(`rm -f '${home}/bin/tau'`),
      W(`${home}/.tau/skills/skill-a/SKILL.md`, 'A'),
      W(`${home}/.tau/skills/skill-a/ref/x.md`, 'X'),
      W(`${home}/.tau/skills/skill-b/SKILL.md`, 'B'),
      W(`${home}/workspace/.tau/.env`, 'export FOO=bar\n', '0600'),
      W(`${home}/memory/context.md`, '# ctx'),
      W(`${home}/memory/map.md`, '# map'),
      B(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`),
      W(`${home}/.ssh/config`, 'Host prod\n', '0644'),
      W(`${home}/.ssh/ficus_remote_prod`, 'PRIVATE', '0600'),
      // .pub write throws → the ssh asset's own cleanup removes the one 0600 key
      // it wrote (config/known_hosts, not secret, are left). The COMPLETE .env
      // sibling asset is left intact — per-asset cleanup, no cross-asset removal.
      B(`rm -f '${home}/.ssh/ficus_remote_prod'`),
    ])
  })

  // MERGE NOTE (asset-manifest × content-hash-skip): originally locked the
  // pre-hash-skip OUTER cross-asset cleanup (an ssh failure removed the earlier
  // COMPLETE .env and identity secrets). Per-asset cleanup (see the merge note
  // on the mid-ssh test above) leaves complete sibling assets intact, so the
  // failing ssh asset — whose first write (config) threw before any 0600 key
  // landed — has nothing of its own to clean up. Every byte BEFORE the cleanup
  // tail is unchanged.
  test('mid-ssh-config failure: complete sibling secrets (.env, identity) are left intact (squad member)', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    // Fail on the first ssh write (config, sorted first) — both secrets already landed.
    client.throwOnWrite = (p) => p.includes('/.ssh/')
    await expect(syncBoxFiles(client as any, 'agent_a1', squadAgentOpts, fullDeps())).rejects.toThrow()

    expect(client.calls).toEqual([
      B(`rm -f '${home}/bin/tau'`),
      W(`${home}/.tau/skills/skill-a/SKILL.md`, 'A'),
      W(`${home}/.tau/skills/skill-a/ref/x.md`, 'X'),
      W(`${home}/.tau/skills/skill-b/SKILL.md`, 'B'),
      W(`${home}/workspace/.tau/.env`, 'export FOO=bar\n', '0600'),
      W(`${home}/.private/identity.pem`, PEM, '0600'),
      B(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`),
      // config write throws (no 0600 ssh key written → nothing for the failing
      // asset's own cleanup to remove); the complete .env and identity assets
      // are NOT removed — per-asset cleanup never touches complete siblings.
    ])
  })
})

// ---------------------------------------------------------------------------
// pushSquadSshToBox
// ---------------------------------------------------------------------------

describe('pushSquadSshToBox', () => {
  function makeBox(over: Partial<MachineBox> = {}): MachineBox {
    return {
      sandboxId: 'agent_a1',
      machineId: 'm1',
      unixUser: 'box_abc',
      port: 50100,
      status: 'ready',
      updatedAt: new Date(),
      ...over,
    } as MachineBox
  }

  test('no machine_boxes row (docker/k8s live mount) → {pushed:false, reason:"live-mount"}, no client lookup', async () => {
    let clientLookups = 0
    const deps: PushSquadSshToBoxDeps = {
      getMachineBox: async () => null,
      getClient: async () => {
        clientLookups++
        return null
      },
    }
    const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', deps)
    expect(result).toEqual({ pushed: false, reason: 'live-mount' })
    expect(clientLookups).toBe(0)
  })

  test('a box row but no currently-tracked client → {pushed:false, reason:"box-unreachable"}', async () => {
    const deps: PushSquadSshToBoxDeps = {
      getMachineBox: async () => makeBox(),
      getClient: async () => null,
    }
    const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', deps)
    expect(result).toEqual({ pushed: false, reason: 'box-unreachable' })
  })

  test('a reachable box: re-materializes, pushes the ssh artifact set, re-stamps, and reports pushed:true', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    const calls: string[] = []
    const stamps: Array<{ name: string; hash: string }> = []
    const deps: PushSquadSshToBoxDeps = {
      getMachineBox: async () => makeBox(),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async (squadId) => void calls.push(`materialize:${squadId}`),
      listSquadSshFiles: async (squadId) => {
        calls.push(`list:${squadId}`)
        return [
          { relPath: 'ficus_remote_prod', content: Buffer.from('PRIVATE') },
          { relPath: 'config', content: Buffer.from('Host prod\n') },
        ]
      },
      stampBoxSyncedHash: async (_m, _s, name, hash) => void stamps.push({ name, hash }),
    }
    const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', deps)

    expect(result).toEqual({ pushed: true })
    expect(calls).toEqual([
      'materialize:11111111-1111-4111-8111-111111111111',
      'list:11111111-1111-4111-8111-111111111111',
    ])
    expect(client.modeAt(`${home}/.ssh/ficus_remote_prod`)).toBe('0600')
    expect(client.modeAt(`${home}/.ssh/config`)).toBe('0644')
    expect(client.bashes().map((b) => b.command)).toContain(`mkdir -p '${home}/.ssh' && chmod 700 '${home}/.ssh'`)
    // A forced push re-stamps the squad-ssh asset so the box's NEXT full ensure
    // skips this now-current tree.
    expect(stamps).toHaveLength(1)
    expect(stamps[0]?.name).toBe('squad-ssh')
  })

  test('FORCES the push even when the box row already carries a matching squad-ssh stamp', async () => {
    // The on-demand route's whole point is to deliver a just-granted host to a
    // running box NOW; it never consults syncedHashes, so a matching prior stamp
    // must not suppress the write.
    const client = new FakeClient()
    const home = HOME('agent_a1')
    const files = [{ relPath: 'ficus_remote_prod', content: Buffer.from('PRIVATE') }]
    const deps: PushSquadSshToBoxDeps = {
      // A box row whose squad-ssh stamp equals whatever hash this very tree
      // produces would make syncBoxFiles skip — but the on-demand path ignores it.
      getMachineBox: async () => makeBox({ syncedHashes: { 'squad-ssh': 'anything' } } as Partial<MachineBox>),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async () => {},
      listSquadSshFiles: async () => files,
      stampBoxSyncedHash: async () => {},
    }
    const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', deps)
    expect(result).toEqual({ pushed: true })
    expect(client.writePaths()).toContain(`${home}/.ssh/ficus_remote_prod`)
  })

  test('rejects on-demand SSH traversal before any write or Bash effect', async () => {
    const client = new FakeClient()
    await expect(
      pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
        getMachineBox: async () => makeBox(),
        getClient: async () => client as any,
        materializeSquadRemoteHosts: async () => {},
        listSquadSshFiles: async () => [{ relPath: '../escape', content: Buffer.from('secret') }],
      })
    ).rejects.toThrow('invalid managed asset path')
    expect(client.calls).toEqual([])
  })

  test('on-demand legacy SSH cleanup precedes retained-host rewrite and structured stamp', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    const stamps: Array<{ files?: string[] }> = []
    await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
      getMachineBox: async () => makeBox({ syncedHashes: { 'squad-ssh': 'legacy-hash' } }),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async () => {},
      listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod', content: Buffer.from('NEW') }],
      stampBoxSyncedHash: async (_m, _s, _n, _h, files) => void stamps.push({ files }),
    })
    const cleanup = client.calls.findIndex(
      (call) => call.kind === 'bash' && call.command.includes("-name 'ficus_remote_*'")
    )
    const write = client.calls.findIndex((call) => call.kind === 'write')
    expect(cleanup).toBeGreaterThan(-1)
    expect(cleanup).toBeLessThan(write)
    expect(stamps).toEqual([{ files: ['ficus_remote_prod'] }])
    expect(client.bashes()[cleanup].command).not.toContain('known_hosts')
    expect(client.bashes()[cleanup].command).not.toContain('id_rsa')
    expect(client.bashes()[cleanup].command).toContain(`${home}/.ssh/config`)
  })

  test('on-demand legacy SSH cleanup removes both ficus_remote_ and pre-rename tau_remote_ key files (K2)', async () => {
    const client = new FakeClient()
    await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
      getMachineBox: async () => makeBox({ syncedHashes: { 'squad-ssh': 'legacy-hash' } }),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async () => {},
      listSquadSshFiles: async () => [],
      stampBoxSyncedHash: async () => {},
    })
    const cleanup = client.bashes().find((b) => b.command.includes('-delete'))?.command ?? ''
    expect(cleanup).toContain("-name 'ficus_remote_*'")
    expect(cleanup).toContain("-name 'tau_remote_*'")
  })

  test('on-demand legacy final-host revoke cleans generated SSH names and stamps empty', async () => {
    const client = new FakeClient()
    const stamps: Array<{ files?: string[] }> = []
    await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
      getMachineBox: async () => makeBox({ syncedHashes: { 'squad-ssh': 'legacy-hash' } }),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async () => {},
      listSquadSshFiles: async () => [],
      stampBoxSyncedHash: async (_m, _s, _n, _h, files) => void stamps.push({ files }),
    })
    expect(client.bashes().some((bash) => bash.command.includes("-name 'ficus_remote_*'"))).toBe(true)
    expect(client.writes()).toEqual([])
    expect(stamps).toEqual([{ files: [] }])
  })

  test('failed legacy SSH cleanup prevents on-demand writes and stamping', async () => {
    const client = new FakeClient()
    client.bashExit = 1
    let stamps = 0
    await expect(
      pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
        getMachineBox: async () => makeBox({ syncedHashes: { 'squad-ssh': 'legacy-hash' } }),
        getClient: async () => client as any,
        materializeSquadRemoteHosts: async () => {},
        listSquadSshFiles: async () => [{ relPath: 'ficus_remote_prod', content: Buffer.from('NEW') }],
        stampBoxSyncedHash: async () => {
          stamps++
        },
      })
    ).rejects.toThrow('Command failed')
    expect(client.writes()).toEqual([])
    expect(stamps).toBe(0)
  })

  test('final host revocation clears the prior managed SSH manifest before stamping empty', async () => {
    const client = new FakeClient()
    const home = HOME('agent_a1')
    const stamps: Array<{ hash: string; files?: string[] }> = []
    const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
      getMachineBox: async () =>
        makeBox({ syncedHashes: { 'squad-ssh': { hash: 'old', files: ['config', 'ficus_remote_prod'] } } }),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async () => {},
      listSquadSshFiles: async () => [],
      stampBoxSyncedHash: async (_m, _s, _name, hash, files) => void stamps.push({ hash, files }),
    })
    expect(result).toEqual({ pushed: true })
    expect(client.writes()).toEqual([])
    expect(client.bashes().map((b) => b.command)).toEqual([
      `rm -f -- '${home}/.ssh/config' '${home}/.ssh/ficus_remote_prod'`,
    ])
    expect(stamps).toHaveLength(1)
    expect(stamps[0].files).toEqual([])
  })

  test('default client lookup attaches on-miss: a ready row a DIFFERENT process ensured still yields pushed:true', async () => {
    // No deps.getClient injected → production defaultGetClient runs, which must
    // prefer the vm manager's getOrAttachClient so an api-served sync reaches a
    // box the WORKER ensured (the api's in-memory client map is empty).
    const client = new FakeClient()
    const attachCalls: string[] = []
    const spy = spyOn(factory, 'getSandboxManager').mockReturnValue({
      getOrAttachClient: async (sandboxId: string) => {
        attachCalls.push(sandboxId)
        return client as any
      },
      // Tracked-only lookup would MISS — it must not be what decides reachability.
      getClientForSandbox: () => null,
    } as any)
    try {
      const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', {
        getMachineBox: async () => makeBox(),
        materializeSquadRemoteHosts: async () => {},
        listSquadSshFiles: async () => [],
      })
      expect(result).toEqual({ pushed: true })
      expect(attachCalls).toEqual(['agent_a1'])
    } finally {
      spy.mockRestore()
    }
  })

  test('a reachable box with no ssh dir yet: no writes, no /bash, still pushed:true', async () => {
    const client = new FakeClient()
    const deps: PushSquadSshToBoxDeps = {
      getMachineBox: async () => makeBox(),
      getClient: async () => client as any,
      materializeSquadRemoteHosts: async () => {},
      listSquadSshFiles: async () => [],
    }
    const result = await pushSquadSshToBox('11111111-1111-4111-8111-111111111111', 'agent_a1', deps)

    expect(result).toEqual({ pushed: true })
    expect(client.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// resolveBoxApiUrl
// ---------------------------------------------------------------------------

describe('resolveBoxApiUrl', () => {
  test('projects bounded reverse binding and direct-fallback diagnostics', async () => {
    expect(
      await resolveBoxApiTransport(makeMachine(), {
        getCorePort: () => 3000,
        tunnels: {
          addReverse: async () => 1,
          ensureReverseDetailed: async () => ({ remotePort: 40001, binding: 'reused', allocation: 'dynamic' }),
        },
      })
    ).toEqual({ url: 'http://127.0.0.1:40001', reverse: 'reused', allocation: 'dynamic' })
    expect(
      await resolveBoxApiTransport(makeMachine(), {
        getCorePort: () => 3000,
        getAppUrl: () => 'https://user:secret@example.com/?token=hidden',
        sleep: async () => {},
        tunnels: {
          addReverse: async () => {
            throw new Error('secret stderr')
          },
        },
        warn: () => {},
      })
    ).toEqual({ url: 'https://user:secret@example.com/?token=hidden', reverse: 'lost', allocation: 'direct_fallback' })
  })

  test('reverse tunnel is the DEFAULT — a public-looking APP_URL does not bypass it', async () => {
    const seen: Array<{ machine: Machine; localPort: number }> = []
    const url = await resolveBoxApiUrl(makeMachine(), {
      getAppUrl: () => 'https://tau.example.com',
      getCorePort: () => 3000,
      tunnels: {
        addReverse: async (machine, localPort) => {
          seen.push({ machine, localPort })
          return 45678
        },
      },
    })
    expect(url).toBe('http://127.0.0.1:45678')
    expect(seen).toEqual([{ machine: makeMachine(), localPort: 3000 }])
  })

  test('no APP_URL: reverse tunnel still used (it never depended on APP_URL)', async () => {
    const url = await resolveBoxApiUrl(makeMachine(), {
      getAppUrl: () => undefined,
      getCorePort: () => 3000,
      tunnels: { addReverse: async () => 46000 },
    })
    expect(url).toBe('http://127.0.0.1:46000')
  })

  test('an ambiguous tunnel outcome is never retried before degraded fallback', async () => {
    let attempts = 0
    const error = Object.assign(new Error('unknown'), { code: 'TUNNEL_OUTCOME_UNKNOWN' })
    const url = await resolveBoxApiUrl(makeMachine(), {
      getAppUrl: () => 'https://tau.example.com',
      getCorePort: () => 3000,
      tunnels: {
        addReverse: async () => {
          attempts++
          throw error
        },
      },
      sleep: async () => {
        throw new Error('must not sleep')
      },
      warn: () => {},
    })
    expect(url).toBe('https://tau.example.com')
    expect(attempts).toBe(1)
  })

  test('a TRANSIENT addReverse failure is retried once — tunnel URL returned, no fallback, no warn', async () => {
    let attempts = 0
    const sleeps: number[] = []
    const warns: string[] = []
    const url = await resolveBoxApiUrl(makeMachine(), {
      getAppUrl: () => 'https://tau.example.com',
      getCorePort: () => 3000,
      tunnels: {
        addReverse: async () => {
          attempts++
          if (attempts === 1) throw new Error('ssh -O forward exited 1') // transient (MaxSessions pressure)
          return 47000
        },
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      warn: (msg) => {
        warns.push(msg)
      },
    })
    expect(url).toBe('http://127.0.0.1:47000')
    expect(attempts).toBe(2)
    expect(sleeps).toHaveLength(1) // one pause before the single retry, injectable so tests don't sleep
    expect(warns).toHaveLength(0) // healthy outcome — no degradation to report
  })

  test('addReverse failing BOTH attempts falls back to a valid APP_URL AND warns (visible degradation)', async () => {
    let attempts = 0
    const warns: string[] = []
    const url = await resolveBoxApiUrl(makeMachine(), {
      getAppUrl: () => 'https://tau.example.com',
      getCorePort: () => 3000,
      tunnels: {
        addReverse: async () => {
          attempts++
          throw new Error('tcp forwarding disabled')
        },
      },
      sleep: async () => {},
      warn: (msg) => {
        warns.push(msg)
      },
    })
    expect(url).toBe('https://tau.example.com')
    expect(attempts).toBe(2)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toBe('reverse tunnel failed twice; using degraded direct callback fallback')
    expect(warns[0]).not.toContain('tcp forwarding disabled')
    expect(warns[0]).not.toContain('tau.example.com')
  })

  test('addReverse failure with NO APP_URL throws a bounded safe error after retry', async () => {
    let attempts = 0
    await expect(
      resolveBoxApiUrl(makeMachine(), {
        getAppUrl: () => undefined,
        getCorePort: () => 3000,
        tunnels: {
          addReverse: async () => {
            attempts++
            throw new Error('tcp forwarding disabled')
          },
        },
        sleep: async () => {},
      })
    ).rejects.toThrow('cannot resolve a core callback URL after bounded reverse-tunnel recovery')
    expect(attempts).toBe(2)
  })

  test('addReverse failure with an INVALID APP_URL throws a bounded safe error', async () => {
    await expect(
      resolveBoxApiUrl(makeMachine(), {
        getAppUrl: () => 'not a url',
        getCorePort: () => 3000,
        tunnels: {
          addReverse: async () => {
            throw new Error('boom')
          },
        },
        sleep: async () => {},
      })
    ).rejects.toThrow('cannot resolve a core callback URL after bounded reverse-tunnel recovery')
  })

  test('isValidHttpUrl checks http(s) URL validity only (NOT reachability)', () => {
    expect(isValidHttpUrl('https://tau.example.com')).toBe(true)
    expect(isValidHttpUrl('http://1.2.3.4:3000')).toBe(true)
    expect(isValidHttpUrl('http://localhost:3000')).toBe(true)
    expect(isValidHttpUrl('ftp://tau.example.com')).toBe(false)
    expect(isValidHttpUrl('not a url')).toBe(false)
  })
})
