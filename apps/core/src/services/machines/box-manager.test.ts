import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { db, machineBoxes } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  ARCHIVE_CODEC_PROBE_COMMAND,
  BoxArchiveStreamError,
  BoxEnvValidationError,
  BoxHealthTimeoutError,
  BoxStopUnverifiedError,
  type BoxManagerDeps,
  DEFAULT_BOX_HEALTH_BUDGET_MS,
  LISTENING_FRESH_MS,
  MachineUnavailableError,
  MachineUnusableError,
  boxUnitControl,
  boxUnixUser,
  boxStatus,
  boxChainHealth,
  durableStateDirsForRole,
  buildArchiveStreamCommand,
  buildStateDirFactsCommand,
  buildStreamRestoreCommand,
  checkDestinationBaseline,
  compareStateDirFacts,
  computeProvisioningMarker,
  describeProvisioningMarkerDrift,
  detectArchiveCodec,
  ensureBox,
  expectedStateDirMode,
  externalizeUnverifiedStop,
  findLatestPrivateArchive,
  installBoxOnMachine,
  listListeningLoopbackPorts,
  buildMachineSnapshotCommand,
  measureBoxStateDirs,
  parseListeningLoopbackPorts,
  parseBoxUid,
  parseMachineSnapshotOutput,
  parseStateDirFacts,
  pullPrivateArchive,
  removeBox,
  removeBoxUserOnMachine,
  resolveBoxHealthBudgetMs,
  resolveMachineForBox,
  restorePrivateArchive,
  stopBox,
  streamBoxStateArchive,
  teardownBoxOnMachine,
  queryReadySharedMachines,
  roleWantsDocker,
  tarCodecFlag,
} from './box-manager'
import { insertMachine, deleteMachine, listMachines, upsertMachineBox } from './queries'
import type { Machine, MachineBox } from './queries'
import type { SshResult, SshRunner, SshStreamer } from './ssh'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'box-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.5',
    sshPort: 22,
    sshUser: 'tau',
    sshKeyId: 'secret-key',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: { forwarding: 'yes' },
    scope: 'shared',
    bootstrapVersion: null,
    artifactVersions: {},
    lastSeenAt: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  } as Machine
}

function makeBox(overrides: Partial<MachineBox> = {}): MachineBox {
  return {
    sandboxId: 'sb-1',
    machineId: '11111111-1111-1111-1111-111111111111',
    unixUser: boxUnixUser('sb-1'),
    port: 50100,
    status: 'ensuring',
    // Post-hardening rows carry a per-box executor auth token; the fast-path
    // requires it (a legacy null-token box re-provisions once to mint one).
    authToken: 'tok-existing',
    updatedAt: new Date(),
    ...overrides,
  } as MachineBox
}

interface RecordedCall {
  command: string
  stdin?: string
  /** The SSH budget the caller asked for. Recorded because a dropped budget is
   *  invisible otherwise — see "both slow SSH steps get the caller's budget". */
  timeoutMs?: number
}

/** Fake runner: records every command, classifies it into the shared event log,
 *  and returns exit 0 by default (override via `handler`). */
function makeFakeRunner(
  events: string[],
  handler?: (command: string) => SshResult | Error | undefined
): { runner: SshRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const runner: SshRunner = {
    async run(_machine, command, opts): Promise<SshResult> {
      const stdin = opts?.stdin === undefined ? undefined : String(opts.stdin)
      calls.push({ command, stdin, timeoutMs: opts?.timeoutMs })
      if (command.includes('box-provision.sh') && command.includes('--remove')) events.push('remove')
      else if (command.includes('box-provision.sh')) events.push('provision')
      else if (command.includes('server.env')) events.push('env')
      else if (command.includes('systemctl') && command.includes('restart')) events.push('restart')
      else if (command.includes('systemctl') && command.includes('stop')) events.push('stop')
      else if (command.includes('tar czf')) events.push('archive')
      const reply = handler?.(command)
      if (reply instanceof Error) throw reply
      if (reply) return reply
      // box-provision prints the box user's useradd-assigned uid on stdout
      // (`FICUS_BOX_UID=<uid>`) so box-manager can bake the rootless DOCKER_HOST
      // socket path. Default provisions report a stable fake uid.
      if (command.includes('box-provision.sh') && !command.includes('--remove')) {
        return { exitCode: 0, stdout: 'FICUS_BOX_UID=4321\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  return { runner, calls }
}

interface FakeTunnels {
  ensureMaster: (m: Machine) => Promise<void>
  addForward: (m: Machine, port: number) => Promise<number>
  removeForward: (m: Machine, port: number) => Promise<void>
  endpointFor: (machineId: string, port: number) => string | null
  checkHealth: (machineId: string) => Promise<boolean>
}

function makeFakeTunnels(
  events: string[],
  opts?: { endpoint?: string | null; localPort?: number; masterAlive?: boolean }
): FakeTunnels {
  // Mirrors the real BoxTunnels.checkHealth contract: a dead master PURGES its
  // forwards, so endpointFor reports null from then on.
  let purged = false
  return {
    async ensureMaster() {
      events.push('ensureMaster')
    },
    async addForward() {
      events.push('forward')
      return opts?.localPort ?? 59999
    },
    async removeForward() {
      events.push('removeForward')
    },
    endpointFor() {
      if (purged) return null
      return opts?.endpoint === undefined ? 'http://127.0.0.1:59999' : opts.endpoint
    },
    async checkHealth() {
      events.push('checkHealth')
      const alive = opts?.masterAlive ?? true
      if (!alive) purged = true
      return alive
    },
  }
}

function makeFakeFetch(events: string[], results: Array<{ ok: boolean; status: number }>): typeof fetch {
  let i = 0
  return (async () => {
    events.push('health')
    const r = results[Math.min(i, results.length - 1)]
    i++
    return { ok: r.ok, status: r.status } as Response
  }) as unknown as typeof fetch
}

/** Keep only the established endpoint HTTP-dead; a recreated box gets a fresh
 * local forward and must be allowed to pass its separate provisioning poll. */
function establishedDeadFreshHealthyDeps(events: string[]) {
  const tunnels = makeFakeTunnels(events)
  let forwards = 0
  tunnels.addForward = async () => {
    events.push('forward')
    forwards++
    return forwards === 1 ? 59999 : 60000
  }
  const fetch: typeof globalThis.fetch = (async (url: string) => {
    events.push('health')
    const established = url.includes(':59999/healthz')
    return { ok: !established, status: established ? 503 : 200 } as Response
  }) as unknown as typeof fetch
  return { tunnels, fetch }
}

/** Baseline deps that make a full ensure succeed. Callers override pieces. */
function happyDeps(events: string[], machine: Machine, box: MachineBox) {
  const { runner, calls } = makeFakeRunner(events)
  const upserts: Array<{
    sandboxId: string
    status?: string
    authToken?: string | null
    provisionedSpecHash?: string | null
    reconcilableSpecHash?: string | null
  }> = []
  const binds: string[] = []
  const deps = {
    runner,
    tunnels: makeFakeTunnels(events),
    fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
    getMachine: async () => machine,
    getMachineBox: async () => null as MachineBox | null,
    findPrivateArchive: async () => null,
    // installBoxOnMachine wipes the box's per-asset content-hash stamps before a
    // (re)provision so file-sync re-pushes every asset onto the rebuilt box.
    clearBoxSyncedHashes: async () => {
      events.push('clear-stamps')
    },
    ensureMachineArtifacts: async () => {
      events.push('bundle')
    },
    bindMachineBox: async () => {
      events.push('bind')
      binds.push(box.sandboxId)
      // Mirror the real bindMachineBox contract: the bind upsert mints the
      // token atomically (COALESCE keeps an existing one), so the returned row
      // ALWAYS carries the persisted auth token.
      return { ...box, authToken: box.authToken ?? randomBytes(32).toString('hex') } as MachineBox
    },
    upsertMachineBox: async (b: {
      sandboxId: string
      status?: string
      machineId: string
      unixUser: string
      port: number
      authToken?: string | null
      provisionedSpecHash?: string | null
      reconcilableSpecHash?: string | null
    }) => {
      // ensureBox stamps 'ensuring' when a (re-)provision begins, then 'ready'
      // once healthy — surface both so ordering tests can see the stamp.
      events.push(b.status === 'ready' ? 'ready' : 'ensuring')
      upserts.push({
        sandboxId: b.sandboxId,
        status: b.status,
        authToken: b.authToken,
        provisionedSpecHash: b.provisionedSpecHash,
        reconcilableSpecHash: b.reconcilableSpecHash,
      })
      return {
        ...box,
        status: b.status ?? box.status,
        provisionedSpecHash: b.provisionedSpecHash,
        reconcilableSpecHash: b.reconcilableSpecHash,
      } as MachineBox
    },
    healthBudgetMs: 10_000,
    sleep: async () => {},
  }
  return { deps, calls, upserts, binds }
}

// ---------------------------------------------------------------------------
// boxUnixUser
// ---------------------------------------------------------------------------

describe('legacy TAU_ output markers (one release)', () => {
  it('parses the box uid from either marker spelling', () => {
    expect(parseBoxUid('noise\nFICUS_BOX_UID=1001\n')).toBe(1001)
    expect(parseBoxUid('noise\nTAU_BOX_UID=1001\n')).toBe(1001)
    expect(parseBoxUid('BOX_UID=1001\n')).toBeNull()
  })

  it('parses machine snapshot liveness and sections from either marker spelling', () => {
    for (const prefix of ['FICUS', 'TAU']) {
      expect(
        parseMachineSnapshotOutput(
          `${prefix}_BOX_LIVENESS=idle\n${prefix}_CONTAINER_STATES_BEGIN\nworker Up\n${prefix}_CONTAINER_STATES_END\n` +
            `${prefix}_BOX_LOGS_BEGIN\nloaded\n${prefix}_BOX_LOGS_END\n`
        )
      ).toEqual({ liveness: 'idle', containerStates: 'worker Up', logTail: 'loaded' })
    }
    expect(parseMachineSnapshotOutput('FICUS_STATE_BEGIN\nx\nTAU_STATE_END\n')).toEqual({
      liveness: undefined,
      containerStates: undefined,
      logTail: undefined,
    })
  })
})

describe('boxUnixUser', () => {
  it('is box_ + first 12 hex of sha256(sandboxId)', () => {
    const hash = createHash('sha256').update('sb-1').digest('hex').slice(0, 12)
    expect(boxUnixUser('sb-1')).toBe(`box_${hash}`)
    expect(boxUnixUser('sb-1')).toMatch(/^box_[0-9a-f]{12}$/)
  })
})

// ---------------------------------------------------------------------------
// ensureBox — happy path ordering
// ---------------------------------------------------------------------------

describe('ensureBox', () => {
  it('delivers the full machine artifact set (server + cli) via the ensureMachineArtifacts dep BEFORE binding', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)

    await ensureBox(
      { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' },
      {
        ...deps,
        ensureMachineArtifacts: async () => {
          events.push('artifacts')
        },
      }
    )

    // The artifact ensure (box-provision.sh + server bundle + tau cli, per the
    // registry) must land on the machine before the box row is bound /
    // provisioning begins.
    expect(events.indexOf('artifacts')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('artifacts')).toBeLessThan(events.indexOf('bind'))
  })

  it('an artifact ensure failure (e.g. the cli build/push) PROPAGATES: ensureBox throws, nothing bound, box never marked ready', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, upserts } = happyDeps(events, machine, box)

    const progress: string[] = []
    await expect(
      ensureBox(
        {
          sandboxId: 'sb-1',
          machineId: machine.id,
          env: {},
          role: 'squad',
          beginPhysicalWork: (reason) => {
            progress.push(`started:${reason}`)
            return (outcome) => progress.push(`finished:${outcome}`)
          },
        },
        {
          ...deps,
          ensureMachineArtifacts: async () => {
            throw new Error('tau cli build failed (exit 1)')
          },
        }
      )
    ).rejects.toThrow('tau cli build failed')

    // A required artifact failed — the ensure must abort before any mutation:
    // no bind, no provision, and the box is never stamped ready.
    expect(events).not.toContain('bind')
    expect(events).not.toContain('ready')
    expect(upserts.every((u) => u.status !== 'ready')).toBe(true)
    expect(progress).toEqual(['started:runtime_start', 'finished:failed'])
  })

  it('runs the full sequence in order: bundle → bind → ensuring → provision → env → restart → forward → health → ready', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, upserts, calls } = happyDeps(events, machine, box)

    const result = await ensureBox(
      { sandboxId: 'sb-1', machineId: machine.id, env: { FOO: 'bar' }, role: 'squad' },
      deps
    )

    expect(events).toEqual([
      'bundle',
      'bind',
      'ensuring',
      'clear-stamps',
      'provision',
      'env',
      'restart',
      'ensureMaster',
      'forward',
      'health',
      'ready',
    ])
    expect(result.machine.id).toBe(machine.id)
    expect(result.endpoint).toBe('http://127.0.0.1:59999')
    expect(upserts.at(-1)?.status).toBe('ready')

    // The env push is built via ssh.ts's buildPushFileCommand + a chown suffix;
    // its final command string must be byte-identical to the prior inline form.
    const user = boxUnixUser('sb-1')
    const envPath = `/home/${user}/.tau/server.env`
    const envCall = calls.find((c) => c.command.includes('server.env'))!
    expect(envCall.command).toBe(
      `sudo install -m 0600 /dev/stdin '${envPath}' && sudo chown ${user}:${user} '${envPath}'`
    )
  })

  it('a full (re)provision returns a timings breakdown covering artifacts/provision/start, and a priorBoxesOnMachine annotation from listMachineBoxes', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    let tick = 0
    ;(deps as { now?: () => number }).now = () => (tick += 100)
    const otherBox = makeBox({ sandboxId: 'sb-other', machineId: machine.id })
    ;(deps as { listMachineBoxes?: (id: string) => Promise<MachineBox[]> }).listMachineBoxes = async (id) => {
      expect(id).toBe(machine.id)
      return [otherBox, { ...box, sandboxId: 'sb-1' } as MachineBox]
    }

    const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(result.timings?.artifacts).toBeGreaterThan(0)
    expect(result.timings?.provision).toBeGreaterThan(0)
    expect(result.timings?.start).toBeGreaterThan(0)
    // health is the FAST-path-only bucket; a full provision never records it.
    expect(result.timings?.health).toBeUndefined()
    // 1 other box row on the machine (sb-1 itself is excluded from the count).
    expect(result.priorBoxesOnMachine).toBe(1)
  })

  it('the fast healthy-box path returns a `health` timing and leaves priorBoxesOnMachine undefined (no extra query on the hot path)', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    let tick = 0
    ;(deps as { now?: () => number }).now = () => (tick += 100)
    let queried = false
    ;(deps as { listMachineBoxes?: (id: string) => Promise<MachineBox[]> }).listMachineBoxes = async () => {
      queried = true
      return []
    }

    const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(result.timings?.health).toBeGreaterThan(0)
    expect(result.timings?.artifacts).toBeUndefined()
    expect(result.priorBoxesOnMachine).toBeUndefined()
    expect(queried).toBe(false)
  })

  it('a ready box whose provisioning marker drifted (rotated secret / squad githubIdentity change) re-provisions to re-push env', async () => {
    // The staleness bug: a squad_bash call re-ensured an already-running squad
    // box after its githubIdentity override was set. resolveGitHubIdentity
    // produced the new token, so opts.specHash (the env-inclusive provisioning
    // marker) drifted from the box's stamped provisionedSpecHash — but the
    // healthy fast-path returned the box on health alone and never re-pushed
    // server.env, so the box kept the OLD (global) token. A ready box whose
    // marker drifted must fall through to a full (re)provision, exactly like a
    // PARKED box already does in the resume fast-path.
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready', provisionedSpecHash: 'old-marker' })
    const { deps, upserts } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox

    const progress: string[] = []
    const result = await ensureBox(
      {
        sandboxId: 'sb-1',
        machineId: machine.id,
        env: { GITHUB_TOKEN: 'override' },
        role: 'squad',
        specHash: 'new-marker',
        beginPhysicalWork: (reason) => {
          progress.push(`started:${reason}`)
          return (outcome) => progress.push(`finished:${outcome}`)
        },
      },
      deps
    )

    // Re-provisioned: server.env is pushed and the unit restarted (NOT the
    // health-only fast path). The full sequence stamps the fresh marker.
    expect(events).toContain('env')
    expect(events).toContain('restart')
    expect(result.timings?.health).toBeUndefined()
    expect(upserts.at(-1)?.status).toBe('ready')
    expect(upserts.at(-1)?.provisionedSpecHash).toBe('new-marker')
    expect(progress).toEqual(['started:spec_reconcile', 'finished:ready'])
  })

  it('a busy box that misses one health probe then recovers is KEPT on the fast path (retried, not re-provisioned)', async () => {
    // The flapping bug: under a CPU-heavy in-box build the sandbox-server misses
    // one 2s /healthz probe; a single-probe fast path would re-provision, killing
    // the running exec/monitor. Retry must keep the box instead.
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    ;(deps as { healthRecheckGapMs?: number }).healthRecheckGapMs = 0
    // First probe fails (socket closed under load), the retry succeeds.
    deps.fetch = makeFakeFetch(events, [
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ])

    const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    // Kept on the fast path: no re-provision (a re-provision would ensure
    // artifacts), the box stays ready, and the probe was RETRIED not condemned.
    expect(result.box.status).toBe('ready')
    expect(result.timings?.artifacts).toBeUndefined()
    expect(events.filter((e) => e === 'health').length).toBe(2)
  })

  it('consults machine SSH after the established HTTP recheck fails and keeps a running box that recovers', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    deps.fetch = makeFakeFetch(events, [
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ])
    deps.runner = makeFakeRunner(events, (command) => {
      if (!command.includes('FICUS_BOX_LIVENESS')) return { exitCode: 0, stdout: '', stderr: '' }
      events.push('machine-second-opinion')
      return {
        exitCode: 0,
        stdout:
          'FICUS_BOX_LIVENESS=running\nFICUS_CONTAINER_STATES_BEGIN\nworker Up 5 minutes\nFICUS_CONTAINER_STATES_END\nFICUS_BOX_LOGS_BEGIN\nloaded\nFICUS_BOX_LOGS_END\n',
        stderr: '',
      }
    }).runner
    Object.assign(deps, {
      establishedActiveGraceMs: 20,
      establishedIdleGraceMs: 20,
      establishedGraceInitialGapMs: 1,
      hasActiveExecution: async () => true,
    })

    const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(result.box.status).toBe('ready')
    expect(result.timings?.artifacts).toBeUndefined()
    expect(events).toContain('machine-second-opinion')
    expect(events.indexOf('machine-second-opinion')).toBeLessThan(events.lastIndexOf('health'))
  })

  it('preserves refusal versus abort-timeout kind and elapsed milliseconds in condemnation evidence', async () => {
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })

    const condemnWith = async (error: unknown, clockStepMs: number) => {
      const events: string[] = []
      const { deps } = happyDeps(events, machine, readyBox)
      deps.getMachineBox = async () => readyBox
      const { tunnels } = establishedDeadFreshHealthyDeps(events)
      deps.tunnels = tunnels
      deps.fetch = (async (url: string) => {
        events.push('health')
        if (url.includes(':59999/healthz')) throw error
        return { ok: true, status: 200 } as Response
      }) as unknown as typeof fetch
      deps.runner = makeFakeRunner(events, (command) =>
        command.includes('FICUS_BOX_LIVENESS')
          ? { exitCode: 0, stdout: 'FICUS_BOX_LIVENESS=exited\n', stderr: '' }
          : undefined
      ).runner
      let clock = 0
      let evidence: any
      Object.assign(deps, {
        now: () => {
          const value = clock
          clock += clockStepMs
          return value
        },
        sleep: async () => {},
        healthRecheckGapMs: 0,
        persistCondemnationEvidence: async (record: unknown) => {
          evidence = record
        },
      })

      await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)
      return evidence.probes
    }

    const refusalProbes = await condemnWith({ cause: { cause: { code: 'ECONNREFUSED' } } }, 10)
    const namedRefusalProbes = await condemnWith({ name: 'ConnectionRefused' }, 11)
    const resetProbes = await condemnWith(new TypeError('socket connection reset by peer'), 7)
    const timeoutProbes = await condemnWith(new DOMException('operation timed out', 'TimeoutError'), 2_000)

    expect(refusalProbes.every((probe: any) => probe.kind === 'refused' && probe.elapsedMs === 10)).toBe(true)
    expect(refusalProbes.every((probe: any) => probe.elapsedMs < 50)).toBe(true)
    expect(namedRefusalProbes.every((probe: any) => probe.kind === 'refused' && probe.elapsedMs === 11)).toBe(true)
    expect(resetProbes.every((probe: any) => probe.kind === 'reset' && probe.elapsedMs === 7)).toBe(true)
    expect(timeoutProbes.every((probe: any) => probe.kind === 'abort_timeout' && probe.elapsedMs === 2_000)).toBe(true)
  })

  it('repairs a refused tunnel for a machine-running box and retries through the fresh endpoint before grace', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    const { tunnels } = establishedDeadFreshHealthyDeps(events)
    deps.tunnels = tunnels
    deps.fetch = (async (url: string) => {
      events.push('health')
      if (url.includes(':59999/healthz')) {
        try {
          await globalThis.fetch('http://127.0.0.1:1')
        } catch (refused) {
          // Pin the runtime boundary, not a hand-written Node error: Bun puts
          // ConnectionRefused directly on the thrown value's top-level code.
          expect((refused as { code?: unknown }).code).toBe('ConnectionRefused')
          throw refused
        }
        throw new Error('expected Bun fetch to refuse port 1')
      }
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch
    deps.runner = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS')
        ? { exitCode: 0, stdout: 'FICUS_BOX_LIVENESS=running\n', stderr: '' }
        : undefined
    ).runner
    let elapsed = 0
    Object.assign(deps, {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms
      },
      healthRecheckGapMs: 0,
      establishedActiveGraceMs: 5,
      establishedIdleGraceMs: 5,
      establishedGraceInitialGapMs: 5,
      hasActiveExecution: async () => {
        throw new Error('grace tier must not be consulted after successful tunnel repair')
      },
      persistCondemnationEvidence: async () => {
        throw new Error('a repaired tunnel must not condemn the box')
      },
    })

    const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(result.endpoint).toBe('http://127.0.0.1:60000')
    expect(events.filter((event) => event === 'forward')).toHaveLength(2)
    expect(events).toContain('removeForward')
    expect(events.indexOf('removeForward')).toBeLessThan(events.lastIndexOf('forward'))
    expect(events).not.toContain('bundle')
  })

  it('an active execution receives the full established-box grace budget', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    Object.assign(deps, establishedDeadFreshHealthyDeps(events))
    deps.runner = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS')
        ? { exitCode: 0, stdout: 'FICUS_BOX_LIVENESS=running\n', stderr: '' }
        : undefined
    ).runner
    let elapsed = 0
    const persisted: unknown[] = []
    Object.assign(deps, {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms
      },
      healthRecheckGapMs: 0,
      establishedActiveGraceMs: 40,
      establishedIdleGraceMs: 10,
      establishedGraceInitialGapMs: 10,
      hasActiveExecution: async () => true,
      persistCondemnationEvidence: async (record: unknown) => {
        persisted.push(record)
        events.push('evidence')
      },
    })

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(elapsed).toBe(40)
    expect(events.filter((event) => event === 'health').length).toBeGreaterThan(4)
    expect(persisted).toHaveLength(1)
  })

  it('an idle established box uses the short grace tier', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    Object.assign(deps, establishedDeadFreshHealthyDeps(events))
    deps.runner = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS')
        ? { exitCode: 0, stdout: 'FICUS_BOX_LIVENESS=running\n', stderr: '' }
        : undefined
    ).runner
    let elapsed = 0
    Object.assign(deps, {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms
      },
      healthRecheckGapMs: 0,
      establishedActiveGraceMs: 40,
      establishedIdleGraceMs: 10,
      establishedGraceInitialGapMs: 10,
      hasActiveExecution: async () => false,
      persistCondemnationEvidence: async () => {
        events.push('evidence')
      },
    })

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(elapsed).toBe(10)
    expect(events.filter((event) => event === 'health')).toHaveLength(5)
  })

  it('eventually condemns a still-running but HTTP-dead established box and persists its reason chain first', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    Object.assign(deps, establishedDeadFreshHealthyDeps(events))
    deps.runner = makeFakeRunner(events, (command) => {
      if (command.includes('FICUS_BOX_LIVENESS')) {
        return {
          exitCode: 0,
          stdout:
            'FICUS_BOX_LIVENESS=running\nFICUS_CONTAINER_STATES_BEGIN\njob Up 1 minute\nFICUS_CONTAINER_STATES_END\nFICUS_BOX_LOGS_BEGIN\nstalled\nFICUS_BOX_LOGS_END\n',
          stderr: '',
        }
      }
      return undefined
    }).runner
    let elapsed = 0
    let evidence: any
    Object.assign(deps, {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms
      },
      healthRecheckGapMs: 0,
      establishedActiveGraceMs: 20,
      establishedIdleGraceMs: 5,
      establishedGraceInitialGapMs: 5,
      hasActiveExecution: async () => true,
      persistCondemnationEvidence: async (record: unknown) => {
        evidence = record
        events.push('evidence')
      },
    })

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(elapsed).toBe(20)
    expect(events).toContain('bundle')
    expect(events.indexOf('evidence')).toBeLessThan(events.indexOf('bundle'))
    expect(evidence.classification).toBe('running_http_dead')
    expect(evidence.probes).toHaveLength(6)
    expect(
      evidence.probes.every(
        (probe: any) =>
          probe.kind === 'http_status' &&
          probe.status === 503 &&
          probe.elapsedMs === 0 &&
          probe.observedAt instanceof Date
      )
    ).toBe(true)
    expect(evidence.machineSnapshot.containerStates).toContain('job Up 1 minute')
    expect(evidence.machineSnapshot.logTail).toContain('stalled')
  })

  it('condemns immediately when machine SSH reports the box exited, with durable evidence', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    Object.assign(deps, establishedDeadFreshHealthyDeps(events))
    deps.runner = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS')
        ? {
            exitCode: 0,
            stdout: 'FICUS_BOX_LIVENESS=exited\nFICUS_BOX_LOGS_BEGIN\nexit 137\nFICUS_BOX_LOGS_END\n',
            stderr: '',
          }
        : undefined
    ).runner
    let evidence: any
    Object.assign(deps, {
      persistCondemnationEvidence: async (record: unknown) => {
        evidence = record
        events.push('evidence')
      },
    })

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(evidence.classification).toBe('exited')
    expect(evidence.machineSnapshot.logTail).toContain('exit 137')
    expect(events.indexOf('evidence')).toBeLessThan(events.indexOf('bundle'))
    expect(events.filter((event) => event === 'health')).toHaveLength(4)
  })

  it('records unreachable machine SSH and snapshot failure without blocking recreate', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    Object.assign(deps, establishedDeadFreshHealthyDeps(events))
    deps.runner = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS') ? new Error('ssh connect timeout') : undefined
    ).runner
    let evidence: any
    Object.assign(deps, {
      persistCondemnationEvidence: async (record: unknown) => {
        evidence = record
        events.push('evidence')
      },
    })

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(evidence.classification).toBe('machine_unreachable')
    expect(evidence.machineSnapshot.error).toContain('ssh connect timeout')
    expect(events.indexOf('evidence')).toBeLessThan(events.indexOf('bundle'))
  })

  it('does not condemn when the reason chain cannot be durably persisted', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    deps.fetch = makeFakeFetch(events, [{ ok: false, status: 503 }])
    deps.runner = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS')
        ? { exitCode: 0, stdout: 'FICUS_BOX_LIVENESS=exited\n', stderr: '' }
        : undefined
    ).runner
    Object.assign(deps, {
      persistCondemnationEvidence: async () => {
        throw new Error('database unavailable')
      },
    })

    await expect(ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)).rejects.toThrow(
      'database unavailable'
    )
    expect(events).not.toContain('bundle')
    expect(events).not.toContain('provision')
  })

  it('a listMachineBoxes failure is swallowed (best-effort annotation, never fails the ensure)', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    ;(deps as { listMachineBoxes?: (id: string) => Promise<MachineBox[]> }).listMachineBoxes = async () => {
      throw new Error('db unavailable')
    }

    const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    expect(result.box.status).toBe('ready')
    expect(result.priorBoxesOnMachine).toBeUndefined()
  })

  it('pushes server.env with mode 0600 and chowns it to the box user', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: { FOO: 'bar' }, role: 'squad' }, deps)

    const envCall = calls.find((c) => c.command.includes('server.env'))
    expect(envCall).toBeDefined()
    expect(envCall!.command).toContain('install -m 0600 /dev/stdin')
    const user = boxUnixUser('sb-1')
    expect(envCall!.command).toContain(`chown ${user}:${user}`)
    expect(envCall!.command).toContain(`/home/${user}/.tau/server.env`)
    // Caller env + the baked runtime vars are all present in the pushed content.
    expect(envCall!.stdin).toContain('FOO=bar')
    expect(envCall!.stdin).toContain('EXECUTOR_PORT=50100')
    expect(envCall!.stdin).toContain('EXECUTOR_SERVICE_CGROUP=1')
    expect(envCall!.stdin).toContain(`WORKSPACE_PATH=/home/${user}/workspace`)
    expect(envCall!.stdin).toContain('FICUS_DEVBOX_DIR=')
    // FICUS_BOX_HOME is baked so the box's sandbox-server permits file-sync writes
    // under the box HOME (~/bin, ~/.tau/skills, ~/memory).
    expect(envCall!.stdin).toContain(`FICUS_BOX_HOME=/home/${user}`)
    // BUN_PTY_LIB points the bundled server's shell/PTY loader at the native lib
    // ensureServerBundle ships next to server.js; without it the server crashes at
    // boot when the shell path dlopens librust_pty.so.
    expect(envCall!.stdin).toContain('BUN_PTY_LIB=/opt/tau/server/librust_pty.so')
  })

  it('overrides a conflicting caller service-cgroup marker in pushed server.env', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox(
      { sandboxId: 'sb-1', machineId: machine.id, env: { EXECUTOR_SERVICE_CGROUP: '0' }, role: 'squad' },
      deps
    )

    const envCall = calls.find((call) => call.command.includes('server.env'))!
    expect(envCall.stdin!.match(/^EXECUTOR_SERVICE_CGROUP=.*$/gm)).toEqual(['EXECUTOR_SERVICE_CGROUP=1'])
  })

  // ── executor auth token + loopback bind (cross-box hardening) ────────────
  it('bakes EXECUTOR_BIND=127.0.0.1 and reuses the row auth token in server.env', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox() // bindMachineBox returns authToken 'tok-existing'
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    const envCall = calls.find((c) => c.command.includes('server.env'))!
    // Loopback bind: the box is only ever reached via the machine-local SSH -L
    // forward, so nothing off-loopback may connect.
    expect(envCall.stdin).toContain('EXECUTOR_BIND=127.0.0.1')
    // Stable token: the row's existing token is REUSED, never re-minted.
    expect(envCall.stdin).toContain('EXECUTOR_AUTH_TOKEN=tok-existing\n')
  })

  it('pushes the token bindMachineBox minted (bind-time atomic mint) and persists it on both upserts', async () => {
    const events: string[] = []
    const machine = makeMachine()
    // The row had no token; the bind fake mints one (mirroring the real
    // COALESCE mint inside bindMachineBox — box-manager itself never mints).
    const box = makeBox({ authToken: null })
    const { deps, calls, upserts } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    const envCall = calls.find((c) => c.command.includes('server.env'))!
    const minted = envCall.stdin!.match(/^EXECUTOR_AUTH_TOKEN=([0-9a-f]+)$/m)?.[1]
    // Cryptographically random 32 bytes, hex-encoded — the bind-minted token.
    expect(minted).toMatch(/^[0-9a-f]{64}$/)
    // The SAME token is carried on both the 'ensuring' and 'ready' upserts —
    // the row (both core processes' source of truth) never diverges from what
    // the server enforces.
    expect(upserts.map((u) => u.authToken)).toEqual([minted, minted])
  })

  it('fails loudly when bindMachineBox violates its always-a-token contract', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ authToken: null })
    const { deps } = happyDeps(events, machine, box)
    // A broken bind that returns a token-less row (should be impossible: the
    // bind upsert COALESCE-mints). Pushing a token-less server.env would boot
    // an unauthenticated executor, so ensureBox must throw instead.
    deps.bindMachineBox = async () => box

    await expect(ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)).rejects.toThrow(
      /no auth token/
    )
    // It threw BEFORE any machine mutation of the provision phase.
    expect(events).not.toContain('provision')
    expect(events).not.toContain('env')
  })

  it('re-provisions (once) a legacy ready box whose row has no auth token, delivering the hardening', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const legacyBox = makeBox({ status: 'ready', authToken: null })
    const { deps, calls } = happyDeps(events, machine, legacyBox)
    deps.getMachineBox = async () => legacyBox

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    // The healthy fast-path is SKIPPED (no token on the row): the box takes the
    // full path so a token is minted, pushed, and the unit restarted onto the
    // current (enforcing) bundle.
    expect(events).toContain('provision')
    expect(events).toContain('env')
    expect(events).toContain('restart')
    const envCall = calls.find((c) => c.command.includes('server.env'))!
    expect(envCall.stdin).toMatch(/^EXECUTOR_AUTH_TOKEN=[0-9a-f]{64}$/m)
    expect(envCall.stdin).toContain('EXECUTOR_BIND=127.0.0.1')
  })

  it('bakes WORKSPACE_PATH to ~/.private for an agent role', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'agent' }, deps)

    const envCall = calls.find((c) => c.command.includes('server.env'))!
    const user = boxUnixUser('sb-1')
    expect(envCall.stdin).toContain(`WORKSPACE_PATH=/home/${user}/.private`)
  })

  it('clears the box content-hash stamps BEFORE provisioning (a rebuilt box is never skip-starved)', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'agent' }, deps)

    // The stamp clear must precede the box-provision run (and the server.env push).
    expect(events).toContain('clear-stamps')
    expect(events.indexOf('clear-stamps')).toBeLessThan(events.indexOf('provision'))
  })

  it('installBoxOnMachine clears stamps on the sandboxId before the provision command (all (re)provision paths)', async () => {
    const order: string[] = []
    const machine = makeMachine()
    const runner: SshRunner = {
      async run(_m, command) {
        if (command.includes('box-provision.sh')) order.push('provision')
        else if (command.includes('server.env')) order.push('env')
        return { exitCode: 0, stdout: 'FICUS_BOX_UID=4321\n', stderr: '' }
      },
    }
    const cleared: string[] = []
    await installBoxOnMachine(
      {
        machine,
        sandboxId: 'sb-mig',
        unixUser: boxUnixUser('sb-mig'),
        port: 50100,
        role: 'agent',
        env: {},
        authToken: 'tok',
      },
      {
        runner,
        clearBoxSyncedHashes: async (sandboxId) => {
          cleared.push(sandboxId)
          order.push('clear')
        },
      }
    )
    // Keyed on the sandboxId (the migrate target install runs while the row still
    // points at the source machine, so it must clear machine-agnostically).
    expect(cleared).toEqual(['sb-mig'])
    expect(order[0]).toBe('clear')
    expect(order).toEqual(['clear', 'provision', 'env'])
  })

  // ── per-box browser token DIGEST file (R-B8 / R-B2) ──────────────────────

  it('pushes the browser token DIGEST (not the raw token) to /opt/tau/browser-tokens/<user>.token, 0640 root:tau-browser, over the same non-argv channel as server.env', async () => {
    const events: string[] = []
    const { runner, calls } = makeFakeRunner(events)
    const machine = makeMachine()
    const authToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    const unixUser = boxUnixUser('sb-tok')

    await installBoxOnMachine(
      {
        machine,
        sandboxId: 'sb-tok',
        unixUser,
        port: 50100,
        role: 'agent',
        env: {},
        authToken,
      },
      { runner, clearBoxSyncedHashes: async () => {} }
    )

    const tokenPath = `/opt/tau/browser-tokens/${unixUser}.token`
    const tokenCall = calls.find((c) => c.command.includes('/opt/tau/browser-tokens'))
    expect(tokenCall).toBeDefined()
    // Correct sibling path (NOT inside /opt/tau/browser, which bootstrap chmods world-open).
    expect(tokenCall!.command).toContain(tokenPath)
    expect(tokenCall!.command).not.toContain('/opt/tau/browser/tokens')
    // The dir is created, ownership handed to the service group, mode locked to 0640.
    expect(tokenCall!.command).toContain('mkdir -p')
    expect(tokenCall!.command).toContain('chown root:tau-browser')
    expect(tokenCall!.command).toContain('0640')
    // The bytes ride stdin (install -m /dev/stdin), the SAME non-argv channel server.env uses.
    const envCall = calls.find((c) => c.command.includes('server.env'))!
    expect(envCall.command).toContain('/dev/stdin')
    expect(tokenCall!.command).toContain('/dev/stdin')
    // The file CONTENT is the sha256 hex digest of the token — a raw token would 401 the fleet.
    const expectedDigest = createHash('sha256').update(authToken).digest('hex')
    expect(tokenCall!.stdin).toBe(expectedDigest)
    // The digest and the raw token never appear in an argv position (/proc/cmdline is world-readable).
    expect(tokenCall!.command).not.toContain(expectedDigest)
    expect(tokenCall!.command).not.toContain(authToken)
  })

  it('browser token push is NON-FATAL and self-cleans on a pre-browser machine (no tau-browser group → chown fails)', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const unixUser = boxUnixUser('sb-legacy')
    const tokenPath = `/opt/tau/browser-tokens/${unixUser}.token`
    const { runner, calls } = makeFakeRunner(events, (command) => {
      // The token write chain fails at chown (no group) on a pre-browser machine.
      if (command.includes('/opt/tau/browser-tokens') && command.includes('chown root:tau-browser')) {
        return { exitCode: 1, stdout: '', stderr: 'chown: invalid group: root:tau-browser' }
      }
      return undefined
    })

    // Provisioning must still succeed despite the token write failing.
    await installBoxOnMachine(
      {
        machine,
        sandboxId: 'sb-legacy',
        unixUser,
        port: 50100,
        role: 'agent',
        env: {},
        authToken: 'tok',
      },
      { runner, clearBoxSyncedHashes: async () => {} }
    )

    // The half-written file is removed so it never lingers with wrong ownership.
    const rmCall = calls.find((c) => c.command.includes(`rm -f`) && c.command.includes(tokenPath))
    expect(rmCall).toBeDefined()
  })

  // ── rootless docker per box (--with-docker + DOCKER_HOST) ────────────────

  // Product requirement (verified live 2026-08-08: rootless dockerd runs for
  // the SQUAD box only — 257MB RSS — and isn't even installed for agent boxes
  // — 75MB/19MB RSS): a box's role is the SOLE seam that decides whether
  // box-provision.sh brings up rootless docker. Pinned directly at
  // roleWantsDocker (rather than only indirectly through ensureBox's SSH
  // command assertions below) so the invariant can never silently drift.
  it('roleWantsDocker: squad and system-manager want docker, agent does not', () => {
    expect(roleWantsDocker('squad')).toBe(true)
    expect(roleWantsDocker('system-manager')).toBe(true)
    expect(roleWantsDocker('agent')).toBe(false)
  })

  it('provisions a squad box --with-docker and bakes DOCKER_HOST at the box uid', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

    const provCall = calls.find((c) => c.command.includes('box-provision.sh'))!
    expect(provCall.command).toContain('--with-docker')

    const envCall = calls.find((c) => c.command.includes('server.env'))!
    // The uid comes from box-provision's FICUS_BOX_UID marker (fake runner → 4321).
    expect(envCall.stdin).toContain('DOCKER_HOST=unix:///run/user/4321/docker.sock')
  })

  it('provisions a system-manager box --with-docker and bakes DOCKER_HOST', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'system-manager' }, deps)

    const provCall = calls.find((c) => c.command.includes('box-provision.sh'))!
    expect(provCall.command).toContain('--with-docker')
    const envCall = calls.find((c) => c.command.includes('server.env'))!
    expect(envCall.stdin).toContain('DOCKER_HOST=unix:///run/user/4321/docker.sock')
  })

  it('does NOT pass --with-docker or bake DOCKER_HOST for an agent (light) box', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps, calls } = happyDeps(events, machine, box)

    await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'agent' }, deps)

    const provCall = calls.find((c) => c.command.includes('box-provision.sh'))!
    expect(provCall.command).not.toContain('--with-docker')
    const envCall = calls.find((c) => c.command.includes('server.env'))!
    expect(envCall.stdin).not.toContain('DOCKER_HOST')
  })

  it('fails loudly when a --with-docker box does not report its uid', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    // Provision succeeds but emits no FICUS_BOX_UID marker → DOCKER_HOST would be
    // wrong; fail before pushing a broken env. (Handler forces empty stdout on
    // every command, overriding the default provision uid marker.)
    deps.runner = makeFakeRunner(events, () => ({ exitCode: 0, stdout: '', stderr: '' })).runner

    await expect(ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)).rejects.toThrow(
      /FICUS_BOX_UID/
    )
  })

  // ── resume fast path (parked box, provisioning already up to date) ───────
  describe('ensureBox resume fast path', () => {
    it('does not bind or provision while a prior physical stop remains unverified', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const box = makeBox({ status: 'stop_unverified' })
      const { deps } = happyDeps(events, machine, box)
      deps.getMachineBox = async () => box

      await expect(
        ensureBox({ sandboxId: box.sandboxId, machineId: machine.id, env: {}, role: 'agent' }, deps)
      ).rejects.toBeInstanceOf(BoxStopUnverifiedError)
      expect(events).toEqual([])
    })

    it('fails closed when inline remnant retirement errors', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const targetId = 'agent_original'
      const remnant = makeBox({ sandboxId: 'unverified_stop_remnant_test', status: 'orphaned' })
      const { deps: baseline } = happyDeps(events, machine, makeBox())
      const deps: BoxManagerDeps = baseline
      deps.getMachineBox = async () => null
      deps.findUnverifiedStopRemnant = async (machineId, unixUser) =>
        machineId === machine.id && unixUser === boxUnixUser(targetId) ? remnant : null
      deps.retireUnverifiedStopRemnant = async () => {
        throw new Error('old host teardown failed')
      }

      await expect(
        ensureBox({ sandboxId: targetId, machineId: machine.id, env: {}, role: 'agent' }, deps)
      ).rejects.toThrow('old host teardown failed')
      expect(events).toEqual([])
    })

    it('retires a returning sole-machine remnant inline before replacement', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const targetId = 'agent_original'
      const remnant = makeBox({ sandboxId: 'unverified_stop_remnant_test', status: 'orphaned' })
      const { deps: baseline, calls } = happyDeps(events, machine, makeBox({ sandboxId: targetId }))
      const deps: BoxManagerDeps = baseline
      const retired: string[] = []
      deps.getMachineBox = async () => null
      deps.findUnverifiedStopRemnant = async () => remnant
      deps.retireUnverifiedStopRemnant = async (candidate, ownerId) => {
        retired.push(`${candidate.sandboxId}:${ownerId}`)
      }
      deps.findPrivateArchive = async (sandboxId) => (sandboxId === targetId ? '/archives/private.tar.gz' : null)
      deps.readArchiveFile = async () => new Uint8Array([1, 2, 3])

      await expect(
        ensureBox({ sandboxId: targetId, machineId: machine.id, env: {}, role: 'agent' }, deps)
      ).resolves.toMatchObject({ machine: { id: machine.id }, box: { sandboxId: targetId, status: 'ready' } })
      expect(retired).toEqual([`${remnant.sandboxId}:${targetId}`])
      expect(calls.some((call) => call.command.includes('--restore'))).toBe(true)
      expect(events.filter((event) => event === 'provision')).toHaveLength(2)
    })

    it('does not restore a stale archive onto an ordinary fresh box', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const { deps: baseline, calls } = happyDeps(events, machine, makeBox())
      const deps: BoxManagerDeps = baseline
      deps.findPrivateArchive = async () => '/archives/stale/private.tar.gz'
      deps.readArchiveFile = async () => new Uint8Array([1, 2, 3])

      await ensureBox({ sandboxId: 'agent_fresh', machineId: machine.id, env: {}, role: 'agent' }, deps)

      expect(calls.some((call) => call.command.includes('--restore'))).toBe(false)
    })

    it('a stopped box whose provisionedSpecHash matches the desired specHash skips bundle/bind/provision — only restarts + tunnels + health-checks', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: 'spec-abc' })
      const { deps } = happyDeps(events, machine, stoppedBox)
      deps.getMachineBox = async () => stoppedBox
      let tick = 0
      ;(deps as { now?: () => number }).now = () => (tick += 100)

      const progress: string[] = []
      const result = await ensureBox(
        {
          sandboxId: 'sb-1',
          machineId: machine.id,
          env: {},
          role: 'squad',
          specHash: 'spec-abc',
          beginPhysicalWork: (reason) => {
            progress.push(`started:${reason}`)
            return (outcome) => progress.push(`finished:${outcome}`)
          },
        },
        deps
      )

      expect(events).not.toContain('bundle')
      expect(events).not.toContain('bind')
      expect(events).not.toContain('clear-stamps')
      expect(events).not.toContain('provision')
      expect(events).not.toContain('env')
      // 'ensuring' is stamped BEFORE the restart/health window (minor #2 from
      // review: a concurrent status observer during the ~2-3s wait reads
      // 'starting', not the stale 'stopped') — no box.status event on that
      // stamp though, matching the full path's own pre-provision stamp.
      expect(events).toEqual(['ensuring', 'restart', 'ensureMaster', 'forward', 'health', 'ready'])
      expect(result.box.status).toBe('ready')
      expect(result.timings?.start).toBeGreaterThan(0)
      expect(result.timings?.provision).toBeUndefined()
      expect(result.timings?.artifacts).toBeUndefined()
      // No extra query on this hot path either (mirrors the healthy fast path).
      expect(result.priorBoxesOnMachine).toBeUndefined()
      expect(progress).toEqual(['started:runtime_start', 'finished:ready'])
    })

    it('a stopped box with NO provisionedSpecHash (legacy row / never recorded) runs the full path — no silent degradation', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: null })
      const { deps } = happyDeps(events, machine, stoppedBox)
      deps.getMachineBox = async () => stoppedBox

      const result = await ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad', specHash: 'spec-abc' },
        deps
      )

      expect(events).toContain('bundle')
      expect(events).toContain('provision')
      expect(result.box.status).toBe('ready')
    })

    it('a stopped box whose provisionedSpecHash does NOT match the desired specHash (drift, e.g. recreateSandbox) runs the full path', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: 'spec-OLD' })
      const { deps } = happyDeps(events, machine, stoppedBox)
      deps.getMachineBox = async () => stoppedBox

      const result = await ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad', specHash: 'spec-NEW' },
        deps
      )

      expect(events).toContain('bundle')
      expect(events).toContain('provision')
      expect(result.box.status).toBe('ready')
    })

    it('a brand-new box (no existing row) runs the unchanged full path regardless of specHash', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const box = makeBox()
      const { deps } = happyDeps(events, machine, box)
      // happyDeps' default getMachineBox already returns null (no existing row).

      const result = await ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad', specHash: 'spec-abc' },
        deps
      )

      expect(events).toEqual([
        'bundle',
        'bind',
        'ensuring',
        'clear-stamps',
        'provision',
        'env',
        'restart',
        'ensureMaster',
        'forward',
        'health',
        'ready',
      ])
      expect(result.box.status).toBe('ready')
    })

    it('a full (re)provision stamps provisionedSpecHash from the caller-supplied specHash into the ready upsert', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const box = makeBox()
      const { deps, upserts } = happyDeps(events, machine, box)

      await ensureBox(
        {
          sandboxId: 'sb-1',
          machineId: machine.id,
          env: { FICUS_BOX_SPEC_HASH: 'bare-spec-fresh' },
          role: 'squad',
          specHash: 'spec-fresh',
        },
        deps
      )

      const readyUpsert = upserts.find((u) => u.status === 'ready')!
      expect(readyUpsert.provisionedSpecHash).toBe('spec-fresh')
      expect(readyUpsert.reconcilableSpecHash).toBe('bare-spec-fresh')
    })

    it('if the resume attempt fails to come healthy, it falls back to the full (re)provision path instead of throwing — a slow correct ensure beats a fast broken box', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: 'spec-abc' })
      const { deps } = happyDeps(events, machine, stoppedBox)
      deps.getMachineBox = async () => stoppedBox
      deps.healthBudgetMs = 0 // the resume attempt's poll fails once and times out immediately
      let fetchCalls = 0
      deps.fetch = (async () => {
        fetchCalls++
        events.push('health')
        // First call (resume attempt) fails; every call after (full-path retry) succeeds.
        return fetchCalls === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 }
      }) as unknown as typeof fetch

      const result = await ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad', specHash: 'spec-abc' },
        deps
      )

      // Fell through to the full path: provisioning actually ran.
      expect(events).toContain('bundle')
      expect(events).toContain('provision')
      expect(result.box.status).toBe('ready')
    })

    // Review finding #1 (CRITICAL): the resume fast path must not resume a box
    // on stale env (GITHUB_TOKEN, callback secret, API URL, ...) — the marker
    // vm/manager.ts computes (computeProvisioningMarker) folds a hash of the
    // caller env in on top of the bare spec hash, so an env-only rotation
    // still busts the fast path here even though the underlying specHash
    // (bundle/role/provision-script) never changed.
    it('an env-only change (e.g. a rotated GITHUB_TOKEN) between provision and resume busts the marker and forces the full path; an unchanged env still takes the fast path', async () => {
      const specHash = 'spec-abc'
      const envBefore: Record<string, string> = { GITHUB_TOKEN: 'tok-old', FICUS_API_URL: 'http://127.0.0.1:1' }
      const envAfter: Record<string, string> = { GITHUB_TOKEN: 'tok-rotated', FICUS_API_URL: 'http://127.0.0.1:1' }
      const markerBefore = computeProvisioningMarker(specHash, envBefore)
      const markerAfter = computeProvisioningMarker(specHash, envAfter)
      expect(markerBefore).not.toBe(markerAfter) // sanity: the marker actually moved

      // Rotated env: the row was provisioned with markerBefore; the caller now
      // wants markerAfter. Must NOT resume on the stale token.
      {
        const events: string[] = []
        const machine = makeMachine()
        const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: markerBefore })
        const { deps } = happyDeps(events, machine, stoppedBox)
        deps.getMachineBox = async () => stoppedBox

        const result = await ensureBox(
          { sandboxId: 'sb-1', machineId: machine.id, env: envAfter, role: 'squad', specHash: markerAfter },
          deps
        )

        expect(events).toContain('bundle')
        expect(events).toContain('provision')
        expect(events).toContain('env') // server.env actually re-pushed with the new token
        expect(result.box.status).toBe('ready')
      }

      // Unchanged env: same marker on both sides — fast path still fires.
      {
        const events: string[] = []
        const machine = makeMachine()
        const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: markerBefore })
        const { deps } = happyDeps(events, machine, stoppedBox)
        deps.getMachineBox = async () => stoppedBox

        const result = await ensureBox(
          { sandboxId: 'sb-1', machineId: machine.id, env: envBefore, role: 'squad', specHash: markerBefore },
          deps
        )

        expect(events).not.toContain('provision')
        expect(events).not.toContain('env')
        expect(result.box.status).toBe('ready')
      }
    })

    // Review finding #3: pin the two "uncertainty" arms of the resume-path
    // guard that nothing else exercises.
    it('a matching hash on a LEGACY box (authToken null) still takes the full path — the legacy-row exclusion applies to resume too', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: 'spec-abc', authToken: null })
      const { deps } = happyDeps(events, machine, stoppedBox)
      deps.getMachineBox = async () => stoppedBox

      const result = await ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad', specHash: 'spec-abc' },
        deps
      )

      expect(events).toContain('bundle')
      expect(events).toContain('provision')
      expect(result.box.status).toBe('ready')
    })

    it('a stopped box with a recorded provisionedSpecHash but an opts.specHash the caller never supplied (undefined) takes the full path', async () => {
      const events: string[] = []
      const machine = makeMachine()
      const stoppedBox = makeBox({ status: 'stopped', provisionedSpecHash: 'spec-abc' })
      const { deps } = happyDeps(events, machine, stoppedBox)
      deps.getMachineBox = async () => stoppedBox

      // No specHash on opts at all (legacy/test caller shape).
      const result = await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)

      expect(events).toContain('bundle')
      expect(events).toContain('provision')
      expect(result.box.status).toBe('ready')
    })
  })

  it('rejects an env value containing a newline BEFORE any mutation', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)

    await expect(
      ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: { EVIL: 'a\nExecStart=x' }, role: 'squad' }, deps)
    ).rejects.toThrow(BoxEnvValidationError)
    // Nothing was provisioned/bound/bundled.
    expect(events).toEqual([])
  })

  it('rejects an env key with an invalid charset BEFORE any mutation', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)

    await expect(
      ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: { 'bad-key': 'x' }, role: 'squad' }, deps)
    ).rejects.toThrow(BoxEnvValidationError)
    expect(events).toEqual([])
  })

  it('rejects a forwarding=no machine with MachineUnusableError before any mutation', async () => {
    const events: string[] = []
    const machine = makeMachine({ capabilities: { forwarding: 'no' } })
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)

    await expect(ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)).rejects.toThrow(
      MachineUnusableError
    )
    expect(events).toEqual([])
  })

  it('is idempotent: a ready + healthy box skips provision/env but still verifies health', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox

    const progress: string[] = []
    const result = await ensureBox(
      {
        sandboxId: 'sb-1',
        machineId: machine.id,
        env: {},
        role: 'squad',
        beginPhysicalWork: (reason) => {
          progress.push(`started:${reason}`)
          return (outcome) => progress.push(`finished:${outcome}`)
        },
      },
      deps
    )

    // Fast path: forward + health only, no bundle/bind/provision/env/restart/ready.
    expect(events).toEqual(['ensureMaster', 'forward', 'health'])
    expect(result.box.status).toBe('ready')
    expect(result.endpoint).toBe('http://127.0.0.1:59999')
    expect(progress).toEqual([])
  })

  it('re-provisions when an existing ready box fails EVERY health re-check attempt', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const readyBox = makeBox({ status: 'ready' })
    const { deps } = happyDeps(events, machine, readyBox)
    deps.getMachineBox = async () => readyBox
    ;(deps as { healthRecheckGapMs?: number }).healthRecheckGapMs = 0
    // All 3 fast-path re-check probes fail (a genuinely dead box, not a transient
    // blip); the re-provision's own health poll then passes.
    deps.fetch = makeFakeFetch(events, [
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ])

    const progress: string[] = []
    await ensureBox(
      {
        sandboxId: 'sb-1',
        machineId: machine.id,
        env: {},
        role: 'squad',
        beginPhysicalWork: (reason) => {
          progress.push(`started:${reason}`)
          return (outcome) => progress.push(`finished:${outcome}`)
        },
      },
      deps
    )

    expect(events).toEqual([
      'ensureMaster',
      'forward',
      'health', // re-check attempt 1
      'health', // attempt 2
      'health', // attempt 3 — all failed, so fall through to a full re-provision
      'bundle',
      'bind',
      'ensuring',
      'clear-stamps',
      'provision',
      'env',
      'restart',
      'ensureMaster',
      'forward',
      'health',
      'ready',
    ])
    expect(progress).toEqual(['started:runtime_reconnect', 'finished:ready'])
  })

  it('throws BoxHealthTimeoutError when the box never becomes healthy', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    deps.fetch = makeFakeFetch(events, [{ ok: false, status: 503 }])
    deps.healthBudgetMs = 5
    let t = 0
    ;(deps as { now?: () => number }).now = () => (t += 10) // advances past the budget on the first re-check

    await expect(ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)).rejects.toThrow(
      BoxHealthTimeoutError
    )
  })

  // ------------------------------------------------------------------------
  // Fresh-box health budget on a slow-booting VM (live: a BYO cloud VM's box
  // took >60s to start answering /healthz — every probe failed with "The socket
  // connection was closed unexpectedly" (server still booting, NOT dead) and
  // the whole execution was failed at the old 60s budget).
  // ------------------------------------------------------------------------

  /** A /healthz fake driven by a virtual clock: connection-refused (fetch
   *  throws) until `healthyAtMs` on that clock, 2xx after. `never` = never
   *  becomes healthy. */
  function slowBootFetch(events: string[], clock: () => number, healthyAtMs: number | 'never'): typeof fetch {
    return (async () => {
      events.push('health')
      if (healthyAtMs === 'never' || clock() < healthyAtMs) {
        throw new Error(
          'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
        )
      }
      return { ok: true, status: 200 } as Response
    }) as unknown as typeof fetch
  }

  /** Virtual clock: `now` reads it, `sleep` advances it (no real waiting). */
  function virtualClock() {
    let t = 0
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      elapsed: () => t,
    }
  }

  function withoutHealthBudgetEnv<T>(fn: () => T): T {
    const prior = process.env.FICUS_BOX_HEALTH_BUDGET_MS
    delete process.env.FICUS_BOX_HEALTH_BUDGET_MS
    const restore = () => {
      if (prior === undefined) delete process.env.FICUS_BOX_HEALTH_BUDGET_MS
      else process.env.FICUS_BOX_HEALTH_BUDGET_MS = prior
    }
    let out: T
    try {
      out = fn()
    } catch (err) {
      restore()
      throw err
    }
    if (out instanceof Promise) return out.finally(restore) as T
    restore()
    return out
  }

  it('DEFAULT budget keeps a fresh box that only starts answering /healthz after 90s of socket-closed probes (slow VM boot)', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    const clock = virtualClock()

    const result = await withoutHealthBudgetEnv(() =>
      ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' },
        {
          ...deps,
          healthBudgetMs: undefined, // exercise the PRODUCTION default, not the harness's 10s
          now: clock.now,
          sleep: clock.sleep,
          fetch: slowBootFetch(events, clock.now, 90_000),
        }
      )
    )

    expect(result.endpoint).toBe('http://127.0.0.1:59999')
    expect(events.at(-1)).toBe('ready')
    // It genuinely waited through the boot (~90s of 2s probes), not a fluke.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(90_000)
    expect(events.filter((e) => e === 'health').length).toBeGreaterThanOrEqual(45)
  })

  it('DEFAULT budget still expires: a box that never answers throws BoxHealthTimeoutError carrying the budget + last error', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    const clock = virtualClock()

    let caught: unknown
    try {
      await withoutHealthBudgetEnv(() =>
        ensureBox(
          { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' },
          {
            ...deps,
            healthBudgetMs: undefined,
            now: clock.now,
            sleep: clock.sleep,
            fetch: slowBootFetch(events, clock.now, 'never'),
          }
        )
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(BoxHealthTimeoutError)
    expect((caught as Error).message).toBe(
      `box at http://127.0.0.1:59999 did not become healthy within ${DEFAULT_BOX_HEALTH_BUDGET_MS}ms ` +
        '(last: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch())'
    )
    // The default is the raised slow-boot budget (the live failure was at 60s).
    expect(DEFAULT_BOX_HEALTH_BUDGET_MS).toBeGreaterThanOrEqual(180_000)
    expect(clock.elapsed()).toBeGreaterThanOrEqual(DEFAULT_BOX_HEALTH_BUDGET_MS)
    expect(events).not.toContain('ready')
  })

  it('logs periodic "still waiting for box health" progress (every ~20s) while a fresh box boots', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    const clock = virtualClock()
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await ensureBox(
        { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' },
        {
          ...deps,
          healthBudgetMs: 240_000,
          now: clock.now,
          sleep: clock.sleep,
          fetch: slowBootFetch(events, clock.now, 90_000),
        }
      )
      const progress = logSpy.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((line) => line.includes('still waiting for box health at http://127.0.0.1:59999'))
      // 90s of waiting at a ~20s cadence → 20/40/60/80s = 4 lines (never a
      // per-probe flood: 45 probes must NOT yield 45 lines).
      expect(progress.length).toBe(4)
      // Each line tells the operator how far into the budget we are and what
      // the last probe saw, so a tail shows "waiting", not "hung".
      expect(progress[0]).toContain('20s/240s')
      expect(progress[0]).toContain('last: The socket connection was closed unexpectedly')
      expect(progress[3]).toContain('80s/240s')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('FICUS_BOX_HEALTH_BUDGET_MS overrides the default fresh-box health budget (positive int only)', () => {
    withoutHealthBudgetEnv(() => {
      expect(resolveBoxHealthBudgetMs()).toBe(DEFAULT_BOX_HEALTH_BUDGET_MS)
      process.env.FICUS_BOX_HEALTH_BUDGET_MS = '600000'
      expect(resolveBoxHealthBudgetMs()).toBe(600_000)
      process.env.FICUS_BOX_HEALTH_BUDGET_MS = '-5'
      expect(resolveBoxHealthBudgetMs()).toBe(DEFAULT_BOX_HEALTH_BUDGET_MS)
      process.env.FICUS_BOX_HEALTH_BUDGET_MS = 'soon'
      expect(resolveBoxHealthBudgetMs()).toBe(DEFAULT_BOX_HEALTH_BUDGET_MS)
    })
  })

  it('pollBoxHealth aborts a wedged /healthz connection per attempt (bounded, not hung)', async () => {
    // A raw fetch with no AbortSignal lets one black-holed connection hang the
    // whole poll forever (the 60s budget is only checked BETWEEN resolved
    // fetches). Each fetch must carry an AbortSignal.timeout so a wedged
    // connection is dropped and the poll makes progress / times out. This fetch
    // mirrors real fetch: it settles ONLY when its signal aborts — with no signal
    // (the bug) it never resolves and this test hangs (fails on timeout).
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    deps.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation timed out')))
      })) as unknown as typeof fetch
    deps.healthBudgetMs = 1 // first aborted attempt (~2s) already exceeds the budget

    await expect(ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' }, deps)).rejects.toThrow(
      BoxHealthTimeoutError
    )
  }, 10_000)

  it('re-ensure sticks to the recorded ready machine even when another is less-loaded', async () => {
    const events: string[] = []
    const machineA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'ready' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const readyBox = makeBox({ status: 'ready', machineId: machineA.id })

    const result = await ensureBox(
      { sandboxId: 'sb-1', machineId: null, env: {}, role: 'squad' },
      {
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
        getMachineBox: async () => readyBox,
        getMachine: async () => machineA,
        // Placement, if (wrongly) consulted with a null pin, would pick the
        // less-loaded machineB — proving stickiness requires it to be untouched.
        queryReadySharedMachines: async () => {
          events.push('placement')
          return [{ machine: machineB, boxCount: 0 }]
        },
        sleep: async () => {},
      }
    )

    // Stuck to the recorded machine; placement never consulted, fast path only.
    expect(result.machine.id).toBe(machineA.id)
    expect(events).toEqual(['ensureMaster', 'forward', 'health'])
  })

  // ── migrate-with-teardown (the slice-5 correctness fix) ──────────────────
  it('migrate-with-teardown: an explicit pin that differs from the box machine tears down the OLD box BEFORE binding the new one', async () => {
    const events: string[] = []
    const machineA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'ready' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const existingOnA = makeBox({ status: 'ready', machineId: machineA.id, port: 50100 })
    const boundOnB = makeBox({ status: 'ensuring', machineId: machineB.id, port: 50200 })
    const { runner } = makeFakeRunner(events)
    const deleted: string[] = []

    await ensureBox(
      { sandboxId: 'sb-1', machineId: machineB.id, env: {}, role: 'squad' },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
        getMachineBox: async () => existingOnA,
        // Old machine for the teardown; new (pinned) machine for placement.
        getMachine: async (id: string) => (id === machineA.id ? machineA : machineB),
        deleteMachineBox: async (id: string) => {
          deleted.push(id)
          events.push('delete')
        },
        ensureMachineArtifacts: async () => {
          events.push('bundle')
        },
        bindMachineBox: async () => {
          events.push('bind')
          return boundOnB
        },
        upsertMachineBox: async (b: { status?: string }) => {
          events.push(b.status === 'ready' ? 'ready' : 'ensuring')
          return { ...boundOnB, status: b.status } as MachineBox
        },
        healthBudgetMs: 10_000,
        sleep: async () => {},
      }
    )

    // The OLD box teardown (removeForward → --remove → row delete) strictly
    // precedes bind + provision on the NEW machine.
    const removeIdx = events.indexOf('remove')
    const bindIdx = events.indexOf('bind')
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(bindIdx).toBeGreaterThan(removeIdx)
    expect(deleted).toContain('sb-1')
    // A squad box owns no per-remove private tree, so no archive pull runs.
    expect(events).toEqual([
      'removeForward',
      'remove',
      'delete',
      'bundle',
      'bind',
      'ensuring',
      'provision',
      'env',
      'restart',
      'ensureMaster',
      'forward',
      'health',
      'ready',
    ])
  })

  it('migrate-with-teardown archives ~/.private for an agent box (role-appropriate) before removal', async () => {
    const events: string[] = []
    const machineA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'ready' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const existingOnA = makeBox({ status: 'ready', machineId: machineA.id, port: 50100 })
    const boundOnB = makeBox({ status: 'ensuring', machineId: machineB.id, port: 50200 })
    const { runner } = makeFakeRunner(events, (command) =>
      command.includes('tar czf')
        ? { exitCode: 0, stdout: Buffer.from('x').toString('base64'), stderr: '' }
        : command.includes('box-provision.sh') && !command.includes('--remove')
          ? { exitCode: 0, stdout: 'FICUS_BOX_UID=4321\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' }
    )
    const written: Array<{ dest: string }> = []

    await ensureBox(
      { sandboxId: 'sb-1', machineId: machineB.id, env: {}, role: 'agent' },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
        getMachineBox: async () => existingOnA,
        getMachine: async (id: string) => (id === machineA.id ? machineA : machineB),
        deleteMachineBox: async () => {},
        getArchiveRoot: () => '/tmp/archive-root',
        writeArchiveFile: async (dest: string) => {
          written.push({ dest })
        },
        now: () => 1234,
        ensureMachineArtifacts: async () => {
          events.push('bundle')
        },
        bindMachineBox: async () => {
          events.push('bind')
          return boundOnB
        },
        upsertMachineBox: async (b: { status?: string }) => {
          events.push(b.status === 'ready' ? 'ready' : 'ensuring')
          return { ...boundOnB, status: b.status } as MachineBox
        },
        healthBudgetMs: 10_000,
        sleep: async () => {},
      }
    )

    // The agent role owns a per-box ~/.private, so the migrate pulls its archive
    // (strictly before --remove) and only then rebinds on the new machine.
    expect(events.slice(0, 4)).toEqual(['removeForward', 'archive', 'remove', 'bundle'])
    expect(written).toHaveLength(1)
    expect(written[0].dest).toBe('/tmp/archive-root/sb-1-1234/private.tar.gz')
    expect(events.indexOf('bind')).toBeGreaterThan(events.indexOf('remove'))
  })

  it('does NOT tear down the old box when its recorded machine is not ready — rebinds on the new machine and ensure succeeds (outage recovery)', async () => {
    // The ensureBox caller always passes a CONCRETE machineId (placement runs once
    // upstream). When the recorded machine went not-ready, upstream placement
    // re-places onto a healthy machine B, so ensureBox sees existing.machineId
    // (dead A) != B. The migrate teardown MUST NOT fire here: every removeBox step
    // SSHes the unreachable host and throws, which would fail ensure for the whole
    // outage. Instead we skip the teardown and rebind cleanly on B.
    const events: string[] = []
    const notReadyA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'terminated' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const existingOnDead = makeBox({ status: 'ready', machineId: notReadyA.id, port: 50100 })
    const boundOnB = makeBox({ status: 'ensuring', machineId: machineB.id, port: 50200 })
    // A teardown against the dead host would SSH and throw; prove it never runs.
    const { runner } = makeFakeRunner(events, (command) =>
      command.includes('--remove')
        ? new Error('ssh: connect to host aaaa timed out')
        : command.includes('box-provision.sh')
          ? { exitCode: 0, stdout: 'FICUS_BOX_UID=4321\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' }
    )
    const deleted: string[] = []

    const result = await ensureBox(
      { sandboxId: 'sb-1', machineId: machineB.id, env: {}, role: 'squad' },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
        getMachineBox: async () => existingOnDead,
        getMachine: async (id: string) => (id === notReadyA.id ? notReadyA : machineB),
        deleteMachineBox: async (id: string) => {
          deleted.push(id)
          events.push('delete')
        },
        ensureMachineArtifacts: async () => {
          events.push('bundle')
        },
        bindMachineBox: async () => {
          events.push('bind')
          return boundOnB
        },
        upsertMachineBox: async (b: { status?: string }) => {
          events.push(b.status === 'ready' ? 'ready' : 'ensuring')
          return { ...boundOnB, status: b.status } as MachineBox
        },
        healthBudgetMs: 10_000,
        sleep: async () => {},
      }
    )

    // Rebound cleanly on the healthy machine, with NO teardown of the dead box.
    expect(result.machine.id).toBe(machineB.id)
    expect(events).not.toContain('removeForward')
    expect(events).not.toContain('remove')
    expect(deleted).not.toContain('sb-1')
    expect(events).toEqual([
      'bundle',
      'bind',
      'ensuring',
      'provision',
      'env',
      'restart',
      'ensureMaster',
      'forward',
      'health',
      'ready',
    ])
  })

  it('migrate teardown failure on a ready-but-now-unreachable old machine is non-fatal — rebind still succeeds', async () => {
    // The old machine is `ready` at the readiness check, so the teardown is
    // attempted — but it goes unreachable between the check and the teardown, so
    // its --remove SSH throws. That failure must NOT block the rebind: removeBox
    // throws BEFORE it deletes the row, so bind() below repoints the row. (The old
    // machine's box-side remnants are NOT reclaimed after such a failed teardown —
    // the row-based reconciler can't see them once the row is repointed; a
    // machine-side sweep is a follow-up, see runtime.md Backlog.)
    const events: string[] = []
    const machineA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'ready' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const existingOnA = makeBox({ status: 'ready', machineId: machineA.id, port: 50100 })
    const boundOnB = makeBox({ status: 'ensuring', machineId: machineB.id, port: 50200 })
    const { runner } = makeFakeRunner(events, (command) =>
      command.includes('--remove')
        ? new Error('ssh: connect to host aaaa timed out')
        : command.includes('box-provision.sh')
          ? { exitCode: 0, stdout: 'FICUS_BOX_UID=4321\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' }
    )
    const deleted: string[] = []

    const result = await ensureBox(
      { sandboxId: 'sb-1', machineId: machineB.id, env: {}, role: 'squad' },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
        getMachineBox: async () => existingOnA,
        getMachine: async (id: string) => (id === machineA.id ? machineA : machineB),
        deleteMachineBox: async (id: string) => {
          deleted.push(id)
          events.push('delete')
        },
        ensureMachineArtifacts: async () => {
          events.push('bundle')
        },
        bindMachineBox: async () => {
          events.push('bind')
          return boundOnB
        },
        upsertMachineBox: async (b: { status?: string }) => {
          events.push(b.status === 'ready' ? 'ready' : 'ensuring')
          return { ...boundOnB, status: b.status } as MachineBox
        },
        healthBudgetMs: 10_000,
        sleep: async () => {},
      }
    )

    // The teardown was attempted (removeForward + the --remove command reached)
    // but failed before the row delete; the rebind proceeded to a healthy box.
    expect(result.machine.id).toBe(machineB.id)
    expect(events).toContain('removeForward')
    expect(events).toContain('remove')
    expect(deleted).not.toContain('sb-1')
    expect(events).toEqual([
      'removeForward',
      'remove',
      'bundle',
      'bind',
      'ensuring',
      'provision',
      'env',
      'restart',
      'ensureMaster',
      'forward',
      'health',
      'ready',
    ])
  })

  it('does NOT tear down when the explicit pin matches the box machine (sticky same-machine fast path)', async () => {
    // A re-ensure with the SAME explicit pin must hit the healthy fast path — no
    // teardown, no re-provision — proving the migrate branch only fires on a real move.
    const events: string[] = []
    const machine = makeMachine({ status: 'ready' })
    const readyBox = makeBox({ status: 'ready', machineId: machine.id })
    let removed = false
    const result = await ensureBox(
      { sandboxId: 'sb-1', machineId: machine.id, env: {}, role: 'squad' },
      {
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
        getMachineBox: async () => readyBox,
        getMachine: async () => machine,
        deleteMachineBox: async () => {
          removed = true
        },
        sleep: async () => {},
      }
    )
    expect(events).toEqual(['ensureMaster', 'forward', 'health'])
    expect(removed).toBe(false)
    expect(result.machine.id).toBe(machine.id)
  })

  it('falls back to placement (and warns) when the recorded machine is not ready', async () => {
    const events: string[] = []
    const notReadyA = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'bootstrapping' })
    const machineB = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000', status: 'ready' })
    const staleBox = makeBox({ status: 'ready', machineId: notReadyA.id })
    const boxOnB = makeBox({ status: 'ensuring', machineId: machineB.id })
    const { runner } = makeFakeRunner(events)

    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '))
    }
    let result: Awaited<ReturnType<typeof ensureBox>>
    try {
      result = await ensureBox(
        { sandboxId: 'sb-1', machineId: null, env: {}, role: 'squad' },
        {
          runner,
          tunnels: makeFakeTunnels(events),
          fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
          getMachineBox: async () => staleBox,
          getMachine: async () => notReadyA,
          queryReadySharedMachines: async () => [{ machine: machineB, boxCount: 0 }],
          ensureMachineArtifacts: async () => {
            events.push('bundle')
          },
          bindMachineBox: async () => {
            events.push('bind')
            return boxOnB
          },
          upsertMachineBox: async (b: { status?: string }) => {
            events.push(b.status === 'ready' ? 'ready' : 'ensuring')
            return { ...boxOnB, status: b.status } as MachineBox
          },
          healthBudgetMs: 10_000,
          sleep: async () => {},
        }
      )
    } finally {
      console.warn = origWarn
    }

    // Re-placed onto the ready machine, and a full (re)provision ran there.
    expect(result.machine.id).toBe(machineB.id)
    expect(events).toContain('provision')
    // The stale machine's remnants are flagged for the reconciler via a WARN.
    expect(warnings.some((w) => w.includes('sb-1') && /re-plac/i.test(w))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolveMachineForBox
// ---------------------------------------------------------------------------

describe('resolveMachineForBox', () => {
  it('returns an explicit machine when it exists and is ready', async () => {
    const machine = makeMachine({ status: 'ready' })
    const resolved = await resolveMachineForBox(machine.id, { getMachine: async () => machine })
    expect(resolved.id).toBe(machine.id)
  })

  it('throws MachineUnavailableError for an explicit machine that is missing', async () => {
    await expect(resolveMachineForBox('nope', { getMachine: async () => null })).rejects.toThrow(
      MachineUnavailableError
    )
  })

  it('throws MachineUnavailableError for an explicit machine that is not ready', async () => {
    const machine = makeMachine({ status: 'bootstrapping' })
    await expect(resolveMachineForBox(machine.id, { getMachine: async () => machine })).rejects.toThrow(/not ready/)
  })

  it('throws MachineUnavailableError with the documented message when no shared machine is ready', async () => {
    await expect(resolveMachineForBox(null, { queryReadySharedMachines: async () => [] })).rejects.toThrow(
      'no ready shared machine registered'
    )
  })

  it('returns the sole ready shared machine', async () => {
    const machine = makeMachine()
    const resolved = await resolveMachineForBox(null, {
      queryReadySharedMachines: async () => [{ machine, boxCount: 3 }],
    })
    expect(resolved.id).toBe(machine.id)
  })

  it('picks the least-loaded machine when several are ready', async () => {
    const busy = makeMachine({ id: 'aaaaaaaa-0000-0000-0000-000000000000' })
    const idle = makeMachine({ id: 'bbbbbbbb-0000-0000-0000-000000000000' })
    const resolved = await resolveMachineForBox(null, {
      queryReadySharedMachines: async () => [
        { machine: busy, boxCount: 5 },
        { machine: idle, boxCount: 1 },
      ],
    })
    expect(resolved.id).toBe(idle.id)
  })

  it('breaks a load tie deterministically by createdAt then id', async () => {
    const older = makeMachine({
      id: 'cccccccc-0000-0000-0000-000000000000',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    })
    const newer = makeMachine({
      id: 'aaaaaaaa-0000-0000-0000-000000000000',
      createdAt: new Date('2021-01-01T00:00:00Z'),
    })
    // Same box count → the older machine wins regardless of input order.
    const forward = await resolveMachineForBox(null, {
      queryReadySharedMachines: async () => [
        { machine: newer, boxCount: 2 },
        { machine: older, boxCount: 2 },
      ],
    })
    expect(forward.id).toBe(older.id)
    const reversed = await resolveMachineForBox(null, {
      queryReadySharedMachines: async () => [
        { machine: older, boxCount: 2 },
        { machine: newer, boxCount: 2 },
      ],
    })
    expect(reversed.id).toBe(older.id)
  })
})

// ---------------------------------------------------------------------------
// removeBox
// ---------------------------------------------------------------------------

describe('removeBox', () => {
  // Teardown makes TWO slow SSH calls: it tars the box's ~/.private off the
  // machine (pullPrivateArchive), then tars the whole home and userdels it
  // (box-provision --remove). Both are `tar` over SSH on a home measured in
  // hundreds of megabytes; the runner's 30s default is a budget for neither.
  //
  // #1403 gave the second one a real budget and stopped there. That fix
  // deployed and changed nothing on a tenant whose boxes were big: removal
  // still failed with `ssh command timed out after 30000ms`, just from the
  // pull instead of the remove, and the archive loop it was written to end
  // carried on. The caller's budget has to reach BOTH or neither is fixed.
  it('gives both slow SSH steps the caller-supplied budget', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner, calls } = makeFakeRunner(events, (command) => {
      if (command.includes('tar czf')) {
        return { exitCode: 0, stdout: Buffer.from('archive-bytes').toString('base64'), stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await removeBox(
      'sb-1',
      { archivePrivate: true, timeoutMs: 300_000 },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        deleteMachineBox: async () => {},
        getArchiveRoot: () => '/tmp/archive-root',
        writeArchiveFile: async () => {},
        now: () => 1234,
      }
    )

    const pull = calls.find((c) => c.command.includes('tar czf'))
    const remove = calls.find((c) => c.command.includes('box-provision.sh') && c.command.includes('--remove'))
    expect(pull).toBeDefined()
    expect(remove).toBeDefined()
    expect(pull!.timeoutMs).toBe(300_000)
    expect(remove!.timeoutMs).toBe(300_000)
  })

  it('pulls the private archive BEFORE --remove, then deletes the row', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner } = makeFakeRunner(events, (command) => {
      if (command.includes('tar czf')) {
        // base64 of an empty-ish payload; content fidelity is asserted via the write.
        return { exitCode: 0, stdout: Buffer.from('archive-bytes').toString('base64'), stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const deleted: string[] = []
    const written: Array<{ dest: string; bytes: Uint8Array }> = []

    await removeBox(
      'sb-1',
      { archivePrivate: true },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        deleteMachineBox: async (id: string) => {
          deleted.push(id)
        },
        getArchiveRoot: () => '/tmp/archive-root',
        writeArchiveFile: async (dest: string, bytes: Uint8Array) => {
          written.push({ dest, bytes })
        },
        now: () => 1234,
      }
    )

    // removeForward → archive → remove (archive strictly before --remove).
    expect(events).toEqual(['removeForward', 'archive', 'remove'])
    expect(deleted).toEqual(['sb-1'])
    expect(written).toHaveLength(1)
    // Written into a per-archive DIRECTORY so the private-archive janitor sweeps it.
    expect(written[0].dest).toBe('/tmp/archive-root/sb-1-1234/private.tar.gz')
    expect(new TextDecoder().decode(written[0].bytes)).toBe('archive-bytes')
  })

  it('names the archive dir so its swept segment matches the janitor regex /-(\\d+)$/', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner } = makeFakeRunner(events, (command) =>
      command.includes('tar czf')
        ? { exitCode: 0, stdout: Buffer.from('x').toString('base64'), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )
    const written: Array<{ dest: string; bytes: Uint8Array }> = []
    const root = '/tmp/archive-root'

    await removeBox(
      'sb-1',
      { archivePrivate: true },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        deleteMachineBox: async () => {},
        getArchiveRoot: () => root,
        writeArchiveFile: async (dest: string, bytes: Uint8Array) => {
          written.push({ dest, bytes })
        },
        now: () => 1699999999999,
      }
    )

    // purgeExpiredAgentPrivateArchives (services/sandbox/private-archive.ts) reads
    // each entry directly under the archive root and sweeps those matching
    // /-(\d+)$/. The swept segment is the entry name directly under the root.
    const segment = written[0].dest.slice(root.length + 1).split('/')[0]
    expect(segment).toBe('sb-1-1699999999999')
    expect(segment).toMatch(/-(\d+)$/)
  })

  it('tolerates a missing ~/.private: the archive pull guards existence, removal still completes', async () => {
    // On a half-provisioned box ~/.private may be absent; a bare `tar` would exit
    // non-zero and wedge removal forever. The pull must guard the dir's existence
    // (emitting an empty archive when absent) so --remove + row deletion proceed.
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner, calls } = makeFakeRunner(events, (command) =>
      command.includes('tar czf')
        ? { exitCode: 0, stdout: Buffer.from('').toString('base64'), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )
    const deleted: string[] = []
    const written: Array<{ dest: string; bytes: Uint8Array }> = []

    await removeBox(
      'sb-1',
      { archivePrivate: true },
      {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        deleteMachineBox: async (id: string) => {
          deleted.push(id)
        },
        getArchiveRoot: () => '/tmp/archive-root',
        writeArchiveFile: async (dest: string, bytes: Uint8Array) => {
          written.push({ dest, bytes })
        },
        now: () => 1234,
      }
    )

    const archiveCmd = calls.find((c) => c.command.includes('tar czf'))!.command
    // The guard: only tar .private when it exists, else an empty archive.
    expect(archiveCmd).toContain('test -d')
    expect(archiveCmd).toContain('--files-from /dev/null')
    // Removal completed end-to-end despite the (simulated) missing dir.
    expect(events).toEqual(['removeForward', 'archive', 'remove'])
    expect(deleted).toEqual(['sb-1'])
    expect(written).toHaveLength(1)
  })

  it('removes the per-box browser token file on box removal (revocation per R-B2)', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner, calls } = makeFakeRunner(events)

    await removeBox('sb-1', undefined, {
      runner,
      tunnels: makeFakeTunnels(events),
      getMachineBox: async () => box,
      getMachine: async () => machine,
      deleteMachineBox: async () => {},
    })

    const tokenPath = `/opt/tau/browser-tokens/${box.unixUser}.token`
    const removed = calls.some((c) => c.command.includes('rm -f') && c.command.includes(tokenPath))
    expect(removed).toBe(true)
  })

  it('skips the archive pull when archivePrivate is not requested', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner } = makeFakeRunner(events)
    const deleted: string[] = []

    await removeBox('sb-1', undefined, {
      runner,
      tunnels: makeFakeTunnels(events),
      getMachineBox: async () => box,
      getMachine: async () => machine,
      deleteMachineBox: async (id: string) => {
        deleted.push(id)
      },
    })

    expect(events).toEqual(['removeForward', 'remove'])
    expect(deleted).toEqual(['sb-1'])
  })

  it('is a no-op when no box row exists', async () => {
    const events: string[] = []
    const { runner } = makeFakeRunner(events)
    let deleted = false
    await removeBox('absent', undefined, {
      runner,
      tunnels: makeFakeTunnels(events),
      getMachineBox: async () => null,
      getMachine: async () => makeMachine(),
      deleteMachineBox: async () => {
        deleted = true
      },
    })
    expect(events).toEqual([])
    expect(deleted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// restorePrivateArchive
// ---------------------------------------------------------------------------

describe('restorePrivateArchive', () => {
  it('finds the newest owner-attributed archive for fresh replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-latest-private-'))
    try {
      mkdirSync(join(root, 'agent_owner-100'))
      mkdirSync(join(root, 'agent_owner-300'))
      mkdirSync(join(root, 'agent_other-999'))
      expect(await findLatestPrivateArchive('agent_owner', { getArchiveRoot: () => root })).toBe(
        join(root, 'agent_owner-300', 'private.tar.gz')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Local fake runner that keeps stdin RAW (the shared makeFakeRunner
   *  stringifies it, which would mangle the pushed tar bytes). */
  function makeRawRunner(handler?: (command: string) => SshResult): {
    runner: SshRunner
    calls: Array<{ command: string; stdin?: string | Uint8Array }>
  } {
    const calls: Array<{ command: string; stdin?: string | Uint8Array }> = []
    const runner: SshRunner = {
      async run(_machine, command, opts): Promise<SshResult> {
        calls.push({ command, stdin: opts?.stdin })
        return handler?.(command) ?? { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    return { runner, calls }
  }

  it('reads the archive, pushes the bytes to a scratch path, then runs box-provision --restore', async () => {
    const machine = makeMachine()
    const { runner, calls } = makeRawRunner()
    const archiveBytes = new TextEncoder().encode('tar-bytes')
    const reads: string[] = []

    await restorePrivateArchive(runner, machine, 'sb-1', '/home/box_x', '/tmp/archive-root/sb-1-1234/private.tar.gz', {
      readArchiveFile: async (src: string) => {
        reads.push(src)
        return archiveBytes
      },
    })

    expect(reads).toEqual(['/tmp/archive-root/sb-1-1234/private.tar.gz'])
    expect(calls).toHaveLength(3)
    // (b) the bytes land at a machine-side scratch path, root-installed 0600 so
    // no co-located box user can read the private tree in transit.
    expect(calls[0].command).toBe(`sudo install -m 0600 /dev/stdin '/tmp/tau-restore-sb-1.tar.gz'`)
    expect(calls[0].stdin).toBe(archiveBytes)
    // (c) box-provision extracts the scratch tar into the box home.
    expect(calls[1].command).toBe(
      `sudo bash /opt/tau/bin/box-provision.sh --unix-user '${boxUnixUser('sb-1')}' ` +
        `--restore '/tmp/tau-restore-sb-1.tar.gz'`
    )
    // (d) the scratch tar (a full copy of the private tree) never lingers.
    expect(calls[2].command).toBe(`sudo rm -f '/tmp/tau-restore-sb-1.tar.gz'`)
  })

  it('throws when the --restore command exits non-zero (but still removes the scratch tar)', async () => {
    const machine = makeMachine()
    const { runner, calls } = makeRawRunner((command) =>
      command.includes('--restore')
        ? { exitCode: 1, stdout: '', stderr: 'tar: broken' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )

    await expect(
      restorePrivateArchive(runner, machine, 'sb-1', '/home/box_x', '/tmp/archive-root/sb-1-1234/private.tar.gz', {
        readArchiveFile: async () => new TextEncoder().encode('tar-bytes'),
      })
    ).rejects.toThrow(/box-provision --restore failed for sb-1 \(exit 1\): tar: broken/)

    // Best-effort scratch cleanup runs on the failure path too.
    expect(calls.map((c) => c.command).filter((c) => c.startsWith('sudo rm -f'))).toEqual([
      `sudo rm -f '/tmp/tau-restore-sb-1.tar.gz'`,
    ])
  })

  it('is a no-op when the archive file is ABSENT: no push, no throw', async () => {
    const machine = makeMachine()
    const { runner, calls } = makeRawRunner()

    // No readArchiveFile injected: the DEFAULT reader hits the real fs, sees
    // ENOENT, and must resolve as a successful no-op (mirroring the pull side's
    // empty-archive tolerance for a box that never had ~/.private).
    await restorePrivateArchive(
      runner,
      machine,
      'sb-1',
      '/home/box_x',
      '/tmp/archive-root/definitely-absent-tau-test/private.tar.gz',
      {}
    )

    expect(calls).toEqual([])
  })

  it('is a no-op when the archive file is EMPTY: no push, no throw', async () => {
    const machine = makeMachine()
    const { runner, calls } = makeRawRunner()

    await restorePrivateArchive(runner, machine, 'sb-1', '/home/box_x', '/tmp/archive-root/sb-1-1234/private.tar.gz', {
      readArchiveFile: async () => new Uint8Array(0),
    })

    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// durableStateDirsForRole + pullPrivateArchive (role-driven archive set)
// ---------------------------------------------------------------------------

describe('durableStateDirsForRole', () => {
  it('preserves an idle agent workspace independently of WORKSPACE_PATH', () => {
    expect(durableStateDirsForRole('agent')).toEqual(['workspace', '.private'])
    expect(durableStateDirsForRole('system-manager')).toEqual(['workspace', '.private'])
    expect(durableStateDirsForRole('squad')).toEqual(['workspace', '.private'])
  })
})

describe('pullPrivateArchive', () => {
  const ARCHIVE_B64 = Buffer.from('archive-bytes').toString('base64')

  it('default (.private) pull emits the exact legacy tar invocation — regression pin', async () => {
    const machine = makeMachine()
    const { runner, calls } = makeFakeRunner([], (command) =>
      command.includes('tar czf')
        ? { exitCode: 0, stdout: ARCHIVE_B64, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )

    await pullPrivateArchive(runner, machine, 'sb-1', '/home/box_x', {
      getArchiveRoot: () => '/tmp/archive-root',
      writeArchiveFile: async () => {},
      now: () => 1234,
    })

    // Byte-identical to the command shipped before squad archiving existed: a
    // single-member archive keeps the exact if/tar/else/empty shape.
    expect(calls[0].command).toBe(
      `if sudo test -d '/home/box_x'/.private; then sudo tar czf - -C '/home/box_x' .private; ` +
        `else sudo tar czf - -C '/home/box_x' --files-from /dev/null; fi | base64 -w0`
    )
  })

  it('squad state dirs pull tars ~/workspace and ~/.private (only the members that exist)', async () => {
    const machine = makeMachine()
    const { runner, calls } = makeFakeRunner([], (command) =>
      command.includes('tar czf')
        ? { exitCode: 0, stdout: ARCHIVE_B64, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )

    await pullPrivateArchive(
      runner,
      machine,
      'squad_1',
      '/home/box_y',
      { getArchiveRoot: () => '/tmp/archive-root', writeArchiveFile: async () => {}, now: () => 1234 },
      { stateDirs: ['workspace', '.private'] }
    )

    const cmd = calls[0].command
    // Both authoritative dirs are candidates for the tar…
    expect(cmd).toContain('for d in workspace .private')
    // …each guarded by an existence test (a member that doesn't exist is skipped
    // rather than failing the whole tar under pipefail)…
    expect(cmd).toContain('sudo test -d')
    // …with the same empty-archive fallback when NEITHER exists.
    expect(cmd).toContain('--files-from /dev/null')
    expect(cmd).toContain('base64 -w0')
  })

  it('threads a large timeout budget to the runner so a multi-GB tar over SSH is not killed at the 30s default', async () => {
    const machine = makeMachine()
    const seen: Array<{ timeoutMs?: number }> = []
    const runner: SshRunner = {
      async run(_m, command, opts): Promise<SshResult> {
        seen.push({ timeoutMs: opts?.timeoutMs })
        return command.includes('tar czf')
          ? { exitCode: 0, stdout: ARCHIVE_B64, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' }
      },
    }

    await pullPrivateArchive(
      runner,
      machine,
      'squad_1',
      '/home/box_y',
      { getArchiveRoot: () => '/tmp/archive-root', writeArchiveFile: async () => {}, now: () => 1234 },
      { stateDirs: ['workspace', '.private'], timeoutMs: 1_800_000 }
    )

    expect(seen[0].timeoutMs).toBe(1_800_000)
  })
})

// ---------------------------------------------------------------------------
// Streamed state-archive transport (migration): codec, commands, verification
// ---------------------------------------------------------------------------

describe('tarCodecFlag', () => {
  it('maps each codec onto tar’s own flag (zstd’s default level IS 3 — fast, not maximal)', () => {
    expect(tarCodecFlag('zstd')).toBe('--zstd')
    expect(tarCodecFlag('gzip')).toBe('-z')
  })
})

describe('detectArchiveCodec', () => {
  function probeRunner(replies: Record<string, string | Error>): { runner: SshRunner; probed: string[] } {
    const probed: string[] = []
    const runner: SshRunner = {
      async run(machine, command): Promise<SshResult> {
        probed.push(machine.id)
        expect(command).toBe(ARCHIVE_CODEC_PROBE_COMMAND)
        const reply = replies[machine.id]
        if (reply instanceof Error) throw reply
        if (reply === undefined) return { exitCode: 1, stdout: '', stderr: 'probe blew up' }
        return { exitCode: 0, stdout: `${reply}\n`, stderr: '' }
      },
    }
    return { runner, probed }
  }

  const SRC = makeMachine({ id: 'src' })
  const DST = makeMachine({ id: 'dst' })

  it('uses zstd only when BOTH hosts prove they can produce a zstd tar', async () => {
    const { runner, probed } = probeRunner({ src: 'zstd', dst: 'zstd' })
    expect(await detectArchiveCodec(runner, [SRC, DST], { preference: 'auto' })).toBe('zstd')
    expect(probed).toEqual(['src', 'dst'])
  })

  it('falls back to gzip when EITHER host lacks zstd — the write codec is never one the reader cannot decode', async () => {
    const { runner } = probeRunner({ src: 'zstd', dst: 'gzip' })
    expect(await detectArchiveCodec(runner, [SRC, DST], { preference: 'auto' })).toBe('gzip')

    const other = probeRunner({ src: 'gzip', dst: 'zstd' })
    expect(await detectArchiveCodec(other.runner, [SRC, DST], { preference: 'auto' })).toBe('gzip')
  })

  it('falls back to gzip when a probe fails outright (non-zero exit or a thrown SSH error)', async () => {
    const failed = probeRunner({ src: 'zstd' }) // dst → exit 1
    expect(await detectArchiveCodec(failed.runner, [SRC, DST], { preference: 'auto' })).toBe('gzip')

    const threw = probeRunner({ src: 'zstd', dst: new Error('connection reset') })
    expect(await detectArchiveCodec(threw.runner, [SRC, DST], { preference: 'auto' })).toBe('gzip')
  })

  it('an explicit gzip preference skips the probes entirely', async () => {
    const { runner, probed } = probeRunner({ src: 'zstd', dst: 'zstd' })
    expect(await detectArchiveCodec(runner, [SRC, DST], { preference: 'gzip' })).toBe('gzip')
    expect(probed).toEqual([])
  })

  it('an explicit zstd preference is still VERIFIED against both hosts, not trusted', async () => {
    // Pinning a codec a host cannot read is exactly the corruption this
    // detection exists to prevent, so the pin only selects the candidate.
    const { runner, probed } = probeRunner({ src: 'zstd', dst: 'gzip' })
    expect(await detectArchiveCodec(runner, [SRC, DST], { preference: 'zstd' })).toBe('gzip')
    expect(probed).toEqual(['src', 'dst'])
  })
})

describe('buildArchiveStreamCommand', () => {
  it('tars the role-derived dirs straight to stdout — no base64, no trailing pipe', () => {
    const cmd = buildArchiveStreamCommand('/home/box_y', ['workspace', '.private'], 'zstd')

    expect(cmd).toContain('for d in workspace .private')
    expect(cmd).toContain(`sudo tar -c --zstd -f - -C '/home/box_y'`)
    // No base64 anywhere: the whole point is that no encoded copy is ever made.
    expect(cmd).not.toContain('base64')
    // And no pipeline tail — a pipeline's exit status is its LAST element's, so
    // a `| something` here would MASK a failing tar and make a truncated stream
    // look complete. tar must be the command whose status ssh reports.
    expect(cmd).not.toContain('|')
  })

  it('keeps the existence guard + empty-archive fallback (a box missing a state dir must not fail the tar)', () => {
    const cmd = buildArchiveStreamCommand('/home/box_x', ['.private'], 'gzip')

    expect(cmd).toContain(`sudo test -d '/home/box_x'`)
    expect(cmd).toContain('--files-from /dev/null')
    expect(cmd).toContain('sudo tar -c -z -f -')
  })

  it('refuses a state dir name that is not a plain path segment (it is interpolated unquoted)', () => {
    expect(() => buildArchiveStreamCommand('/home/box_x', ['work space'], 'gzip')).toThrow(/state dir/)
    expect(() => buildArchiveStreamCommand('/home/box_x', ['../etc'], 'gzip')).toThrow(/state dir/)
    expect(() => buildArchiveStreamCommand('/home/box_x', ['$(id)'], 'gzip')).toThrow(/state dir/)
  })
})

describe('buildStreamRestoreCommand', () => {
  it('hands box-provision.sh the SAME codec and safely omits the unused port', async () => {
    const unixUser = 'box_ffffeeee2222'
    const dirs = ['workspace', '.private']
    const codec = 'zstd' as const
    const cmd = buildStreamRestoreCommand(unixUser, dirs, codec)
    const scriptUrl = new URL('../../../../../scripts/machine/box-provision.sh', import.meta.url)

    // Let bash parse the exact production command suffix into NUL-delimited
    // argv. No handwritten argv or shell word splitting approximates it.
    const launcher = 'sudo bash /opt/tau/bin/box-provision.sh '
    expect(cmd.startsWith(launcher)).toBeTrue()
    const capture = Bun.spawn(['bash', '-c', `printf '%s\\0' ${cmd.slice(launcher.length)}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [captured, captureExit] = await Promise.all([new Response(capture.stdout).arrayBuffer(), capture.exited])
    expect(captureExit).toBe(0)
    const argv = new TextDecoder().decode(captured).split('\0').slice(0, -1)

    // Execute that actual production argv through the checked-in parser. The
    // absent fixture user proves --restore-stream reached its branch.
    expect(Bun.spawnSync(['id', '-u', unixUser]).exitCode).not.toBe(0)
    const proc = Bun.spawn(['bash', scriptUrl.pathname, ...argv], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('cannot restore')
    expect(stderr).not.toContain('--port')

    expect(cmd).toBe(
      `sudo bash /opt/tau/bin/box-provision.sh --unix-user 'box_ffffeeee2222' ` +
        `--restore-stream --codec zstd --state-dirs 'workspace .private' ` +
        `--staging-id '00000000-0000-4000-8000-000000000000'`
    )
    expect(cmd).not.toContain('--port')
    expect(cmd).not.toContain('/tmp/')
    expect(cmd).not.toContain('install -m')

    const callerSource = readFileSync(new URL('./box-manager.ts', import.meta.url), 'utf8')
    expect(callerSource).toContain('intentionally omits `--port`')
    const script = readFileSync(scriptUrl, 'utf8')
    expect(script).toContain('Restore/remove (port unused and optional):')
  })

  it('shell-quotes a hostile unix user as one byte-identical argv element without side effects', async () => {
    const marker = `/tmp/tau-restore-render-${randomUUID()}`
    const unixUser = `-bad 'quote' space $(touch ${marker}) ` + '`touch ' + marker + '` ; back\\slash\nnewline'
    const cmd = buildStreamRestoreCommand(unixUser, ['workspace', '.private'], 'gzip')
    const launcher = 'sudo bash /opt/tau/bin/box-provision.sh '

    rmSync(marker, { force: true })
    try {
      const capture = Bun.spawn(['bash', '-c', `printf '%s\\0' ${cmd.slice(launcher.length)}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [captured, captureExit] = await Promise.all([new Response(capture.stdout).arrayBuffer(), capture.exited])
      const argv = new TextDecoder().decode(captured).split('\0').slice(0, -1)

      expect(existsSync(marker)).toBeFalse()
      expect(captureExit).toBe(0)
      expect(argv).toEqual([
        '--unix-user',
        unixUser,
        '--restore-stream',
        '--codec',
        'gzip',
        '--state-dirs',
        'workspace .private',
        '--staging-id',
        '00000000-0000-4000-8000-000000000000',
      ])
      expect(argv.filter((arg) => arg === unixUser)).toHaveLength(1)
    } finally {
      rmSync(marker, { force: true })
    }
  })

  it('refuses an unsafe state dir name', () => {
    expect(() => buildStreamRestoreCommand('box_abc123abc123', ['a b'], 'gzip')).toThrow(/state dir/)
  })
})

describe('state-dir facts (the replacement for the at-rest archive inspection)', () => {
  it('expectedStateDirMode mirrors box-provision.sh --restore’s own locks', () => {
    // A root-owned or group-readable ~/workspace is a dead squad box; these are
    // the modes the script applies and the ones verification demands back.
    expect(expectedStateDirMode('workspace')).toBe('755')
    expect(expectedStateDirMode('.private')).toBe('700')
  })

  it('buildStateDirFactsCommand asks for presence, owner:mode and a top-level entry count per dir', () => {
    const cmd = buildStateDirFactsCommand('/home/box_y', ['workspace', '.private'])

    expect(cmd).toContain('for d in workspace .private')
    expect(cmd).toContain(`sudo test -d '/home/box_y'`)
    expect(cmd).toContain(`sudo stat -c '%U:%a'`)
    // Top level only: an O(entries) probe, never a full-tree walk of a
    // multi-GB workspace.
    expect(cmd).toContain('-mindepth 1 -maxdepth 1')
  })

  it('parseStateDirFacts reads the present and absent line shapes', () => {
    const facts = parseStateDirFacts(['workspace present box_abc:755 12', '.private absent - 0'].join('\n'))

    expect(facts).toEqual({
      workspace: { present: true, owner: 'box_abc', mode: '755', entries: 12 },
      '.private': { present: false, owner: '', mode: '', entries: 0 },
    })
  })

  it('measureBoxStateDirs throws when the probe itself fails (an unmeasurable box is never assumed intact)', async () => {
    const runner: SshRunner = {
      async run(): Promise<SshResult> {
        return { exitCode: 1, stdout: '', stderr: 'stat: no such file' }
      },
    }

    await expect(measureBoxStateDirs(runner, makeMachine(), 'sb-1', '/home/box_x', ['.private'])).rejects.toThrow(
      /state dir probe failed for sb-1/
    )
  })

  it('measureBoxStateDirs returns a fact per requested dir', async () => {
    const runner: SshRunner = {
      async run(): Promise<SshResult> {
        return { exitCode: 0, stdout: 'workspace present box_abc:755 3\n.private present box_abc:700 1\n', stderr: '' }
      },
    }

    const facts = await measureBoxStateDirs(runner, makeMachine(), 'squad_1', '/home/box_y', ['workspace', '.private'])

    expect(facts.workspace).toEqual({ present: true, owner: 'box_abc', mode: '755', entries: 3 })
    expect(facts['.private'].entries).toBe(1)
  })

  it('measureBoxStateDirs throws when a requested dir is missing from the reply (a partial probe proves nothing)', async () => {
    const runner: SshRunner = {
      async run(): Promise<SshResult> {
        return { exitCode: 0, stdout: 'workspace present box_abc:755 3\n', stderr: '' }
      },
    }

    await expect(
      measureBoxStateDirs(runner, makeMachine(), 'squad_1', '/home/box_y', ['workspace', '.private'])
    ).rejects.toThrow(/\.private/)
  })
})

describe('compareStateDirFacts (destination outcome verification)', () => {
  const unixUser = 'box_abc123abc123'
  const stateDirs = ['workspace', '.private']
  const sourceFacts = {
    workspace: { present: true, owner: 'box_src', mode: '755', entries: 7 },
    '.private': { present: true, owner: 'box_src', mode: '700', entries: 2 },
  }
  const goodDest = {
    workspace: { present: true, owner: unixUser, mode: '755', entries: 7 },
    '.private': { present: true, owner: unixUser, mode: '700', entries: 2 },
  }

  it('passes when every dir landed with the source’s top-level entries and the box user’s ownership/mode', () => {
    expect(compareStateDirFacts([sourceFacts], goodDest, { unixUser, stateDirs })).toEqual({ ok: true, reason: '' })
  })

  it('FAILS an empty/absent workspace — the exact silent-total-loss shape', () => {
    expect(
      compareStateDirFacts(
        [sourceFacts],
        { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries: 0 } },
        { unixUser, stateDirs }
      ).ok
    ).toBe(false)

    const absent = compareStateDirFacts(
      [sourceFacts],
      { ...goodDest, workspace: { present: false, owner: '', mode: '', entries: 0 } },
      { unixUser, stateDirs }
    )
    expect(absent.ok).toBe(false)
    expect(absent.reason).toContain('workspace')
  })

  it('FAILS a partially-delivered dir (fewer top-level entries than the source had)', () => {
    const result = compareStateDirFacts(
      [sourceFacts],
      { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries: 3 } },
      { unixUser, stateDirs }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('3')
  })

  it('FAILS a root-owned restored workspace (a dead squad box) and a wrong mode', () => {
    const rootOwned = compareStateDirFacts(
      [sourceFacts],
      { ...goodDest, workspace: { present: true, owner: 'root', mode: '755', entries: 7 } },
      { unixUser, stateDirs }
    )
    expect(rootOwned.ok).toBe(false)
    expect(rootOwned.reason).toContain('root')

    const wrongMode = compareStateDirFacts(
      [sourceFacts],
      { ...goodDest, '.private': { present: true, owner: unixUser, mode: '755', entries: 2 } },
      { unixUser, stateDirs }
    )
    expect(wrongMode.ok).toBe(false)
    expect(wrongMode.reason).toContain('700')
  })

  it('tolerates a source dir that never existed, but still demands the dir exist on the destination', () => {
    const emptySource = {
      workspace: { present: false, owner: '', mode: '', entries: 0 },
      '.private': { present: false, owner: '', mode: '', entries: 0 },
    }
    // A brand-new squad box that has done no work: box-provision's ensure_dirs
    // created both dirs on the target, so the migration is genuinely complete.
    const freshDest = {
      workspace: { present: true, owner: unixUser, mode: '755', entries: 0 },
      '.private': { present: true, owner: unixUser, mode: '700', entries: 0 },
    }
    expect(compareStateDirFacts([emptySource], freshDest, { unixUser, stateDirs })).toEqual({ ok: true, reason: '' })
  })

  // ---------------------------------------------------------------------------
  // A STALE destination is exactly as dangerous as a partial one, which is why
  // this comparison keeps an UPPER bound rather than settling for `>=`.
  //
  // The reachable path: migration A→B streams the workspace and then fails at
  // health/repoint. `teardownNewBox` is best-effort and its failure is only a
  // WARN, so the restored home survives on B. Work continues on A and a
  // top-level entry is deleted. A later A→B attempt whose transfer silently
  // omits `workspace` (both ends exit 0, bytes > 0 from a `.private`-only
  // archive) would pass a `>=` check against B's stale SUPERSET — health
  // passes, the row repoints, and A is torn down. That is the data loss.
  //
  // (checkDestinationBaseline is the primary guard against that shape — it
  // proves the destination EMPTY before the stream. The ceiling here is
  // defence in depth for the day the baseline is bypassed or regressed.)
  // ---------------------------------------------------------------------------
  it('FAILS a destination holding MORE than the source (a STALE tree from an abandoned attempt)', () => {
    const result = compareStateDirFacts(
      [sourceFacts],
      { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries: 9 } },
      { unixUser, stateDirs }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('9')
    expect(result.reason).toContain('7')
  })

  // ---------------------------------------------------------------------------
  // TWO source readings: the migration measures the source before provisioning
  // and again right after the stream, because minutes of artifact delivery and
  // box install sit between them and the source box stays LIVE throughout. Any
  // entry a background build adds in that window would make an exact
  // comparison abort AFTER the whole multi-GB stream was paid for. The band
  // between the readings absorbs that; the ceiling survives it.
  // ---------------------------------------------------------------------------
  const sourceAfter = {
    workspace: { present: true, owner: 'box_src', mode: '755', entries: 9 },
    '.private': { present: true, owner: 'box_src', mode: '700', entries: 2 },
  }

  it('accepts a destination ANYWHERE in [min, max] of the two source readings', () => {
    for (const entries of [7, 8, 9]) {
      const result = compareStateDirFacts(
        [sourceFacts, sourceAfter],
        { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries } },
        { unixUser, stateDirs }
      )
      expect(result).toEqual({ ok: true, reason: '' })
    }
  })

  it('reading ORDER does not matter — drift downward widens the same band', () => {
    expect(
      compareStateDirFacts(
        [sourceAfter, sourceFacts],
        { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries: 8 } },
        { unixUser, stateDirs }
      )
    ).toEqual({ ok: true, reason: '' })
  })

  it('still FAILS a destination beyond BOTH readings (the ceiling is retained, not dropped)', () => {
    const result = compareStateDirFacts(
      [sourceFacts, sourceAfter],
      { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries: 10 } },
      { unixUser, stateDirs }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('10')
  })

  it('still FAILS a destination below BOTH readings (partial delivery survives drift)', () => {
    const result = compareStateDirFacts(
      [sourceFacts, sourceAfter],
      { ...goodDest, workspace: { present: true, owner: unixUser, mode: '755', entries: 6 } },
      { unixUser, stateDirs }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('6')
  })

  it('refuses to verify against NO source reading at all (unmeasured ≠ verified)', () => {
    const result = compareStateDirFacts([], goodDest, { unixUser, stateDirs })
    expect(result.ok).toBe(false)
  })
})

describe('checkDestinationBaseline (the destination is freshly provisioned)', () => {
  const stateDirs = ['workspace', '.private']
  const fresh = {
    workspace: { present: true, owner: 'box_abc123abc123', mode: '755', entries: 0 },
    '.private': { present: true, owner: 'box_abc123abc123', mode: '700', entries: 0 },
  }

  it('passes for a just-provisioned box: every state dir present and EMPTY', () => {
    expect(checkDestinationBaseline(fresh, { stateDirs })).toEqual({ ok: true, reason: '' })
  })

  it('FAILS when a state dir already holds entries (a stale tree from an abandoned migration)', () => {
    const result = checkDestinationBaseline(
      { ...fresh, workspace: { present: true, owner: 'box_abc123abc123', mode: '755', entries: 9 } },
      { stateDirs }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('workspace')
    expect(result.reason).toContain('9')
  })

  it('FAILS when a state dir is absent (box-provision’s ensure_dirs creates every one)', () => {
    const result = checkDestinationBaseline(
      { ...fresh, '.private': { present: false, owner: '', mode: '', entries: 0 } },
      { stateDirs }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('.private')
  })

  it('FAILS when a requested dir was not measured at all', () => {
    expect(checkDestinationBaseline({}, { stateDirs }).ok).toBe(false)
  })
})

describe('streamBoxStateArchive (fail-closed matrix)', () => {
  const source = { machine: makeMachine({ id: 'src' }), home: '/home/box_y' }
  const dest = { machine: makeMachine({ id: 'dst' }), unixUser: 'box_abc123abc123' }

  function fakeStreamer(
    result: Partial<{
      bytes: number
      source: { exitCode: number; stderr: string }
      dest: { exitCode: number; stderr: string }
      throws: Error
    }>
  ): { streamer: SshStreamer; calls: Array<{ source: string; dest: string; timeoutMs?: number }> } {
    const calls: Array<{ source: string; dest: string; timeoutMs?: number }> = []
    const streamer: SshStreamer = {
      async stream(src, dst, opts) {
        calls.push({ source: src.command, dest: dst.command, timeoutMs: opts?.timeoutMs })
        if (result.throws) throw result.throws
        return {
          bytes: result.bytes ?? 4096,
          source: result.source ?? { exitCode: 0, stderr: '' },
          dest: result.dest ?? { exitCode: 0, stderr: '' },
        }
      },
    }
    return { streamer, calls }
  }

  const run = (streamer: SshStreamer, extra: { timeoutMs?: number } = {}) =>
    streamBoxStateArchive(
      {
        sandboxId: 'squad_1',
        source,
        dest,
        stateDirs: ['workspace', '.private'],
        codec: 'zstd',
        ...extra,
      },
      { streamer }
    )

  it('wires the source tar to the destination restore with the SAME codec and threads the budget', async () => {
    const { streamer, calls } = fakeStreamer({ bytes: 123456 })

    const result = await run(streamer, { timeoutMs: 1_800_000 })

    expect(result).toEqual({ bytes: 123456 })
    expect(calls[0].source).toBe(buildArchiveStreamCommand('/home/box_y', ['workspace', '.private'], 'zstd'))
    expect(calls[0].dest).toBe(buildStreamRestoreCommand('box_abc123abc123', ['workspace', '.private'], 'zstd'))
    expect(calls[0].timeoutMs).toBe(1_800_000)
  })

  it('a non-zero SOURCE exit aborts as end="source" even though the destination exited 0', async () => {
    const { streamer } = fakeStreamer({
      bytes: 4096,
      source: { exitCode: 2, stderr: 'tar: /home/box_y/workspace: Cannot read' },
    })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err).toBeInstanceOf(BoxArchiveStreamError)
    expect(err.end).toBe('source')
    expect(err.message).toContain('Cannot read')
  })

  it('a non-zero DESTINATION exit aborts as end="destination"', async () => {
    const { streamer } = fakeStreamer({ dest: { exitCode: 1, stderr: 'tar: Unexpected EOF in archive' } })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err.end).toBe('destination')
    expect(err.message).toContain('Unexpected EOF')
  })

  it('a ZERO-byte transfer aborts even when both ends exited 0 (the source produced nothing at all)', async () => {
    const { streamer } = fakeStreamer({ bytes: 0 })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err).toBeInstanceOf(BoxArchiveStreamError)
    expect(err.message).toContain('0 bytes')
  })

  it('a transport-level throw (timeout / connection death) aborts as end="transport"', async () => {
    const { streamer } = fakeStreamer({ throws: new Error('ssh stream timed out after 1800000ms') })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err.end).toBe('transport')
    expect(err.message).toContain('timed out')
  })

  // -------------------------------------------------------------------------
  // BOTH ends are always reported. The attribution is a heuristic and must
  // never be the only thing an operator gets: when the DESTINATION is the real
  // cause, core's pipe pump cancels the source's stdout, the source ssh dies of
  // EPIPE, and BOTH ends exit non-zero — a shape reproduced live as
  // {"bytes":262144,"sExit":1,"dExit":2,dErr:"unknown argument: --restore-stream"}.
  // Attributing that to the source is defensible (a truncated source also fails
  // the destination's decompressor) but reporting ONLY the source's stderr —
  // empty or "Broken pipe" — hides the real cause entirely.
  // -------------------------------------------------------------------------
  it('reports BOTH ends’ exit codes and stderr even when the SOURCE end is blamed', async () => {
    const { streamer } = fakeStreamer({
      bytes: 262144,
      source: { exitCode: 1, stderr: 'Broken pipe' },
      dest: { exitCode: 2, stderr: 'box-provision.sh: unknown argument: --restore-stream' },
    })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err).toBeInstanceOf(BoxArchiveStreamError)
    // Attribution kept (callers map it to a migrate reason) …
    expect(err.end).toBe('source')
    // … but presented as a guess, not a fact, because BOTH ends failed.
    expect(err.ambiguous).toBe(true)
    expect(err.message).toContain('ambiguous')
    // … and the real cause is in the message regardless of the attribution.
    expect(err.message).toContain('unknown argument: --restore-stream')
    expect(err.message).toContain('Broken pipe')
    expect(err.message).toContain('source exit 1')
    expect(err.message).toContain('destination exit 2')
    expect(err.message).toContain('262144')
    // Structured too, so a caller need not scrape the message.
    expect(err.ends).toEqual({
      bytes: 262144,
      source: { exitCode: 1, stderr: 'Broken pipe' },
      dest: { exitCode: 2, stderr: 'box-provision.sh: unknown argument: --restore-stream' },
    })
  })

  it('reports BOTH ends when only ONE failed, and does not claim ambiguity', async () => {
    const { streamer } = fakeStreamer({
      bytes: 4096,
      source: { exitCode: 2, stderr: 'tar: /home/box_y/workspace: Cannot read' },
    })
    const sourceOnly = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(sourceOnly.ambiguous).toBe(false)
    expect(sourceOnly.message).toContain('source exit 2')
    expect(sourceOnly.message).toContain('destination exit 0')

    const { streamer: destStreamer } = fakeStreamer({ dest: { exitCode: 9, stderr: 'No space left on device' } })
    const destOnly = (await run(destStreamer).catch((e) => e)) as BoxArchiveStreamError
    expect(destOnly.end).toBe('destination')
    expect(destOnly.ambiguous).toBe(false)
    expect(destOnly.message).toContain('source exit 0')
    expect(destOnly.message).toContain('No space left on device')
  })

  it('reports both ends for a ZERO-byte transfer too (both exited 0 — nothing to blame but the source)', async () => {
    const { streamer } = fakeStreamer({ bytes: 0 })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err.ends?.bytes).toBe(0)
    expect(err.message).toContain('source exit 0')
    expect(err.message).toContain('destination exit 0')
  })

  it('caps each end’s stderr to a tail so one chatty end cannot flood the log', async () => {
    const { streamer } = fakeStreamer({
      dest: { exitCode: 1, stderr: `${'x'.repeat(9000)}THE-ACTUAL-CAUSE` },
    })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    // The TAIL is what diagnoses a failure, so it is the tail that survives.
    expect(err.message).toContain('THE-ACTUAL-CAUSE')
    expect(err.message.length).toBeLessThan(6000)
  })

  it('a transport failure still says so plainly (no end results exist to report)', async () => {
    const { streamer } = fakeStreamer({ throws: new Error('connection closed by remote host') })

    const err = (await run(streamer).catch((e) => e)) as BoxArchiveStreamError
    expect(err.end).toBe('transport')
    expect(err.ends).toBeUndefined()
    expect(err.ambiguous).toBe(false)
  })
})

describe('archive codec round trip (real tar, no fakes)', () => {
  // The command builders emit tar flags; these prove the WRITE flag and the
  // READ flag this module pairs actually round-trip through real tar, and that
  // a truncated compressed stream fails the reader closed rather than
  // extracting a partial tree silently.
  async function localProbeVerdict(): Promise<string> {
    const proc = Bun.spawn(['bash', '-c', ARCHIVE_CODEC_PROBE_COMMAND], { stdout: 'pipe', stderr: 'pipe' })
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return out.trim()
  }

  async function roundTrip(codec: 'gzip' | 'zstd', truncateTo?: number): Promise<number> {
    const flag = tarCodecFlag(codec)
    const dir = `${process.env.HOME_DIR ?? '/tmp'}/codec-${codec}-${truncateTo ?? 'full'}`
    const cut = truncateTo === undefined ? '' : ` | head -c ${truncateTo}`
    const script =
      `set -o pipefail; rm -rf ${dir} && mkdir -p ${dir}/src/workspace ${dir}/out && ` +
      `head -c 200000 /dev/urandom > ${dir}/src/workspace/blob && ` +
      `(tar -c ${flag} -f - -C ${dir}/src workspace${cut}) > ${dir}/archive.bin && ` +
      `tar -x ${flag} -f - -C ${dir}/out < ${dir}/archive.bin`
    const proc = Bun.spawn(['bash', '-c', script], { stdout: 'pipe', stderr: 'pipe' })
    return await proc.exited
  }

  it('gzip: what the write flag produces, the read flag extracts', async () => {
    expect(await roundTrip('gzip')).toBe(0)
  })

  it('gzip: a TRUNCATED stream fails the reader closed (never a silent partial extract)', async () => {
    expect(await roundTrip('gzip', 512)).not.toBe(0)
  })

  it('the codec the PROBE blesses on this host really round-trips here (write AND read)', async () => {
    // The property that matters, asserted against whatever this host actually
    // supports: the probe must never bless a codec that cannot be read back.
    // macOS ships bsdtar, which CREATES `--zstd` archives it then cannot
    // extract — so on this host the probe must say gzip, and on a zstd-capable
    // host it must say zstd and zstd must round-trip. Either way the invariant
    // is the same, and a create-only probe would fail this test on macOS.
    // (The probe runs under `sudo -n` to match the transfer's privilege
    // context, so a dev host without NOPASSWD sudo also answers gzip — still a
    // verdict this host genuinely round-trips, which is all this asserts.)
    const verdict = await localProbeVerdict()
    expect(['zstd', 'gzip']).toContain(verdict)
    expect(await roundTrip(verdict as 'gzip' | 'zstd')).toBe(0)
    expect(await roundTrip(verdict as 'gzip' | 'zstd', 512)).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// stopBox
// ---------------------------------------------------------------------------

describe('stopBox', () => {
  it('stops the unit, removes the forward, and marks the box stopped', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner, calls } = makeFakeRunner(events)
    const upserts: Array<{ status?: string }> = []

    const result = await stopBox('sb-1', {
      runner,
      tunnels: makeFakeTunnels(events),
      getMachineBox: async () => box,
      getMachine: async () => machine,
      upsertMachineBox: async (b: { status?: string }) => {
        upserts.push({ status: b.status })
        return { ...box, status: b.status } as MachineBox
      },
    })

    expect(result).toEqual({ kind: 'verified' })
    expect(events).toEqual(['stop', 'removeForward'])
    expect(upserts.at(-1)?.status).toBe('stopped')
    const stopCall = calls.find((c) => c.command.includes('systemctl'))!
    expect(stopCall.command).toContain(`--machine=${box.unixUser}@.host`)
    // ALL THREE units, socket first: a park that left the socket listening
    // would be undone by the next connection re-activating the proxy.
    expect(stopCall.command).toContain(
      'stop tau-sandbox-server.socket tau-sandbox-server-proxy.service tau-sandbox-server.service'
    )
  })

  it('marks an unreachable-machine stop unverified without attempting SSH or tunnel mutation', async () => {
    const box = makeBox({ status: 'ready' })
    const machine = makeMachine({ status: 'unreachable' })
    const upserts: string[] = []
    const result = await stopBox('sb-1', {
      runner: { run: async () => Promise.reject(new Error('must not SSH')) } as any,
      tunnels: { removeForward: async () => Promise.reject(new Error('must not mutate tunnel')) } as any,
      getMachineBox: async () => box,
      getMachine: async () => machine,
      upsertMachineBox: async (update: { status?: string }) => {
        upserts.push(update.status ?? '')
        return { ...box, status: update.status } as MachineBox
      },
    })
    expect(result).toEqual({ kind: 'unverified' })
    expect(upserts).toEqual(['stop_unverified'])
  })

  it('deletes a stale box row when its recorded machine row is already gone', async () => {
    const box = makeBox({ status: 'stop_unverified' })
    const deleted: string[] = []
    await expect(
      stopBox('sb-1', {
        getMachineBox: async () => box,
        getMachine: async () => null,
        deleteMachineBox: async (sandboxId) => void deleted.push(sandboxId),
      })
    ).resolves.toEqual({ kind: 'not-found' })
    expect(deleted).toEqual(['sb-1'])
  })

  it('externalizes a durable stop marker, removes its old forward, and invalidates the original identity', async () => {
    const events: string[] = []
    const statuses: Array<{ sandboxId: string; machineId: string; status: string; port: number }> = []
    const machine = makeMachine({ id: '11111111-1111-1111-1111-111111111111', status: 'unreachable' })
    const unsubscribe = eventEmitter.on('box.status', (event) => statuses.push(event))
    try {
      await expect(
        externalizeUnverifiedStop('agent_old', {
          externalize: async () => ({
            kind: 'externalized',
            remnantId: 'unverified_stop_remnant_test',
            machineId: machine.id,
            port: 50123,
          }),
          getMachine: async () => machine,
          tunnels: makeFakeTunnels(events),
        })
      ).resolves.toBe(true)
    } finally {
      unsubscribe()
    }
    expect(events).toEqual(['removeForward'])
    expect(statuses).toContainEqual({ sandboxId: 'agent_old', machineId: machine.id, status: 'gone', port: 50123 })
  })

  it('verifies a deferred stop once the machine is ready and preserves the marker on failure', async () => {
    const box = makeBox({ status: 'stop_unverified' })
    const machine = makeMachine({ status: 'ready' })
    const statuses: string[] = []
    const failed = await stopBox('sb-1', {
      runner: { run: async () => Promise.reject(new Error('still unreachable')) } as any,
      tunnels: makeFakeTunnels([]),
      getMachineBox: async () => box,
      getMachine: async () => machine,
      upsertMachineBox: async (update: { status?: string }) => {
        statuses.push(update.status ?? '')
        return { ...box, status: update.status } as MachineBox
      },
    }).catch((error) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(statuses).toEqual([])

    const events: string[] = []
    const result = await stopBox('sb-1', {
      runner: makeFakeRunner(events).runner,
      tunnels: makeFakeTunnels(events),
      getMachineBox: async () => box,
      getMachine: async () => machine,
      upsertMachineBox: async (update: { status?: string }) => {
        statuses.push(update.status ?? '')
        return { ...box, status: update.status } as MachineBox
      },
    })
    expect(result).toEqual({ kind: 'verified' })
    expect(events).toEqual(['stop', 'removeForward'])
    expect(statuses).toEqual(['stopped'])
  })
})

// ---------------------------------------------------------------------------
// box unit control (system units for light boxes)
// ---------------------------------------------------------------------------

// Light (`agent_*`) boxes run their sandbox-server from a per-box SYSTEM unit
// so the host stops paying for a `systemd --user` manager + dbus per box
// (measured 2026-09-01 on the noah host: ~13 MB each, 45 managers). Boxes that
// need rootless docker (`squad_*` / `system_manager_*`) keep the user manager,
// and every command this manager builds for them must stay byte-identical.
describe('boxUnitControl', () => {
  it('puts an agent_* box on its own root-owned system unit', () => {
    const unixUser = boxUnixUser('agent_a1')
    const ctl = boxUnitControl({ sandboxId: 'agent_a1', unixUser })
    expect(ctl.mode).toBe('system')
    expect(ctl.unit).toBe(`tau-box-${unixUser}.service`)
    expect(ctl.systemctl).toBe('sudo systemctl')
    expect(ctl.journalctl).toBe(`sudo journalctl -u tau-box-${unixUser}.service`)
    expect(ctl.isActiveCommand()).toBe(`sudo systemctl is-active tau-box-${unixUser}.service`)
  })

  it('keeps docker-bearing and legacy boxes on the user manager, byte-identical to the pre-density commands', () => {
    for (const sandboxId of ['squad_s1', 'system_manager_u1', 'sb-legacy']) {
      const unixUser = boxUnixUser(sandboxId)
      const ctl = boxUnitControl({ sandboxId, unixUser })
      expect(ctl.mode).toBe('user')
      expect(ctl.unit).toBe('tau-sandbox-server.service')
      expect(ctl.systemctl).toBe(`sudo systemctl --machine=${unixUser}@.host --user`)
      // `$uid` is a REMOTE shell variable the caller defines (`uid=$(id -u …)`);
      // these two strings are exactly what the machine snapshot used to inline.
      expect(ctl.journalctl).toBe(
        `sudo -u '${unixUser}' env XDG_RUNTIME_DIR=/run/user/$uid journalctl --user -u tau-sandbox-server.service`
      )
      expect(ctl.isActiveCommand()).toBe(
        `sudo -u '${unixUser}' env XDG_RUNTIME_DIR=/run/user/$uid systemctl --user is-active tau-sandbox-server.service`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Socket activation: liveness, and never waking an idle box
// ---------------------------------------------------------------------------

/**
 * The snapshot's liveness decision is a REMOTE SHELL PROGRAM, so assert it by
 * running the exact command box-manager emits through real bash, with sudo /
 * systemctl / id stubbed on PATH. Asserting the string alone would happily pass
 * on a program that mis-decides.
 */
describe('machine snapshot liveness (executed)', () => {
  const stubs: string[] = []
  afterEach(() => {
    for (const dir of stubs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function stubDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'box-liveness-stub-'))
    stubs.push(dir)
    // `sudo` drops a leading `-u <user>` and execs the rest (so a
    // `sudo -u x env VAR=… systemctl …` probe still reaches the stub below).
    writeFileSync(join(dir, 'sudo'), '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"\n')
    // `systemctl is-active <unit>`: the unit is the last argument.
    writeFileSync(
      join(dir, 'systemctl'),
      [
        '#!/bin/sh',
        'unit=""',
        'for a in "$@"; do unit="$a"; done',
        'case "$unit" in',
        '  *.socket) printf "%s\\n" "$FAKE_SOCK" ;;',
        '  tau-box-*) printf "%s\\n" "$FAKE_SERVICE" ;;',
        '  *) printf "%s\\n" "$FAKE_LEGACY" ;;',
        'esac',
        '',
      ].join('\n')
    )
    chmodSync(join(dir, 'sudo'), 0o755)
    chmodSync(join(dir, 'systemctl'), 0o755)
    return dir
  }

  async function livenessFor(states: { sock: string; service: string; legacy: string }): Promise<string> {
    // A system-mode (agent_*) box: its three probes are distinguishable, so the
    // stub can answer each independently.
    const sandboxId = 'agent_live1'
    const command = buildMachineSnapshotCommand({ sandboxId, unixUser: boxUnixUser(sandboxId) })
    const dir = stubDir()
    const proc = Bun.spawn(['bash', '-c', command], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        FAKE_SOCK: states.sock,
        FAKE_SERVICE: states.service,
        FAKE_LEGACY: states.legacy,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return stdout.match(/^FICUS_BOX_LIVENESS=(\w+)$/m)?.[1] ?? `NONE:${stdout}`
  }

  it('reads socket active + service active as running', async () => {
    expect(await livenessFor({ sock: 'active', service: 'active', legacy: 'inactive' })).toBe('running')
    expect(await livenessFor({ sock: 'active', service: 'activating', legacy: 'inactive' })).toBe('running')
  })

  it('reads socket active + service inactive as IDLE — the healthy steady state', async () => {
    expect(await livenessFor({ sock: 'active', service: 'inactive', legacy: 'inactive' })).toBe('idle')
  })

  it('reads socket active + service FAILED as exited, not idle', async () => {
    // A server that exhausted Restart=on-failure is genuinely broken. Calling it
    // idle would make the box immortal: every probe fails, nothing condemns it.
    expect(await livenessFor({ sock: 'active', service: 'failed', legacy: 'inactive' })).toBe('exited')
  })

  it('falls back to the LEGACY user unit when there is no socket yet', async () => {
    // A box not re-provisioned since the socket layout landed: its port is held
    // by the old user-manager server, and condemning it would be wrong.
    expect(await livenessFor({ sock: 'inactive', service: 'inactive', legacy: 'active' })).toBe('running')
  })

  it('reads nothing active as exited', async () => {
    expect(await livenessFor({ sock: 'inactive', service: 'inactive', legacy: 'inactive' })).toBe('exited')
  })

  it('never mistakes the substring "inactive" for "active"', async () => {
    expect(await livenessFor({ sock: 'inactive', service: 'inactive', legacy: 'inactive' })).toBe('exited')
    expect(await livenessFor({ sock: 'failed', service: 'inactive', legacy: 'deactivating' })).toBe('exited')
  })
})

describe('idle boxes are healthy, and are never woken by a keep-warm ensure', () => {
  /** A ready box whose marker matches, with a fetch that always fails. */
  function idleBoxDeps(livenessLine: string) {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready', provisionedSpecHash: 'marker-1' })
    const { deps, calls } = happyDeps(events, machine, box)
    deps.getMachineBox = async () => box
    deps.fetch = makeFakeFetch(events, [{ ok: false, status: 503 }])
    // Any fall-through to a full re-provision must fail FAST: with sleep stubbed
    // out, the default budget would spin pollBoxHealth for ten wall-clock
    // seconds instead of failing the assertion.
    deps.healthBudgetMs = 1
    deps.runner = {
      run: async (_m: Machine, command: string) => {
        calls.push({ command, stdin: undefined })
        return {
          exitCode: 0,
          stdout: command.includes('FICUS_BOX_LIVENESS') ? livenessLine : '',
          stderr: '',
        } as SshResult
      },
      stream: (() => {
        throw new Error('unused')
      }) as unknown as SshStreamer,
    } as unknown as SshRunner
    // Bound the established-box grace loop too: `sleep` is stubbed out, so an
    // unbounded budget would spin real-time probes (and grow the evidence
    // array) instead of letting the assertion fail.
    const bounded = {
      ...deps,
      establishedIdleGraceMs: 0,
      establishedActiveGraceMs: 0,
      hasActiveExecution: async () => false,
      persistCondemnationEvidence: async () => {},
    } as unknown as Parameters<typeof ensureBox>[1]
    return { deps: bounded, events, machine, box, calls }
  }

  it('returns an `idle` box as healthy instead of condemning it', async () => {
    const { deps, events, machine, box } = idleBoxDeps('FICUS_BOX_LIVENESS=idle\n')
    const result = await ensureBox(
      { sandboxId: box.sandboxId, machineId: machine.id, env: {}, role: 'squad', specHash: 'marker-1' },
      deps
    )
    expect(result.box.status).toBe('ready')
    // No re-provision: the fast path returned, so nothing was rebuilt.
    expect(events).not.toContain('bundle')
    expect(events).not.toContain('ensuring')
  })

  it('with a `listening` hint, does not probe at all — probing IS what wakes the box', async () => {
    const { deps, events, machine, box, calls } = idleBoxDeps('FICUS_BOX_LIVENESS=idle\n')
    const result = await ensureBox(
      {
        sandboxId: box.sandboxId,
        machineId: machine.id,
        env: {},
        role: 'squad',
        specHash: 'marker-1',
        liveness: 'listening',
      },
      deps
    )
    expect(result.box.status).toBe('ready')
    expect(events).not.toContain('health')
    // ...and no machine snapshot either: the hint answered the question.
    expect(calls.some((c) => c.command.includes('FICUS_BOX_LIVENESS'))).toBe(false)
    // The tunnel forward IS still established — establishing an SSH -L does not
    // connect to the box port, so the endpoint is ready when work arrives.
    expect(events).toContain('forward')
    expect(result.endpoint).toBe('http://127.0.0.1:59999')
  })

  it('without the hint, an unhealthy `running` box still takes the condemnation path', async () => {
    const { deps, machine, box } = idleBoxDeps('FICUS_BOX_LIVENESS=running\n')
    const classifications: string[] = []
    // The condemnation is the assertion; the re-provision it falls through to
    // is not modelled by this fake runner and is allowed to fail.
    await ensureBox({ sandboxId: box.sandboxId, machineId: machine.id, env: {}, role: 'squad', specHash: 'marker-1' }, {
      ...deps,
      establishedIdleGraceMs: 0,
      establishedActiveGraceMs: 0,
      hasActiveExecution: async () => false,
      persistCondemnationEvidence: async (input: { classification: string }) => {
        classifications.push(input.classification)
      },
    } as unknown as Parameters<typeof ensureBox>[1]).catch(() => {})
    expect(classifications).toEqual(['running_http_dead'])
  })
})

describe('listening-port sweep', () => {
  it('parses only loopback listeners out of ss -ltnH', () => {
    const ss = [
      'LISTEN 0      4096       127.0.0.1:50100      0.0.0.0:*',
      'LISTEN 0      4096       127.0.0.1:50101      0.0.0.0:*',
      'LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*',
      'LISTEN 0      4096            [::1]:9999           [::]:*',
    ].join('\n')
    expect([...parseListeningLoopbackPorts(ss)].sort()).toEqual([50100, 50101])
  })

  it('is ONE ss per machine and surfaces a failed sweep rather than reporting nothing listening', async () => {
    const machine = makeMachine()
    const commands: string[] = []
    const runner = {
      run: async (_m: Machine, command: string) => {
        commands.push(command)
        return { exitCode: 0, stdout: 'LISTEN 0 4096 127.0.0.1:50100 0.0.0.0:*\n', stderr: '' } as SshResult
      },
      stream: (() => {
        throw new Error('unused')
      }) as unknown as SshStreamer,
    } as unknown as SshRunner
    expect([...(await listListeningLoopbackPorts(machine, { runner }))]).toEqual([50100])
    expect(commands).toEqual(['ss -ltnH'])

    const failing = {
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'ss: not found' }) as SshResult,
      stream: (() => {
        throw new Error('unused')
      }) as unknown as SshStreamer,
    } as unknown as SshRunner
    await expect(listListeningLoopbackPorts(machine, { runner: failing })).rejects.toThrow(/ss -ltnH failed/)
  })
})

describe('box unit commands by mode', () => {
  /** Fresh full provision; returns every command the runner saw. */
  async function provisionCommands(sandboxId: string, role: 'agent' | 'squad'): Promise<RecordedCall[]> {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ sandboxId, unixUser: boxUnixUser(sandboxId) })
    const { deps, calls } = happyDeps(events, machine, box)
    await ensureBox({ sandboxId, machineId: machine.id, env: {}, role }, deps)
    return calls
  }

  /** The machine snapshot an established box takes when /healthz stops answering. */
  async function snapshotCommand(sandboxId: string, role: 'agent' | 'squad'): Promise<string> {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ sandboxId, unixUser: boxUnixUser(sandboxId), status: 'ready' })
    const { deps } = happyDeps(events, machine, box)
    deps.getMachineBox = async () => box
    deps.fetch = makeFakeFetch(events, [
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ])
    const { runner, calls } = makeFakeRunner(events, (command) =>
      command.includes('FICUS_BOX_LIVENESS')
        ? { exitCode: 0, stdout: 'FICUS_BOX_LIVENESS=running\n', stderr: '' }
        : undefined
    )
    deps.runner = runner
    Object.assign(deps, {
      establishedActiveGraceMs: 20,
      establishedIdleGraceMs: 20,
      establishedGraceInitialGapMs: 1,
      hasActiveExecution: async () => true,
    })
    await ensureBox({ sandboxId, machineId: machine.id, env: {}, role }, deps)
    return calls.find((c) => c.command.includes('FICUS_BOX_LIVENESS'))!.command
  }

  async function stopCommand(sandboxId: string): Promise<string> {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ sandboxId, unixUser: boxUnixUser(sandboxId), status: 'ready' })
    const { runner, calls } = makeFakeRunner(events)
    await stopBox(sandboxId, {
      runner,
      tunnels: makeFakeTunnels(events),
      getMachineBox: async () => box,
      getMachine: async () => machine,
      upsertMachineBox: async (b: { status?: string }) => ({ ...box, status: b.status }) as MachineBox,
    })
    return calls.find((c) => c.command.includes('systemctl'))!.command
  }

  it('drives an agent_* box entirely through its system unit', async () => {
    const sandboxId = 'agent_a1'
    const unixUser = boxUnixUser(sandboxId)
    const unit = `tau-box-${unixUser}.service`

    const calls = await provisionCommands(sandboxId, 'agent')
    // The script is told the mode explicitly, so the two sides cannot disagree
    // about which unit exists (and a light box still gets no docker).
    const provCall = calls.find((c) => c.command.includes('box-provision.sh'))!
    expect(provCall.command).toContain('--unit-mode system')
    expect(provCall.command).not.toContain('--with-docker')
    // The socket start is what resumes a PARKED box; it is tolerated failing so
    // a box not yet re-provisioned onto the socket layout still restarts, and
    // the compound command's exit code is the RESTART's.
    expect(calls.find((c) => c.command.includes('systemctl'))!.command).toBe(
      `sudo systemctl reset-failed ${unit} 2>/dev/null || true; sudo systemctl start tau-box-${unixUser}.socket 2>/dev/null || true; sudo systemctl restart ${unit}`
    )

    expect(await stopCommand(sandboxId)).toBe(
      `sudo systemctl stop tau-box-${unixUser}.socket tau-box-${unixUser}-proxy.service ${unit}`
    )

    const snapshot = await snapshotCommand(sandboxId, 'agent')
    expect(snapshot).toContain(`sock=$(sudo systemctl is-active tau-box-${unixUser}.socket 2>/dev/null || true)`)
    expect(snapshot).toContain(`state=$(sudo systemctl is-active ${unit} 2>/dev/null || true)`)
    // A system-mode box that has NOT been re-provisioned since the unit-mode
    // split still runs the old user unit; without this leg it would read
    // `exited` and be condemned on its first unhealthy probe.
    expect(snapshot).toContain(
      `legacy=$(sudo -u '${unixUser}' env XDG_RUNTIME_DIR=/run/user/$uid systemctl --user is-active tau-sandbox-server.service 2>/dev/null || true)`
    )
    expect(snapshot).toContain(`sudo journalctl -u ${unit} -n 200 --no-pager`)
  })

  it('leaves a squad_* box on the user manager with the exact commands it had before', async () => {
    const sandboxId = 'squad_s1'
    const unixUser = boxUnixUser(sandboxId)

    const calls = await provisionCommands(sandboxId, 'squad')
    const provCall = calls.find((c) => c.command.includes('box-provision.sh'))!
    expect(provCall.command).toContain('--unit-mode user')
    expect(provCall.command).toContain('--with-docker')
    const userCtl = `sudo systemctl --machine=${unixUser}@.host --user`
    expect(calls.find((c) => c.command.includes('systemctl'))!.command).toBe(
      `${userCtl} reset-failed tau-sandbox-server.service 2>/dev/null || true; ${userCtl} start tau-sandbox-server.socket 2>/dev/null || true; ${userCtl} restart tau-sandbox-server.service`
    )

    expect(await stopCommand(sandboxId)).toBe(
      `${userCtl} stop tau-sandbox-server.socket tau-sandbox-server-proxy.service tau-sandbox-server.service`
    )

    const snapshot = await snapshotCommand(sandboxId, 'squad')
    expect(snapshot).toContain(
      `state=$(sudo -u '${unixUser}' env XDG_RUNTIME_DIR=/run/user/$uid systemctl --user is-active tau-sandbox-server.service 2>/dev/null || true)`
    )
    expect(snapshot).toContain(
      `sock=$(sudo -u '${unixUser}' env XDG_RUNTIME_DIR=/run/user/$uid systemctl --user is-active tau-sandbox-server.socket 2>/dev/null || true)`
    )
    // A user-mode box's pre-socket layout used the SAME service unit name, so
    // there is no separate legacy probe to run.
    expect(snapshot).toContain('legacy=;')
    expect(snapshot).toContain(
      `sudo -u '${unixUser}' env XDG_RUNTIME_DIR=/run/user/$uid journalctl --user -u tau-sandbox-server.service -n 200 --no-pager`
    )
  })
})

// ---------------------------------------------------------------------------
// box.status emission
// ---------------------------------------------------------------------------

describe('box.status emission', () => {
  function boxStatusEvents(spy: ReturnType<typeof spyOn>) {
    return spy.mock.calls.filter((c: unknown[]) => c[0] === 'box.status').map((c: unknown[]) => c[1])
  }

  it('ensureBox emits box.status ready after the box is marked ready', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox()
    const { deps } = happyDeps(events, machine, box)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await ensureBox({ sandboxId: 'sb-1', machineId: machine.id, env: { FOO: 'bar' }, role: 'squad' }, deps)
      // Carries the box's bound port so subscribers (the vm manager in BOTH
      // processes) can invalidate tunnel forwards without a DB read.
      expect(boxStatusEvents(spy)).toContainEqual({
        sandboxId: 'sb-1',
        machineId: machine.id,
        status: 'ready',
        port: 50100,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('stopBox emits box.status stopped after the row is parked', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner } = makeFakeRunner(events)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await stopBox('sb-1', {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        upsertMachineBox: async (b: { status?: string }) => ({ ...box, status: b.status }) as MachineBox,
      })
      expect(boxStatusEvents(spy)).toContainEqual({
        sandboxId: 'sb-1',
        machineId: box.machineId,
        status: 'stopped',
        port: box.port,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('removeBox emits box.status gone after the row is deleted', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'ready' })
    const { runner } = makeFakeRunner(events)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await removeBox('sb-1', undefined, {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        deleteMachineBox: async () => {},
      })
      expect(boxStatusEvents(spy)).toContainEqual({
        sandboxId: 'sb-1',
        machineId: box.machineId,
        status: 'gone',
        port: box.port,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('stopBox does NOT re-emit box.status stopped on a box that is already stopped', async () => {
    const events: string[] = []
    const machine = makeMachine()
    const box = makeBox({ status: 'stopped' })
    const { runner } = makeFakeRunner(events)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await stopBox('sb-1', {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => box,
        getMachine: async () => machine,
        upsertMachineBox: async (b: { status?: string }) => ({ ...box, status: b.status }) as MachineBox,
      })
      expect(boxStatusEvents(spy)).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('removeBox does NOT emit box.status when there is no box row', async () => {
    const events: string[] = []
    const { runner } = makeFakeRunner(events)
    const spy = spyOn(eventEmitter, 'emit')
    try {
      await removeBox('absent', undefined, {
        runner,
        tunnels: makeFakeTunnels(events),
        getMachineBox: async () => null,
        getMachine: async () => makeMachine(),
        deleteMachineBox: async () => {},
      })
      expect(boxStatusEvents(spy)).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// boxStatus
// ---------------------------------------------------------------------------

describe('boxStatus', () => {
  it('reports absent when there is no box row', async () => {
    expect(await boxStatus('sb-1', { getMachineBox: async () => null })).toBe('absent')
  })

  it('reports stopped for a parked box', async () => {
    expect(await boxStatus('sb-1', { getMachineBox: async () => makeBox({ status: 'stopped' }) })).toBe('stopped')
  })

  it('reports starting while the box row is mid-provision (ensuring)', async () => {
    // A brand-new box (or a re-provision) sits at 'ensuring'. That is non-terminal
    // — never a crash — so it must surface as a starting-equivalent, not 'failed'.
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ensuring' }),
        getMachine: async () => makeMachine({ status: 'ready' }),
      })
    ).toBe('starting')
  })

  it('reports ready when the box row is live, its machine is ready, and /healthz passes', async () => {
    const events: string[] = []
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ready' }),
        getMachine: async () => makeMachine({ status: 'ready' }),
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
      })
    ).toBe('ready')
  })

  it('reports ready from a ready row when THIS process has no local endpoint (split api/worker)', async () => {
    // Tunnels are in-memory + owned by the process that ensured the box (the
    // worker). The api serving a status query has none, so probing is structurally
    // impossible there. A 'ready' row (past 'ensuring', machine ready) means the
    // box is up — trust it rather than reporting a perpetual false 'starting'.
    // Death is caught by the worker's health/lifecycle reconcile, not this poll.
    const events: string[] = []
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ready' }),
        getMachine: async () => makeMachine({ status: 'ready' }),
        tunnels: makeFakeTunnels(events, { endpoint: null }),
      })
    ).toBe('ready')
  })

  it('reports starting (transient) when the machine is ready but /healthz fails', async () => {
    // A ready machine with a probe miss is a transient box/server hiccup (mid-restart),
    // mirroring k8s treating a waiting container on a healthy node as starting.
    const events: string[] = []
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ready' }),
        getMachine: async () => makeMachine({ status: 'ready' }),
        tunnels: makeFakeTunnels(events),
        fetch: makeFakeFetch(events, [{ ok: false, status: 500 }]),
        healthRecheckGapMs: 0,
      })
    ).toBe('starting')
  })

  it('aborts a wedged /healthz probe (bounded) instead of hanging boxStatus forever', async () => {
    // probeHealthOnce must pass an AbortSignal.timeout so one black-holed
    // connection can't wedge boxStatus (nor the ensure fast-path). This fetch
    // settles ONLY on abort — with no signal (the bug) boxStatus never returns.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation timed out')))
      })) as unknown as typeof fetch
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ready' }),
        getMachine: async () => makeMachine({ status: 'ready' }),
        tunnels: makeFakeTunnels([]),
        fetch: hangingFetch,
        // One attempt: this test is about the per-probe abort, not the re-check.
        healthRecheckAttempts: 1,
      })
    ).toBe('starting')
  }, 10_000)

  it('reports failed when the box row is live but its machine is gone', async () => {
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ready' }),
        getMachine: async () => null,
      })
    ).toBe('failed')
  })

  it('reports failed when the box row is live but its machine is no longer ready', async () => {
    expect(
      await boxStatus('sb-1', {
        getMachineBox: async () => makeBox({ status: 'ready' }),
        getMachine: async () => makeMachine({ status: 'terminated' }),
      })
    ).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// boxChainHealth — presentation breakdown backing the VM chain-health status
// (machine reachable / box provisioned / box server up)
// ---------------------------------------------------------------------------

describe('boxChainHealth', () => {
  it('reports every link down when there is no box row', async () => {
    const result = await boxChainHealth('sb-1', { getMachineBox: async () => null })
    expect(result.status).toBe('absent')
    expect(result.chain).toEqual({ boxProvisioned: false, machine: 'unknown', boxServer: 'unknown' })
  })

  it('reports a parked box as provisioned with its server down (not probed)', async () => {
    const result = await boxChainHealth('sb-1', { getMachineBox: async () => makeBox({ status: 'stopped' }) })
    expect(result.status).toBe('stopped')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'unknown', boxServer: 'down' })
  })

  it.each([
    ['ready', 'reachable'],
    ['unreachable', 'unreachable'],
  ] as const)(
    'reports an unverified stop on a %s machine without claiming the server is down',
    async (status, expected) => {
      const result = await boxChainHealth('sb-1', {
        getMachineBox: async () => makeBox({ status: 'stop_unverified' }),
        getMachine: async () => makeMachine({ status }),
      })
      expect(result.status).toBe('stopped')
      expect(result.chain).toEqual({ boxProvisioned: true, machine: expected, boxServer: 'unknown' })
    }
  )

  it('reports a mid-provision box as provisioned with machine/server unknown', async () => {
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ensuring' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
    })
    expect(result.status).toBe('starting')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'unknown', boxServer: 'unknown' })
  })

  it('reports the machine as unreachable when it is gone', async () => {
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => null,
    })
    expect(result.status).toBe('failed')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' })
  })

  it('reports the machine as unreachable when it is no longer ready', async () => {
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'terminated' }),
    })
    expect(result.status).toBe('failed')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'unreachable', boxServer: 'unknown' })
  })

  it('reports the box server as up when the machine is ready and /healthz passes', async () => {
    const events: string[] = []
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
    })
    expect(result.status).toBe('ready')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'up' })
  })

  it('reports the box server as down (transiently) when the machine is ready but /healthz fails', async () => {
    const events: string[] = []
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [{ ok: false, status: 500 }]),
      healthRecheckGapMs: 0,
    })
    expect(result.status).toBe('starting')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'down' })
  })

  it('keeps a ready box ready when its server misses ONE probe then answers (busy, not dead)', async () => {
    // Under a CPU-heavy in-box build the sandbox-server can miss a single 2s
    // /healthz while very much alive. A status poll must re-check (like the
    // ensure fast-path does via recheckBoxHealth) rather than flip the pill to
    // "Starting…" on every poll for a box whose agent is running fine.
    const events: string[] = []
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [
        { ok: false, status: 503 },
        { ok: true, status: 200 },
      ]),
      healthRecheckGapMs: 0,
    })
    expect(result.status).toBe('ready')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'up' })
    expect(events.filter((e) => e === 'health')).toHaveLength(2)
  })

  it('still reports starting + server down when EVERY re-check attempt fails (genuinely dead server)', async () => {
    const events: string[] = []
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [{ ok: false, status: 503 }]),
      healthRecheckAttempts: 3,
      healthRecheckGapMs: 0,
    })
    expect(result.status).toBe('starting')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'down' })
    expect(events.filter((e) => e === 'health')).toHaveLength(3)
  })

  it('trusts the ready row (server unknown, no probe) when this process holds a DEAD tunnel master', async () => {
    // The api process does hold tunnels (it prewarms boxes). A stale forward
    // whose SSH master has died makes every probe fail → perpetual 'starting'
    // until restart. checkHealth() detects the dead master and purges its
    // forwards, so the status poll must fall through to the no-endpoint branch
    // (trust the row) instead of probing a dead local port.
    const events: string[] = []
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events, { masterAlive: false }),
      fetch: makeFakeFetch(events, [{ ok: false, status: 503 }]),
      healthRecheckGapMs: 0,
    })
    expect(result.status).toBe('ready')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'unknown' })
    expect(events).toContain('checkHealth')
    expect(events).not.toContain('health')
  })

  it('reports a freshly-listening box as ready + idle WITHOUT probing (a probe would wake it)', async () => {
    // The UI polls sandbox status every few seconds while a squad/agent page is
    // open. Under socket activation every probe wakes the box's server, so an
    // open browser tab alone would keep every box resident forever. A fresh
    // `last_listening_at` from the lifecycle sweep IS the health signal.
    const events: string[] = []
    const now = Date.now()
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready', lastListeningAt: new Date(now - 1_000) }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
      now: () => now,
    })
    expect(result.status).toBe('ready')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'idle' })
    expect(events).not.toContain('health')
  })

  it('short-circuits at the very edge of the freshness window', async () => {
    const events: string[] = []
    const now = Date.now()
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () =>
        makeBox({ status: 'ready', lastListeningAt: new Date(now - (LISTENING_FRESH_MS - 1)) }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
      now: () => now,
    })
    expect(result.chain.boxServer).toBe('idle')
    expect(events).not.toContain('health')
  })

  it('falls through to the probe path when the listening stamp is stale', async () => {
    const events: string[] = []
    const now = Date.now()
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready', lastListeningAt: new Date(now - LISTENING_FRESH_MS - 1) }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events),
      fetch: makeFakeFetch(events, [{ ok: true, status: 200 }]),
      now: () => now,
    })
    expect(result.status).toBe('ready')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'up' })
    expect(events).toContain('health')
  })

  it('never short-circuits a parked/mid-provision row or a box whose machine is gone', async () => {
    const fresh = new Date()
    const stopped = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'stopped', lastListeningAt: fresh }),
      getMachine: async () => makeMachine({ status: 'ready' }),
    })
    expect(stopped.status).toBe('stopped')
    const ensuring = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ensuring', lastListeningAt: fresh }),
      getMachine: async () => makeMachine({ status: 'ready' }),
    })
    expect(ensuring.status).toBe('starting')
    const failed = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready', lastListeningAt: fresh }),
      getMachine: async () => null,
    })
    expect(failed.status).toBe('failed')
  })

  it('reports the box server as unknown (trusts the row) when this process holds no tunnel endpoint', async () => {
    const events: string[] = []
    const result = await boxChainHealth('sb-1', {
      getMachineBox: async () => makeBox({ status: 'ready' }),
      getMachine: async () => makeMachine({ status: 'ready' }),
      tunnels: makeFakeTunnels(events, { endpoint: null }),
    })
    expect(result.status).toBe('ready')
    expect(result.chain).toEqual({ boxProvisioned: true, machine: 'reachable', boxServer: 'unknown' })
  })
})

// ---------------------------------------------------------------------------
// queryReadySharedMachines — real SQL (DB-backed)
// ---------------------------------------------------------------------------

describe('queryReadySharedMachines (DB)', () => {
  const prefix = `bmtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  function machineValues(name: string, overrides: Partial<typeof import('../../db').machines.$inferInsert> = {}) {
    return {
      name: `${prefix}-${name}`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      ...overrides,
    }
  }

  async function cleanup() {
    for (const m of await listMachines()) {
      if (m.name.startsWith(prefix)) await deleteMachine(m.id)
    }
  }
  beforeEach(cleanup)
  afterEach(cleanup)

  it('counts boxes per ready shared machine and excludes non-ready/non-shared', async () => {
    const ready = await insertMachine(machineValues('ready', { status: 'ready', scope: 'shared' }))
    const busy = await insertMachine(machineValues('busy', { status: 'ready', scope: 'shared' }))
    // Excluded: not ready.
    await insertMachine(machineValues('boot', { status: 'bootstrapping', scope: 'shared' }))
    // Excluded: dedicated scope.
    await insertMachine(machineValues('ded', { status: 'ready', scope: 'dedicated' }))

    await upsertMachineBox({ sandboxId: `${prefix}-b1`, machineId: busy.id, unixUser: 'box1', port: 50100 })
    await upsertMachineBox({ sandboxId: `${prefix}-b2`, machineId: busy.id, unixUser: 'box2', port: 50101 })

    const rows = (await queryReadySharedMachines()).filter((r) => r.machine.name.startsWith(prefix))
    const byId = new Map(rows.map((r) => [r.machine.id, r.boxCount]))
    expect(rows).toHaveLength(2)
    expect(byId.get(ready.id)).toBe(0)
    expect(byId.get(busy.id)).toBe(2)
  })

  it('excludes squad/commons-purpose machines (intra-tenant isolation — only general shared hosts)', async () => {
    // A ready, scope='shared' machine that belongs to a squad (purpose='squad')
    // must NEVER be handed out as a general least-loaded shared host, or a box
    // could land on another squad's VM.
    const general = await insertMachine(
      machineValues('general', { status: 'ready', scope: 'shared', purpose: 'shared' })
    )
    await insertMachine(machineValues('squad', { status: 'ready', scope: 'shared', purpose: 'squad', squadId: 'sq-1' }))
    await insertMachine(machineValues('commons', { status: 'ready', scope: 'shared', purpose: 'commons' }))

    const rows = (await queryReadySharedMachines()).filter((r) => r.machine.name.startsWith(prefix))
    expect(rows.map((r) => r.machine.id)).toEqual([general.id])
  })
})

// Silence unused import warnings for db/machineBoxes if the DB block is skipped.
void db
void machineBoxes

describe('archive codec probe privilege', () => {
  // The probe decides which codec BOTH hosts will write and read with, but the
  // transfer itself runs everything under sudo (`sudo tar -c` on the source,
  // `sudo bash box-provision.sh` on the destination). sudo resolves binaries
  // through its own `secure_path`, not the login user's PATH — so a host where
  // zstd exists only on the login user's PATH would be blessed for zstd and
  // then fail EVERY transfer. The probe must therefore ask the same question in
  // the same privilege context the transfer will use.
  it('runs under sudo, matching the sudo the real transfer uses on both ends', () => {
    expect(ARCHIVE_CODEC_PROBE_COMMAND).toContain('sudo')
    // Non-interactive: a host whose sudo wants a password must fail the probe
    // instantly (degrading to gzip, the safe direction) rather than hang on a
    // tty prompt inside a migration.
    expect(ARCHIVE_CODEC_PROBE_COMMAND).toContain('sudo -n')
    // The two ends the verdict is applied to.
    expect(buildArchiveStreamCommand('/home/box_x', ['.private'], 'zstd')).toContain('sudo tar')
    expect(buildStreamRestoreCommand('box_abc123abc123', ['.private'], 'zstd')).toContain('sudo bash')
  })

  it('still answers exactly one of zstd/gzip when sudo is unavailable (never an empty verdict)', async () => {
    // The `if/else` always exits 0 and always prints a verdict, so a sudo that
    // refuses (no NOPASSWD on this dev host) degrades to gzip rather than
    // producing an unparseable answer detectArchiveCodec would have to guess at.
    const proc = Bun.spawn(['bash', '-c', ARCHIVE_CODEC_PROBE_COMMAND], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exitCode).toBe(0)
    expect(['zstd', 'gzip']).toContain(out.trim())
  }, 20_000)
})

// ---------------------------------------------------------------------------
// Machine-side teardown budget.
//
// `box-provision.sh --remove` gzips the ENTIRE home before `userdel`, so for a
// stale multi-GB squad ~/workspace the removal runs for minutes. On the
// runner's 30s default that SSH times out, the teardown fails, the stale tree
// survives — and it is precisely that stale tree checkDestinationBaseline
// refuses to stream onto, so every later migration of the box to that machine
// fails at the baseline again. Permanently, not for one retry.
// ---------------------------------------------------------------------------
describe('removeBoxUserOnMachine (teardown budget)', () => {
  function makeTimeoutRunner(): { runner: SshRunner; calls: Array<{ command: string; timeoutMs?: number }> } {
    const calls: Array<{ command: string; timeoutMs?: number }> = []
    return {
      calls,
      runner: {
        async run(_machine, command, opts): Promise<SshResult> {
          calls.push({ command, timeoutMs: opts?.timeoutMs })
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    }
  }

  it('forwards an explicit timeoutMs to the runner (the whole-home gzip must outlive 30s)', async () => {
    const { runner, calls } = makeTimeoutRunner()

    await removeBoxUserOnMachine(makeMachine(), 'box_abc123abc123', { runner, timeoutMs: 30 * 60_000 })

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toContain('--remove')
    expect(calls[0].timeoutMs).toBe(30 * 60_000)
  })

  it('leaves the runner default in place when no budget is given (the remnant-sweep path)', async () => {
    const { runner, calls } = makeTimeoutRunner()

    await removeBoxUserOnMachine(makeMachine(), 'box_abc123abc123', { runner })

    expect(calls[0].timeoutMs).toBeUndefined()
  })

  it('teardownBoxOnMachine threads its caller’s budget down to the --remove', async () => {
    const { runner, calls } = makeTimeoutRunner()
    const events: string[] = []

    await teardownBoxOnMachine(
      makeMachine(),
      'squad_1',
      'box_abc123abc123',
      50100,
      { timeoutMs: 30 * 60_000 },
      { runner, tunnels: makeFakeTunnels(events) }
    )

    const remove = calls.find((c) => c.command.includes('--remove'))
    expect(remove?.timeoutMs).toBe(30 * 60_000)
  })
})

describe('provisioning marker decomposition', () => {
  // The marker is `<specHash>.<envHash>` (not an opaque digest) so a
  // fast-path miss can LOG which half drifted. A spurious full re-provision
  // restarts the box's systemd unit — killing shells and running agent
  // commands — so when it happens the log must say why, in one line.
  const env: Record<string, string> = { GITHUB_TOKEN: 'tok', FICUS_API_URL: 'http://127.0.0.1:1' }

  it('embeds the spec hash verbatim ahead of the env hash', () => {
    const marker = computeProvisioningMarker('spec-abc', env)
    expect(marker.startsWith('spec-abc.')).toBe(true)
    expect(marker.split('.')).toHaveLength(2)
  })

  it('an env-only change moves only the env half; a spec-only change only the spec half', () => {
    const base = computeProvisioningMarker('spec-abc', env)
    const envMoved = computeProvisioningMarker('spec-abc', { ...env, GITHUB_TOKEN: 'rotated' })
    const specMoved = computeProvisioningMarker('spec-def', env)
    expect(envMoved.split('.')[0]).toBe(base.split('.')[0])
    expect(envMoved.split('.')[1]).not.toBe(base.split('.')[1])
    expect(specMoved.split('.')[1]).toBe(base.split('.')[1])
    expect(specMoved.split('.')[0]).not.toBe(base.split('.')[0])
  })

  it('describeProvisioningMarkerDrift names the drifted half', () => {
    const base = computeProvisioningMarker('spec-abc', env)
    const envMoved = computeProvisioningMarker('spec-abc', { ...env, GITHUB_TOKEN: 'rotated' })
    const specMoved = computeProvisioningMarker('spec-def', env)
    const bothMoved = computeProvisioningMarker('spec-def', { ...env, GITHUB_TOKEN: 'rotated' })
    expect(describeProvisioningMarkerDrift(base, envMoved)).toContain('env')
    expect(describeProvisioningMarkerDrift(base, envMoved)).not.toContain('spec hash')
    expect(describeProvisioningMarkerDrift(base, specMoved)).toContain('spec hash')
    expect(describeProvisioningMarkerDrift(base, specMoved)).not.toContain('env')
    expect(describeProvisioningMarkerDrift(base, bothMoved)).toContain('spec hash')
    expect(describeProvisioningMarkerDrift(base, bothMoved)).toContain('env')
    // A pre-decomposition (opaque) stamp cannot be split — say so rather than guess.
    expect(describeProvisioningMarkerDrift('0123456789abcdef', envMoved)).toContain('legacy')
  })
})
