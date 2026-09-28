import { MAX_INGEST_MACHINES, type IngestMachine } from '@ficus/shared/platform-usage'
/**
 * Platform usage-sample reporter — the tau-instance side of the shadow-
 * metering loop. Every 5 minutes, samples the
 * live `machines` fleet and POSTs it to the platform's ingest endpoint, which
 * stores it for later billing aggregation. Entirely inert on a self-hosted
 * (non-platform-managed) instance: `FICUS_PLATFORM_INGEST_URL` is only ever set
 * by the platform's render-config for a tenant it provisioned.
 *
 * Shadow metering must never hurt the instance it's reporting on: every
 * failure mode (missing config, network error, non-2xx response) is caught
 * and logged at `warn`, never thrown — a bad or unreachable platform must
 * never affect this tau instance's own operation. The next 5-minute tick is
 * the only retry; there is no backoff/queue, matching the "sample, don't
 * guarantee delivery" nature of the shadow-metering design.
 */

import { inArray, sql } from 'drizzle-orm'
import { createLogger } from '../../lib/infra/logger'
import { User } from '../../entities/User'
import { Agent } from '../../entities/Agent'
import { db, executions, machineBoxes, squads } from '../../db'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { MONOREPO_ROOT } from '../../lib/paths'
import { sampleMachineDiskUsage } from './machine-health'
import { getSecretStore } from '../secrets'
import { resolveRepoRoot } from '../updates/deployment-flavor'
import { isArtifactDeployment, readArtifactManifest } from './machine-prebuilt'
import { listMachines as listMachinesQuery, type Machine } from './queries'
import { sshExec } from './ssh'
import { createMachineMetricsSampler, type MachineMetricsSampler } from './machine-metrics-sampler'
import { buildCombinedSampleCommand, type MachineMetricsAggregate } from './machine-metrics-sample'

const log = createLogger('platform-usage-reporter')

const REPORT_INTERVAL_MS = 5 * 60_000

/**
 * Client-side mirror of the platform's server-side cap
 * (the hosted control plane's `MAX_MACHINES`). Truncating
 * here means an oversized payload never round-trips to get a 400 back — real
 * fleets are orders of magnitude below this, so truncation should never fire
 * outside of a test.
 */
const MAX_MACHINES = MAX_INGEST_MACHINES

/** The shared ingest contract keeps client and server payloads aligned. */
export type { IngestMachine } from '@ficus/shared/platform-usage'

export interface UsageReportPayload {
  sampledAt: string
  machines: IngestMachine[]
  /**
   * Count of the instance's enabled human user accounts (see
   * {@link User.countActive} — there is no system/service/bot account type on
   * `users`, so this is every account minus disabled ones). Drives the
   * platform's per-seat billing ($10/mo per user beyond the first). Same
   * hand-sync caveat as {@link IngestMachine}: must stay in exact step with
   * the platform's `IngestUsageSample` shape.
   */
  userCount: number
  /**
   * Full 40-hex commit sha of the checkout this instance is running from, and
   * the branch it is on ('HEAD' when detached). OMITTED ENTIRELY when it can't
   * be determined (no git, no checkout, a git that errors) — the platform's
   * ingest validator treats both as optional exactly like `userCount`, so an
   * instance without a resolvable version still reports usage normally.
   *
   * Lets the operator see what every instance in the fleet is running without
   * touching any of them (the hosted control plane's admin instance list/detail).
   */
  commitSha?: string
  gitRef?: string
  /**
   * The release artifact's content digest ({@link BuildVersion.artifactDigest}),
   * present only when `commitSha` was resolved from an artifact deployment
   * rather than a git checkout. OMITTED ENTIRELY on a git-checkout instance
   * — same "absent, never a placeholder" discipline as every other optional
   * field here. NEW field: the platform's ingest validator (Task 5) does not
   * yet read it, but unrecognized JSON keys are ignored, not rejected, so
   * sending it now is forward-compatible and costs nothing on an unupgraded
   * platform.
   */
  artifactDigest?: string
  /**
   * T3 — feeds the platform's storage guard
   * (docs/history/superpowers/specs/2026-08-07-machine-size-catalog-design.md's
   * "Storage guard" section): a `df`-level (not per-box) sample of the
   * PRIMARY machine host's box-storage filesystem, floored to whole GiB.
   * OMITTED ENTIRELY — never sent as zero — when the core manages no
   * machines or the sample fails (see {@link pickPrimaryMachineForDiskReport}
   * and machine-health.ts's `sampleMachineDiskUsage`), exactly like
   * `commitSha`/`gitRef` above: the platform's ingest validator treats both
   * as optional.
   *
   * This payload is per-INSTANCE, not per-machine, so a core with more than
   * one machine reports only its primary's disk — see
   * {@link pickPrimaryMachineForDiskReport}'s doc for that limitation.
   */
  diskUsedGb?: number
  diskTotalGb?: number
  /**
   * T4 — the 60-second machine sub-sampler's aggregate ({@link
   * MachineMetricsAggregate}: load/CPU/mem/disk over the report window) plus
   * this instance's activity counts (see {@link countInstanceActivity}).
   * OMITTED ENTIRELY when the object would otherwise be empty — never a
   * block full of nothing — exactly like `diskUsedGb`/`diskTotalGb` above.
   * Its own `diskUsedGb`/`diskTotalGb` sample the SAME filesystem as the
   * top-level fields (both are machine-metrics-sample.ts's
   * `DISK_SAMPLE_PATH` — one shared constant, so the storage guard, this
   * graph/alert-facing block, and the disk report can never disagree about
   * what "the disk" means) but are a SEPARATE sample: this one is a
   * 60s-averaged window from the sub-sampler, the top-level one is a single
   * one-shot `df` per tick — the two numbers may drift slightly moment-to-
   * moment, but must never describe two DIFFERENT filesystems.
   */
  metrics?: UsageMetricsBlock
  hostMetrics?: HostMetricsReport[]
}

export interface HostMetricsReport {
  hostKind: 'machine_host' | 'core_vm'
  hostId: string
  metrics: UsageMetricsBlock
}

/**
 * The `metrics` payload block: {@link MachineMetricsAggregate}'s load/CPU/
 * mem/disk fields plus this instance's activity counts. All optional —
 * {@link buildUsagePayload} omits the whole `metrics` key when this is empty,
 * and each field within it is independently omitted (never zero-filled) by
 * its producer ({@link MachineMetricsAggregate}'s aggregator,
 * {@link countInstanceActivity}) on a failed/empty sample.
 */
export interface UsageMetricsBlock extends MachineMetricsAggregate {
  /** Runtime-live agents by status — see {@link countInstanceActivity}. */
  agentsAlive?: number
  /** All `machine_boxes` rows (every status is a still-existing box; rows are deleted, not soft-removed). */
  boxesTotal?: number
  /** All `squads` rows. */
  squadsTotal?: number
  /** Executions currently `queued` or `running`. */
  executionsActive?: number
}

export interface BuildVersion {
  commitSha: string
  gitRef?: string
  /**
   * The release artifact's content digest (scripts/artifact/lib/manifest.ts's
   * `sha256:<hex>` over its files map), present only when this build was
   * resolved from an artifact deployment's `artifact.json` rather than a git
   * checkout — see {@link getBuildVersion}'s artifact branch.
   */
  artifactDigest?: string
}

/** A full, lowercase git object name — what `git rev-parse HEAD` prints. */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

/**
 * Resolved ONCE per process and cached (including the "couldn't resolve" answer
 * as `null`), for two reasons:
 *
 *   1. Cost — spawning two `git` processes on every 5-minute tick to re-read a
 *      value that cannot change without a restart is pure waste.
 *   2. HONESTY — and this is the load-bearing one. `tau-api` runs
 *      `bun run dist/index.js`, so the code actually serving requests is the
 *      BUILD, not the checkout. Re-reading git per tick would report a moved
 *      checkout as the running version the instant someone fetched, even
 *      though the old bundle was still being served. Sampling at startup means
 *      the reported sha is the one this process was started against — a
 *      fetch-without-rebuild-without-restart keeps reporting the old sha,
 *      which is the truth.
 *
 * Note the platform does not rely on this alone for upgrade verification: its
 * upgrade executor independently checks on the box that the core bundle was
 * rebuilt and the service restarted after it. This field is the fleet-wide
 * VIEW; that check is the proof.
 */
let cachedBuildVersion: BuildVersion | null | undefined

/** Run `git <args>` in `cwd`, returning trimmed stdout, or undefined on any failure (missing git, not a checkout, non-zero exit). */
async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode !== 0) return undefined
    const trimmed = out.trim()
    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/**
 * The running build's identity, read from the deployed checkout (the same
 * `resolveRepoRoot` walk the self-updater uses, so it works under the setup
 * toolkit's `WorkingDirectory=<dest>/apps/core`). Cached — see
 * {@link cachedBuildVersion}.
 */
export async function getBuildVersion(
  overrides: { repoRoot?: string; git?: typeof gitOutput; artifactRoot?: string } = {}
): Promise<BuildVersion | null> {
  const forced = overrides.repoRoot !== undefined || overrides.git !== undefined || overrides.artifactRoot !== undefined
  if (!forced && cachedBuildVersion !== undefined) return cachedBuildVersion

  // Artifact deployments carry no `.git` (their release identity is
  // `artifact.json`, never a checkout to shell git against), and take
  // priority over the git branch below — see deployment-flavor.ts's
  // detectSource for the identical ordering rationale. A malformed/
  // commit-less manifest resolves to null (honest "can't determine",
  // matching the existing not-a-real-sha behavior below) rather than
  // falling through to a git command that has nothing to find in an
  // artifact tree.
  const artifactRoot = overrides.artifactRoot ?? MONOREPO_ROOT
  if (isArtifactDeployment(artifactRoot)) {
    const manifest = readArtifactManifest(artifactRoot)
    const resolved: BuildVersion | null =
      manifest?.commit && COMMIT_SHA_RE.test(manifest.commit)
        ? { commitSha: manifest.commit, gitRef: undefined, artifactDigest: manifest.digest }
        : null
    if (!forced) cachedBuildVersion = resolved
    return resolved
  }

  const repoRoot = overrides.repoRoot ?? resolveRepoRoot()
  const git = overrides.git ?? gitOutput
  const commitSha = await git(repoRoot, ['rev-parse', 'HEAD'])
  const resolved: BuildVersion | null =
    commitSha && COMMIT_SHA_RE.test(commitSha)
      ? { commitSha, gitRef: await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) }
      : null

  if (!forced) cachedBuildVersion = resolved
  return resolved
}

/** Test seam only — drops the cached answer so the next getBuildVersion() re-resolves. */
export function resetBuildVersionCache(): void {
  cachedBuildVersion = undefined
}

function toIngestMachine(machine: Machine): IngestMachine {
  return {
    name: machine.name,
    provider: machine.provider,
    scope: machine.scope,
    purpose: machine.purpose,
    autoProvisioned: machine.autoProvisioned,
    status: machine.status,
    createdAt: machine.createdAt.toISOString(),
  }
}

/**
 * Build the ingest payload from live machine rows and the active user count,
 * capping (and warning on) an oversized fleet client-side to mirror the
 * platform's own cap.
 */
export function buildUsagePayload(
  machines: Machine[],
  userCount: number,
  sampledAt: Date,
  version?: BuildVersion | null,
  disk?: { usedGb: number; totalGb: number } | null,
  metrics?: UsageMetricsBlock | null,
  coreMetrics?: UsageMetricsBlock | null
): UsageReportPayload {
  let mapped = machines.map(toIngestMachine)
  if (mapped.length > MAX_MACHINES) {
    log.warn(`Sampled fleet has ${mapped.length} machines; truncating to ${MAX_MACHINES} for the platform ingest cap`)
    mapped = mapped.slice(0, MAX_MACHINES)
  }
  const payload: UsageReportPayload = { sampledAt: sampledAt.toISOString(), machines: mapped, userCount }
  // Spread-in rather than `commitSha: version?.commitSha` so an unresolvable
  // version omits the KEYS entirely instead of sending `undefined` (which
  // JSON.stringify would drop anyway, but the payload type stays honest).
  if (version) {
    payload.commitSha = version.commitSha
    if (version.gitRef) payload.gitRef = version.gitRef
    if (version.artifactDigest) payload.artifactDigest = version.artifactDigest
  }
  // Same "omit the keys, never send zero" discipline as version above — a
  // missing/failed disk sample must never read as an empty disk.
  if (disk) {
    payload.diskUsedGb = disk.usedGb
    payload.diskTotalGb = disk.totalGb
  }
  // Same "omit the keys, never send zero" discipline again — an empty
  // aggregate (no sub-samples landed, every activity count failed) must
  // never surface as a `metrics` block full of nothing.
  const hostMetrics: HostMetricsReport[] = []
  if (metrics && Object.keys(metrics).length > 0) {
    payload.metrics = metrics
    hostMetrics.push({ hostKind: 'machine_host', hostId: 'primary', metrics })
  }
  if (coreMetrics && Object.keys(coreMetrics).length > 0) {
    hostMetrics.push({ hostKind: 'core_vm', hostId: 'self', metrics: coreMetrics })
  }
  if (hostMetrics.length > 0) payload.hostMetrics = hostMetrics
  return payload
}

/**
 * The "primary" machine host for the disk report. The usage-reporter's
 * payload is per-INSTANCE, not per-machine, but the platform's tenant row
 * models exactly one machine host (`machineHostDropletId`/`machineHostIp` —
 * managed instance configuration), which for a platform-hosted (do_droplet
 * mode) tenant is the single VM machine registered via `POST /api/machines`
 * during provisioning ("VM machine mode"). For that common case there is
 * exactly one `ready` machine and this pick is unambiguous.
 *
 * For a self-hosted core with more than one machine (BYO SSH fleets,
 * multiple exe VMs) this is a deliberate simplification, not a full
 * per-machine report: the OLDEST `ready` machine (by `createdAt`) is
 * reported, so the same machine is named report over report rather than a
 * different one each tick. Non-`ready` machines (unreachable/parked/etc.)
 * are never picked — an unreachable primary would never yield a sample
 * anyway. Returns `undefined` when the core manages no `ready` machines.
 */
export function pickPrimaryMachineForDiskReport(machines: Machine[]): Machine | undefined {
  let primary: Machine | undefined
  for (const machine of machines) {
    if (machine.status !== 'ready') continue
    if (!primary || machine.createdAt.getTime() < primary.createdAt.getTime()) primary = machine
  }
  return primary
}

/**
 * The metrics sub-sampler's CURRENT exec target — the primary machine every
 * 60s sub-sample between now and the next 5-minute tick will run against.
 * Deliberately NOT re-resolved per sub-sample: it is pinned exactly ONCE per
 * tick, by the tick itself (see `reportUsageSampleOnce`'s `pinMetricsMachine`
 * call), from the SAME `machines` snapshot and the SAME
 * {@link pickPrimaryMachineForDiskReport} pick the tick's disk sample uses.
 * Re-deriving independently on every 60s sub-sample (the earlier approach)
 * meant a ~5-minute drain window could blend sub-samples from TWO DIFFERENT
 * hosts if the ready-machine set changed mid-window — exactly what happens
 * during a resize, which is precisely when this data matters most. `null`
 * means "no ready machine this tick" (mirrors `sampleDisk` resolving to
 * `null`), causing sub-samples to be skipped rather than fabricated.
 */
let pinnedPrimaryMachine: Machine | null = null

/**
 * `exec` seam for {@link createMachineMetricsSampler}: runs the sub-sample
 * command against whichever machine is CURRENTLY {@link pinnedPrimaryMachine}
 * — never resolves a primary itself (that's the tick's job, once per tick;
 * see {@link pinnedPrimaryMachine}'s doc for why). Throws (never returns a
 * fabricated empty string) on "nothing pinned yet" or a nonzero SSH exit —
 * {@link MachineMetricsSampler}'s `sample()` already catches and skips on
 * any exec rejection, so this seam does not need its own try/catch.
 */
async function execOnPinnedPrimaryMachine(command: string): Promise<string> {
  const primary = pinnedPrimaryMachine
  if (!primary) throw new Error('no primary machine pinned yet to sample metrics from')
  const result = await sshExec(primary, command)
  if (result.exitCode !== 0) {
    throw new Error(`machine metrics sub-sample command failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

/**
 * Process-wide sub-sampler singleton, created lazily so a `reportUsageSampleOnce`
 * call in a test (or before `startUsageReporter` has run) can still drain a
 * (empty) aggregate without requiring the 60s timer to have been started.
 * `startUsageReporter`/`stopUsageReporter` own start()/stop(); the tick only drains.
 */
let machineMetricsSampler: MachineMetricsSampler | null = null
let coreMetricsSampler: MachineMetricsSampler | null = null

function getMachineMetricsSampler(): MachineMetricsSampler {
  if (!machineMetricsSampler) {
    machineMetricsSampler = createMachineMetricsSampler({
      exec: (command: string) => execOnPinnedPrimaryMachine(command),
    })
  }
  return machineMetricsSampler
}

async function execLocal(command: string): Promise<string> {
  const proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => proc.kill(), 10_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) throw new Error(`local metrics sample failed (exit ${exitCode}): ${stderr.trim()}`)
    return stdout
  } finally {
    clearTimeout(timeout)
  }
}

function getCoreMetricsSampler(): MachineMetricsSampler {
  if (!coreMetricsSampler) {
    coreMetricsSampler = createMachineMetricsSampler({
      exec: execLocal,
      command: buildCombinedSampleCommand('/'),
    })
  }
  return coreMetricsSampler
}

/** The four independent count queries behind {@link countInstanceActivity}, injectable for testing per-key failure isolation. */
export interface InstanceActivityDeps {
  countAgentsAlive: () => Promise<number>
  countBoxesTotal: () => Promise<number>
  countSquadsTotal: () => Promise<number>
  countExecutionsActive: () => Promise<number>
}

function defaultInstanceActivityDeps(): InstanceActivityDeps {
  return {
    // "Alive" = non-terminated, the existing vocabulary (see machine-health.ts's
    // isOwnerTerminated is status-based; timestamps are audit-only.
    countAgentsAlive: () => Agent.count({ live: true }),
    countBoxesTotal: async () => {
      // `::int` cast (matches agent-queries.ts's countAgents) rather than a
      // bare `count(*)` + runtime `Number(...)`: postgres.js already returns
      // a genuine JS number for the cast result, so there's nothing to coerce.
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(machineBoxes)
      return row?.count ?? 0
    },
    countSquadsTotal: async () => {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(squads)
      return row?.count ?? 0
    },
    countExecutionsActive: async () => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executions)
        .where(inArray(executions.status, ['queued', 'running']))
      return row?.count ?? 0
    },
  }
}

/**
 * This instance's activity snapshot for the `metrics` block: non-terminated
 * agents, total boxes/squads, and in-flight executions. Each count is its
 * OWN independent query — a single query failing (a locked table, a bad
 * connection) omits THAT key while the rest of the snapshot (and the rest of
 * the usage sample) still reports, matching the "omit the keys, never send
 * zero" discipline used throughout this module.
 */
export async function countInstanceActivity(
  overrides: Partial<InstanceActivityDeps> = {}
): Promise<Pick<UsageMetricsBlock, 'agentsAlive' | 'boxesTotal' | 'squadsTotal' | 'executionsActive'>> {
  const deps = { ...defaultInstanceActivityDeps(), ...overrides }

  async function countOr(label: string, fn: () => Promise<number>): Promise<number | undefined> {
    try {
      return await fn()
    } catch (err) {
      log.warn(`Platform usage activity count (${label}) failed (omitting this key):`, err)
      return undefined
    }
  }

  const [agentsAlive, boxesTotal, squadsTotal, executionsActive] = await Promise.all([
    countOr('agentsAlive', deps.countAgentsAlive),
    countOr('boxesTotal', deps.countBoxesTotal),
    countOr('squadsTotal', deps.countSquadsTotal),
    countOr('executionsActive', deps.countExecutionsActive),
  ])

  const counts: Pick<UsageMetricsBlock, 'agentsAlive' | 'boxesTotal' | 'squadsTotal' | 'executionsActive'> = {}
  if (agentsAlive !== undefined) counts.agentsAlive = agentsAlive
  if (boxesTotal !== undefined) counts.boxesTotal = boxesTotal
  if (squadsTotal !== undefined) counts.squadsTotal = squadsTotal
  if (executionsActive !== undefined) counts.executionsActive = executionsActive
  return counts
}

/** Join the configured base URL (with or without a trailing slash) to the ingest path. */
export function buildIngestEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/ingest/usage`
}

/** Token resolution: secret-store override, falling back to the raw env var (same pattern as services/github/api-client.ts's githubApiGet). */
function resolveUsageToken(): string | undefined {
  return getSecretStore().get('FICUS_PLATFORM_USAGE_TOKEN') ?? process.env.FICUS_PLATFORM_USAGE_TOKEN
}

export interface ReportUsageSampleDeps {
  listMachines: () => Promise<Machine[]>
  countUsers: () => Promise<number>
  fetch: typeof fetch
  now: () => Date
  ingestUrl: string | undefined
  getToken: () => string | undefined
  getVersion: () => Promise<BuildVersion | null>
  /**
   * Sample the fleet's disk usage for the payload's `diskUsedGb`/
   * `diskTotalGb`. Takes the already-listed `machines` (no second DB round
   * trip) and resolves `null` for "no report this tick" — no ready machine,
   * or the SSH sample failed. Default: {@link pickPrimaryMachineForDiskReport}
   * + machine-health.ts's `sampleMachineDiskUsage` over the real SSH runner.
   */
  sampleDisk: (machines: Machine[]) => Promise<{ usedGb: number; totalGb: number } | null>
  /**
   * Pin the metrics sub-sampler's exec target for the window until the next
   * tick to `machine` (`undefined` = unpin — no ready machine this tick).
   * Called EXACTLY ONCE per tick, with the SAME {@link pickPrimaryMachineForDiskReport}
   * pick the disk sample uses on the SAME `machines` snapshot — never
   * per-sub-sample — so `metrics` and `diskUsedGb`/`diskTotalGb` can never
   * describe different hosts even if the ready-machine set drifts between
   * ticks (e.g. mid-resize). Default: sets the module-level
   * {@link pinnedPrimaryMachine} the sub-sampler's exec seam reads.
   */
  pinMetricsMachine: (machine: Machine | undefined) => void
  /**
   * Aggregate + clear this process's 60s machine-metrics sub-sample ring for
   * the payload's `metrics` block (load/CPU/mem/disk over the report
   * window). Synchronous, mirroring {@link MachineMetricsSampler.drain} —
   * never throws in production (drain() itself can't), but the seam may be
   * overridden with a throwing fake, and the tick wraps the call in its own
   * try/catch regardless. Default: the singleton {@link getMetricsSampler}'s
   * `drain()`.
   */
  drainMachineMetrics: () => MachineMetricsAggregate
  /** Aggregate + clear the local core VM sampler independently. */
  drainCoreMetrics: () => MachineMetricsAggregate
  /**
   * This instance's activity counts for `metrics` (see
   * {@link countInstanceActivity}). Its own try/catch in the tick — same
   * reasoning as `sampleDisk`: a DB hiccup here must not cost the rest of the
   * sample (notably `userCount`, which carries seat billing).
   */
  countActivity: () => Promise<
    Pick<UsageMetricsBlock, 'agentsAlive' | 'boxesTotal' | 'squadsTotal' | 'executionsActive'>
  >
}

function defaultDeps(): ReportUsageSampleDeps {
  return {
    listMachines: listMachinesQuery,
    countUsers: () => User.countActive(),
    fetch,
    now: () => new Date(),
    ingestUrl: process.env.FICUS_PLATFORM_INGEST_URL,
    getToken: resolveUsageToken,
    getVersion: () => getBuildVersion(),
    sampleDisk: (machines: Machine[]) => {
      const primary = pickPrimaryMachineForDiskReport(machines)
      return primary ? sampleMachineDiskUsage(primary) : Promise.resolve(null)
    },
    pinMetricsMachine: (machine: Machine | undefined) => {
      pinnedPrimaryMachine = machine ?? null
    },
    drainMachineMetrics: () => getMachineMetricsSampler().drain(),
    drainCoreMetrics: () => getCoreMetricsSampler().drain(),
    countActivity: () => countInstanceActivity(),
  }
}

/**
 * Run one sample: read the fleet, POST it to the platform, and swallow any
 * failure as a `warn` log. Never throws — see the module doc for why.
 */
export async function reportUsageSampleOnce(overrides: Partial<ReportUsageSampleDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides }
  if (!deps.ingestUrl) return // gated off; startUsageReporter already logged this at start

  try {
    const machines = await deps.listMachines()
    // Same try/catch as the machine sample: a count-query hiccup swallows the
    // whole tick as a warn (never throws) rather than reporting a partial or
    // stale payload — the next 5-minute tick retries.
    const userCount = await deps.countUsers()
    // Cached after the first tick (see getBuildVersion); a null answer omits
    // the version fields rather than failing the sample.
    const version = await deps.getVersion()
    // Deliberately its OWN try/catch, unlike userCount above: a disk-sample
    // hiccup (unreachable primary, SSH timeout) must NOT abort the whole
    // tick — the rest of the payload (machines, userCount, version) still
    // has value and should still be reported. sampleMachineDiskUsage already
    // swallows real SSH failures internally and resolves null; this guards
    // the seam itself (e.g. an overridden sampleDisk that throws).
    let disk: { usedGb: number; totalGb: number } | null = null
    try {
      disk = await deps.sampleDisk(machines)
    } catch (err) {
      log.warn('Platform disk-usage sample failed (reporting the rest of the sample without it):', err)
    }
    // Pin the sub-sampler's exec target to the SAME primary the disk sample
    // above just used — resolved ONCE here, from THIS tick's `machines`, via
    // the identical pickPrimaryMachineForDiskReport pick sampleDisk made
    // internally (a pure function of the same input, so both resolutions
    // agree). Never re-derived per 60s sub-sample — see pinMetricsMachine's
    // doc for why that mattered. Pure/synchronous; nothing to catch.
    deps.pinMetricsMachine(pickPrimaryMachineForDiskReport(machines))
    // Same isolation as disk above, split into TWO independent try/catches
    // (not one): a sub-sampler hiccup and an activity-count hiccup are
    // unrelated failure modes, and one must not cost the other's half of the
    // `metrics` block. Merged into one object; buildUsagePayload omits the
    // whole `metrics` key only if BOTH halves came back empty.
    let metrics: UsageMetricsBlock = {}
    try {
      metrics = { ...metrics, ...deps.drainMachineMetrics() }
    } catch (err) {
      log.warn('Platform machine-metrics sub-sample drain failed (reporting the rest of the sample without it):', err)
    }
    try {
      metrics = { ...metrics, ...(await deps.countActivity()) }
    } catch (err) {
      log.warn('Platform instance-activity count failed (reporting the rest of the sample without it):', err)
    }
    let coreMetrics: UsageMetricsBlock = {}
    try {
      coreMetrics = deps.drainCoreMetrics()
    } catch (err) {
      log.warn('Platform core-metrics sub-sample drain failed (reporting the rest of the sample without it):', err)
    }
    const payload = buildUsagePayload(machines, userCount, deps.now(), version, disk, metrics, coreMetrics)
    const token = deps.getToken()
    const res = await deps.fetch(buildIngestEndpoint(deps.ingestUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token ?? ''}`,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      log.warn(`Platform usage ingest rejected the sample: ${res.status} ${res.statusText}`)
    }
  } catch (err) {
    // Network error, DNS failure, JSON serialization, etc. — never let a
    // reporting hiccup affect this instance; the next tick retries.
    log.warn('Platform usage ingest failed:', err)
  }
}

let runner: PeriodicRunner | null = null

/**
 * Start the `platform-usage-reporter` subsystem. No-op (one log line, no
 * runner) when `FICUS_PLATFORM_INGEST_URL` is unset — the common case for a
 * self-hosted instance the platform never provisioned.
 */
export function startUsageReporter(): void {
  if (!process.env.FICUS_PLATFORM_INGEST_URL) {
    log.info('FICUS_PLATFORM_INGEST_URL not configured — platform usage reporter disabled')
    return
  }
  if (runner) return

  // Own 60s cadence, independent of the 5-minute report tick — drained by
  // the tick above, never by this loop itself.
  getMachineMetricsSampler().start()
  getCoreMetricsSampler().start()

  runner = createPeriodicRunner({
    name: 'platform-usage-reporter',
    intervalMs: REPORT_INTERVAL_MS,
    runImmediately: true,
    task: () => reportUsageSampleOnce(),
  })
  runner.start()
  log.info(`platform-usage-reporter started (interval ${REPORT_INTERVAL_MS}ms)`)
}

/** Stop the subsystem. No-op when not started. */
export async function stopUsageReporter(): Promise<void> {
  if (machineMetricsSampler) machineMetricsSampler.stop()
  if (coreMetricsSampler) coreMetricsSampler.stop()
  if (!runner) return
  await runner.stop()
  runner = null
}
