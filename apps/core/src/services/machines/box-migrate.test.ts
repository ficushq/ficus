import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agents, db, executions, forcedBoxMigrationAudits, squads, users } from '../../db'
import { Agent } from '../../entities/Agent'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../../entities/agent-runners/constants'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { BoxArchiveStreamError } from './box-manager'
import type { ArchiveCodec, StateDirFacts } from './box-manager'
import { boxUnixUser } from './box-paths'
import { migrateBox, sandboxHasActiveExecution } from './box-migrate'
import type { MigrateDeps } from './box-migrate'
import { createMigrationManifest } from './migration-manifest'
import type { MigrationManifestV1 } from './migration-manifest'
import { BoxBindConflictError } from './queries'
import type { Machine, MachineBox } from './queries'
import type { SshResult, SshRunner } from './ssh'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const OLD_MACHINE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TARGET_MACHINE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const FENCE_EXECUTOR = Object.create(db) as typeof db
const SANDBOX_ID = 'agent_11111111-1111-1111-1111-111111111111'

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: OLD_MACHINE_ID,
    name: 'migrate-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.5',
    sshPort: 22,
    sshUser: 'ficus',
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
    sandboxId: SANDBOX_ID,
    machineId: OLD_MACHINE_ID,
    unixUser: boxUnixUser(SANDBOX_ID),
    port: 50100,
    status: 'ready',
    authToken: 'tok-old',
    lastActivityAt: null,
    migrating: false,
    updatedAt: new Date(),
    ...overrides,
  } as MachineBox
}

/** The old box's server.env as pushed by a previous full ensure: one carried
 *  caller var plus the machine-derived vars a migrate must re-bake, not copy. */
const OLD_SERVER_ENV = [
  'FICUS_SANDBOX_ID=' + SANDBOX_ID,
  'GIT_USER_NAME=Ficus Test',
  'EXECUTOR_PORT=50100',
  'EXECUTOR_AUTH_TOKEN=tok-old',
  'EXECUTOR_BIND=127.0.0.1',
  'WORKSPACE_PATH=/home/box_x/.private',
  'FICUS_DEVBOX_DIR=/home/box_x/.tau/devbox',
  'FICUS_BOX_HOME=/home/box_x',
  'BUN_PTY_LIB=/opt/tau/server/bun-pty.so',
  'DOCKER_HOST=unix:///run/user/4321/docker.sock',
  'FICUS_API_URL=https://ficus.example.com',
].join('\n')

/** Facts a healthy SOURCE box reports for its state dirs (only the requested
 *  ones are returned — see the fake measure below). */
const SOURCE_FACTS: Record<string, StateDirFacts> = {
  workspace: { present: true, owner: 'box_source', mode: '755', entries: 6 },
  '.private': { present: true, owner: 'box_source', mode: '700', entries: 3 },
}

/** Facts a correctly-restored DESTINATION box reports: the source's contents,
 *  owned by the box user with the modes box-provision.sh's restore applies. */
function destFactsFor(sandboxId: string): Record<string, StateDirFacts> {
  const owner = boxUnixUser(sandboxId)
  return {
    workspace: { present: true, owner, mode: '755', entries: 6 },
    '.private': { present: true, owner, mode: '700', entries: 3 },
  }
}

/** Facts a FRESHLY PROVISIONED destination reports, BEFORE the stream:
 *  box-provision's ensure_dirs created every state dir and nothing on the
 *  provision path writes into them, so all are present and empty. */
function freshDestFactsFor(sandboxId: string): Record<string, StateDirFacts> {
  const owner = boxUnixUser(sandboxId)
  return {
    workspace: { present: true, owner, mode: '755', entries: 0 },
    '.private': { present: true, owner, mode: '700', entries: 0 },
  }
}

interface HarnessOpts {
  sandboxId?: string
  box?: MachineBox | null
  targetMachineId?: string
  oldMachine?: Machine | null
  target?: Machine | null
  hasActive?: boolean
  useProductionActivity?: boolean
  serverEnv?: string
  envReadExit?: number
  /** The SOURCE state-dir probe throws (an unreadable old box). */
  failMeasureSource?: boolean
  /** The post-restore DESTINATION probe throws. */
  failMeasureDest?: boolean
  /** The PRE-stream destination baseline probe throws (unmeasurable target). */
  failMeasureBaseline?: boolean
  failPeek?: boolean
  failInstall?: boolean
  /** The streamed transfer throws; `streamFailEnd` picks which end failed. */
  failStream?: boolean
  streamFailEnd?: 'source' | 'destination' | 'transport'
  /** BOTH ends exited non-zero, so `streamFailEnd` is the transport's GUESS. */
  streamAmbiguous?: boolean
  failStart?: boolean
  probeOk?: boolean
  failBind?: boolean
  failStopDeployments?: boolean
  failRestartDeployments?: boolean
  /** Override the SOURCE box's reported state-dir facts. */
  sourceFacts?: Record<string, StateDirFacts>
  /** Facts the SECOND (post-stream) source probe reports — the source as it
   *  actually is once the transfer is done, which is NOT necessarily what it
   *  was before provisioning. Defaults to `sourceFacts` (no drift). */
  sourceFactsAfter?: Record<string, StateDirFacts>
  /** Mutate the second source manifest to prove source-change detection. */
  sourceManifestChanged?: boolean
  /** Mutate the destination manifest while keeping top-level counts equal. */
  targetManifestChanged?: boolean
  /** The post-stream SOURCE re-probe throws. */
  failRemeasureSource?: boolean
  /** Override the DESTINATION box's post-restore facts (the outcome check). */
  destFacts?: Record<string, StateDirFacts>
  /** Override the DESTINATION box's PRE-stream facts (the baseline check) —
   *  e.g. a leftover tree from an earlier attempt whose teardown failed. */
  destBaselineFacts?: Record<string, StateDirFacts>
  /** Codec the fake detector agrees on for both hosts. */
  codec?: ArchiveCodec
  /** The conditional bind's CAS precondition failed (the row drifted in the
   *  provision window): the fake bind throws BoxBindConflictError, mirroring
   *  the real bind's in-transaction rollback — the row stays on the OLD
   *  machine, untouched. */
  bindConflict?: boolean
  failTeardown?: 'old' | 'new' | 'all'
  peekPort?: number
  /** Row returned by getMachineBox on the SECOND read (the post-fence re-read);
   *  `null` = the row vanished between the snapshot and the fence. Defaults to
   *  the first read's box (no drift). */
  reReadBox?: MachineBox | null
}

function makeHarness(opts: HarnessOpts = {}) {
  const sandboxId = opts.sandboxId ?? SANDBOX_ID
  const box = opts.box === undefined ? makeBox({ sandboxId, unixUser: boxUnixUser(sandboxId) }) : opts.box
  const oldMachine = opts.oldMachine === undefined ? makeMachine() : opts.oldMachine
  const target =
    opts.target === undefined ? makeMachine({ id: TARGET_MACHINE_ID, name: 'migrate-target' }) : opts.target

  const events: string[] = []
  const installs: Array<{ machineId: string; port: number; env: Record<string, string>; authToken: string }> = []
  /** Every streamed transfer: which machines, which dirs, which codec, budget. */
  const streams: Array<{
    sourceMachineId: string
    destMachineId: string
    destUnixUser: string
    stateDirs: string[]
    codec: ArchiveCodec
    timeoutMs?: number
  }> = []
  /** Every state-dir probe (source measurement AND destination verification). */
  const measures: Array<{ machineId: string; stateDirs: string[] }> = []
  /** Machines each codec detection was asked to agree across. */
  const codecProbes: string[][] = []
  const binds: Array<{
    sandboxId: string
    machineId: string
    unixUser: string
    port?: number
    authToken?: string
    expected?: { fromMachineId: string; port: number; authToken: string | null }
  }> = []
  const teardowns: Array<{
    machineId: string
    unixUser: string
    port: number
    opts: { archivePrivate?: boolean; timeoutMs?: number }
  }> = []
  const runnerCommands: string[] = []
  const fenceCalls: string[] = []
  const clearCalls: string[] = []

  const runner: SshRunner = {
    async run(_machine, command): Promise<SshResult> {
      runnerCommands.push(command)
      if (command.includes('server.env')) {
        return {
          exitCode: opts.envReadExit ?? 0,
          stdout: opts.serverEnv ?? OLD_SERVER_ENV,
          stderr: '',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }

  let boxReads = 0
  let destMeasures = 0
  let sourceMeasures = 0
  const deps: MigrateDeps = {
    isVmRuntime: () => true,
    runner,
    getMachineBox: async () => {
      boxReads++
      // First read = the pre-fence snapshot; later reads = the post-fence
      // re-read, which a test can drift (or delete) via opts.reReadBox.
      if (boxReads > 1 && opts.reReadBox !== undefined) return opts.reReadBox
      return box
    },
    getMachine: async (id: string) => {
      if (oldMachine && id === oldMachine.id) return oldMachine
      if (target && id === target.id) return target
      return null
    },
    fenceBoxForMigration: async (id, hasActiveExecution) => {
      fenceCalls.push(id)
      events.push('fence')
      // Mirror the real set-then-recheck: an active turn loses the fence.
      return !(await hasActiveExecution(id, FENCE_EXECUTOR as any))
    },
    clearBoxMigrating: async (id) => {
      clearCalls.push(id)
      events.push('unfence')
    },
    ...(opts.useProductionActivity ? {} : { hasActiveExecution: async () => opts.hasActive ?? false }),
    ensureMachineArtifacts: async () => {
      events.push('bundle')
    },
    peekNextBoxPort: async () => {
      if (opts.failPeek) throw new Error('peek failed')
      return opts.peekPort ?? 50123
    },
    detectArchiveCodec: async (_runner, machines) => {
      codecProbes.push(machines.map((m) => m.id))
      return opts.codec ?? 'zstd'
    },
    measureBoxStateDirs: async (_runner, machine, _sandboxId, _home, dirs) => {
      const onSource = machine.id === oldMachine?.id
      // BOTH ends are probed TWICE. The source: once before provisioning (the
      // comparison baseline) and once right after the stream, because minutes
      // of artifact delivery + install sit between the two and the source is
      // still live. The destination: once right after provisioning (the empty
      // baseline) and once after the stream (the outcome check).
      const phase = onSource
        ? sourceMeasures++ === 0
          ? 'measure-source'
          : 'remeasure-source'
        : destMeasures++ === 0
          ? 'baseline-dest'
          : 'verify-restore'
      events.push(phase)
      measures.push({ machineId: machine.id, stateDirs: dirs })
      if (phase === 'measure-source' && opts.failMeasureSource) throw new Error('state dir probe failed')
      if (phase === 'remeasure-source' && opts.failRemeasureSource) throw new Error('state dir probe failed')
      if (phase === 'baseline-dest' && opts.failMeasureBaseline) throw new Error('state dir probe failed')
      if (phase === 'verify-restore' && opts.failMeasureDest) throw new Error('state dir probe failed')
      const all =
        phase === 'measure-source'
          ? (opts.sourceFacts ?? SOURCE_FACTS)
          : phase === 'remeasure-source'
            ? (opts.sourceFactsAfter ?? opts.sourceFacts ?? SOURCE_FACTS)
            : phase === 'baseline-dest'
              ? (opts.destBaselineFacts ?? freshDestFactsFor(sandboxId))
              : (opts.destFacts ?? destFactsFor(sandboxId))
      return Object.fromEntries(
        dirs.map((dir) => [dir, all[dir] ?? { present: false, owner: '', mode: '', entries: 0 }])
      )
    },
    beginManualBoxEvacuation: async (input) => ({ ...input, id: input.operationId }) as never,
    recordEvacuationBoxProof: async (input) => input as never,
    verifyMachineEvacuation: async (operationId) => ({ operationId }) as never,
    scanMigrationManifest: async (_runner, machine, _home, _unixUser, identity) => {
      const scanIndex = measures.filter((measure) => measure.machineId === machine.id).length
      const changed =
        (machine.id === oldMachine?.id && opts.sourceManifestChanged && scanIndex > 1) ||
        (machine.id === target?.id && opts.targetManifestChanged)
      return createMigrationManifest(identity, [
        {
          name: 'workspace',
          presence: 'present',
          mode: '755',
          owner: 'box-user',
          entries: [
            {
              pathB64: Buffer.from('marker').toString('base64'),
              type: 'file',
              mode: '644',
              size: '1',
              contentSha256: (changed ? 'b' : 'a').repeat(64),
            },
          ],
        },
        { name: '.private', presence: 'present', mode: '700', owner: 'box-user', entries: [] },
      ]) as MigrationManifestV1
    },
    streamBoxStateArchive: async (streamOpts) => {
      events.push('stream')
      streams.push({
        sourceMachineId: streamOpts.source.machine.id,
        destMachineId: streamOpts.dest.machine.id,
        destUnixUser: streamOpts.dest.unixUser,
        stateDirs: streamOpts.stateDirs,
        codec: streamOpts.codec,
        timeoutMs: streamOpts.timeoutMs,
      })
      if (opts.failStream) {
        throw new BoxArchiveStreamError(
          'stream failed',
          opts.streamFailEnd ?? 'destination',
          undefined,
          opts.streamAmbiguous
        )
      }
      if (streamOpts.source.machine.id !== oldMachine?.id) throw new Error('streamed from the wrong machine')
      return { bytes: 4096 }
    },
    stopLocalDeploymentsForBox: async () => {
      events.push('stop-deployments')
      if (opts.failStopDeployments) throw new Error('deployment stop failed')
    },
    restartLocalDeploymentsForBox: async () => {
      events.push('restart-deployments')
      if (opts.failRestartDeployments) throw new Error('deployment restart failed')
    },
    installBoxOnMachine: async (installOpts) => {
      events.push('install')
      installs.push({
        machineId: installOpts.machine.id,
        port: installOpts.port,
        env: installOpts.env,
        authToken: installOpts.authToken,
      })
      if (opts.failInstall) throw new Error('box-provision failed')
    },
    startBoxAndAwaitHealth: async () => {
      events.push('start')
      if (opts.failStart) throw new Error('never became healthy')
      return 'http://127.0.0.1:59999'
    },
    fetch: async () => {
      events.push('probe')
      return { ok: opts.probeOk ?? true, status: opts.probeOk === false ? 401 : 200 }
    },
    bindMachineBox: async (values) => {
      events.push('repoint')
      binds.push(values)
      if (opts.failBind) throw new Error('bind rejected')
      // Mirror the real conditional bind: a CAS conflict throws INSIDE the
      // bind transaction, so nothing committed — the row stays on the old
      // machine exactly as the concurrent writer left it.
      if (opts.bindConflict) throw new BoxBindConflictError('row drifted from the expected pre-state')
      return { ...(box as MachineBox), ...values } as MachineBox
    },
    teardownBoxOnMachine: async (machine, _sandboxId, unixUser, port, teardownOpts) => {
      events.push(machine.id === oldMachine?.id ? 'teardown-old' : 'teardown-new')
      teardowns.push({ machineId: machine.id, unixUser, port, opts: teardownOpts ?? {} })
      if (opts.failTeardown === 'all') throw new Error('teardown failed')
      if (opts.failTeardown === 'old' && machine.id === oldMachine?.id) throw new Error('teardown failed')
      if (opts.failTeardown === 'new' && machine.id !== oldMachine?.id) throw new Error('teardown failed')
    },
    resolveBoxApiUrl: async () => 'http://127.0.0.1:40001',
  }

  return {
    sandboxId,
    targetMachineId: opts.targetMachineId ?? TARGET_MACHINE_ID,
    deps,
    events,
    installs,
    streams,
    measures,
    codecProbes,
    binds,
    teardowns,
    runnerCommands,
    fenceCalls,
    clearCalls,
    box,
    oldMachine,
    target,
  }
}

// ---------------------------------------------------------------------------
// migrateBox — ordering + failure containment (fake deps, no SSH/DB)
// ---------------------------------------------------------------------------

describe('migrateBox', () => {
  it('happy path: fence → measure → provision → stream → verify → start → probe → repoint → teardown old → unfence, {moved:true}', async () => {
    const h = makeHarness()

    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(result).toEqual({ moved: true })
    expect(h.events).toEqual([
      'fence',
      // The source's state is MEASURED (not pulled to core) before anything is
      // provisioned; the transfer itself streams source→destination later.
      'measure-source',
      'bundle',
      'install',
      // The just-provisioned destination is measured BEFORE the stream and must
      // be EMPTY. That baseline is what keeps the post-stream comparison's
      // upper bound meaningful — see the stale-superset test below.
      'baseline-dest',
      'stream',
      // The SOURCE is re-measured on THIS side of the transfer (it stayed live
      // through minutes of artifact delivery + install), then the destination's
      // actual post-restore state is verified BEFORE the old box can be torn
      // down — the replacement for inspecting a pulled archive.
      'remeasure-source',
      'verify-restore',
      'start',
      'probe',
      // Row repoint BEFORE the old teardown: the row (and its migrating fence)
      // must exist at every instant, and a repoint failure must leave the old
      // box authoritative. See box-migrate.ts for why this inverts the naive
      // removeBox-then-bind order.
      'repoint',
      'teardown-old',
      'unfence',
    ])
    // Provision + restore landed on the TARGET machine at the peeked port.
    expect(h.installs).toEqual([
      {
        machineId: TARGET_MACHINE_ID,
        port: 50123,
        env: expect.any(Object),
        authToken: 'tok-old',
      },
    ])
    // ONE transfer, source machine → target machine, with no core-side archive
    // path anywhere in it: the bytes never land on core's disk or in its memory.
    expect(h.streams).toEqual([
      {
        sourceMachineId: OLD_MACHINE_ID,
        destMachineId: TARGET_MACHINE_ID,
        destUnixUser: boxUnixUser(h.sandboxId),
        stateDirs: ['workspace', '.private'],
        codec: 'zstd',
        // Agent path: the minutes-scale agent budget, not the squad's half hour
        // (see the regression pin below and both timeout consts' docs).
        timeoutMs: 5 * 60_000,
      },
    ])
    // The codec is agreed across BOTH hosts before a single byte moves, so the
    // codec that WROTE is always the codec that READS.
    expect(h.codecProbes).toEqual([[OLD_MACHINE_ID, TARGET_MACHINE_ID]])
    // The repoint carries the provisioned port and the box's EXISTING token so
    // the row can never disagree with what the new unit serves — and the CAS
    // precondition (the fenced re-read's pre-state), so a row a concurrent
    // writer touched rolls the repoint back instead of committing over it.
    expect(h.binds).toEqual([
      {
        sandboxId: h.sandboxId,
        machineId: TARGET_MACHINE_ID,
        unixUser: boxUnixUser(h.sandboxId),
        port: 50123,
        authToken: 'tok-old',
        expected: { fromMachineId: OLD_MACHINE_ID, port: 50100, authToken: 'tok-old' },
      },
    ])
    // The OLD box is torn down on the OLD machine at its OLD port, with
    // archivePrivate deliberately OFF: ~/.private was already archived (step 5)
    // and restored onto the target — a second archive here would race/overwrite
    // the belt-and-braces machine-side whole-home archive for nothing. It
    // carries the move's size budget, because --remove gzips the whole home.
    expect(h.teardowns).toEqual([
      { machineId: OLD_MACHINE_ID, unixUser: boxUnixUser(h.sandboxId), port: 50100, opts: { timeoutMs: 5 * 60_000 } },
    ])
    expect(h.clearCalls).toEqual([h.sandboxId])
  })

  it('carries the old box caller env but strips machine-derived vars (re-baked by install)', async () => {
    const h = makeHarness()

    await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    const env = h.installs[0].env
    // Carried caller vars survive.
    expect(env.FICUS_SANDBOX_ID).toBe(h.sandboxId)
    expect(env.GIT_USER_NAME).toBe('Ficus Test')
    // FICUS_API_URL is ALWAYS re-resolved for the TARGET machine (the reverse
    // tunnel is the default box→core path, and a tunnel URL is machine-specific)
    // — even when the carried value looks like a public URL.
    expect(env.FICUS_API_URL).toBe('http://127.0.0.1:40001')
    // Machine-derived vars are stripped (installBoxOnMachine re-derives them
    // for the target port/uid); copying the old values would pin the old port.
    for (const key of [
      'EXECUTOR_PORT',
      'EXECUTOR_AUTH_TOKEN',
      'EXECUTOR_BIND',
      'WORKSPACE_PATH',
      'FICUS_DEVBOX_DIR',
      'FICUS_BOX_HOME',
      'BUN_PTY_LIB',
      'DOCKER_HOST',
    ]) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('re-resolves a reverse-tunnel FICUS_API_URL against the TARGET machine', async () => {
    // A reverse-tunnel FICUS_API_URL is an SSH forward ON THE OLD MACHINE —
    // carrying it verbatim would point the new box's callbacks at a port that
    // only exists on the machine it just left.
    const h = makeHarness({
      serverEnv: ['FICUS_SANDBOX_ID=' + SANDBOX_ID, 'FICUS_API_URL=http://127.0.0.1:39999'].join('\n'),
    })

    await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(h.installs[0].env.FICUS_API_URL).toBe('http://127.0.0.1:40001')
  })

  it('mints a token for a legacy token-less box and threads the SAME token to install and repoint', async () => {
    const h = makeHarness({ box: makeBox({ authToken: null }) })

    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(result).toEqual({ moved: true })
    const installed = h.installs[0].authToken
    expect(installed).toMatch(/^[0-9a-f]{64}$/)
    expect(h.binds[0].authToken).toBe(installed)
    // The CAS precondition reflects the row's true pre-state: token-LESS. The
    // minted token is only the bind's candidate, never the expectation.
    expect(h.binds[0].expected).toEqual({ fromMachineId: OLD_MACHINE_ID, port: 50100, authToken: null })
  })

  it('ensures the TARGET’s machine artifacts BEFORE the streamed restore (box-provision.sh rollout)', async () => {
    // box-provision.sh is a machine artifact, and `--restore-stream` is a mode
    // only a current copy understands. This ordering is what makes the rollout
    // automatic: a machine provisioned before the flag existed gets the new
    // script on the ensure that precedes the very transfer that needs it. If
    // these two ever swap, every migration onto a stale machine fails until the
    // whole fleet is re-bootstrapped by hand.
    const h = makeHarness()

    await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(h.events.indexOf('bundle')).toBeGreaterThanOrEqual(0)
    expect(h.events.indexOf('bundle')).toBeLessThan(h.events.indexOf('stream'))
  })

  it('no-ops when the box is already on the target machine (idempotent)', async () => {
    const h = makeHarness({ targetMachineId: OLD_MACHINE_ID })

    const result = await migrateBox(h.sandboxId, OLD_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'already-on-target' })
    expect(h.events).toEqual([])
  })

  it('refuses to migrate a squad box when allowSquad is explicitly false', async () => {
    const squadId = 'squad_22222222-2222-2222-2222-222222222222'
    const h = makeHarness({ sandboxId: squadId, box: makeBox({ sandboxId: squadId }) })

    const result = await migrateBox(squadId, TARGET_MACHINE_ID, h.deps, { allowSquad: false })

    expect(result).toEqual({ moved: false, reason: 'squad-box' })
    expect(h.events).toEqual([])
  })

  it('returns box-not-found for an absent box row', async () => {
    const h = makeHarness({ box: null })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'box-not-found' })
    expect(h.events).toEqual([])
  })

  it('returns machine-not-ready when the target machine is missing', async () => {
    const h = makeHarness({ target: null })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'machine-not-ready' })
    expect(h.events).toEqual([])
  })

  it('returns machine-not-ready when the target machine is not ready', async () => {
    const h = makeHarness({ target: makeMachine({ id: TARGET_MACHINE_ID, status: 'registered' }) })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'machine-not-ready' })
    expect(h.events).toEqual([])
  })

  it('returns machine-not-ready when the OLD machine is gone (nothing to pull files from)', async () => {
    const h = makeHarness({ oldMachine: null })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'machine-not-ready' })
    expect(h.events).toEqual([])
  })

  it('returns count-only context when the production activity probe refuses migration', async () => {
    const agentId = SANDBOX_ID.slice('agent_'.length)
    await db.insert(agents).values({ id: agentId, agentTypeId: 'developer' })
    await db.insert(executions).values([
      { agentId, status: 'queued' },
      { agentId, status: 'running' },
    ])
    try {
      const h = makeHarness({ useProductionActivity: true })
      expect(await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)).toEqual({
        moved: false,
        reason: 'active-turn',
        activeExecutionCount: 2,
      })
      expect(h.events).toEqual(['fence'])
    } finally {
      // Executions do NOT go with the agent row here, and this file's
      // migrateBox describe has no per-test DB cleanup — leaving them behind
      // inflates the activity count of every later test on this sandbox id.
      await db.delete(executions).where(eq(executions.agentId, agentId))
      await db.delete(agents).where(eq(agents.id, agentId))
    }
  })

  it('active turn: fence lost → active-turn; NO archive/provision, and migrate does NOT clear the fence it never won', async () => {
    const h = makeHarness({ hasActive: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'active-turn' })
    expect(h.events).toEqual(['fence'])
    // fenceBoxForMigration cleared its own provisional flip inside the txn; a
    // lost claim must NOT call clearBoxMigrating (that could lift a fence a
    // CONCURRENT migration legitimately holds).
    expect(h.clearCalls).toEqual([])
  })

  describe('structured forced migration audit', () => {
    const force = {
      actor: { type: 'user' as const, id: '11111111-1111-1111-1111-111111111111' },
      reason: 'Evacuate failing source host',
      requestId: '22222222-2222-4222-8222-222222222222',
    }

    it('persists the locked activity decision before destructive work and settles success', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const [squad] = await db.insert(squads).values({ id: squadId, name: 'force-audit', purpose: 'test' }).returning()
      const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
      await db.insert(executions).values({ agentId: agent.id, status: 'running' })
      const h = makeHarness({ sandboxId, useProductionActivity: true })
      const starts: any[] = []
      const startExecutors: unknown[] = []
      const finishes: any[] = []
      try {
        const result = await migrateBox(
          sandboxId,
          TARGET_MACHINE_ID,
          {
            ...h.deps,
            findForceMigrationAudit: async () => null,
            startForceMigrationAudit: async (input, executor) => {
              starts.push(input)
              startExecutors.push(executor)
              return { id: 'audit-1', outcome: 'started' } as any
            },
            finishForceMigrationAudit: async (...args) => {
              finishes.push(args)
              return { kind: 'settled', audit: {} } as any
            },
          },
          { force, allowSquad: true }
        )
        expect(result).toEqual({ moved: true })
        expect(starts[0]).toMatchObject({ actor: force.actor, reason: force.reason, activeExecutionCount: 1, squadId })
        expect(startExecutors).toEqual([FENCE_EXECUTOR])
        expect(finishes[0].slice(1, 3)).toEqual(['succeeded', { moved: true }])
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    // The success settlement is deliberately NOT a post-hoc write: it rides the
    // repoint transaction (`bindMachineBox`'s `onBound`), so there is no window
    // in which the box has moved but the audit still says 'started'. The test
    // above cannot see that — its fake bind ignores `onBound`, so the fallback
    // settler produces the same observable. This one runs a REAL committing
    // transaction against the REAL audit repository, so removing `onBound`
    // from either migrateBox or bindMachineBox turns it red.
    it('settles a successful forced migration inside the repoint transaction, not afterwards', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const requestId = crypto.randomUUID()
      const [squad] = await db.insert(squads).values({ id: squadId, name: 'force-atomic', purpose: 'test' }).returning()
      const h = makeHarness({ sandboxId, useProductionActivity: true })
      const finishes: any[] = []
      let settledInsideBindTx = false
      try {
        const result = await migrateBox(
          sandboxId,
          TARGET_MACHINE_ID,
          {
            ...h.deps,
            bindMachineBox: async (values: any) => {
              const box = makeBox({ sandboxId, machineId: TARGET_MACHINE_ID })
              await db.transaction(async (tx) => {
                await values.onBound?.(tx, box)
                // Read through the SAME transaction: a post-commit hook could
                // not observe 'succeeded' here.
                const [row] = await tx
                  .select()
                  .from(forcedBoxMigrationAudits)
                  .where(eq(forcedBoxMigrationAudits.requestId, requestId))
                settledInsideBindTx = row?.outcome === 'succeeded'
              })
              return box
            },
            finishForceMigrationAudit: async (...args: any[]) => {
              finishes.push(args)
              return { kind: 'settled', audit: {} } as any
            },
          },
          { force: { ...force, requestId }, allowSquad: true }
        )
        expect(result).toEqual({ moved: true })
        expect(settledInsideBindTx).toBe(true)
        // Settled transactionally, so the post-hoc settler must never run.
        expect(finishes).toEqual([])
        const [stored] = await db
          .select()
          .from(forcedBoxMigrationAudits)
          .where(eq(forcedBoxMigrationAudits.requestId, requestId))
        expect(stored).toMatchObject({ outcome: 'succeeded', result: { moved: true }, activeExecutionCount: 0 })
      } finally {
        await db.delete(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, requestId))
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('audits a legitimate zero-activity force request with the exact count', async () => {
      const squadId = crypto.randomUUID()
      const [squad] = await db.insert(squads).values({ id: squadId, name: 'force-zero', purpose: 'test' }).returning()
      const h = makeHarness({ sandboxId: `squad_${squadId}`, useProductionActivity: true })
      const starts: any[] = []
      try {
        expect(
          await migrateBox(
            `squad_${squadId}`,
            TARGET_MACHINE_ID,
            {
              ...h.deps,
              findForceMigrationAudit: async () => null,
              startForceMigrationAudit: async (input) => {
                starts.push(input)
                return { id: 'audit-zero', outcome: 'started' } as any
              },
              finishForceMigrationAudit: async () => ({ kind: 'settled', audit: {} }) as any,
            },
            { force, allowSquad: true }
          )
        ).toEqual({ moved: true })
        expect(starts[0].activeExecutionCount).toBe(0)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('persists the actual structured failure and cancellation outcomes', async () => {
      const squadId = crypto.randomUUID()
      const [squad] = await db
        .insert(squads)
        .values({ id: squadId, name: 'force-outcomes', purpose: 'test' })
        .returning()
      const finishes: any[] = []
      const audit = {
        findForceMigrationAudit: async () => null,
        startForceMigrationAudit: async () => ({ id: `audit-${finishes.length}`, outcome: 'started' }) as any,
        finishForceMigrationAudit: async (...args: any[]) => {
          finishes.push(args)
          return { kind: 'settled', audit: {} } as any
        },
      }
      try {
        const failed = makeHarness({
          sandboxId: `squad_${squadId}`,
          useProductionActivity: true,
          failMeasureSource: true,
        })
        expect(
          await migrateBox(
            `squad_${squadId}`,
            TARGET_MACHINE_ID,
            { ...failed.deps, ...audit },
            { force, allowSquad: true }
          )
        ).toEqual({ moved: false, reason: 'archive-failed' })
        expect(finishes[0].slice(1, 4)).toEqual([
          'failed',
          { moved: false, reason: 'archive-failed' },
          'archive-failed',
        ])

        const canceled = makeHarness({ sandboxId: `squad_${squadId}`, useProductionActivity: true })
        await expect(
          migrateBox(
            `squad_${squadId}`,
            TARGET_MACHINE_ID,
            { ...canceled.deps, ...audit },
            {
              force: { ...force, requestId: '88888888-8888-4888-8888-888888888888' },
              allowSquad: true,
              onProgress: ({ phase }) => {
                if (phase === 'archive') {
                  const error = new Error('canceled')
                  error.name = 'AbortError'
                  throw error
                }
              },
            }
          )
        ).rejects.toThrow('canceled')
        expect(finishes[1][1]).toBe('canceled')
        expect(finishes[1][3]).toBe('canceled')
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('never accepts an absent injected settlement result', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const [squad] = await db
        .insert(squads)
        .values({ id: squadId, name: 'force-invalid-settlement', purpose: 'test' })
        .returning()
      const h = makeHarness({ sandboxId, useProductionActivity: true, failMeasureSource: true })
      try {
        await expect(
          migrateBox(
            sandboxId,
            TARGET_MACHINE_ID,
            {
              ...h.deps,
              findForceMigrationAudit: async () => null,
              startForceMigrationAudit: async () => ({ id: crypto.randomUUID(), outcome: 'started' }) as any,
              finishForceMigrationAudit: (async () => undefined) as any,
            },
            { force, allowSquad: true }
          )
        ).rejects.toThrow()
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('settles after an onBound callback when bind commit fails, and still settles if unfence fails', async () => {
      const squadId = crypto.randomUUID()
      const [squad] = await db
        .insert(squads)
        .values({ id: squadId, name: 'force-commit-fail', purpose: 'test' })
        .returning()
      const finishes: any[] = []
      const h = makeHarness({ sandboxId: `squad_${squadId}`, useProductionActivity: true })
      try {
        const deps = {
          ...h.deps,
          findForceMigrationAudit: async () => null,
          startForceMigrationAudit: async () =>
            ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outcome: 'started' }) as any,
          finishForceMigrationAudit: async (...args: any[]) => {
            finishes.push(args)
            return { kind: 'settled', audit: {} } as any
          },
          bindMachineBox: async (values: any) => {
            await db.transaction(async (tx) => {
              await values.onBound?.(tx, makeBox())
              throw new Error('commit failed')
            })
            return makeBox()
          },
          clearBoxMigrating: async () => {
            throw new Error('unfence failed')
          },
        }
        await expect(
          migrateBox(`squad_${squadId}`, TARGET_MACHINE_ID, deps, { force, allowSquad: true })
        ).rejects.toThrow(/unfence failed|cleanup/)
        expect(finishes).toHaveLength(1)
        expect(finishes[0][1]).toBe('failed')
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('settles an injected audit when the fence fails and replays the failure', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const h = makeHarness({ sandboxId, useProductionActivity: true })
      const finishes: any[] = []
      const started = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd', outcome: 'started' } as any
      await expect(
        migrateBox(
          sandboxId,
          TARGET_MACHINE_ID,
          {
            ...h.deps,
            findForceMigrationAudit: async () => null,
            startForceMigrationAudit: async () => started,
            finishForceMigrationAudit: async (...args: any[]) => {
              finishes.push(args)
              return { kind: 'settled', audit: {} } as any
            },
            fenceBoxForMigration: async (id, probe) => {
              await probe(id)
              throw new Error('fence commit failed')
            },
          },
          { force, allowSquad: true }
        )
      ).rejects.toThrow('fence commit failed')
      expect(finishes[0].slice(1, 4)).toEqual(['failed', { moved: false, reason: 'failed' }, 'fence-failed'])

      const existing = {
        ...started,
        sandboxId,
        squadId,
        sourceMachineId: OLD_MACHINE_ID,
        targetMachineId: TARGET_MACHINE_ID,
        actorType: 'user',
        actorId: force.actor.id,
        reason: force.reason,
        outcome: 'failed',
        result: { moved: false, reason: 'failed' },
      } as any
      let fenced = false
      expect(
        await migrateBox(
          sandboxId,
          TARGET_MACHINE_ID,
          {
            ...h.deps,
            findForceMigrationAudit: async () => existing,
            fenceBoxForMigration: async () => {
              fenced = true
              return true
            },
          },
          { force, allowSquad: true }
        )
      ).toEqual({ moved: false, reason: 'failed' })
      expect(fenced).toBe(false)
    })

    it('rethrows the fence failure alone when the started audit rolled back with it', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const requestId = crypto.randomUUID()
      const [squad] = await db
        .insert(squads)
        .values({ id: squadId, name: 'force-fence-rollback', purpose: 'test' })
        .returning()
      const h = makeHarness({ sandboxId, useProductionActivity: true })
      const boom = new Error('fence commit failed')
      try {
        await expect(
          migrateBox(
            sandboxId,
            TARGET_MACHINE_ID,
            {
              ...h.deps,
              // Real fence semantics with the REAL audit repository: the probe
              // (and so the started audit) runs on this transaction, which then
              // fails. Nothing destructive ran and the audit row went with it.
              fenceBoxForMigration: async (id, probe) => {
                await db.transaction(async (tx) => {
                  await probe(id, tx as any)
                  throw boom
                })
                return true
              },
            },
            { force: { ...force, requestId }, allowSquad: true }
          )
        ).rejects.toBe(boom)
        expect(
          await db.select().from(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, requestId))
        ).toEqual([])
      } finally {
        await db.delete(forcedBoxMigrationAudits).where(eq(forcedBoxMigrationAudits.requestId, requestId))
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('fails closed when a fence failure meets a conflicting audit settlement', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const [squad] = await db
        .insert(squads)
        .values({ id: squadId, name: 'force-fence-conflict', purpose: 'test' })
        .returning()
      const h = makeHarness({ sandboxId, useProductionActivity: true })
      const boom = new Error('fence failed')
      try {
        // `missing` is tolerated above only because the audit rolls back WITH
        // the fence; a conflicting terminal state is a real disagreement and
        // must still surface alongside the fence error.
        const error = await migrateBox(
          sandboxId,
          TARGET_MACHINE_ID,
          {
            ...h.deps,
            findForceMigrationAudit: async () => null,
            startForceMigrationAudit: async () => ({ id: crypto.randomUUID(), outcome: 'started' }) as any,
            finishForceMigrationAudit: async () =>
              ({ kind: 'conflict', audit: { outcome: 'canceled' }, requested: {} }) as any,
            fenceBoxForMigration: async (id, probe) => {
              await probe(id)
              throw boom
            },
          },
          { force: { ...force, requestId: crypto.randomUUID() }, allowSquad: true }
        ).then(
          () => null,
          (thrown) => thrown
        )
        expect(error).toBeInstanceOf(AggregateError)
        expect((error as AggregateError).errors[0]).toBe(boom)
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('rejects every preflight-verifiable request identity mismatch independently', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const h = makeHarness({ sandboxId })
      const existing = {
        id: crypto.randomUUID(),
        requestId: force.requestId,
        sandboxId,
        squadId,
        sourceMachineId: OLD_MACHINE_ID,
        targetMachineId: TARGET_MACHINE_ID,
        actorType: force.actor.type,
        actorId: force.actor.id,
        reason: force.reason,
        outcome: 'failed',
        result: { moved: false, reason: 'failed' },
      } as any
      const mismatches = [
        { ...existing, sandboxId: `squad_${crypto.randomUUID()}` },
        { ...existing, squadId: crypto.randomUUID() },
        { ...existing, sourceMachineId: crypto.randomUUID() },
        { ...existing, targetMachineId: crypto.randomUUID() },
        { ...existing, actorType: 'agent' },
        { ...existing, actorId: crypto.randomUUID() },
        { ...existing, reason: 'different reason' },
      ]
      for (const mismatch of mismatches)
        await expect(
          migrateBox(
            sandboxId,
            TARGET_MACHINE_ID,
            { ...h.deps, findForceMigrationAudit: async () => mismatch },
            { force, allowSquad: true }
          )
        ).rejects.toThrow('request ID conflict')
      expect(h.events).toEqual([])
    })

    it('fails closed when durable audit persistence fails', async () => {
      const squadId = crypto.randomUUID()
      const sandboxId = `squad_${squadId}`
      const [squad] = await db
        .insert(squads)
        .values({ id: squadId, name: 'force-audit-fail', purpose: 'test' })
        .returning()
      const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
      await db.insert(executions).values({ agentId: agent.id, status: 'running' })
      const h = makeHarness({ sandboxId, useProductionActivity: true })
      try {
        await expect(
          migrateBox(
            sandboxId,
            TARGET_MACHINE_ID,
            {
              ...h.deps,
              findForceMigrationAudit: async () => null,
              startForceMigrationAudit: async () => {
                throw new Error('audit unavailable')
              },
            },
            { force, allowSquad: true }
          )
        ).rejects.toThrow('audit unavailable')
        expect(h.events).toEqual(['fence'])
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })
  })

  it('source state-dir probe failure: archive-failed, old box intact, nothing provisioned, fence cleared', async () => {
    const h = makeHarness({ failMeasureSource: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    // An unmeasurable source box is never assumed intact: the migration stops
    // before anything is provisioned, with the old box fully authoritative.
    expect(result).toEqual({ moved: false, reason: 'archive-failed' })
    expect(h.events).toEqual(['fence', 'measure-source', 'unfence'])
    expect(h.streams).toEqual([])
    expect(h.teardowns).toEqual([])
    expect(h.binds).toEqual([])
  })

  it('an AMBIGUOUS source attribution does NOT accuse the old machine (both ends died; the guess is not a verdict)', async () => {
    // The motivating shape: the destination fails (a stale script, ENOSPC
    // mid-extract), core's pump cancels the source's stdout, the source ssh
    // dies of EPIPE, and BOTH ends exit non-zero. The transport's attribution
    // stays source-first, but it FLAGS the guess — and 'archive-failed' renders
    // to an operator as "old machine unreadable", naming the wrong machine.
    // Both branches already behave identically, so the ambiguous case takes the
    // destination-side reason rather than a confident lie about the source.
    const h = makeHarness({ failStream: true, streamFailEnd: 'source', streamAmbiguous: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).toContain('teardown-new')
    expect(h.binds).toEqual([])
  })

  it('a SOURCE-end stream failure is reported as archive-failed (old machine unreadable), new box torn down', async () => {
    // The source/destination distinction the migrate reasons draw survives the
    // move to a single streamed transfer: the transport reports which end died —
    // UNAMBIGUOUSLY here (only the source exited non-zero), which is what makes
    // "old machine unreadable" a fact rather than a guess.
    const h = makeHarness({ failStream: true, streamFailEnd: 'source' })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'archive-failed' })
    expect(h.events).toEqual([
      'fence',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'teardown-new',
      'unfence',
    ])
    expect(h.binds).toEqual([])
  })

  it('a TRANSPORT stream failure (timeout / connection death) is a restore failure, never a silent success', async () => {
    const h = makeHarness({ failStream: true, streamFailEnd: 'transport' })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    // Verification never even runs, and the old box is untouched.
    expect(h.events).not.toContain('verify-restore')
    expect(h.events).not.toContain('teardown-old')
    expect(h.binds).toEqual([])
  })

  it('old server.env read failure: provision-failed, nothing provisioned, NO teardown (no port was ever peeked), fence cleared', async () => {
    const h = makeHarness({ envReadExit: 1 })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'provision-failed' })
    expect(h.installs).toEqual([])
    expect(h.binds).toEqual([])
    expect(h.teardowns).toEqual([])
    expect(h.clearCalls).toEqual([SANDBOX_ID])
  })

  it('provisions the target via ensureMachineArtifacts (box-provision + server + cli) BEFORE install', async () => {
    const h = makeHarness()

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, {
      ...h.deps,
      ensureMachineArtifacts: async () => {
        h.events.push('artifacts')
      },
    })

    expect(result.moved).toBe(true)
    expect(h.events.indexOf('artifacts')).toBeGreaterThanOrEqual(0)
    expect(h.events.indexOf('artifacts')).toBeLessThan(h.events.indexOf('install'))
  })

  it('artifact ensure failure (e.g. cli push) on the target: provision-failed, nothing installed, old box intact, fence cleared', async () => {
    const h = makeHarness()

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, {
      ...h.deps,
      ensureMachineArtifacts: async () => {
        throw new Error('ficus cli push failed')
      },
    })

    expect(result).toEqual({ moved: false, reason: 'provision-failed' })
    expect(h.installs).toEqual([])
    expect(h.binds).toEqual([])
    expect(h.teardowns).toEqual([])
    expect(h.clearCalls).toEqual([SANDBOX_ID])
  })

  it('port-peek failure: provision-failed, nothing provisioned, NO teardown, fence cleared', async () => {
    const h = makeHarness({ failPeek: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'provision-failed' })
    expect(h.events).toEqual(['fence', 'measure-source', 'bundle', 'unfence'])
    expect(h.installs).toEqual([])
    expect(h.teardowns).toEqual([])
    expect(h.binds).toEqual([])
  })

  it('provision failure: old box NOT removed, row NOT repointed, the half-provisioned NEW box torn down, fence cleared', async () => {
    // Symmetry with the restore/health/bind failure paths: install can die
    // halfway (user created, unit half-written) and leaving that partial unix
    // user stranded on the target means every failed migrate leaks a box-shaped
    // remnant. teardownBoxOnMachine is safe on a box that never fully appeared
    // (box-provision.sh --remove no-ops on an absent user).
    const h = makeHarness({ failInstall: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'provision-failed' })
    expect(h.events).toEqual(['fence', 'measure-source', 'bundle', 'install', 'teardown-new', 'unfence'])
    expect(h.teardowns).toEqual([
      { machineId: TARGET_MACHINE_ID, unixUser: boxUnixUser(SANDBOX_ID), port: 50123, opts: { timeoutMs: 5 * 60_000 } },
    ])
    expect(h.binds).toEqual([])
  })

  it('restore failure: the just-provisioned NEW box is torn down, old box intact, fence cleared', async () => {
    const h = makeHarness({ failStream: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).toEqual([
      'fence',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'teardown-new',
      'unfence',
    ])
    // NEW-box teardown never archives: its ~/.private is a partial restore of
    // an archive core already holds — archiving it would clobber nothing useful
    // and waste a machine round-trip.
    expect(h.teardowns).toEqual([
      { machineId: TARGET_MACHINE_ID, unixUser: boxUnixUser(SANDBOX_ID), port: 50123, opts: { timeoutMs: 5 * 60_000 } },
    ])
    expect(h.binds).toEqual([])
  })

  it('unhealthy (start/poll failure): new box torn down, old intact, fence cleared', async () => {
    const h = makeHarness({ failStart: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'unhealthy' })
    expect(h.events).toEqual([
      'fence',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'remeasure-source',
      'verify-restore',
      'start',
      'teardown-new',
      'unfence',
    ])
    expect(h.teardowns).toEqual([
      { machineId: TARGET_MACHINE_ID, unixUser: boxUnixUser(SANDBOX_ID), port: 50123, opts: { timeoutMs: 5 * 60_000 } },
    ])
    expect(h.binds).toEqual([])
  })

  it('unhealthy (token-auth probe rejected): new box torn down, old intact, fence cleared', async () => {
    const h = makeHarness({ probeOk: false })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'unhealthy' })
    expect(h.events).toEqual([
      'fence',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'remeasure-source',
      'verify-restore',
      'start',
      'probe',
      'teardown-new',
      'unfence',
    ])
    expect(h.binds).toEqual([])
  })

  it('repoint failure: new box torn down, old box + row untouched, fence cleared', async () => {
    const h = makeHarness({ failBind: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'repoint-conflict' })
    expect(h.events).toEqual([
      'fence',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'remeasure-source',
      'verify-restore',
      'start',
      'probe',
      'repoint',
      'teardown-new',
      'unfence',
    ])
    // Only the NEW box was torn down (never archiving); the old box was never touched.
    expect(h.teardowns).toEqual([
      { machineId: TARGET_MACHINE_ID, unixUser: boxUnixUser(SANDBOX_ID), port: 50123, opts: { timeoutMs: 5 * 60_000 } },
    ])
  })

  // -------------------------------------------------------------------------
  // Post-fence staleness: the load-bearing row values (machineId, port,
  // authToken) are snapshotted BEFORE the fence is won, and ensureBox's full
  // path is NOT fence-gated — a concurrent ensure can repoint the row or mint
  // a token in the getBox→fence window. Migrating on the stale snapshot would
  // wedge the box (row token ≠ unit token → permanent 401) or operate against
  // the wrong machine, so the migrate re-reads the row right after winning the
  // fence and aborts on ANY drift (nothing provisioned yet — old box intact).
  // -------------------------------------------------------------------------

  const DRIFTS: Array<[string, Partial<MachineBox>]> = [
    ['machineId', { machineId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }],
    ['port', { port: 50777 }],
    ['authToken', { authToken: 'tok-minted-by-concurrent-ensure' }],
  ]
  for (const [field, drift] of DRIFTS) {
    it(`post-fence re-read: ${field} drift → provision-failed with NO side effects, fence cleared`, async () => {
      const h = makeHarness({ reReadBox: makeBox(drift) })

      const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

      expect(result).toEqual({ moved: false, reason: 'provision-failed' })
      // Nothing archived, provisioned, bound, or torn down — only the fence
      // was claimed and lifted; the old box and its row are untouched.
      expect(h.events).toEqual(['fence', 'unfence'])
      expect(h.installs).toEqual([])
      expect(h.binds).toEqual([])
      expect(h.teardowns).toEqual([])
      expect(h.clearCalls).toEqual([SANDBOX_ID])
    })
  }

  it('post-fence re-read: row vanished (concurrent removeBox) → box-not-found, no side effects, fence cleared', async () => {
    const h = makeHarness({ reReadBox: null })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'box-not-found' })
    expect(h.events).toEqual(['fence', 'unfence'])
    expect(h.installs).toEqual([])
    expect(h.binds).toEqual([])
    expect(h.teardowns).toEqual([])
    // clearBoxMigrating no-ops on an absent row, so calling it stays harmless.
    expect(h.clearCalls).toEqual([SANDBOX_ID])
  })

  it('repoint CAS conflict (row drifted in the provision window): bind ROLLED BACK, row stays on the old machine, new box torn down, old box intact, fence cleared', async () => {
    // The conditional bind throws INSIDE its transaction, so — unlike the old
    // post-commit verify, which tore down a box the COMMITTED row now pointed
    // at (the next ensure would then provision an EMPTY ~/.private = file
    // loss) — nothing committed: the old box is genuinely authoritative and
    // tearing down the NEW box is safe.
    const h = makeHarness({ bindConflict: true })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'repoint-conflict' })
    expect(h.events).toEqual([
      'fence',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'remeasure-source',
      'verify-restore',
      'start',
      'probe',
      'repoint',
      'teardown-new',
      'unfence',
    ])
    // The repoint carried the CAS precondition (the fenced re-read pre-state)…
    expect(h.binds).toEqual([
      {
        sandboxId: SANDBOX_ID,
        machineId: TARGET_MACHINE_ID,
        unixUser: boxUnixUser(SANDBOX_ID),
        port: 50123,
        authToken: 'tok-old',
        expected: { fromMachineId: OLD_MACHINE_ID, port: 50100, authToken: 'tok-old' },
      },
    ])
    // …and ONLY the NEW box was torn down: the old box (which the rolled-back
    // row still points at) was never touched.
    expect(h.teardowns).toEqual([
      { machineId: TARGET_MACHINE_ID, unixUser: boxUnixUser(SANDBOX_ID), port: 50123, opts: { timeoutMs: 5 * 60_000 } },
    ])
    expect(h.clearCalls).toEqual([SANDBOX_ID])
  })

  it('a successful move emits box.status "gone" for the OLD box (old machine, old port) so the OTHER process drops its stale client/forward too', async () => {
    // The migrate runs in the API process; only teardownBoxOnMachine's local
    // removeForward runs here. The WORKER's cached SandboxClient + tunnel
    // forward for the old (machine, port) would otherwise linger until its
    // next ensure — first use fails once. The distributed box.status event is
    // what VmSandboxManager.onBoxStatus subscribes to for exactly this.
    const h = makeHarness()
    const emitted: Array<{ sandboxId: string; machineId: string; status: string; port: number }> = []
    const unsubscribe = eventEmitter.on('box.status', (data) => emitted.push(data))
    try {
      const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)
      expect(result).toEqual({ moved: true })
      expect(emitted).toEqual([{ sandboxId: h.sandboxId, machineId: OLD_MACHINE_ID, status: 'gone', port: 50100 }])

      // A FAILED move must not announce anything: the old box is still live.
      const failed = makeHarness({ failStream: true })
      await migrateBox(failed.sandboxId, failed.targetMachineId, failed.deps)
      expect(emitted).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  it('teardown-OLD failure after the new box is healthy + repointed still returns {moved:true}', async () => {
    const h = makeHarness({ failTeardown: 'old' })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: true })
    expect(h.events[h.events.length - 1]).toBe('unfence')
  })

  it('a failing best-effort NEW-box teardown does not mask the structured failure reason', async () => {
    const h = makeHarness({ failStream: true, failTeardown: 'all' })

    const result = await migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.clearCalls).toEqual([SANDBOX_ID])
  })

  it('a never-run agent workspace reaches production archive orchestration', async () => {
    const h = makeHarness()

    await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    // These live-incident markers existed only in idle agent workspaces:
    // 400667b5005624fc6c862b017e596cf2f8bd9e121ccd1d88532535d995051f5c
    // 789f7672afe55eb8d01a94951deddf3c409aac3a23d50d8191e0a1521d02c74b
    expect(h.streams[0].stateDirs).toEqual(['workspace', '.private'])
    expect(h.measures).toEqual([
      { machineId: OLD_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: TARGET_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: OLD_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: TARGET_MACHINE_ID, stateDirs: ['workspace', '.private'] },
    ])
    expect(h.events).not.toContain('stop-deployments')
    expect(h.events).not.toContain('restart-deployments')
  })

  it('rejects an equal-count destination content mismatch before source teardown', async () => {
    const h = makeHarness({ targetManifestChanged: true })
    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)
    expect(result).toEqual({
      moved: false,
      reason: 'target-content-mismatch',
      lossReport: { type: 'target-content-mismatch', root: 'workspace', pathB64: 'bWFya2Vy' },
    })
    expect(h.binds).toEqual([])
    expect(h.teardowns.some((call) => call.machineId === OLD_MACHINE_ID)).toBe(false)
  })

  it('does not bind when durable proof recording fails', async () => {
    const h = makeHarness()
    h.deps.recordEvacuationBoxProof = async () => {
      throw new Error('proof disk unavailable')
    }
    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)
    expect(result).toEqual({ moved: false, reason: 'repoint-conflict' })
    expect(h.binds).toEqual([])
    expect(h.teardowns.some((call) => call.machineId === TARGET_MACHINE_ID)).toBe(true)
  })

  it('retains the authoritative target and settles failure when manual verification fails after bind', async () => {
    const h = makeHarness()
    let settled = 0
    h.deps.verifyMachineEvacuation = async () => {
      throw new Error('verification unavailable')
    }
    h.deps.failEvacuationSourceRetained = async () => {
      settled++
    }
    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)
    expect(result).toEqual({ moved: true })
    expect(h.binds).toHaveLength(1)
    expect(h.teardowns.some((call) => call.machineId === TARGET_MACHINE_ID)).toBe(false)
    expect(h.teardowns.some((call) => call.machineId === OLD_MACHINE_ID)).toBe(false)
    expect(settled).toBe(1)
  })

  it('keeps post-bind committed semantics when failure settlement itself throws', async () => {
    const h = makeHarness()
    h.deps.verifyMachineEvacuation = async () => {
      throw new Error('verification unavailable')
    }
    h.deps.failEvacuationSourceRetained = async () => {
      throw new Error('settlement unavailable')
    }
    await expect(migrateBox(h.sandboxId, h.targetMachineId, h.deps)).rejects.toThrow(/settlement unavailable/)
    expect(h.binds).toHaveLength(1)
    expect(h.teardowns.some((call) => call.machineId === TARGET_MACHINE_ID)).toBe(false)
    expect(h.events.filter((event) => event === 'restart-source-unit')).toEqual([])
  })

  it('surfaces failed-source-retained settlement failure on a pre-bind abandonment', async () => {
    const h = makeHarness()
    h.deps.recordEvacuationBoxProof = async () => {
      throw new Error('proof unavailable')
    }
    h.deps.failEvacuationSourceRetained = async () => {
      throw new Error('settlement unavailable')
    }
    await expect(migrateBox(h.sandboxId, h.targetMachineId, h.deps)).rejects.toThrow(/settlement unavailable/)
    expect(h.binds).toEqual([])
  })

  it('rejects source writes completed after the published manifest', async () => {
    const h = makeHarness({ sourceManifestChanged: true })
    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)
    expect(result).toEqual({ moved: false, reason: 'source-changed' })
    expect(h.binds).toEqual([])
    expect(h.teardowns.some((call) => call.machineId === OLD_MACHINE_ID)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Teardown budget. `box-provision.sh --remove` gzips the ENTIRE home before
  // `userdel`, so a migrate's teardowns are exactly as size-bound as its
  // transfer: the NEW-box teardown on a failure path is what has to clear a
  // just-streamed multi-GB home, and it is also the only thing that can clear
  // the stale tree checkDestinationBaseline refuses to stream onto. On the
  // runner's 30s default that teardown times out for a big box, the stale tree
  // survives, and every later migration of that box to that machine fails at
  // the baseline again — a permanent block, not the one retry the baseline's
  // rationale promises. Both teardowns therefore reuse the transfer budget
  // rather than inventing a second ladder.
  // -------------------------------------------------------------------------
  it('teardowns reuse the TRANSFER budget, so a multi-GB home’s whole-home gzip is not cut off at 30s', async () => {
    const h = makeHarness()

    await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(h.teardowns).toHaveLength(1)
    expect(h.teardowns[0].opts.timeoutMs).toBe(h.streams[0].timeoutMs)
  })

  it('the NEW-box teardown on a failure path gets the same budget (it clears a just-streamed home)', async () => {
    const h = makeSquadHarness({ failStart: true })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'unhealthy' })
    expect(h.teardowns).toHaveLength(1)
    expect(h.teardowns[0].machineId).toBe(TARGET_MACHINE_ID)
    // The squad transfer budget, not the runner's 30s default.
    expect(h.teardowns[0].opts.timeoutMs).toBe(h.streams[0].timeoutMs)
    expect(h.teardowns[0].opts.timeoutMs).toBeGreaterThan(60_000)
  })

  it('agent migrate gets minutes for the transfer, but far less than the squad budget — regression pin', async () => {
    // The fail-fast rationale is about a HUNG box, not a fat one: an agent
    // box's ~/.private holds its git trees, and the previous streaming shape
    // effectively halved its budget (it used to be 30s to pull PLUS 30s to
    // restore; the single streamed transfer got 30s for the whole thing).
    // Minutes, not seconds — while still bounded well under the squad's, since
    // rebalance moves boxes sequentially and one hung agent box must not stall
    // the whole run for half an hour.
    const h = makeHarness()

    await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(h.streams[0].timeoutMs).toBeGreaterThanOrEqual(2 * 60_000)
    expect(h.streams[0].timeoutMs).toBeLessThanOrEqual(10 * 60_000)
  })

  // -------------------------------------------------------------------------
  // Squad migration — ON by default now that archives stream instead of being
  // buffered whole in memory. A squad box migrates like an agent box PLUS its
  // ~/workspace archive set and deployment quiesce/restart. allowSquad:false is
  // the escape hatch. Rebalance is unaffected either way: its planner never
  // selects a squad box.
  // -------------------------------------------------------------------------

  const SQUAD_ID = 'squad_22222222-2222-2222-2222-222222222222'
  const makeSquadHarness = (opts: HarnessOpts = {}) =>
    makeHarness({ sandboxId: SQUAD_ID, box: makeBox({ sandboxId: SQUAD_ID }), ...opts })

  it('allowSquad:false is the escape hatch — refuses and touches nothing', async () => {
    const h = makeSquadHarness()

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: false })

    expect(result).toEqual({ moved: false, reason: 'squad-box' })
    expect(h.events).toEqual([])
  })

  // Deliberately passes NO options: this is the test that pins squad migration
  // as the DEFAULT. If someone restores the old opt-in, this fails rather than
  // silently reverting the behaviour to a refusal.
  it('by default streams ~/workspace + ~/.private, quiesces then restarts deployments, repoints, tears down', async () => {
    const h = makeSquadHarness()

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps)

    expect(result).toEqual({ moved: true })
    // Deployment stop lands BEFORE the source is read (a running app writing to
    // ~/workspace would make the tar inconsistent); the managed ones are
    // restarted only AFTER the move is proven (repoint + old teardown).
    expect(h.events).toEqual([
      'fence',
      'stop-deployments',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'remeasure-source',
      'verify-restore',
      'start',
      'probe',
      'repoint',
      'teardown-old',
      'restart-deployments',
      'unfence',
    ])
    // The state set is role-derived: a squad box's authoritative ~/workspace is
    // carried, not the .private-only set that would silently lose it.
    expect(h.streams).toEqual([
      {
        sourceMachineId: OLD_MACHINE_ID,
        destMachineId: TARGET_MACHINE_ID,
        destUnixUser: boxUnixUser(SQUAD_ID),
        stateDirs: ['workspace', '.private'],
        codec: 'zstd',
        timeoutMs: expect.any(Number),
      },
    ])
    // Squad-only: the streamed transfer gets the widened multi-GB budget, well
    // past the runner's 30s default — the agent path (pin above) does not.
    expect(h.streams[0].timeoutMs).toBeGreaterThan(60_000)
    // Both ends were measured over the SAME role-derived set, and both TWICE:
    // the source on either side of the transfer (it stays live throughout), the
    // destination as an empty baseline and then as the restored outcome.
    expect(h.measures).toEqual([
      { machineId: OLD_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: TARGET_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: OLD_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: TARGET_MACHINE_ID, stateDirs: ['workspace', '.private'] },
    ])
  })

  it('allowSquad: a source box with NO ~/workspace aborts BEFORE provisioning, old box intact, fence cleared', async () => {
    // box-provision's ensure_dirs creates ~/workspace for every box, so its
    // absence means the source box is not in a state we can safely read — the
    // source-side half of the check the at-rest archive inspection used to do.
    const h = makeSquadHarness({
      sourceFacts: {
        workspace: { present: false, owner: '', mode: '', entries: 0 },
        '.private': { present: true, owner: 'box_source', mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'archive-failed' })
    expect(h.events).toEqual(['fence', 'stop-deployments', 'measure-source', 'unfence'])
    // Nothing was streamed, provisioned, bound, or torn down — the check runs
    // before ANY of that, with the old box still fully authoritative.
    expect(h.streams).toEqual([])
    expect(h.installs).toEqual([])
    expect(h.binds).toEqual([])
    expect(h.teardowns).toEqual([])
    expect(h.clearCalls).toEqual([SQUAD_ID])
  })

  it('allowSquad: an EMPTY/partial restored ~/workspace aborts BEFORE the source is torn down (the data-loss shape)', async () => {
    // THE case this whole verification exists for: the transfer reports success
    // at both ends, but the target's ~/workspace did not actually land. The old
    // box is the only surviving copy of the squad's work, so it must survive.
    const h = makeSquadHarness({
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 0 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    // The NEW box is torn down; the OLD box is never touched and the row never
    // repointed, so the squad's work is still where it was.
    expect(h.events).toEqual([
      'fence',
      'stop-deployments',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'stream',
      'remeasure-source',
      'verify-restore',
      'teardown-new',
      'unfence',
    ])
    expect(h.binds).toEqual([])
    expect(h.teardowns).toEqual([
      { machineId: TARGET_MACHINE_ID, unixUser: boxUnixUser(SQUAD_ID), port: 50123, opts: { timeoutMs: 30 * 60_000 } },
    ])
  })

  it('allowSquad: a ROOT-OWNED restored ~/workspace aborts before the source teardown (a dead squad box)', async () => {
    // The restore's chown is the difference between a working squad box and an
    // unwritable one; verification demands it back rather than trusting it.
    const h = makeSquadHarness({
      destFacts: {
        workspace: { present: true, owner: 'root', mode: '755', entries: 6 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
    expect(h.binds).toEqual([])
  })

  it('allowSquad: a destination probe that FAILS aborts before the source teardown (unverifiable ≠ verified)', async () => {
    const h = makeSquadHarness({ failMeasureDest: true })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
    expect(h.binds).toEqual([])
  })

  it('allowSquad: a brand-new squad box with a genuinely EMPTY workspace still migrates', async () => {
    // The destination check compares against the SOURCE, not a fixed floor, so
    // a squad that has done no work yet is not mistaken for a lost workspace.
    const empty = { present: true, owner: 'box_source', mode: '755', entries: 0 }
    const h = makeSquadHarness({
      sourceFacts: { workspace: empty, '.private': { ...empty, mode: '700' } },
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 0 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 0 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: true })
  })

  // -------------------------------------------------------------------------
  // The STALE-DESTINATION data-loss path, closed at both ends.
  //
  // Reachable shape: migration A→B streams the workspace then fails at
  // health/repoint; teardownNewBox is best-effort and its failure is only a
  // WARN, so the restored home survives on B. Work continues on A and a
  // top-level entry is deleted. A later A→B attempt whose transfer silently
  // omits `workspace` (both ends exit 0, bytes > 0 from a `.private`-only
  // archive) used to pass verification against B's stale SUPERSET — health
  // passes, the row repoints, and A (the last real copy) is torn down.
  // -------------------------------------------------------------------------
  it('allowSquad: REFUSES to stream onto a destination that already holds a tree (stale from an abandoned attempt)', async () => {
    const h = makeSquadHarness({
      destBaselineFacts: {
        // What an abandoned earlier attempt left behind on the target.
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 7 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    // Not a single byte moved, and the old box was never touched.
    expect(h.streams).toEqual([])
    expect(h.events).toEqual([
      'fence',
      'stop-deployments',
      'measure-source',
      'bundle',
      'install',
      'baseline-dest',
      'teardown-new',
      'unfence',
    ])
    expect(h.binds).toEqual([])
    expect(h.events).not.toContain('teardown-old')
  })

  it('allowSquad: a destination holding MORE than the source fails verification (a `>=` check would pass it)', async () => {
    // Same stale superset, reached from the other direction: suppose the
    // baseline was clean but the transfer dropped `workspace` while the target
    // ended up with more entries than the source has. `>=` called that fine.
    const h = makeSquadHarness({
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 9 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
    expect(h.binds).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Concurrent SOURCE drift is a non-event, not an expensive late abort.
  //
  // The source is measured at step 6; the tar runs at step 8. Between them sit
  // ensureMachineArtifacts (up to 2 min PER FILE) and installBoxOnMachine (a
  // minute+) — and the source box is still LIVE the whole time. A background
  // build or a dev server an agent left running can add a top-level entry to
  // ~/workspace in that window. Comparing the destination against the
  // pre-provision reading alone would abort at step 8.5 AFTER the entire
  // multi-GB stream has been paid for. So the source is RE-MEASURED right
  // after the stream and the destination is accepted anywhere in [min, max] of
  // the two readings — a genuine upper bound is retained (defence in depth if
  // the empty baseline is ever bypassed or regressed), but it is measured
  // against a reading taken on the same side of the transfer.
  // -------------------------------------------------------------------------
  it('allowSquad: SOURCE drift during the provision window does not abort the move', async () => {
    const h = makeSquadHarness({
      // A build wrote two new top-level entries into ~/workspace while the
      // target was being provisioned; the tar therefore carried 8, not 6.
      sourceFactsAfter: {
        workspace: { present: true, owner: 'box_source', mode: '755', entries: 8 },
        '.private': { present: true, owner: 'box_source', mode: '700', entries: 3 },
      },
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 8 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: true })
    // The second reading is a REAL probe of the source, not the first one
    // reused: four measurements, source and destination twice each.
    expect(h.measures).toEqual([
      { machineId: OLD_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: TARGET_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: OLD_MACHINE_ID, stateDirs: ['workspace', '.private'] },
      { machineId: TARGET_MACHINE_ID, stateDirs: ['workspace', '.private'] },
    ])
    // …and it is taken AFTER the stream, so it sees what the tar actually read.
    expect(h.events.indexOf('remeasure-source')).toBeGreaterThan(h.events.indexOf('stream'))
  })

  it('allowSquad: source drift DOWNWARD (entries deleted mid-move) is equally a non-event', async () => {
    const h = makeSquadHarness({
      sourceFactsAfter: {
        workspace: { present: true, owner: 'box_source', mode: '755', entries: 4 },
        '.private': { present: true, owner: 'box_source', mode: '700', entries: 3 },
      },
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 4 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    expect(await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })).toEqual({ moved: true })
  })

  it('allowSquad: the UPPER BOUND still holds — a destination beyond BOTH source readings fails', async () => {
    // Drift widens the accepted band; it does not remove the ceiling. A target
    // holding more than the source ever held in this move is still a stale
    // superset standing in for content the transfer may have dropped.
    const h = makeSquadHarness({
      sourceFactsAfter: {
        workspace: { present: true, owner: 'box_source', mode: '755', entries: 8 },
        '.private': { present: true, owner: 'box_source', mode: '700', entries: 3 },
      },
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 9 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
    expect(h.binds).toEqual([])
  })

  it('allowSquad: a destination BELOW both source readings still fails (the data-loss shape survives drift)', async () => {
    const h = makeSquadHarness({
      sourceFactsAfter: {
        workspace: { present: true, owner: 'box_source', mode: '755', entries: 4 },
        '.private': { present: true, owner: 'box_source', mode: '700', entries: 3 },
      },
      destFacts: {
        workspace: { present: true, owner: boxUnixUser(SQUAD_ID), mode: '755', entries: 0 },
        '.private': { present: true, owner: boxUnixUser(SQUAD_ID), mode: '700', entries: 3 },
      },
    })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
  })

  it('allowSquad: an unmeasurable SOURCE re-probe aborts before the source teardown (unverifiable ≠ verified)', async () => {
    // The comparison has no upper bound it can trust without it, and the source
    // is the last authoritative copy — so this fails closed, costing one retry.
    const h = makeSquadHarness({ failRemeasureSource: true })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
    expect(h.binds).toEqual([])
  })

  it('allowSquad: an UNMEASURABLE destination baseline aborts before the stream (unverifiable ≠ empty)', async () => {
    const h = makeSquadHarness({ failMeasureBaseline: true })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.streams).toEqual([])
    expect(h.events).not.toContain('teardown-old')
  })

  it('agent migrate ALSO baselines its destination before streaming (not a squad-only guard)', async () => {
    const h = makeHarness({
      destBaselineFacts: { '.private': { present: true, owner: boxUnixUser(SANDBOX_ID), mode: '700', entries: 4 } },
    })

    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.streams).toEqual([])
    expect(h.events).not.toContain('teardown-old')
  })

  it('agent migrate ALSO verifies its destination before the source teardown (not a squad-only guard)', async () => {
    const h = makeHarness({
      destFacts: { '.private': { present: false, owner: '', mode: '', entries: 0 } },
    })

    const result = await migrateBox(h.sandboxId, h.targetMachineId, h.deps)

    expect(result).toEqual({ moved: false, reason: 'restore-failed' })
    expect(h.events).not.toContain('teardown-old')
  })

  it('allowSquad: a deployment RESTART failure does not fail the move (restartable by the user; WARN)', async () => {
    const h = makeSquadHarness({ failRestartDeployments: true })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    // The move already succeeded (new box healthy, row repointed, old box gone);
    // a failed restart is logged, never surfaced as a migration failure.
    expect(result).toEqual({ moved: true })
    expect(h.events[h.events.length - 1]).toBe('unfence')
  })

  it('allowSquad: a deployment STOP failure aborts BEFORE the source is read — old box intact, nothing provisioned, fence cleared', async () => {
    const h = makeSquadHarness({ failStopDeployments: true })

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })

    // The stop MUST complete before the source tar or the archive is inconsistent;
    // a failed stop is a hard abort with the old box fully authoritative.
    expect(result).toEqual({ moved: false, reason: 'quiesce-failed' })
    expect(h.events).toEqual(['fence', 'stop-deployments', 'unfence'])
    expect(h.streams).toEqual([])
    expect(h.measures).toEqual([])
    expect(h.installs).toEqual([])
    expect(h.binds).toEqual([])
    expect(h.teardowns).toEqual([])
  })

  it('allowSquad: emits phase progress in order so an external driver can tail the move live', async () => {
    const h = makeSquadHarness()
    const phases: string[] = []

    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, {
      allowSquad: true,
      onProgress: (p) => phases.push(p.phase),
    })

    expect(result).toEqual({ moved: true })
    expect(phases).toEqual([
      'fence',
      'stop-deployments',
      'archive',
      'provision',
      'restore',
      'health',
      'repoint',
      'teardown',
      'restart-deployments',
    ])
  })

  it('allowSquad squad quiesce: an idle squad proceeds after the activity fence', async () => {
    // sandboxHasActiveExecution returns false for a squad box (its real quiesce
    // is the deployment stop), so the fence is won without a member-turn probe.
    const h = makeSquadHarness()
    const result = await migrateBox(SQUAD_ID, TARGET_MACHINE_ID, h.deps, { allowSquad: true })
    expect(result.moved).toBe(true)
  })

  it('throws outside the VM runtime', async () => {
    const h = makeHarness()
    h.deps.isVmRuntime = () => false

    await expect(migrateBox(SANDBOX_ID, TARGET_MACHINE_ID, h.deps)).rejects.toThrow(/VM sandbox runtime/)
    expect(h.events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sandboxHasActiveExecution — the default fence activity probe (DB)
// ---------------------------------------------------------------------------

describe('sandboxHasActiveExecution (DB)', () => {
  const createdUserIds: string[] = []

  async function insertUser(): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({ email: `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com` })
      .returning({ id: users.id })
    createdUserIds.push(row.id)
    return row.id
  }

  async function insertAgent(values: {
    agentTypeId: string
    ownerUserId?: string | null
    parentAgentId?: string | null
    squadId?: string | null
    terminatedAt?: Date | null
  }): Promise<string> {
    const [row] = await db
      .insert(agents)
      .values({
        agentTypeId: values.agentTypeId,
        ownerUserId: values.ownerUserId ?? null,
        parentAgentId: values.parentAgentId ?? null,
        squadId: values.squadId ?? null,
        terminatedAt: values.terminatedAt ?? null,
      })
      .returning({ id: agents.id })
    return row.id
  }

  const createdAgentIds: string[] = []

  async function insertAgentTracked(values: {
    agentTypeId: string
    ownerUserId?: string | null
    parentAgentId?: string | null
    squadId?: string | null
    terminatedAt?: Date | null
  }): Promise<string> {
    const id = await insertAgent(values)
    createdAgentIds.push(id)
    return id
  }

  async function insertExecution(agentId: string, status: string): Promise<void> {
    await db.insert(executions).values({ agentId, status: status as 'queued' })
  }

  async function cleanup() {
    // executions cascade off agents; subagents cascade off parents (delete in
    // reverse creation order so children go first); owned agents cascade off users.
    for (const id of createdAgentIds.splice(0).reverse()) {
      await db.delete(agents).where(eq(agents.id, id))
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id))
    }
  }

  beforeEach(cleanup)
  afterEach(cleanup)

  it('agent_<id>: true for queued/running/stopping, false for terminal statuses', async () => {
    const agentId = await insertAgentTracked({ agentTypeId: 'developer' })

    expect(await sandboxHasActiveExecution(`agent_${agentId}`)).toBe(false)

    await insertExecution(agentId, 'completed')
    expect(await sandboxHasActiveExecution(`agent_${agentId}`)).toBe(false)

    for (const status of ['queued', 'running', 'stopping']) {
      const active = await insertAgentTracked({ agentTypeId: 'developer' })
      await insertExecution(active, status)
      expect(await sandboxHasActiveExecution(`agent_${active}`)).toBe(true)
    }
  })

  it('agent_<id>: a live SUBAGENT turn (own execution row, parent’s box) blocks the migrate', async () => {
    const parent = await insertAgentTracked({ agentTypeId: 'developer' })
    const child = await insertAgentTracked({ agentTypeId: 'subagent', parentAgentId: parent })
    const grandchild = await insertAgentTracked({ agentTypeId: 'subagent', parentAgentId: child })

    expect(await sandboxHasActiveExecution(`agent_${parent}`)).toBe(false)

    // Subagents inherit the PARENT's sandbox (Agent.getSandboxId recurses), so
    // an active execution anywhere in the descendant tree blocks the box.
    await insertExecution(grandchild, 'running')
    expect(await sandboxHasActiveExecution(`agent_${parent}`)).toBe(true)
    // ...but not the other way round: the child's own agent_<child> box (never
    // provisioned, but derivationally distinct) doesn't see the parent as owner.
    expect(await sandboxHasActiveExecution(`agent_${child}`)).toBe(true) // grandchild is child's descendant
  })

  it('system_manager_<userId>: considers EVERY system-manager agent of that user', async () => {
    const userId = await insertUser()
    const first = await insertAgentTracked({ agentTypeId: 'system-manager', ownerUserId: userId })
    const second = await insertAgentTracked({ agentTypeId: 'system-manager', ownerUserId: userId })

    expect(await sandboxHasActiveExecution(`system_manager_${userId}`)).toBe(false)

    // An active turn on the SECOND system-manager still blocks the shared box.
    await insertExecution(second, 'running')
    expect(await sandboxHasActiveExecution(`system_manager_${userId}`)).toBe(true)
    expect(first).not.toBe(second)
  })

  it('system_manager_<userId>: another user’s active system-manager does not block this box', async () => {
    const userId = await insertUser()
    const otherUserId = await insertUser()
    await insertAgentTracked({ agentTypeId: 'system-manager', ownerUserId: userId })
    const otherAgent = await insertAgentTracked({ agentTypeId: 'system-manager', ownerUserId: otherUserId })
    await insertExecution(otherAgent, 'running')

    expect(await sandboxHasActiveExecution(`system_manager_${userId}`)).toBe(false)
  })

  it('terminates (correctly) when parent_agent_id forms a cycle', async () => {
    // The schema does not forbid a parent cycle. The recursive owner walk must
    // use UNION (distinct) — with UNION ALL a cycle recurses forever while
    // holding the fence's box row lock and two pool connections (a silent
    // cross-connection hang Postgres cannot detect as a deadlock).
    const a = await insertAgentTracked({ agentTypeId: 'developer' })
    const b = await insertAgentTracked({ agentTypeId: 'subagent', parentAgentId: a })
    await db.update(agents).set({ parentAgentId: b }).where(eq(agents.id, a))

    expect(await sandboxHasActiveExecution(`agent_${a}`)).toBe(false)

    await insertExecution(b, 'running')
    expect(await sandboxHasActiveExecution(`agent_${a}`)).toBe(true)
  }, 10_000)

  it('squad_<id>: counts capable top-level members and squad subagents', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `migration-${Date.now()}`, purpose: 'test' })
      .returning()
    const sandboxId = `squad_${squad.id}`
    const cases = [
      { agentTypeId: 'manager', status: 'running' },
      { agentTypeId: 'engineer', status: 'stopping' },
      { agentTypeId: 'consultant', status: 'stopping' },
    ]
    for (const entry of cases) {
      const member = await insertAgentTracked({ agentTypeId: entry.agentTypeId, squadId: squad.id })
      expect(await sandboxHasActiveExecution(sandboxId)).toBe(false)
      await insertExecution(member, entry.status)
      expect(await sandboxHasActiveExecution(sandboxId)).toBe(true)
      await db.delete(executions).where(eq(executions.agentId, member))
    }

    const parent = await insertAgentTracked({ agentTypeId: 'engineer', squadId: squad.id })
    const child = await insertAgentTracked({ agentTypeId: 'subagent', squadId: squad.id, parentAgentId: parent })
    await insertExecution(child, 'running')
    expect(await sandboxHasActiveExecution(sandboxId)).toBe(true)
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  it('squad_<id>: excludes unrelated, queued, terminal, and personal-only executions', async () => {
    const [squad, other] = await db
      .insert(squads)
      .values([
        { name: `migration-${Date.now()}-a`, purpose: 'test' },
        { name: `migration-${Date.now()}-b`, purpose: 'test' },
      ])
      .returning()
    const sandboxId = `squad_${squad.id}`
    const excluded = [
      { agentTypeId: 'engineer', squadId: other.id, status: 'running' },
      { agentTypeId: 'engineer', squadId: squad.id, status: 'queued' },
      { agentTypeId: 'engineer', squadId: squad.id, status: 'queued', terminatedAt: new Date() },
      { agentTypeId: 'engineer', squadId: squad.id, status: 'completed' },
      { agentTypeId: 'engineer', squadId: squad.id, status: 'failed' },
      { agentTypeId: 'engineer', squadId: squad.id, status: 'stopped' },
      { agentTypeId: 'system-manager', squadId: squad.id, status: 'running' },
      { agentTypeId: 'artifact-builder-default', squadId: squad.id, status: 'running' },
    ]
    for (const entry of excluded) {
      const member = await insertAgentTracked(entry)
      await insertExecution(member, entry.status)
    }
    expect(await sandboxHasActiveExecution(sandboxId)).toBe(false)

    const member = await insertAgentTracked({ agentTypeId: 'engineer', squadId: squad.id })
    await insertExecution(member, 'running')
    expect(await sandboxHasActiveExecution(`agent_${member}`)).toBe(true)
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(squads).where(eq(squads.id, other.id))
  })

  it('squad_<id>: the SQL predicate agrees with Agent.hasSquadSandboxAccessForExecution for every runner shape', async () => {
    // These two are the two halves of the same rule — the fence decides who
    // blocks a migration, pickup decides who takes the squad row lock — and
    // they are written in different languages (raw SQL vs a runnerType list),
    // so nothing but this test stops them drifting apart.
    const [squad] = await db
      .insert(squads)
      .values({ name: `migration-parity-${Date.now()}`, purpose: 'test' })
      .returning()
    const sandboxId = `squad_${squad.id}`
    const shapes: Array<{ agentTypeId: string; underParent?: boolean }> = [
      { agentTypeId: 'manager' },
      { agentTypeId: 'consultant' },
      { agentTypeId: 'engineer' },
      { agentTypeId: 'consultant' },
      { agentTypeId: 'system-manager' },
      { agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID },
      { agentTypeId: 'subagent', underParent: true },
      // A personal-only TYPE that is nonetheless a subagent: both halves must
      // key off the parent link, not the type. This is the shape where a naive
      // "exclude these agent types" rule diverges.
      { agentTypeId: 'system-manager', underParent: true },
      { agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, underParent: true },
    ]
    const seen: Array<{ shape: string; capable: boolean }> = []
    for (const shape of shapes) {
      const parentAgentId = shape.underParent
        ? await insertAgentTracked({ agentTypeId: 'engineer', squadId: squad.id })
        : null
      const id = await insertAgentTracked({ agentTypeId: shape.agentTypeId, squadId: squad.id, parentAgentId })
      await insertExecution(id, 'running')
      const capable = new Agent({
        id,
        agentTypeId: shape.agentTypeId,
        squadId: squad.id,
        parentAgentId,
        ownerUserId: null,
      } as any).hasSquadSandboxAccessForExecution()
      expect(await sandboxHasActiveExecution(sandboxId)).toBe(capable)
      seen.push({ shape: `${shape.agentTypeId}${shape.underParent ? ' (subagent)' : ''}`, capable })
      await db.delete(executions).where(eq(executions.agentId, id))
    }
    // Guard against a vacuous sweep: both verdicts must actually occur, or the
    // loop above proves only that one branch matches itself.
    expect(seen.filter((s) => s.capable).length).toBeGreaterThan(0)
    expect(seen.filter((s) => !s.capable).map((s) => s.shape)).toEqual([
      'system-manager',
      ARTIFACT_BUILDER_AGENT_TYPE_ID,
    ])
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  it('squad_<id>: terminated agents still block while their execution is running or stopping', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `migration-terminated-${Date.now()}`, purpose: 'test' })
      .returning()
    const sandboxId = `squad_${squad.id}`
    const runningMember = await insertAgentTracked({
      agentTypeId: 'engineer',
      squadId: squad.id,
      terminatedAt: new Date(),
    })
    await insertExecution(runningMember, 'running')
    expect(await sandboxHasActiveExecution(sandboxId)).toBe(true)
    await db.delete(executions).where(eq(executions.agentId, runningMember))

    // Cascade termination sets the child marker before its in-flight execution
    // finishes stopping. The shared box remains reachable until that row settles.
    const parent = await insertAgentTracked({ agentTypeId: 'engineer', squadId: squad.id })
    const child = await insertAgentTracked({
      agentTypeId: 'subagent',
      squadId: squad.id,
      parentAgentId: parent,
      terminatedAt: new Date(),
    })
    await insertExecution(child, 'stopping')
    expect(await sandboxHasActiveExecution(sandboxId)).toBe(true)
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  it('fails safe (true) for a sandboxId whose owner cannot be derived', async () => {
    expect(await sandboxHasActiveExecution('agent_not-a-uuid')).toBe(true)
    expect(await sandboxHasActiveExecution('mystery_box')).toBe(true)
  })
})
