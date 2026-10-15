import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  WORK_STREAM_ADMITTED_STATUSES,
  isStackedDependencyEdge,
  resolveCodeHostReference,
  workStreamTitle,
  type WorkStreamDependencyStackState,
} from '@ficus/shared'
import { db } from '../../db'
import { workStreams, type integrationOutputEvents } from '../../db/schema'
import { deliveryPullRequestHead } from './delivery-pull-requests'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import {
  claimStackDecisions,
  markStackRetrying,
  patchEdgeStack,
  settleStackClaim,
  type DependencyEdges,
} from './dependency-edges'
import { fetchRemoteBranchToRef, type RepositoryExec, type ResolveGitHubToken } from './repository-setup'

/**
 * Stacking for streams unlocked by a `ready` dependency.
 *
 * When such a stream is admitted while the dependency is still unmerged and
 * both are code-producing in the same repository, the stream's branch is built
 * on the dependency's pushed branch head. The platform only ever moves the
 * dependent's own clean, never-started branch; a branch with commits or a
 * dirty worktree is left exactly as it is and the assignee is told to merge
 * the dependency branch in. The dependency's branch and worktree are never
 * touched.
 *
 * The decision is recorded once per edge (`dependencyEdges[id].stack`), and is
 * what the delivery hold and the change/merged/canceled notices key on.
 */

const log = createLogger('work-stream-stacking')

type StackDecision = WorkStreamDependencyStackState
type GitMetadata = {
  repository?: unknown
  worktree?: unknown
  branch?: unknown
  remote?: unknown
  baseCommit?: unknown
}

export interface StackingRuntime {
  /** Runs a command in the dependent squad's runtime. */
  exec: RepositoryExec
  resolveGitHubToken?: ResolveGitHubToken
}
export type ResolveStackingRuntime = (squadId: string) => Promise<StackingRuntime>

let runtimeForTest: ResolveStackingRuntime | undefined

/** Test-only: replace the squad sandbox with an owned fixture runtime. */
export function setStackingRuntimeForTest(resolve?: ResolveStackingRuntime): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Stacking runtime override is test-only')
  runtimeForTest = resolve
}

const squadRuntime: ResolveStackingRuntime = async (squadId) => {
  const { ensureSquadSandbox } = await import('../sandbox/ensure')
  const { getSandboxManager } = await import('../sandbox/factory')
  const { Squad } = await import('../../entities/Squad')
  await ensureSquadSandbox(squadId)
  const manager = getSandboxManager()
  return {
    exec: async (args, options) => (await manager.exec(Squad.getSandboxId(squadId), args, options)).toString(),
    // Same authority as remote-base provisioning: the squad's default GitHub assignment.
    resolveGitHubToken: async () => {
      const { resolveGitHubConnection } = await import('../integrations/github/resolve-connection')
      return (await resolveGitHubConnection(squadId))?.credential.accessToken
    },
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
const gitOf = (metadata: unknown): GitMetadata => ((metadata as { git?: GitMetadata } | null)?.git ?? {}) as GitMetadata

/** Both streams deliver to the same repository. */
export function sameRepository(dependent: unknown, dependency: unknown): boolean {
  const a = resolveCodeHostReference(dependent)
  const b = resolveCodeHostReference(dependency)
  if (a && b) return a.integration === b.integration && a.repository.toLowerCase() === b.repository.toLowerCase()
  const ga = gitOf(dependent)
  const gb = gitOf(dependency)
  return (
    !!text(ga.repository) &&
    ga.repository === gb.repository &&
    (text(ga.remote) ?? 'origin') === (text(gb.remote) ?? 'origin')
  )
}

export interface StackCandidate {
  /** Dependency work stream ID. */
  id: string
  branch: string
}

/**
 * Build the dependent's branch on its unmerged dependencies, or decide not to.
 *
 * With several dependencies the branch is stacked on one of them only when
 * every other one is an ancestor of it (so that single head carries them all);
 * otherwise nothing is rewritten. The dependent's branch moves only when its
 * worktree is clean and the branch has no commits of its own, and only with
 * `reset --keep`, which refuses rather than discard anything.
 */
export async function stackOntoDependencies(
  runtime: StackingRuntime,
  input: {
    repository: string
    worktree: string
    branch: string
    remote: string
    /** The commit the branch was provisioned from, when known. */
    baseCommit?: string
    candidates: StackCandidate[]
  }
): Promise<Record<string, StackDecision>> {
  const { exec } = runtime
  const decidedAt = new Date().toISOString()
  const git = (...args: string[]) => exec(['git', '-C', input.repository, ...args]).then((out) => out.trim())
  const at = (...args: string[]) => exec(['git', '-C', input.worktree, ...args]).then((out) => out.trim())
  const succeeds = (run: Promise<unknown>) =>
    run.then(
      () => true,
      () => false
    )
  const heads = new Map<string, string>()
  const refs: string[] = []
  const all = (mode: 'stacked' | 'included' | 'manual', reason?: string, base?: string) =>
    Object.fromEntries(
      input.candidates.map((candidate): [string, StackDecision] => [
        candidate.id,
        {
          mode: mode === 'stacked' && candidate.id !== base ? 'included' : mode,
          decidedAt,
          branch: candidate.branch,
          ...(heads.has(candidate.id) ? { headSha: heads.get(candidate.id)! } : {}),
          ...(reason ? { reason } : {}),
        },
      ])
    )
  try {
    const fetchUrl = await git('remote', 'get-url', input.remote)
    for (const candidate of input.candidates) {
      const ref = `refs/ficus/stacking/${crypto.randomUUID()}`
      refs.push(ref)
      try {
        await git('check-ref-format', '--branch', candidate.branch)
        await fetchRemoteBranchToRef(exec, {
          repo: input.repository,
          remote: input.remote,
          fetchUrl,
          branch: candidate.branch,
          ref,
          resolveGitHubToken: runtime.resolveGitHubToken,
        })
        const head = await git('rev-parse', '--verify', `${ref}^{commit}`)
        if (/^[a-f0-9]{40,64}$/.test(head)) heads.set(candidate.id, head)
      } catch {
        // Git/transport errors can carry credential-bearing URLs: never surface them.
      }
    }
    const unfetched = input.candidates.filter((candidate) => !heads.has(candidate.id))
    if (unfetched.length > 0)
      return all(
        'manual',
        `could not fetch ${unfetched.map((candidate) => candidate.branch).join(', ')} from ${input.remote}`
      )

    let base: StackCandidate | undefined
    for (const candidate of input.candidates) {
      const head = heads.get(candidate.id)!
      let carriesAll = true
      for (const other of input.candidates) {
        const otherHead = heads.get(other.id)!
        if (other.id === candidate.id || otherHead === head) continue
        if (!(await succeeds(git('merge-base', '--is-ancestor', otherHead, head)))) {
          carriesAll = false
          break
        }
      }
      if (carriesAll) {
        base = candidate
        break
      }
    }
    if (!base)
      return all('manual', 'the dependency branches do not contain one another, so no single one can be the base')
    const target = heads.get(base.id)!

    if ((await at('symbolic-ref', '--short', 'HEAD')) !== input.branch)
      return all('manual', 'the worktree is not on this stream’s branch')
    if ((await at('status', '--porcelain')) !== '') return all('manual', 'the worktree has uncommitted changes')
    const head = await at('rev-parse', '--verify', 'HEAD^{commit}')
    if (head === target) return all('stacked', undefined, base.id)
    const fastForward = await succeeds(git('merge-base', '--is-ancestor', head, target))
    if (!fastForward) {
      if (!input.baseCommit || head !== input.baseCommit) return all('manual', 'the branch already has commits')
      // Moving sideways rewrites what a push already published.
      if (await succeeds(git('show-ref', '--verify', '--quiet', `refs/remotes/${input.remote}/${input.branch}`)))
        return all('manual', 'the branch was already pushed')
    }
    // --keep refuses instead of discarding a change that appeared since the check.
    await at('reset', '--keep', target)
    if ((await at('rev-parse', '--verify', 'HEAD^{commit}')) !== target)
      return all('manual', 'the branch could not be moved')
    return all('stacked', undefined, base.id)
  } catch {
    return all('manual', 'the branch could not be prepared automatically')
  } finally {
    for (const ref of refs) await succeeds(git('update-ref', '-d', ref))
  }
}

const admitted = (status: string) => (WORK_STREAM_ADMITTED_STATUSES as readonly string[]).includes(status)

/** A claim this old belongs to a decider that died; it may be taken over. */
const CLAIM_STALE_MS = 5 * 60_000
/** How long a caller waits for another decider before going on without it. */
const CLAIM_WAIT_MS = 60_000
/** After this long without a usable runtime, stop retrying and ask the assignee to merge. */
const RUNTIME_RETRY_WINDOW_MS = 10 * 60_000

type StackCandidateStream = { status: string; dependsOn: string[] | null; dependencyEdges: DependencyEdges | null }

/** Unlocked `ready` edges of an admitted stream with no stack decision, or only an abandoned claim. */
function undecidedStackIds(stream: StackCandidateStream, now = Date.now()): string[] {
  if (!admitted(stream.status)) return []
  const edges = stream.dependencyEdges ?? {}
  return (stream.dependsOn ?? []).filter((id) => {
    const edge = edges[id]
    if (edge?.condition !== 'ready' || !edge.readyUnlockedAt) return false
    return !edge.stack || (edge.stack.mode === 'pending' && now - Date.parse(edge.stack.decidedAt) >= CLAIM_STALE_MS)
  })
}

const beingDecided = (stream: StackCandidateStream, now = Date.now()) =>
  Object.values(stream.dependencyEdges ?? {}).some(
    (edge) => edge.stack?.mode === 'pending' && now - Date.parse(edge.stack.decidedAt) < CLAIM_STALE_MS
  )

const loadStackCandidate = async (streamId: string) =>
  (
    await db
      .select({
        status: workStreams.status,
        dependsOn: workStreams.dependsOn,
        dependencyEdges: workStreams.dependencyEdges,
      })
      .from(workStreams)
      .where(eq(workStreams.id, streamId))
  )[0]

/**
 * Decide, once per edge, how a stream admitted on `ready` dependencies relates
 * to their branches. Runs after admission commits and before participants are
 * dispatched.
 *
 * No transaction, lock or connection is held across the sandbox and Git work:
 * every statement here is a single pooled query. Concurrent deciders are
 * serialized by a claim written on the edges themselves (one guarded UPDATE);
 * the loser waits for the winner's decision, so a caller about to dispatch
 * never races a branch that is being moved. A claim whose holder died is taken
 * over once it is stale.
 */
export async function settleStackDecisions(streamId: string, resolveRuntime?: ResolveStackingRuntime): Promise<void> {
  const deadline = Date.now() + CLAIM_WAIT_MS
  for (;;) {
    const stream = await loadStackCandidate(streamId)
    if (!stream) return
    const undecided = undecidedStackIds(stream)
    if (undecided.length > 0) {
      const claimId = crypto.randomUUID()
      if (await claimStackDecisions(db, streamId, undecided, claimId, new Date(Date.now() - CLAIM_STALE_MS))) {
        const decisions: Record<string, StackDecision | null> = Object.fromEntries(undecided.map((id) => [id, null]))
        try {
          Object.assign(decisions, await decideStacks(streamId, undecided, resolveRuntime))
        } finally {
          // Every claim ends as a decision or is dropped for a later attempt; none is left behind.
          for (const [id, decision] of Object.entries(decisions))
            await settleStackClaim(db, streamId, id, claimId, decision)
        }
        await announceStackDecisions(streamId, decisions)
        return
      }
    } else if (!beingDecided(stream)) return
    // Another decider holds the claim: wait for it rather than dispatch into a moving branch.
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * The decision for edges this caller has claimed. `null` for an edge means "not decided this
 * time" (a dependency still pending, or a passing runtime outage): its claim is dropped.
 */
async function decideStacks(
  streamId: string,
  undecided: string[],
  resolveRuntime?: ResolveStackingRuntime
): Promise<Record<string, StackDecision | null>> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  if (!stream) return {}
  const edges: DependencyEdges = stream.dependencyEdges ?? {}
  const dependsOn = stream.dependsOn ?? []
  const dependencies = await db
    .select({ id: workStreams.id, status: workStreams.status, metadata: workStreams.metadata })
    .from(workStreams)
    .where(inArray(workStreams.id, dependsOn))
  const byId = new Map(dependencies.map((row) => [row.id, row]))
  // Decide with every dependency known: a stream still waiting on one is decided when that settles.
  // (An unlocked edge counts here even if its dependency was just canceled: that is decided below.)
  if (!dependsOn.every((id) => byId.get(id)?.status === 'done' || !!edges[id]?.readyUnlockedAt)) return {}

  const decidedAt = new Date().toISOString()
  const git = gitOf(stream.metadata)
  const decisions: Record<string, StackDecision | null> = {}
  const candidates: StackCandidate[] = []
  for (const id of undecided) {
    const dependency = byId.get(id)
    const branch = text(gitOf(dependency?.metadata).branch)
    if (dependency?.status === 'done')
      decisions[id] = { mode: 'none', decidedAt, reason: 'the dependency had already merged' }
    // Never build on abandoned work, whatever order the cancel and the admission landed in.
    else if (dependency?.status === 'canceled')
      decisions[id] = { mode: 'none', decidedAt, reason: 'the dependency was canceled', dependencyCanceled: true }
    else if (!text(git.branch)) decisions[id] = { mode: 'none', decidedAt, reason: 'this stream has no repository' }
    else if (!branch || !sameRepository(stream.metadata, dependency?.metadata))
      decisions[id] = { mode: 'none', decidedAt, reason: 'the dependency is in a different repository' }
    else candidates.push({ id, branch })
  }
  if (candidates.length > 0) {
    const repository = text(git.repository)
    const worktree = text(git.worktree)
    if (!repository || !worktree) {
      for (const candidate of candidates)
        decisions[candidate.id] = {
          mode: 'manual',
          decidedAt,
          branch: candidate.branch,
          reason: 'this stream has no platform-provisioned worktree',
        }
    } else {
      let stacked: Record<string, StackDecision | null>
      try {
        const runtime = await (resolveRuntime ?? runtimeForTest ?? squadRuntime)(stream.squadId)
        stacked = await stackOntoDependencies(runtime, {
          repository,
          worktree,
          branch: text(git.branch)!,
          remote: text(git.remote) ?? 'origin',
          ...(text(git.baseCommit) ? { baseCommit: text(git.baseCommit)! } : {}),
          candidates,
        })
      } catch (error) {
        log.warn(`Stacking runtime unavailable for work stream ${streamId}:`, error)
        // A passing outage must not turn a stackable branch into a manual merge for good:
        // leave the edges undecided for the reconciler, for a bounded time measured from
        // the first attempt that found no runtime (the unlock can be long before admission).
        const since = await markStackRetrying(
          db,
          streamId,
          candidates.map((candidate) => candidate.id)
        )
        const firstAttempt = Math.min(
          ...candidates.map((candidate) => Date.parse(since[candidate.id] ?? new Date().toISOString()))
        )
        const retry = Date.now() - firstAttempt < RUNTIME_RETRY_WINDOW_MS
        stacked = Object.fromEntries(
          candidates.map((candidate): [string, StackDecision | null] => [
            candidate.id,
            retry
              ? null
              : {
                  mode: 'manual',
                  decidedAt,
                  branch: candidate.branch,
                  reason: 'the squad runtime was unavailable',
                },
          ])
        )
      }
      Object.assign(decisions, stacked)
    }
  }

  return decisions
}

/** After the decisions are stored: record what the stream was built on, and tell who is already working. */
async function announceStackDecisions(streamId: string, decisions: Record<string, StackDecision | null>) {
  if (!Object.values(decisions).some(Boolean)) return
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  if (!stream) return
  const [baseId, base] = Object.entries(decisions).find(([, decision]) => decision?.mode === 'stacked') ?? []
  if (baseId && base?.mode === 'stacked' && base.headSha) {
    // The record the brief asks for: which branch and head this stream was built on.
    const stackedOn = { workStreamId: baseId, branch: base.branch, headSha: base.headSha, stackedAt: base.decidedAt }
    await db
      .update(workStreams)
      .set({
        metadata: sql`jsonb_set(${workStreams.metadata}, '{git,stackedOn}', ${JSON.stringify(stackedOn)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(and(eq(workStreams.id, streamId), sql`jsonb_typeof(${workStreams.metadata}->'git') = 'object'`))
  }
  eventEmitter.emit('workStream.updated', { workStreamId: streamId, squadId: stream.squadId })
  // A stream that already has an assignee (an edge added mid-work) hears it directly;
  // otherwise the first assignment carries the same notice.
  if (stream.assigneeAgentId && !stream.pause) {
    const { loadStackedDependencies, stackedDependencyNotice } = await import('./dependency-edges')
    const notice = stackedDependencyNotice(await loadStackedDependencies(db, stream), gitOf(stream.metadata))
    const decidedAt = Object.values(decisions).find(Boolean)!.decidedAt
    if (notice)
      await sendStackNotice(stream, stream.assigneeAgentId, 'stacked', decidedAt, {
        subject: `Stacked on a dependency: ${workStreamTitle(stream)}`,
        content: notice,
        steer: true,
      })
  }
  // Anything already owed, e.g. a dependency canceled before the decision landed.
  await deliverStackNotices([streamId])
}

/** Stacking must never fail the admission or creation that triggered it. */
export async function settleStackDecisionsSafely(streamId: string): Promise<void> {
  try {
    await settleStackDecisions(streamId)
  } catch (error) {
    log.warn(`Failed to settle stack decisions for work stream ${streamId}:`, error)
  }
}

type StreamRow = typeof workStreams.$inferSelect

/** One message per (event, dependent, dependency, detail, recipient): retries and racing callers adopt the winner. */
async function sendStackNotice(
  stream: Pick<StreamRow, 'id' | 'number' | 'squadId'>,
  recipientId: string,
  event: 'stacked' | 'dependency_head_changed' | 'dependency_merged' | 'dependency_canceled_after_unlock',
  detail: string,
  message: { subject: string; content: string; steer: boolean }
): Promise<void> {
  const { InboxMessage } = await import('../../entities/InboxMessage')
  const key = `work-stream-stack:${createHash('sha256')
    .update(JSON.stringify({ v: 1, event, workStreamId: stream.id, detail, recipientId }))
    .digest('hex')}`
  await InboxMessage.sendOnce(
    {
      recipientType: 'agent',
      recipientId,
      senderType: 'system',
      wakeEligible: true,
      subject: message.subject,
      content: message.content,
      metadata: { workStreamNumber: stream.number, workStreamId: stream.id, squadId: stream.squadId, event },
      ...(message.steer ? { deliveryMode: 'steer' as const } : {}),
    },
    key
  )
}

/**
 * Send what is owed to live, unpaused stacked streams, once per event:
 * - the dependency's branch head changed since the stream was built on it
 * - the dependency merged
 * - the dependency was canceled (also when that was before the stream's stack
 *   decision, which is then `none`: the stream may already be working)
 * A paused or parked stream is skipped and hears it once it runs again;
 * done and canceled streams are never told. Nothing here pauses, parks or
 * blocks a stream. With no IDs, every live stacked stream is considered (the
 * reconciler's backstop): one read for the streams, one for their dependencies.
 */
export async function deliverStackNotices(streamIds?: string[]): Promise<void> {
  if (streamIds && streamIds.length === 0) return
  const streams = await db
    .select()
    .from(workStreams)
    .where(
      and(
        eq(workStreams.status, 'active'),
        isNull(workStreams.pause),
        sql`${workStreams.dependencyEdges} <> '{}'::jsonb`,
        streamIds ? inArray(workStreams.id, streamIds) : undefined
      )
    )
  const stackedIds = (stream: StreamRow) =>
    (stream.dependsOn ?? []).filter((id) => isStackedDependencyEdge(stream.dependencyEdges?.[id]))
  // Decided after the dependency was canceled (the stream may already be working): told once, too.
  const canceledBeforeDecisionIds = (stream: StreamRow) =>
    (stream.dependsOn ?? []).filter((id) => {
      const stack = stream.dependencyEdges?.[id]?.stack
      return stack?.mode === 'none' && stack.dependencyCanceled && !stack.canceledNotifiedAt
    })
  const dependencyIds = [
    ...new Set(streams.flatMap((stream) => [...stackedIds(stream), ...canceledBeforeDecisionIds(stream)])),
  ]
  if (dependencyIds.length === 0) return
  const dependencies = await db
    .select({ id: workStreams.id, number: workStreams.number, title: workStreams.title, status: workStreams.status })
    .from(workStreams)
    .where(inArray(workStreams.id, dependencyIds))
  const byId = new Map(dependencies.map((row) => [row.id, row]))

  for (const stream of streams) {
    for (const dependencyId of canceledBeforeDecisionIds(stream)) {
      const dependency = byId.get(dependencyId)
      if (!dependency) continue
      try {
        await notifyStack(stream, dependencyId, 'dependency_canceled_after_unlock', '', {
          subject: `Ready dependency canceled: ${workStreamTitle(dependency)}`,
          content: `"${workStreamTitle(dependency)}" was canceled after "${workStreamTitle(stream)}" was admitted on its ready unlock. This stream's branch was not built on it and nothing was paused, blocked or held, so work can continue. Its changes will never merge: if this work relies on them, decide with the owner how to proceed.`,
          patch: { canceledNotifiedAt: new Date().toISOString() },
          owner: true,
        })
      } catch (error) {
        log.warn(`Failed to deliver stack notice for work stream ${stream.id} (dependency ${dependencyId}):`, error)
      }
    }
    for (const dependencyId of stackedIds(stream)) {
      const edge = stream.dependencyEdges[dependencyId]
      const dependency = byId.get(dependencyId)
      if (!isStackedDependencyEdge(edge) || !dependency) continue
      const stack = edge.stack
      try {
        if (dependency.status === 'canceled' && !stack.canceledNotifiedAt)
          await notifyStack(stream, dependencyId, 'dependency_canceled_after_unlock', '', {
            subject: `Stacked dependency canceled: ${workStreamTitle(dependency)}`,
            content: `"${workStreamTitle(dependency)}" was canceled after "${workStreamTitle(stream)}" started on its branch ${stack.branch}. Nothing was paused or blocked and work can continue, but that branch will never merge and its commits are still part of this stream's branch: they must not be delivered as they are, so delivery stays held. Decide with the owner whether to remove them; the owner releases the hold by dropping the dependency (ficus workstream update --depends-on or --clear-dependencies).`,
            patch: { canceledNotifiedAt: new Date().toISOString() },
            owner: true,
          })
        else if (dependency.status === 'done' && !stack.mergedNotifiedAt) {
          const git = gitOf(stream.metadata) as GitMetadata & { baseBranch?: unknown }
          const base = text(git.baseBranch)
          await notifyStack(stream, dependencyId, 'dependency_merged', '', {
            subject: `Stacked dependency merged: ${workStreamTitle(dependency)}`,
            content: `"${workStreamTitle(dependency)}", which "${workStreamTitle(stream)}" was built on (branch ${stack.branch}), has merged. Merge the base branch into this stream's branch${base ? ` (git fetch ${text(git.remote) ?? 'origin'} ${base} && git merge FETCH_HEAD)` : ''}, then proceed to delivery. Its delivery hold is released; any other unmerged stacked dependency still holds delivery.`,
            patch: { mergedNotifiedAt: new Date().toISOString() },
            owner: false,
          })
        } else if (
          dependency.status !== 'done' &&
          dependency.status !== 'canceled' &&
          stack.observedHeadSha &&
          stack.observedHeadSha !== stack.headSha &&
          stack.observedHeadSha !== stack.notifiedHeadSha
        )
          await notifyStack(stream, dependencyId, 'dependency_head_changed', stack.observedHeadSha, {
            subject: `Stacked dependency changed: ${workStreamTitle(dependency)}`,
            content: `"${workStreamTitle(dependency)}", which "${workStreamTitle(stream)}" is built on, has a new branch head: ${stack.observedHeadSha} (branch ${stack.branch}${stack.headSha ? `; this stream was built on ${stack.headSha}` : ''}). Bring the change in when it suits the work: git fetch ${text(gitOf(stream.metadata).remote) ?? 'origin'} ${stack.branch} && git merge FETCH_HEAD. This is a notice only: nothing was paused or blocked.`,
            patch: { notifiedHeadSha: stack.observedHeadSha },
            owner: true,
          })
      } catch (error) {
        log.warn(`Failed to deliver stack notice for work stream ${stream.id} (dependency ${dependencyId}):`, error)
      }
    }
  }
}

async function notifyStack(
  stream: StreamRow,
  dependencyId: string,
  event: 'dependency_head_changed' | 'dependency_merged' | 'dependency_canceled_after_unlock',
  detail: string,
  notice: { subject: string; content: string; patch: Record<string, unknown>; owner: boolean }
): Promise<void> {
  const recipients = new Map<string, boolean>()
  if (stream.assigneeAgentId) recipients.set(stream.assigneeAgentId, true)
  if (notice.owner) {
    const { resolveWorkStreamRecipient } = await import('../squad/work-stream-notifications')
    const { WorkStream } = await import('../../entities/WorkStream')
    const owner = await resolveWorkStreamRecipient(new WorkStream(stream))
    if (owner && !recipients.has(owner.id)) recipients.set(owner.id, false)
  }
  // Nobody to tell yet (no assignee between steps): keep it owed rather than record it as sent.
  if (recipients.size === 0) return
  for (const [recipientId, steer] of recipients)
    await sendStackNotice(stream, recipientId, event, `${dependencyId}:${detail}`, { ...notice, steer })
  // Recorded only after every send: a crash in between re-sends into the same idempotency keys.
  await patchEdgeStack(db, stream.id, dependencyId, notice.patch)
}

/**
 * The code host reported a new head for a dependency's delivery pull request:
 * record it on every live stream built on that dependency (one statement),
 * then tell those that can hear it now.
 */
export async function recordDependencyHead(dependencyId: string, headSha: string): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/.test(headSha)) return
  const edge = sql`(${workStreams.dependencyEdges}->(${dependencyId}::text))`
  const updated = await db
    .update(workStreams)
    .set({
      dependencyEdges: sql`jsonb_set(${workStreams.dependencyEdges}, ${`{${dependencyId},stack,observedHeadSha}`}::text[], to_jsonb(${headSha}::text))`,
    })
    .where(
      and(
        sql`${workStreams.dependsOn} @> ARRAY[${dependencyId}]::uuid[]`,
        inArray(workStreams.status, ['active', 'queued']),
        sql`${edge}->'stack'->>'mode' IN ('stacked', 'included', 'manual')`,
        sql`coalesce(${edge}->'stack'->>'observedHeadSha', '') <> ${headSha}`
      )
    )
    .returning({ id: workStreams.id })
  await deliverStackNotices(updated.map((row) => row.id))
}

/**
 * A code-host event may report a new head for a pull request some live stream is built on. Found
 * from the dependents' side, so it does not matter whether the dependency's own flow subscribes to
 * code-host changes. One read when no stream is stacked on anything; two otherwise. Correlation
 * only: a dependency in a squad the event's authority does not cover is ignored.
 */
export async function recordDependencyHeadFromEvent(
  event: typeof integrationOutputEvents.$inferSelect,
  authorize: (squadId: string) => Promise<boolean>
): Promise<void> {
  if (event.fact.output !== 'pull_request.updated') return
  const dependents = await db
    .select({ dependsOn: workStreams.dependsOn, dependencyEdges: workStreams.dependencyEdges })
    .from(workStreams)
    .where(and(inArray(workStreams.status, ['active', 'queued']), sql`${workStreams.dependencyEdges} <> '{}'::jsonb`))
  const dependencyIds = [
    ...new Set(
      dependents.flatMap((stream) =>
        (stream.dependsOn ?? []).filter((id) => isStackedDependencyEdge(stream.dependencyEdges?.[id]))
      )
    ),
  ]
  if (dependencyIds.length === 0) return
  const dependencies = await db
    .select({ id: workStreams.id, squadId: workStreams.squadId, metadata: workStreams.metadata })
    .from(workStreams)
    .where(and(inArray(workStreams.id, dependencyIds), inArray(workStreams.status, ['active', 'queued'])))
  for (const dependency of dependencies) {
    const head = deliveryPullRequestHead(dependency.metadata, event)
    if (head && (await authorize(dependency.squadId))) await recordDependencyHead(dependency.id, head)
  }
}

/** A work stream merged or was canceled: tell the live streams built on it. */
export async function deliverStackNoticesForDependency(dependencyId: string): Promise<void> {
  const dependents = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        sql`${workStreams.dependsOn} @> ARRAY[${dependencyId}]::uuid[]`,
        eq(workStreams.status, 'active'),
        sql`${workStreams.dependencyEdges} <> '{}'::jsonb`
      )
    )
  await deliverStackNotices(dependents.map((row) => row.id))
}

/**
 * Reconciler backstop: decide stacks an interrupted admission left undecided,
 * and send notices missed while a stream was paused or parked, or lost with a
 * process. Two reads when nothing is owed.
 */
export async function reconcileStackedStreams(): Promise<void> {
  const candidates = await db
    .select({
      id: workStreams.id,
      status: workStreams.status,
      dependsOn: workStreams.dependsOn,
      dependencyEdges: workStreams.dependencyEdges,
    })
    .from(workStreams)
    .where(
      and(
        inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES),
        isNull(workStreams.pause),
        sql`${workStreams.dependencyEdges} <> '{}'::jsonb`
      )
    )
  for (const stream of candidates) if (undecidedStackIds(stream).length > 0) await settleStackDecisionsSafely(stream.id)
  await deliverStackNotices()
}
