/**
 * Leftover processes: what an agent's commands left running in this box after
 * the command itself returned (a dev server or test database started in the
 * background so the tool call could finish), and a graceful way to stop them
 * when the work they belonged to is over.
 *
 * Every bash request that names its agent (`owner`) is recorded here with the
 * work stream and flow attempt Core sent with it. Nothing ties a background
 * process to its agent once its shell exits and it is reparented, so the record
 * keeps the link:
 *   - on a box with workload cgroups (workload-cgroup.ts) the invocation's own
 *     `workload/inv-<id>` leaf holds everything the command started, even a
 *     process that called setsid or daemonized;
 *   - elsewhere (k8s, Docker, units provisioned before delegation) the command's
 *     process session does: each command runs as its own session leader, and
 *     its children stay in that session unless they call setsid themselves.
 *
 * Core asks the box to stop an agent's leftovers when its flow attempt ends,
 * when the agent goes dormant, and when its work stream is done or canceled
 * (`POST /processes/leftovers/stop`). A stop is SIGTERM, then SIGKILL for what
 * is still running after a short grace period.
 *
 * What is never stopped:
 *   - a command that is still running (its tool call has not returned);
 *   - commands without an owner (Core's own housekeeping), and everything
 *     outside an agent command's leaf or session: managed apps, monitors and
 *     the tmux server run in their own leaves and sessions;
 *   - the server itself and its ancestors;
 *   - a process started with `FICUS_KEEP_RUNNING=1` in its environment (and
 *     its children, which inherit it): the explicit opt-out for a service an
 *     agent means to keep;
 *   - a process whose environment cannot be read, since the opt-out cannot be
 *     checked.
 */

import { readFile } from 'node:fs/promises'
import type { ProcessIdentity } from './process-session'
import { processSessionDriver } from './process-session'
import { summarizeCommand, type WorkloadCgroups } from './workload-cgroup'

/** The opt-out: a process whose environment sets this to 1 is never stopped automatically. */
export const KEEP_RUNNING_ENV = 'FICUS_KEEP_RUNNING'
/** SIGTERM first; what is still running after this is killed. */
export const LEFTOVER_STOP_GRACE_MS = 5_000
/** How long to wait for SIGKILL to take effect before reporting a survivor. */
const KILL_CONFIRM_MS = 2_000
const POLL_MS = 50
/**
 * Past this many remembered invocations, finished ones verified to have left
 * nothing running are forgotten, oldest first. One with a live leftover is
 * never forgotten for space: it is what a later stop must find.
 */
export const MAX_TRACKED = 2_000

/** Who started a command, as Core sent it with the bash request. */
export interface ProcessOwnership {
  agentId: string
  workStreamId?: string
  attemptId?: number
}

/**
 * Which leftovers to act on. Every field given must match. A selector must
 * name an agent or a work stream, so an empty selector never matches every
 * agent's processes.
 */
export interface LeftoverSelector {
  agentId?: string
  workStreamId?: string
  attemptId?: number
}

/** Why Core asked for the stop; Core tells the owning agent in words (its inbox message). */
export const LEFTOVER_STOP_REASONS = ['attempt-ended', 'agent-dormant', 'stream-finished'] as const
export type LeftoverStopReason = (typeof LEFTOVER_STOP_REASONS)[number]

/** One finished command's processes that are still running. */
export interface LeftoverGroup {
  invocationId: string
  agentId: string
  workStreamId?: string
  attemptId?: number
  /** A single-line excerpt of the command that started them. */
  command: string
  startedAt: string
  /** Processes an automatic stop would end. */
  pids: number[]
  /** Processes kept by the opt-out (or whose environment could not be read). */
  keptPids: number[]
}

export interface StoppedLeftoverGroup extends LeftoverGroup {
  /** Processes that ignored SIGTERM for the grace period and were killed. */
  killedPids: number[]
  /** Processes still running after SIGKILL (should not happen; reported, never hidden). */
  survivingPids: number[]
}

export interface LeftoverStopResult {
  reason: LeftoverStopReason
  stopped: StoppedLeftoverGroup[]
  /** Groups whose every remaining process is kept. */
  kept: LeftoverGroup[]
}

export class LeftoverSelectorError extends Error {}

export interface LeftoverBackend {
  readIdentity(pid: number): Promise<ProcessIdentity | undefined>
  scanSession(sid: number): Promise<ProcessIdentity[]>
  /** Processes in an invocation's workload leaf; undefined without one. */
  leafPids(invocationId: string): Promise<number[] | undefined>
  /**
   * The process environment (NUL-separated); null when the process is gone,
   * undefined when it exists but its environment cannot be read.
   */
  readEnviron(pid: number): Promise<string | null | undefined>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
  /** The server and its ancestors: never candidates. */
  protectedPids(): Promise<Set<number>>
}

interface Entry {
  invocationId: string
  ownership: ProcessOwnership
  command: string
  startedAt: string
  /** The command's session leader, as admitted. */
  leader: ProcessIdentity
  /** Its processes are tracked by its workload leaf rather than its session. */
  inLeaf: boolean
  /** Its command is still running: nothing of it is a leftover yet. */
  attached: boolean
}

interface Candidate {
  identity: ProcessIdentity
  kept: boolean
}

function startTicks(identity: Pick<ProcessIdentity, 'startToken'>): number | undefined {
  const match = /^linux:(\d+)$/.exec(identity.startToken)
  return match ? Number(match[1]) : undefined
}

function sameProcess(left: ProcessIdentity | undefined, right: ProcessIdentity): boolean {
  return Boolean(left && left.pid === right.pid && left.startToken === right.startToken)
}

function matches(entry: Entry, selector: LeftoverSelector): boolean {
  if (selector.agentId !== undefined && entry.ownership.agentId !== selector.agentId) return false
  if (selector.workStreamId !== undefined && entry.ownership.workStreamId !== selector.workStreamId) return false
  if (selector.attemptId !== undefined && entry.ownership.attemptId !== selector.attemptId) return false
  return true
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/** A selector from an untrusted request body. Throws LeftoverSelectorError. */
export function parseLeftoverSelector(value: unknown): LeftoverSelector {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const selector: LeftoverSelector = {}
  if (raw.agentId !== undefined) {
    if (typeof raw.agentId !== 'string' || !ID_PATTERN.test(raw.agentId))
      throw new LeftoverSelectorError('agentId must be an id')
    selector.agentId = raw.agentId
  }
  if (raw.workStreamId !== undefined) {
    if (typeof raw.workStreamId !== 'string' || !ID_PATTERN.test(raw.workStreamId))
      throw new LeftoverSelectorError('workStreamId must be an id')
    selector.workStreamId = raw.workStreamId
  }
  if (raw.attemptId !== undefined) {
    if (typeof raw.attemptId !== 'number' || !Number.isSafeInteger(raw.attemptId) || raw.attemptId < 1)
      throw new LeftoverSelectorError('attemptId must be a positive integer')
    selector.attemptId = raw.attemptId
  }
  if (selector.agentId === undefined && selector.workStreamId === undefined)
    throw new LeftoverSelectorError('a selector must name an agentId or a workStreamId')
  return selector
}

export function parseLeftoverStopReason(value: unknown): LeftoverStopReason {
  if (typeof value === 'string' && (LEFTOVER_STOP_REASONS as readonly string[]).includes(value))
    return value as LeftoverStopReason
  throw new LeftoverSelectorError(`reason must be one of ${LEFTOVER_STOP_REASONS.join(', ')}`)
}

/** Ownership from a bash request body; undefined without a usable agent id. */
export function requestOwnership(body: {
  owner?: unknown
  workStreamId?: unknown
  attemptId?: unknown
}): ProcessOwnership | undefined {
  if (typeof body.owner !== 'string' || !ID_PATTERN.test(body.owner)) return undefined
  const ownership: ProcessOwnership = { agentId: body.owner }
  if (typeof body.workStreamId === 'string' && ID_PATTERN.test(body.workStreamId))
    ownership.workStreamId = body.workStreamId
  if (typeof body.attemptId === 'number' && Number.isSafeInteger(body.attemptId) && body.attemptId > 0)
    ownership.attemptId = body.attemptId
  return ownership
}

export class LeftoverProcesses {
  private readonly entries = new Map<string, Entry>()
  private pruning: Promise<void> | undefined

  constructor(
    private readonly backend: LeftoverBackend,
    private readonly log: (message: string) => void = (message) => console.log(`[sandbox] ${message}`),
    private readonly graceMs = LEFTOVER_STOP_GRACE_MS
  ) {}

  /** Remember an admitted, owned command. Unowned commands are never recorded. */
  record(
    invocationId: string,
    ownership: ProcessOwnership | undefined,
    command: string,
    leader: ProcessIdentity,
    inLeaf: boolean,
    now = new Date()
  ): void {
    if (!ownership) return
    this.entries.delete(invocationId)
    this.entries.set(invocationId, {
      invocationId,
      ownership,
      command: summarizeCommand(command),
      startedAt: now.toISOString(),
      leader,
      inLeaf,
      attached: true,
    })
    if (this.entries.size > MAX_TRACKED) void this.prune()
  }

  /**
   * The command returned; what it left running is now a leftover. A command
   * that left nothing running is forgotten at once (one leaf read or session
   * scan), so the record holds only the few commands that left something.
   * Never rejects.
   */
  async detach(invocationId: string): Promise<void> {
    const entry = this.entries.get(invocationId)
    if (!entry) return
    entry.attached = false
    try {
      if ((await this.candidates(entry)).length === 0 && this.entries.get(invocationId) === entry)
        this.entries.delete(invocationId)
    } catch (error) {
      // Kept: a later list or stop looks again.
      this.log(`WARN: could not check what invocation ${invocationId} left running: ${(error as Error).message}`)
    }
  }

  /** Forget finished entries verified empty, oldest first, until back under MAX_TRACKED. */
  private prune(): Promise<void> {
    this.pruning ??= (async () => {
      try {
        const protectedPids = await this.backend.protectedPids()
        for (const entry of [...this.entries.values()]) {
          if (this.entries.size <= MAX_TRACKED) break
          if (entry.attached) continue
          if ((await this.candidates(entry, protectedPids)).length === 0) this.entries.delete(entry.invocationId)
        }
      } catch (error) {
        this.log(`WARN: could not prune the leftover record: ${(error as Error).message}`)
      } finally {
        this.pruning = undefined
      }
    })()
    return this.pruning
  }

  /** Test seam: the number of remembered invocations. */
  get trackedCount(): number {
    return this.entries.size
  }

  /** Leftovers still running, optionally only those matching `selector`. Forgets finished ones. */
  async list(selector?: LeftoverSelector): Promise<LeftoverGroup[]> {
    const groups: LeftoverGroup[] = []
    const protectedPids = await this.backend.protectedPids()
    for (const entry of [...this.entries.values()]) {
      if (entry.attached || (selector && !matches(entry, selector))) continue
      const candidates = await this.candidates(entry, protectedPids)
      if (candidates.length === 0) {
        this.entries.delete(entry.invocationId)
        continue
      }
      groups.push(this.group(entry, candidates))
    }
    return groups
  }

  /**
   * Stop the leftovers matching `selector`: SIGTERM, then SIGKILL after the
   * grace period. Logs every stop; Core tells each owning agent.
   */
  async stop(selector: LeftoverSelector, reason: LeftoverStopReason): Promise<LeftoverStopResult> {
    if (selector.agentId === undefined && selector.workStreamId === undefined)
      throw new LeftoverSelectorError('a selector must name an agentId or a workStreamId')
    const targets: Array<{ entry: Entry; candidates: Candidate[] }> = []
    const kept: LeftoverGroup[] = []
    const protectedPids = await this.backend.protectedPids()
    for (const entry of [...this.entries.values()]) {
      if (entry.attached || !matches(entry, selector)) continue
      const candidates = await this.candidates(entry, protectedPids)
      if (candidates.length === 0) {
        this.entries.delete(entry.invocationId)
      } else if (candidates.every((candidate) => candidate.kept)) {
        kept.push(this.group(entry, candidates))
      } else {
        targets.push({ entry, candidates })
      }
    }
    if (targets.length === 0) return { reason, stopped: [], kept }

    const victims = targets.flatMap(({ candidates }) => candidates.filter((c) => !c.kept).map((c) => c.identity))
    await this.signalAll(victims, 'SIGTERM')
    let alive = await this.waitForExit(victims, this.graceMs)
    const killed = new Set(alive.map((identity) => identity.pid))
    if (alive.length > 0) {
      await this.signalAll(alive, 'SIGKILL')
      alive = await this.waitForExit(alive, KILL_CONFIRM_MS)
    }
    const surviving = new Set(alive.map((identity) => identity.pid))

    const stopped: StoppedLeftoverGroup[] = []
    for (const { entry, candidates } of targets) {
      const group = this.group(entry, candidates)
      const result: StoppedLeftoverGroup = {
        ...group,
        killedPids: group.pids.filter((pid) => killed.has(pid) && !surviving.has(pid)),
        survivingPids: group.pids.filter((pid) => surviving.has(pid)),
      }
      stopped.push(result)
      // Rescan before forgetting it: a child forked during the grace period stays tracked.
      if (
        group.keptPids.length === 0 &&
        result.survivingPids.length === 0 &&
        (await this.candidates(entry, protectedPids)).length === 0
      )
        this.entries.delete(entry.invocationId)
      this.log(
        `Stopped leftover processes (${reason}) of agent ${entry.ownership.agentId}` +
          `${entry.ownership.workStreamId ? ` stream ${entry.ownership.workStreamId}` : ''}` +
          `${entry.ownership.attemptId ? ` attempt ${entry.ownership.attemptId}` : ''}` +
          `: pids ${group.pids.join(',')}${result.killedPids.length ? ` (killed after grace: ${result.killedPids.join(',')})` : ''}` +
          `${result.survivingPids.length ? ` (still running: ${result.survivingPids.join(',')})` : ''}` +
          `${group.keptPids.length ? ` (kept: ${group.keptPids.join(',')})` : ''} from \`${entry.command}\``
      )
    }
    return { reason, stopped, kept }
  }

  /** Ownership of each live leftover process by pid (for the process list). */
  async attribution(): Promise<Map<number, LeftoverGroup>> {
    const byPid = new Map<number, LeftoverGroup>()
    for (const group of await this.list()) {
      for (const pid of [...group.pids, ...group.keptPids]) byPid.set(pid, group)
    }
    return byPid
  }

  private group(entry: Entry, candidates: Candidate[]): LeftoverGroup {
    return {
      invocationId: entry.invocationId,
      agentId: entry.ownership.agentId,
      ...(entry.ownership.workStreamId ? { workStreamId: entry.ownership.workStreamId } : {}),
      ...(entry.ownership.attemptId ? { attemptId: entry.ownership.attemptId } : {}),
      command: entry.command,
      startedAt: entry.startedAt,
      pids: candidates.filter((c) => !c.kept).map((c) => c.identity.pid),
      keptPids: candidates.filter((c) => c.kept).map((c) => c.identity.pid),
    }
  }

  /** The command's processes that are still running, each with its opt-out state. */
  private async candidates(entry: Entry, protectedPidsHint?: Set<number>): Promise<Candidate[]> {
    const protectedPids = protectedPidsHint ?? (await this.backend.protectedPids())
    let identities: ProcessIdentity[]
    if (entry.inLeaf) {
      const pids = (await this.backend.leafPids(entry.invocationId)) ?? []
      identities = []
      for (const pid of pids) {
        const identity = await this.backend.readIdentity(pid)
        if (identity) identities.push(identity)
      }
    } else {
      // A session id is the leader's pid. If that pid now names a different
      // process, the session is no longer this command's: leave it alone.
      const leader = await this.backend.readIdentity(entry.leader.pid)
      if (leader && !sameProcess(leader, entry.leader)) return []
      const leaderStart = startTicks(entry.leader)
      identities = (await this.backend.scanSession(entry.leader.sid)).filter((identity) => {
        const started = startTicks(identity)
        return leaderStart === undefined || started === undefined || started >= leaderStart
      })
    }
    const candidates: Candidate[] = []
    for (const identity of identities) {
      if (identity.pid <= 1 || identity.state === 'Z' || protectedPids.has(identity.pid)) continue
      const environ = await this.backend.readEnviron(identity.pid)
      if (environ === null) continue
      const kept = environ === undefined || environ.split('\0').includes(`${KEEP_RUNNING_ENV}=1`)
      candidates.push({ identity, kept })
    }
    return candidates
  }

  private async signalAll(identities: ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    for (const identity of identities) {
      // Re-read right before signalling, so a reused pid is never hit.
      if (!sameProcess(await this.backend.readIdentity(identity.pid), identity)) continue
      try {
        this.backend.signal(identity.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          this.log(`WARN: could not send ${signal} to leftover pid ${identity.pid}: ${(error as Error).message}`)
      }
    }
  }

  /** Those of `identities` still running after up to `timeoutMs`. */
  private async waitForExit(identities: ProcessIdentity[], timeoutMs: number): Promise<ProcessIdentity[]> {
    const deadline = Date.now() + timeoutMs
    let alive = identities
    while (true) {
      const next: ProcessIdentity[] = []
      for (const identity of alive) {
        const current = await this.backend.readIdentity(identity.pid)
        // A zombie has exited; its parent has not reaped it yet.
        if (sameProcess(current, identity) && current!.state !== 'Z') next.push(identity)
      }
      alive = next
      if (alive.length === 0 || Date.now() >= deadline) return alive
      await this.backend.sleep(POLL_MS)
    }
  }
}

/** The ancestors of `pid` (inclusive), read from /proc. */
async function ancestry(pid: number): Promise<Set<number>> {
  const chain = new Set<number>()
  let current = pid
  for (let depth = 0; current > 1 && depth < 64 && !chain.has(current); depth++) {
    chain.add(current)
    const stat = await readFile(`/proc/${current}/stat`, 'utf8').catch(() => '')
    const close = stat.lastIndexOf(')')
    if (close < 0) break
    current = Number(stat.slice(close + 2).split(' ')[1])
  }
  return chain
}

export function linuxLeftoverBackend(workloads: () => WorkloadCgroups | null): LeftoverBackend {
  return {
    readIdentity: (pid) => processSessionDriver.readIdentity(pid),
    scanSession: (sid) => processSessionDriver.scanSessionIdentities(sid),
    leafPids: async (invocationId) => workloads()?.leafPids(invocationId),
    readEnviron: (pid) =>
      readFile(`/proc/${pid}/environ`, 'utf8').catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' || error.code === 'ESRCH' ? null : undefined
      ),
    signal: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    protectedPids: () => ancestry(process.pid),
  }
}
