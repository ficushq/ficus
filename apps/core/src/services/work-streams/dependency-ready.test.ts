import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import {
  createBlankWorkflow,
  createWorkflowRun,
  resolveWorkflow,
  type WorkStreamDependencyEdgeState,
  type WorkflowDefinition,
} from '@ficus/shared'
import { db } from '../../db'
import {
  agentTypes,
  agents,
  executions,
  inbox,
  squads,
  workStreamFlowRuns,
  workStreams,
  workStreamWaits,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { WorkStream } from '../../entities/WorkStream'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import {
  createStackingFixture,
  fixtureGit,
  gitFixtureExec,
  type StackingFixture,
} from '../../test-utils/git-stacking-fixture'
import { finishFlow } from '../workflows/execution'
import { deliveryInstructionsForRun } from '../workflows/completion-prompt'
import { promoteEligibleQueuedStreams, runSquadAdmissionMaintenance } from './admission'
import {
  WorkStreamStackedDeliveryHoldError,
  loadStackedDependencies,
  stackedDependencyNotice,
} from './dependency-edges'
import {
  deliverStackNotices,
  deliverStackNoticesForDependency,
  recordDependencyHead,
  recordDependencyHeadFromEvent,
  reconcileStackedStreams,
  setStackingRuntimeForTest,
  settleStackDecisions,
} from './dependency-stacking'
import { listOpenWaits, openWait } from './waits'

/**
 * Dependencies that unlock when the dependency's pull request is ready.
 * Streams are stored legacy fixtures (no participants are dispatched); a
 * dependency's readiness is its stored flow run plus its bound change request.
 */
describe('ready dependencies', () => {
  let prefix: string
  let squad: Squad
  let agentTypeId: string
  let assigneeId: string
  let ownerId: string
  let fixture: StackingFixture | undefined

  beforeEach(async () => {
    prefix = `wsready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    agentTypeId = `${prefix}-agent-type`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Ready Dependency Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'ready dependency tests' })
    ownerId = (await Squad.mustFind(squad.id)).managerAgentId!
    assigneeId = (await Agent.create({ agentTypeId, squadId: squad.id })).id
  })

  afterEach(async () => {
    setStackingRuntimeForTest(undefined)
    await fixture?.cleanup()
    fixture = undefined
    const squadAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squad.id))
    const agentIds = squadAgents.map((agent) => agent.id)
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    if (agentIds.length > 0) {
      await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
      await db.delete(executions).where(inArray(executions.agentId, agentIds))
      await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squad.id))
      await db.delete(agents).where(inArray(agents.id, agentIds))
    }
    await db.delete(squads).where(like(squads.name, `${prefix}%`))
    await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
  })

  const createStream = (title: string, overrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}) =>
    storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} ${title}`, ...overrides })
  const reload = (stream: { id: string }) => WorkStream.mustFind(stream.id)
  const statusOf = async (stream: { id: string }) => (await reload(stream)).status
  const ready = (stream: { id: string }) => ({ id: stream.id, condition: 'ready' as const })

  /** Give a stream a flow run in `status` under `mode`, and optionally a bound delivery pull request. */
  async function setFlow(
    stream: { id: string },
    status: 'running' | 'completion-ready',
    options: { pullRequest?: number; mode?: WorkflowDefinition['completion']['mode'] } = {}
  ) {
    const definition = createBlankWorkflow()
    definition.completion.mode = options.mode ?? 'pr-merge'
    const state = { ...createWorkflowRun(definition), status }
    await db
      .insert(workStreamFlowRuns)
      .values({
        workStreamId: stream.id,
        activated: true,
        state,
        source: resolveWorkflow({ kind: 'inline', definition }),
        createRequestId: crypto.randomUUID(),
        createRequestHash: 'test',
        createdBy: 'test',
      })
      .onConflictDoUpdate({ target: workStreamFlowRuns.workStreamId, set: { state } })
    if (options.pullRequest !== undefined) {
      const current = await reload(stream)
      await db
        .update(workStreams)
        .set({
          metadata: {
            ...current.metadata,
            codeHost: {
              integration: 'github',
              repository: 'example/repo',
              changeRequest: { number: options.pullRequest },
            },
          },
        })
        .where(eq(workStreams.id, stream.id))
    }
  }
  /** The dependency's work is implemented and its pull request is open. */
  const makeReady = (stream: { id: string }, pullRequest = 7) => setFlow(stream, 'completion-ready', { pullRequest })

  const setEdges = (stream: { id: string }, edges: Record<string, WorkStreamDependencyEdgeState>) =>
    db.update(workStreams).set({ dependencyEdges: edges }).where(eq(workStreams.id, stream.id))
  /** A stream already built on `dependency`'s branch, as admission leaves it. */
  const stackOn = (stream: { id: string }, dependency: { id: string }, headSha = 'a'.repeat(40)) =>
    setEdges(stream, {
      [dependency.id]: {
        condition: 'ready',
        readyUnlockedAt: new Date().toISOString(),
        stack: { mode: 'stacked', decidedAt: new Date().toISOString(), branch: 'work/dependency', headSha },
      },
    })
  const notices = (stream: { id: string }, event: string) =>
    db
      .select({ recipientId: inbox.recipientId, content: inbox.content, deliveryMode: inbox.deliveryMode })
      .from(inbox)
      .where(and(sql`${inbox.metadata}->>'workStreamId' = ${stream.id}`, sql`${inbox.metadata}->>'event' = ${event}`))

  describe('admission', () => {
    it('a ready edge admits when the dependency is completion-ready with a bound pull request, not before', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      expect(dependent.status).toBe('queued')
      expect(dependent.dependencies).toEqual([{ workStreamId: dependency.id, condition: 'ready', satisfied: false }])

      // Still being implemented, with a draft pull request already open.
      await setFlow(dependency, 'running', { pullRequest: 7 })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('queued')

      // Implemented, but nothing to stack on: no delivery pull request is bound.
      await db
        .update(workStreams)
        .set({ metadata: { codeHost: { integration: 'github', repository: 'example/repo' } } })
        .where(eq(workStreams.id, dependency.id))
      await setFlow(dependency, 'completion-ready')
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('queued')
      expect((await listOpenWaits(db, dependent.id)).map((wait) => wait.type)).toEqual(['dependency'])

      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      const admitted = await reload(dependent)
      expect(admitted.status).toBe('active')
      expect(await statusOf(dependency)).toBe('active')
      expect(await listOpenWaits(db, dependent.id)).toEqual([])
      expect(admitted.dependencies[0]).toMatchObject({ condition: 'ready', satisfied: true })
      expect(typeof admitted.dependencies[0]!.unlockedAt).toBe('string')
      const [wait] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.workStreamId, dependent.id))
      expect(wait).toMatchObject({ type: 'dependency', resolution: 'satisfied' })
    })

    it('a stream created against an already ready dependency is admitted at creation', async () => {
      const dependency = await createStream('dependency')
      await makeReady(dependency)
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      expect(dependent.status).toBe('active')
      expect(await listOpenWaits(db, dependent.id)).toEqual([])
    })

    it('done edges are unchanged: a ready dependency does not admit a plain dependency', async () => {
      const dependency = await createStream('dependency')
      await makeReady(dependency)
      const plain = await createStream('plain', { dependsOn: [dependency.id] })
      const explicit = await createStream('explicit', { dependsOn: [{ id: dependency.id, condition: 'done' }] })
      await promoteEligibleQueuedStreams(squad.id)
      for (const stream of [plain, explicit]) {
        const current = await reload(stream)
        expect(current.status).toBe('queued')
        expect(current.dependencyEdges).toEqual({})
        expect(current.dependencies).toEqual([{ workStreamId: dependency.id, condition: 'done', satisfied: false }])
      }
      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, dependency.id))
      await db
        .update(workStreamWaits)
        .set({ closedAt: new Date(), resolution: 'satisfied' })
        .where(eq(workStreamWaits.referenceId, dependency.id))
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(plain)).toBe('active')
      expect(await statusOf(explicit)).toBe('active')
    })

    it('a dependency without pull-request delivery satisfies ready only by being done', async () => {
      const deliverable = await createStream('deliverable')
      await setFlow(deliverable, 'completion-ready', { pullRequest: 7, mode: 'deliverable' })
      const legacy = await createStream('legacy, no flow')
      const dependent = await createStream('dependent', { dependsOn: [ready(deliverable), ready(legacy)] })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('queued')

      // The fixture flow has no finish permit: record its completion as delivery would,
      // closing the dependent's wait in the same step.
      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, deliverable.id))
      await db
        .update(workStreamWaits)
        .set({ closedAt: new Date(), resolution: 'satisfied' })
        .where(eq(workStreamWaits.referenceId, deliverable.id))
      await legacy.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      const admitted = await reload(dependent)
      expect(admitted.status).toBe('active')
      // Unlocked by done, not by ready: nothing to stack on and no delivery hold.
      expect(admitted.dependencies.every((edge) => edge.satisfied && !edge.unlockedAt && !edge.stack)).toBe(true)
    })

    it('mixed edges need every one satisfied', async () => {
      const readyDependency = await createStream('ready dependency')
      const doneDependency = await createStream('done dependency')
      const dependent = await createStream('dependent', {
        dependsOn: [ready(readyDependency), doneDependency.id],
      })
      await makeReady(readyDependency)
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('queued')
      expect((await listOpenWaits(db, dependent.id)).map((wait) => wait.referenceId)).toEqual([doneDependency.id])

      await doneDependency.update({ status: 'done' })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('active')
    })

    it('a dependency canceled before it unlocked still flags the dependent and never admits it', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      await dependency.cancel()
      await promoteEligibleQueuedStreams(squad.id)
      const flagged = await reload(dependent)
      expect(flagged.status).toBe('queued')
      const admission = flagged.metadata.admission as Record<string, unknown> | undefined
      expect(typeof admission?.canceledDependencyNotifiedAt).toBe('string')
      expect(flagged.dependencies[0]).toMatchObject({ satisfied: false })
    })

    it('a ready unlock never bypasses the cap, a pause or another open wait', async () => {
      await squad.update({ maxConcurrentWorkStreams: 2 })
      const dependency = await createStream('dependency')
      const holder = await createStream('holder')
      const capped = await createStream('capped', { dependsOn: [ready(dependency)] })
      await makeReady(dependency)

      // Cap: the edge unlocks, but no slot is free.
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(capped)).toBe('queued')
      expect((await reload(capped)).dependencies[0]).toMatchObject({ satisfied: true })

      // Pause and an unrelated open wait each hold a stream whose edge has unlocked.
      await db
        .update(workStreams)
        .set({
          pause: {
            id: crypto.randomUUID(),
            pausedAt: new Date().toISOString(),
            reason: 'test',
            parkAt: null,
            agentIds: [],
          },
        })
        .where(eq(workStreams.id, capped.id))
      await squad.update({ maxConcurrentWorkStreams: null })
      const waiting = await createStream('waiting', { dependsOn: [ready(dependency)] })
      expect(waiting.status).toBe('active')
      await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, waiting.id))
      await openWait(db, { workStreamId: waiting.id, type: 'manual', scope: 'stream', message: 'needs a decision' })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(capped)).toBe('queued')
      expect(await statusOf(waiting)).toBe('queued')
      expect(await statusOf(holder)).toBe('active')

      await db.update(workStreams).set({ pause: null }).where(eq(workStreams.id, capped.id))
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(capped)).toBe('active')
      expect(await statusOf(waiting)).toBe('queued')
    })
  })

  describe('once unlocked', () => {
    it('stays admitted when the dependency returns to rework, and re-sending the edge does not re-block it', async () => {
      await squad.update({ blockedGraceMinutes: 0 })
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('active')

      await setFlow(dependency, 'running')
      await (await reload(dependent)).update({ dependsOn: [ready(dependency)] })
      const { parked } = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
      expect(parked).toEqual([])
      const current = await reload(dependent)
      expect(current.status).toBe('active')
      expect(await listOpenWaits(db, dependent.id)).toEqual([])
      expect(current.dependencies[0]).toMatchObject({ condition: 'ready', satisfied: true })
    })

    it('stays admitted when the dependency is canceled: one notice each to the assignee and the owner', async () => {
      await squad.update({ blockedGraceMinutes: 0 })
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        assigneeAgentId: assigneeId,
      })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency)

      await (await reload(dependency)).cancel()
      await deliverStackNoticesForDependency(dependency.id)
      await deliverStackNoticesForDependency(dependency.id)
      await reconcileStackedStreams()
      const { parked } = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })

      expect(parked).toEqual([])
      const current = await reload(dependent)
      expect(current.status).toBe('active')
      expect(current.pause).toBeNull()
      expect(await listOpenWaits(db, dependent.id)).toEqual([])
      expect((current.metadata.admission as Record<string, unknown> | undefined)?.canceledDependencyNotifiedAt).toBe(
        undefined
      )
      const sent = await notices(dependent, 'dependency_canceled_after_unlock')
      expect(sent.map((notice) => notice.recipientId).sort()).toEqual([assigneeId, ownerId].sort())
      expect(sent.find((notice) => notice.recipientId === assigneeId)!.deliveryMode).toBe('steer')
      expect(sent[0]!.content).toContain('Nothing was paused or blocked')
    })

    it('a new dependency branch head is told once per head, to the assignee and the owner', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        assigneeAgentId: assigneeId,
      })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency, 'a'.repeat(40))

      // The head the stream was built on is not news.
      await recordDependencyHead(dependency.id, 'a'.repeat(40))
      expect(await notices(dependent, 'dependency_head_changed')).toEqual([])

      await recordDependencyHead(dependency.id, 'b'.repeat(40))
      await recordDependencyHead(dependency.id, 'b'.repeat(40))
      await reconcileStackedStreams()
      let sent = await notices(dependent, 'dependency_head_changed')
      expect(sent.map((notice) => notice.recipientId).sort()).toEqual([assigneeId, ownerId].sort())
      expect(sent[0]!.content).toContain('b'.repeat(40))

      await recordDependencyHead(dependency.id, 'c'.repeat(40))
      sent = await notices(dependent, 'dependency_head_changed')
      expect(sent).toHaveLength(4)
      expect(sent.filter((notice) => notice.content.includes('c'.repeat(40)))).toHaveLength(2)
      expect(await statusOf(dependent)).toBe('active')
    })

    it('the merge is told once, to the assignee only', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        assigneeAgentId: assigneeId,
      })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency)

      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, dependency.id))
      await deliverStackNoticesForDependency(dependency.id)
      await deliverStackNoticesForDependency(dependency.id)
      await reconcileStackedStreams()
      const sent = await notices(dependent, 'dependency_merged')
      expect(sent.map((notice) => notice.recipientId)).toEqual([assigneeId])
      expect(sent[0]!.content).toContain('Merge the base branch into this stream')
    })

    it('a paused stream hears nothing until it runs again; done and canceled streams never do', async () => {
      const dependency = await createStream('dependency')
      const [paused, finished, canceled] = await Promise.all(
        ['paused', 'finished', 'canceled'].map((title) =>
          createStream(title, { dependsOn: [ready(dependency)], assigneeAgentId: assigneeId })
        )
      )
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      for (const stream of [paused!, finished!, canceled!]) await stackOn(stream, dependency)
      await db
        .update(workStreams)
        .set({
          pause: {
            id: crypto.randomUUID(),
            pausedAt: new Date().toISOString(),
            reason: 'test',
            parkAt: null,
            agentIds: [],
          },
        })
        .where(eq(workStreams.id, paused!.id))
      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, finished!.id))
      await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, canceled!.id))

      await recordDependencyHead(dependency.id, 'b'.repeat(40))
      await deliverStackNotices()
      for (const stream of [paused!, finished!, canceled!])
        expect(await notices(stream, 'dependency_head_changed')).toEqual([])

      await db.update(workStreams).set({ pause: null }).where(eq(workStreams.id, paused!.id))
      await reconcileStackedStreams()
      expect(await notices(paused!, 'dependency_head_changed')).toHaveLength(2)
      for (const stream of [finished!, canceled!]) expect(await notices(stream, 'dependency_head_changed')).toEqual([])
    })
  })

  describe('stacking', () => {
    async function stackedPair(options: { dependentRepository?: string } = {}) {
      fixture = await createStackingFixture()
      const active = fixture
      const head = await active.pushDependencyBranch('work/dependency', 'dependency.txt')
      setStackingRuntimeForTest(async () => ({ exec: gitFixtureExec }))
      const codeHost = (repository: string) => ({ integration: 'github', repository })
      const dependency = await createStream('dependency', {
        metadata: { codeHost: codeHost('example/repo'), git: { branch: 'work/dependency', baseBranch: 'main' } },
      })
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        metadata: {
          codeHost: codeHost(options.dependentRepository ?? 'example/repo'),
          git: {
            repository: active.repo,
            worktree: active.worktree,
            branch: 'work/dependent',
            baseBranch: 'main',
            remote: 'origin',
            baseCommit: active.baseCommit,
          },
        },
      })
      await makeReady(dependency)
      return { active, head, dependency, dependent }
    }

    it('admission moves the clean, never-started branch onto the dependency head and records it', async () => {
      const { active, head, dependency, dependent } = await stackedPair()
      await promoteEligibleQueuedStreams(squad.id)

      const stacked = await reload(dependent)
      expect(stacked.status).toBe('active')
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(head)
      expect(stacked.metadata.git).toMatchObject({
        branch: 'work/dependent',
        stackedOn: { workStreamId: dependency.id, branch: 'work/dependency', headSha: head },
      })
      expect(stacked.dependencies[0]).toMatchObject({
        condition: 'ready',
        satisfied: true,
        holdsDelivery: true,
        stack: { mode: 'stacked', branch: 'work/dependency', headSha: head },
      })

      // Deciding again changes nothing: the decision is recorded once.
      await settleStackDecisions(dependent.id)
      expect((await reload(dependent)).dependencyEdges).toEqual(stacked.dependencyEdges)
    })

    it('a branch that already has work is left alone and the notice tells the assignee to merge', async () => {
      const { active, dependency, dependent } = await stackedPair()
      await Bun.write(`${active.worktree}/scratch.txt`, 'in progress\n')
      await promoteEligibleQueuedStreams(squad.id)

      const current = await reload(dependent)
      expect(current.status).toBe('active')
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(active.baseCommit)
      expect(current.dependencies[0]).toMatchObject({ holdsDelivery: true, stack: { mode: 'manual' } })
      expect((current.metadata.git as Record<string, unknown>).stackedOn).toBeUndefined()
      const notice = stackedDependencyNotice(await loadStackedDependencies(db, current), current.metadata.git as object)
      expect(notice).toContain('was NOT merged into this stream')
      expect(notice).toContain('git fetch origin work/dependency && git merge FETCH_HEAD')
      expect(notice).toContain('the worktree has uncommitted changes')
      expect(notice).toContain((await reload(dependency)).title)
    })

    it('streams in different repositories only unlock: no stack, no delivery hold', async () => {
      const { active, dependent } = await stackedPair({ dependentRepository: 'example/other' })
      await promoteEligibleQueuedStreams(squad.id)

      const current = await reload(dependent)
      expect(current.status).toBe('active')
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(active.baseCommit)
      expect(current.dependencies[0]).toMatchObject({ condition: 'ready', satisfied: true })
      expect(current.dependencies[0]!.stack).toBeUndefined()
      expect(current.dependencies[0]!.holdsDelivery).toBeUndefined()
      expect(current.dependencyEdges[current.dependsOn[0]!]!.stack).toMatchObject({ mode: 'none' })
      await current.update({ status: 'done' })
      expect(await statusOf(dependent)).toBe('done')
    })
  })

  describe('review regressions', () => {
    const unlockedEdge = (dependency: { id: string }) => ({
      [dependency.id]: { condition: 'ready' as const, readyUnlockedAt: new Date().toISOString() },
    })

    it('many concurrent stack decisions complete: the lock never holds a pooled connection', async () => {
      // More concurrent settles than the pool has connections. Each used to open a pooled
      // transaction and then need a second pooled connection inside it, which deadlocks the pool.
      const dependency = await createStream('dependency', {
        metadata: {
          codeHost: { integration: 'github', repository: 'example/repo' },
          git: { branch: 'work/dependency' },
        },
      })
      await makeReady(dependency)
      const dependents = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          createStream(`dependent-${index}`, {
            metadata: {
              codeHost: { integration: 'github', repository: 'example/repo' },
              git: { repository: '/nowhere/repo', worktree: `/nowhere/wt-${index}`, branch: `work/dependent-${index}` },
            },
          })
        )
      )
      for (const dependent of dependents)
        await db
          .update(workStreams)
          .set({ dependsOn: [dependency.id], dependencyEdges: unlockedEdge(dependency) })
          .where(eq(workStreams.id, dependent.id))
      let entered = 0
      const runtime = async () => {
        entered += 1
        await new Promise((resolve) => setTimeout(resolve, 100))
        // Pool work while the lock is held, like the real sandbox and credential lookups.
        await db.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, dependency.id))
        return {
          exec: async () => {
            throw new Error('no git in this fixture')
          },
        }
      }

      await Promise.all(dependents.map((dependent) => settleStackDecisions(dependent.id, runtime)))

      expect(entered).toBe(8)
      for (const dependent of dependents)
        expect((await reload(dependent)).dependencyEdges[dependency.id]!.stack).toMatchObject({ mode: 'manual' })
      // The pool is still usable.
      expect(await statusOf(dependency)).toBe('active')
    })

    it('two deciders for one stream: one decides, the other waits for that decision', async () => {
      const dependency = await createStream('dependency', {
        metadata: {
          codeHost: { integration: 'github', repository: 'example/repo' },
          git: { branch: 'work/dependency' },
        },
      })
      const dependent = await createStream('dependent', {
        metadata: {
          codeHost: { integration: 'github', repository: 'example/repo' },
          git: { repository: '/nowhere/repo', worktree: '/nowhere/wt', branch: 'work/dependent' },
        },
      })
      await db
        .update(workStreams)
        .set({ dependsOn: [dependency.id], dependencyEdges: unlockedEdge(dependency) })
        .where(eq(workStreams.id, dependent.id))
      let entered = 0
      const seenWhileDeciding: unknown[] = []
      const runtime = async () => {
        entered += 1
        seenWhileDeciding.push((await reload(dependent)).dependencyEdges[dependency.id]!.stack?.mode)
        await new Promise((resolve) => setTimeout(resolve, 400))
        return {
          exec: async () => {
            throw new Error('no git in this fixture')
          },
        }
      }

      const decidedWhenEachReturned = await Promise.all(
        [0, 1].map(async () => {
          await settleStackDecisions(dependent.id, runtime)
          return (await reload(dependent)).dependencyEdges[dependency.id]!.stack?.mode
        })
      )

      expect(entered).toBe(1)
      expect(seenWhileDeciding).toEqual(['pending'])
      // Neither caller went on before the decision existed.
      expect(decidedWhenEachReturned).toEqual(['manual', 'manual'])
      // A claim in progress is never shown as a stack.
      expect((await reload(dependent)).dependencies[0]!.stack).toMatchObject({ mode: 'manual' })
    })

    it('a stream still queued when its ready dependency is canceled is flagged, not admitted or stacked', async () => {
      fixture = await createStackingFixture()
      const active = fixture
      await active.pushDependencyBranch('work/dependency', 'dependency.txt')
      setStackingRuntimeForTest(async () => ({ exec: gitFixtureExec }))
      await squad.update({ maxConcurrentWorkStreams: 2 })
      const codeHost = { integration: 'github', repository: 'example/repo' }
      const dependency = await createStream('dependency', {
        metadata: { codeHost, git: { branch: 'work/dependency', baseBranch: 'main' } },
      })
      const holder = await createStream('holder')
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        metadata: {
          codeHost,
          git: {
            repository: active.repo,
            worktree: active.worktree,
            branch: 'work/dependent',
            baseBranch: 'main',
            remote: 'origin',
            baseCommit: active.baseCommit,
          },
        },
      })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      // Unlocked, but never started: the cap holds it.
      const queued = await reload(dependent)
      expect(queued.status).toBe('queued')
      expect(typeof queued.dependencyEdges[dependency.id]!.readyUnlockedAt).toBe('string')

      // Canceling frees the slot the dependent was waiting for.
      await (await reload(dependency)).cancel()
      await promoteEligibleQueuedStreams(squad.id)
      await reconcileStackedStreams()

      const flagged = await reload(dependent)
      expect(flagged.status).toBe('queued')
      expect(typeof (flagged.metadata.admission as Record<string, unknown>).canceledDependencyNotifiedAt).toBe('string')
      expect(flagged.dependencyEdges).toEqual({ [dependency.id]: { condition: 'ready' } })
      expect(flagged.dependencies).toEqual([{ workStreamId: dependency.id, condition: 'ready', satisfied: false }])
      expect((await listOpenWaits(db, dependent.id)).map((wait) => wait.referenceId)).toEqual([dependency.id])
      expect((flagged.metadata.git as Record<string, unknown>).stackedOn).toBeUndefined()
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(active.baseCommit)
      expect(await statusOf(holder)).toBe('active')
    })

    it('a branch is never moved onto a canceled dependency, even if the cancel lands after admission', async () => {
      fixture = await createStackingFixture()
      const active = fixture
      await active.pushDependencyBranch('work/dependency', 'dependency.txt')
      const codeHost = { integration: 'github', repository: 'example/repo' }
      const dependency = await createStream('dependency', {
        metadata: { codeHost, git: { branch: 'work/dependency', baseBranch: 'main' } },
      })
      const dependent = await createStream('dependent', {
        metadata: {
          codeHost,
          git: { repository: active.repo, worktree: active.worktree, branch: 'work/dependent', remote: 'origin' },
        },
      })
      await db
        .update(workStreams)
        .set({ dependsOn: [dependency.id], dependencyEdges: unlockedEdge(dependency) })
        .where(eq(workStreams.id, dependent.id))
      await dependency.cancel()

      await settleStackDecisions(dependent.id, async () => ({ exec: gitFixtureExec }))

      const current = await reload(dependent)
      expect(current.dependencyEdges[dependency.id]!.stack).toMatchObject({ mode: 'none' })
      expect(current.dependencies[0]!.holdsDelivery).toBeUndefined()
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(active.baseCommit)
      expect(current.status).toBe('active')
    })

    it('a passing runtime outage leaves the decision open, and the next attempt stacks', async () => {
      const { active, head, dependent } = await stackedPairForRegression()
      await promoteEligibleQueuedStreams(squad.id)
      // The admission-time attempt found no runtime: nothing is decided, nothing is rewritten.
      const pending = await reload(dependent)
      expect(pending.status).toBe('active')
      expect(pending.dependencyEdges[pending.dependsOn[0]!]!.stack).toBeUndefined()
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(active.baseCommit)

      setStackingRuntimeForTest(async () => ({ exec: gitFixtureExec }))
      await reconcileStackedStreams()
      expect((await reload(dependent)).dependencies[0]).toMatchObject({ stack: { mode: 'stacked', headSha: head } })
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(head)
    })

    async function stackedPairForRegression(dependentOverrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}) {
      fixture = await createStackingFixture()
      const active = fixture
      const head = await active.pushDependencyBranch('work/dependency', 'dependency.txt')
      setStackingRuntimeForTest(async () => {
        throw new Error('sandbox unavailable')
      })
      const codeHost = { integration: 'github', repository: 'example/repo' }
      const dependency = await createStream('dependency', {
        metadata: { codeHost, git: { branch: 'work/dependency', baseBranch: 'main' } },
      })
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        metadata: {
          codeHost,
          git: {
            repository: active.repo,
            worktree: active.worktree,
            branch: 'work/dependent',
            remote: 'origin',
            baseCommit: active.baseCommit,
          },
        },
        ...dependentOverrides,
      })
      await makeReady(dependency)
      return { active, head, dependency, dependent }
    }

    it('a ready dependency canceled while the admitted stream is undecided opens no wait when the edges are re-sent', async () => {
      // The reviewer probe: admitted during an outage, so no stack decision yet; then the
      // dependency is canceled and the dependency list is re-sent before the reconciler runs.
      await squad.update({ blockedGraceMinutes: 0 })
      const { dependency, dependent } = await stackedPairForRegression({ assigneeAgentId: assigneeId })
      await promoteEligibleQueuedStreams(squad.id)
      expect(await statusOf(dependent)).toBe('active')
      expect((await reload(dependent)).dependencyEdges[dependency.id]!.stack).toBeUndefined()

      await (await reload(dependency)).cancel()
      await (await reload(dependent)).update({ dependsOn: [ready(dependency)] })

      expect(await listOpenWaits(db, dependent.id)).toEqual([])
      const { parked } = await runSquadAdmissionMaintenance(squad.id, { removeSandbox: async () => {} })
      expect(parked).toEqual([])
      expect(await statusOf(dependent)).toBe('active')
    })

    it('a dependency canceled before the stack decision is told once to the assignee and the owner', async () => {
      const { active, dependency, dependent } = await stackedPairForRegression({ assigneeAgentId: assigneeId })
      await promoteEligibleQueuedStreams(squad.id)
      await (await reload(dependency)).cancel()
      await deliverStackNoticesForDependency(dependency.id)

      setStackingRuntimeForTest(async () => ({ exec: gitFixtureExec }))
      await reconcileStackedStreams()
      await reconcileStackedStreams()
      await deliverStackNoticesForDependency(dependency.id)

      const current = await reload(dependent)
      expect(current.dependencyEdges[dependency.id]!.stack).toMatchObject({ mode: 'none', dependencyCanceled: true })
      expect(current.dependencies[0]!.holdsDelivery).toBeUndefined()
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(active.baseCommit)
      const sent = await notices(dependent, 'dependency_canceled_after_unlock')
      expect(sent.map((notice) => notice.recipientId).sort()).toEqual([assigneeId, ownerId].sort())
      expect(sent.find((notice) => notice.recipientId === assigneeId)!.deliveryMode).toBe('steer')
      expect(sent[0]!.content).toContain('was not built on it')
    })

    it('the outage retry window runs from the first attempt after admission, not from the unlock', async () => {
      const { active, head, dependency, dependent } = await stackedPairForRegression()
      // Unlocked long ago, but held behind the cap: admitted only now, during an outage.
      const unlockedAt = new Date(Date.now() - 30 * 60_000).toISOString()
      await setEdges(dependent, { [dependency.id]: { condition: 'ready', readyUnlockedAt: unlockedAt } })
      await promoteEligibleQueuedStreams(squad.id)
      const pending = await reload(dependent)
      expect(pending.status).toBe('active')
      expect(pending.dependencyEdges[dependency.id]!.stack).toBeUndefined()
      const since = pending.dependencyEdges[dependency.id]!.stackRetryingSince!
      expect(Date.now() - Date.parse(since)).toBeLessThan(60_000)

      // Still within the window: another failed attempt keeps the first stamp and stays open.
      await reconcileStackedStreams()
      const retried = await reload(dependent)
      expect(retried.dependencyEdges[dependency.id]!.stack).toBeUndefined()
      expect(retried.dependencyEdges[dependency.id]!.stackRetryingSince).toBe(since)

      setStackingRuntimeForTest(async () => ({ exec: gitFixtureExec }))
      await reconcileStackedStreams()
      expect((await reload(dependent)).dependencies[0]).toMatchObject({ stack: { mode: 'stacked', headSha: head } })
      expect(await fixtureGit(active.worktree, 'rev-parse', 'HEAD')).toBe(head)
    })

    it('after ten minutes of outage from the first attempt, the assignee is asked to merge', async () => {
      const { dependency, dependent } = await stackedPairForRegression()
      await promoteEligibleQueuedStreams(squad.id)
      const edge = (await reload(dependent)).dependencyEdges[dependency.id]!
      await setEdges(dependent, {
        [dependency.id]: { ...edge, stackRetryingSince: new Date(Date.now() - 11 * 60_000).toISOString() },
      })
      await reconcileStackedStreams()
      expect((await reload(dependent)).dependencyEdges[dependency.id]!.stack).toMatchObject({
        mode: 'manual',
        reason: 'the squad runtime was unavailable',
      })
    })

    it('a merge with nobody to tell stays owed until the stream has an assignee', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency)
      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, dependency.id))

      await deliverStackNoticesForDependency(dependency.id)
      expect(await notices(dependent, 'dependency_merged')).toEqual([])

      await db.update(workStreams).set({ assigneeAgentId: assigneeId }).where(eq(workStreams.id, dependent.id))
      await reconcileStackedStreams()
      await reconcileStackedStreams()
      expect((await notices(dependent, 'dependency_merged')).map((notice) => notice.recipientId)).toEqual([assigneeId])
    })

    it('a push to the dependency pull request reaches its dependents without the dependency following changes', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', {
        dependsOn: [ready(dependency)],
        assigneeAgentId: assigneeId,
      })
      // makeReady binds example/repo#7; the fixture flow neither subscribes to nor follows code-host changes.
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency, 'a'.repeat(40))
      const pushed = (number: number, headSha: string) =>
        ({
          id: crypto.randomUUID(),
          integration: 'github',
          authority: { kind: 'instance' },
          fact: {
            output: 'pull_request.updated',
            version: 1,
            eventKey: crypto.randomUUID(),
            resourceKey: `example/repo#${number}`,
            occurredAt: new Date().toISOString(),
            data: { repository: 'example/repo', pullRequest: { number, headSha } },
            subject: '',
            body: '',
          },
        }) as unknown as Parameters<typeof recordDependencyHeadFromEvent>[0]

      // Another pull request, and a squad the event's authority does not cover, tell nobody.
      await recordDependencyHeadFromEvent(pushed(8, 'b'.repeat(40)), async () => true)
      await recordDependencyHeadFromEvent(pushed(7, 'b'.repeat(40)), async () => false)
      expect(await notices(dependent, 'dependency_head_changed')).toEqual([])

      await recordDependencyHeadFromEvent(pushed(7, 'b'.repeat(40)), async () => true)
      await recordDependencyHeadFromEvent(pushed(7, 'b'.repeat(40)), async () => true)
      const sent = await notices(dependent, 'dependency_head_changed')
      expect(sent.map((notice) => notice.recipientId).sort()).toEqual([assigneeId, ownerId].sort())
      expect(sent[0]!.content).toContain('b'.repeat(40))
    })
  })

  describe('delivery hold', () => {
    it('finish is refused with the reason until the dependency merges, then succeeds', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency)
      await setFlow(dependent, 'completion-ready', { mode: 'deliverable' })

      const held = await reload(dependent)
      await expect(finishFlow(dependent.id, 0, { type: 'legacy' })).rejects.toThrow(
        /Delivery is held: .*dependency.*\(branch work\/dependency\) has not merged yet/
      )
      // The entity boundary enforces the same hold for callers outside the flow API.
      await expect(
        db.transaction(async (tx) => {
          const { assertNoStackedDeliveryHold } = await import('./dependency-edges')
          await assertNoStackedDeliveryHold(tx, held)
        })
      ).rejects.toBeInstanceOf(WorkStreamStackedDeliveryHoldError)
      expect(await statusOf(dependent)).toBe('active')
      const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, dependent.id))
      const instructions = deliveryInstructionsForRun(
        held,
        run!.state,
        0,
        stackedDependencyNotice(await loadStackedDependencies(db, held), held.metadata.git as object)
      )
      expect(instructions).toContain('Do not enable auto-merge until then')
      expect(instructions).toContain('Opening the pull request as a draft is fine')

      await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, dependency.id))
      const released = await finishFlow(dependent.id, 0, { type: 'legacy' })
      expect(released.status).toBe('done')
    })

    it('dropping a canceled dependency releases the hold', async () => {
      const dependency = await createStream('dependency')
      const dependent = await createStream('dependent', { dependsOn: [ready(dependency)] })
      await makeReady(dependency)
      await promoteEligibleQueuedStreams(squad.id)
      await stackOn(dependent, dependency)
      await (await reload(dependency)).cancel()

      const held = await reload(dependent)
      await expect(held.update({ status: 'done' })).rejects.toThrow(/was canceled and will never merge/)
      await held.update({ dependsOn: [] })
      await (await reload(dependent)).update({ status: 'done' })
      expect(await statusOf(dependent)).toBe('done')
    })
  })
})
