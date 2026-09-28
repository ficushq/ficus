import * as schema from '../db/schema'
import * as repositorySetup from '../services/work-streams/repository-setup'
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { createBlankWorkflow } from '@ficus/shared'
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq, like, inArray, and, sql } from 'drizzle-orm'
import { Squad } from './Squad'
import { Agent } from './Agent'
import { Execution } from './Execution'
import {
  WorkStream,
  WorkStreamNotReopenableError,
  WorkStreamOpenWaitsError,
  WorkStreamWaitResolveError,
} from './WorkStream'
import { closeOpenWaits, listReviewHistory, openWait } from '../services/work-streams/waits'
import { promoteEligibleQueuedStreams } from '../services/work-streams/admission'
import { backfillExecutionUsage } from '../services/execution/usage-backfill'
import { AgentType } from '../entities/AgentType'
import { User } from '../entities/User'
import { db } from '../db'
import { eventEmitter } from '../lib/infra/event-emitter'
import {
  squads,
  agents,
  agentTypes,
  workStreams,
  workStreamContinuations,
  executions,
  inbox,
  users,
} from '../db/schema'

describe('WorkStream entity', () => {
  let testPrefix: string
  let testSquad: Squad
  let testAgentTypeId: string
  let createdAgentIds: string[] = []

  beforeEach(async () => {
    testPrefix = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`
    createdAgentIds = []

    // Create agent type for test agents
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    // Create test squad
    testSquad = await Squad.create({
      name: `${testPrefix} Test Squad`,
      purpose: 'Testing work streams',
    })
    const definition = createBlankWorkflow()
    definition.participants.worker!.agentTypeId = testAgentTypeId
    await testSquad.update({ metadata: { workflow: { kind: 'inline', definition } } })
  })

  afterEach(async () => {
    // Clean up in order: executions -> agents -> work streams -> squads -> agent types
    // Only delete executions for agents we created in this test
    if (createdAgentIds.length > 0) {
      await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
      await db.delete(inbox).where(inArray(inbox.recipientId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    }
    await db.delete(inbox).where(sql`${inbox.metadata}->>'squadId' = ${testSquad.id}`)
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(workStreams).where(eq(workStreams.squadId, testSquad.id))
    await db.delete(users).where(like(users.email, `${testPrefix}%`))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(like(agentTypes.id, `${testPrefix}%`))
  })

  it('defaults cleanup on for new streams, preserves opt-out and exposes later updates', async () => {
    const enabled = await WorkStream.create({ squadId: testSquad.id, title: 'new cleanup default' })
    expect(enabled.toJson()).toHaveProperty('autoCleanupWorktree', true)
    const retained = await WorkStream.create({ squadId: testSquad.id, title: 'retained', autoCleanupWorktree: false })
    expect((await WorkStream.mustFind(retained.id)).toJson()).toHaveProperty('autoCleanupWorktree', false)
    await enabled.update({ autoCleanupWorktree: false })
    expect((await WorkStream.mustFind(enabled.id)).toJson()).toHaveProperty('autoCleanupWorktree', false)
    await retained.update({ autoCleanupWorktree: true })
    expect((await WorkStream.mustFind(retained.id)).toJson()).toHaveProperty('autoCleanupWorktree', true)
  })

  it('retains historical rows without an explicit cleanup selection', async () => {
    const [historical] = await db
      .insert(workStreams)
      .values({ squadId: testSquad.id, title: 'historical cleanup default' })
      .returning()
    expect((await WorkStream.mustFind(historical.id)).toJson()).toHaveProperty('autoCleanupWorktree', false)
  })

  // Helper to create an agent and track its ID for cleanup
  async function createTestAgent(): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    createdAgentIds.push(agent.id)
    return agent
  }

  async function countWorkStreamInbox(workStreamId: string, event: string, recipientId?: string): Promise<number> {
    const rows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        and(
          sql`${inbox.metadata}->>'workStreamId' = ${workStreamId}`,
          sql`${inbox.metadata}->>'event' = ${event}`,
          ...(recipientId ? [eq(inbox.recipientId, recipientId)] : [])
        )
      )
    return rows.length
  }

  async function getWorkStreamInboxContent(workStreamId: string, event: string, recipientId: string): Promise<string> {
    const rows = await db
      .select({ content: inbox.content })
      .from(inbox)
      .where(
        and(
          sql`${inbox.metadata}->>'workStreamId' = ${workStreamId}`,
          sql`${inbox.metadata}->>'event' = ${event}`,
          eq(inbox.recipientId, recipientId)
        )
      )
    expect(rows).toHaveLength(1)
    return rows[0].content
  }

  describe('list statuses', () => {
    async function createWithStatus(title: string, status: 'active' | 'done' | 'canceled') {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} ${title}` })
      if (status !== 'active') await ws.update({ status })
      return ws
    }

    it('filters list by multiple statuses', async () => {
      await createWithStatus('active-a', 'active')
      await createWithStatus('done-a', 'done')
      await createWithStatus('canceled-a', 'canceled')
      await createWithStatus('active-b', 'active')

      const done = await WorkStream.list({ squadId: testSquad.id, statuses: ['done', 'canceled'] })

      expect(done.length).toBe(2)
      expect(done.every((w) => w.status === 'done' || w.status === 'canceled')).toBe(true)
    })
  })

  it('rolls back both delivered status and cleanup intent when the transaction aborts', async () => {
    const stream = await storedLegacyWorkStream({
      squadId: testSquad.id,
      title: 'atomic cleanup',
      completionMode: 'deliverable',
    })
    const previousStatus = stream.status
    const original = db.transaction.bind(db)
    const transaction = spyOn(db, 'transaction').mockImplementation((fn: any) =>
      original(async (tx) => {
        await fn(tx)
        throw new Error('injected abort before commit')
      })
    )
    try {
      await expect(stream.update({ status: 'done' })).rejects.toThrow('injected abort')
    } finally {
      transaction.mockRestore()
    }
    expect((await WorkStream.mustFind(stream.id)).status).toBe(previousStatus)
    expect(
      await db.select().from(schema.worktreeCleanupJobs).where(eq(schema.worktreeCleanupJobs.workStreamId, stream.id))
    ).toHaveLength(0)
  })

  it('records cleanup intent exactly once on a committed done transition, never on cancel', async () => {
    expect(schema.worktreeCleanupJobs).toBeDefined()
    const stream = await storedLegacyWorkStream({
      squadId: testSquad.id,
      title: 'cleanup outbox',
      completionMode: 'deliverable',
    })
    await stream.update({ autoCleanupWorktree: true })
    expect(
      await db.select().from(schema.worktreeCleanupJobs).where(eq(schema.worktreeCleanupJobs.workStreamId, stream.id))
    ).toHaveLength(0)
    await stream.update({ status: 'done' })
    const [intent] = await db
      .select()
      .from(schema.worktreeCleanupJobs)
      .where(eq(schema.worktreeCleanupJobs.workStreamId, stream.id))
    expect(intent).toMatchObject({ workStreamId: stream.id, status: 'pending', attempts: 0 })
    await stream.update({ status: 'done' })
    expect(
      await db.select().from(schema.worktreeCleanupJobs).where(eq(schema.worktreeCleanupJobs.workStreamId, stream.id))
    ).toEqual([intent])
    const canceled = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'never clean cancellation' })
    await canceled.update({ autoCleanupWorktree: true })
    await canceled.cancel()
    expect(
      await db.select().from(schema.worktreeCleanupJobs).where(eq(schema.worktreeCleanupJobs.workStreamId, canceled.id))
    ).toHaveLength(0)
  })

  it('persists only server-observed ownership, not an editable metadata claim', async () => {
    expect(schema.workStreamWorktrees).toBeDefined()
    const ownership = {
      workspace: '/workspace',
      repository: '/workspace/repo',
      commonDirectory: '/workspace/repo/.git',
      gitDirectory: '/workspace/repo/.git/worktrees/owned',
      worktree: '/workspace/owned',
      directoryIdentity: '1:2',
      branch: 'feature',
    }
    const setup = spyOn(repositorySetup, 'setupWorkStreamRepository').mockImplementation(
      async (_squad, _input, _key, metadata, record) => {
        record?.(ownership)
        return {
          ...metadata,
          git: { repository: ownership.repository, worktree: ownership.worktree, branch: ownership.branch },
        }
      }
    )
    try {
      const stream = await WorkStream.create({ squadId: testSquad.id, title: 'owned', repository: 'repo' })
      const [registered] = await db
        .select()
        .from(schema.workStreamWorktrees)
        .where(eq(schema.workStreamWorktrees.workStreamId, stream.id))
      expect(registered).toMatchObject({ workStreamId: stream.id, squadId: testSquad.id, ownership })
      const forged = await WorkStream.create({
        squadId: testSquad.id,
        title: 'forged',
        metadata: { ownership, git: { worktree: ownership.worktree } },
      })
      expect(
        await db.select().from(schema.workStreamWorktrees).where(eq(schema.workStreamWorktrees.workStreamId, forged.id))
      ).toHaveLength(0)
    } finally {
      setup.mockRestore()
    }
  })

  it('new creation cannot attach to an in-flight cleanup-owned path', async () => {
    const old = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'removing' })
    await db.insert(schema.workStreamWorktrees).values({
      workStreamId: old.id,
      squadId: testSquad.id,
      ownership: {
        workspace: '/workspace',
        repository: '/workspace/repo',
        commonDirectory: '/workspace/repo/.git',
        gitDirectory: '/workspace/repo/.git/worktrees/owned',
        worktree: '/workspace/owned',
        directoryIdentity: '1:2',
        branch: 'feature',
      },
    })
    await db
      .insert(schema.worktreeCleanupJobs)
      .values({ workStreamId: old.id, status: 'removing', operationId: crypto.randomUUID() })
    await expect(
      WorkStream.create({ squadId: testSquad.id, title: 'conflicting', worktree: '/workspace/owned' })
    ).rejects.toThrow(/cleanup|removal/i)
  })

  describe('repository setup', () => {
    it('attaches prepared metadata before the first workflow dispatch', async () => {
      const metadata = {
        git: { worktree: '/workspace/repo-work', branch: 'feature', baseBranch: 'main' },
        codeHost: { integration: 'github', repository: 'example/repo' },
      }
      const setup = spyOn(repositorySetup, 'setupWorkStreamRepository').mockResolvedValue(metadata)
      try {
        const stream = await WorkStream.create({
          squadId: testSquad.id,
          title: `${testPrefix} setup`,
          repository: 'repo',
        })
        expect(setup).toHaveBeenCalledWith(
          testSquad.id,
          expect.objectContaining({ repository: 'repo' }),
          stream.id,
          {},
          expect.any(Function)
        )
        expect(stream.metadata).toMatchObject(metadata)
        const stored = await WorkStream.mustFind(stream.id)
        expect(stored.metadata).toMatchObject(metadata)
        expect(stored.agentIds?.length).toBeGreaterThan(0)
      } finally {
        setup.mockRestore()
      }
    })
    it('does not create a stream or dispatch agents when setup fails', async () => {
      const setup = spyOn(repositorySetup, 'setupWorkStreamRepository').mockRejectedValue(
        new repositorySetup.RepositorySetupError('invalid repository')
      )
      try {
        await expect(
          WorkStream.create({ squadId: testSquad.id, title: `${testPrefix} failed setup`, repository: 'repo' })
        ).rejects.toThrow('invalid repository')
        expect(await WorkStream.list({ squadId: testSquad.id })).toHaveLength(0)
      } finally {
        setup.mockRestore()
      }
    })
    it('sets up a queued stream and preserves unrelated metadata', async () => {
      const stream = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} queued`,
        metadata: { note: 'keep' },
      })
      await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, stream.id))
      const queued = await WorkStream.mustFind(stream.id)
      const owned = {
        workspace: '/workspace',
        repository: '/workspace/repo',
        commonDirectory: '/workspace/repo/.git',
        gitDirectory: '/workspace/repo/.git/worktrees/queued',
        worktree: '/workspace/queued',
        directoryIdentity: '1:2',
        branch: 'feature',
      }
      const setup = spyOn(repositorySetup, 'setupWorkStreamRepository').mockImplementation(
        async (_squad, _input, _key, _metadata, record) => {
          record?.(owned)
          return {
            git: { worktree: '/workspace/queued', branch: 'feature', baseBranch: 'main' },
            codeHost: { integration: 'github', repository: 'example/repo' },
          }
        }
      )
      try {
        await queued.update({ repository: 'repo' })
        expect(queued.metadata).toMatchObject({
          note: 'keep',
          git: { worktree: '/workspace/queued' },
          codeHost: { repository: 'example/repo' },
        })
        expect(queued.status).toBe('queued')
        const [registration] = await db
          .select()
          .from(schema.workStreamWorktrees)
          .where(eq(schema.workStreamWorktrees.workStreamId, queued.id))
        expect(registration?.ownership).toEqual(owned)
      } finally {
        setup.mockRestore()
      }
    })
    it('rejects setup updates after participants start without touching the filesystem', async () => {
      const stream = await WorkStream.create({ squadId: testSquad.id, title: `${testPrefix} running` })
      const setup = spyOn(repositorySetup, 'setupWorkStreamRepository')
      try {
        await expect(stream.update({ repository: 'repo' })).rejects.toThrow('agents have not started')
        expect(setup).not.toHaveBeenCalled()
      } finally {
        setup.mockRestore()
      }
    })
  })

  describe('owner defaulting at creation', () => {
    async function setSquadManager(): Promise<Agent> {
      const manager = await createTestAgent()
      await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, testSquad.id))
      return manager
    }

    it('defaults an ownerless stream to the squad manager and notifies them', async () => {
      const manager = await setSquadManager()
      const creator = await createTestAgent()

      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} ownerless`,
        creatorAgentId: creator.id,
      })
      expect(ws.ownerAgentId).toBe(manager.id)

      const notices = await db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipientId, manager.id), like(inbox.subject, 'New work stream you own:%')))
      expect(notices.length).toBe(1)
    })

    it('keeps an explicit owner instead of overriding with the manager', async () => {
      await setSquadManager()
      const owner = await createTestAgent()
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} explicit owner`,
        ownerAgentId: owner.id,
      })
      expect(ws.ownerAgentId).toBe(owner.id)
    })

    it('does not self-notify when the manager creates an ownerless stream', async () => {
      const manager = await setSquadManager()
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} manager-created`,
        creatorAgentId: manager.id,
      })
      expect(ws.ownerAgentId).toBe(manager.id)

      const notices = await db
        .select()
        .from(inbox)
        .where(and(eq(inbox.recipientId, manager.id), like(inbox.subject, 'New work stream you own:%')))
      expect(notices.length).toBe(0)
    })

    it('leaves the owner null when the squad has no manager', async () => {
      await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, testSquad.id))
      const ws = await WorkStream.create({ squadId: testSquad.id, title: `${testPrefix} no manager` })
      expect(ws.ownerAgentId).toBeNull()
    })
  })

  describe('active assignee handling', () => {
    it('allows active without an assignee (idle is the surfaced alarm, not a rejected state)', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} unowned` })
      expect(ws.status).toBe('active')
      await expect(ws.update({ assigneeAgentId: null })).resolves.toBe(ws)
      expect(ws.assigneeAgentId).toBeNull()
    })

    it('rejects removing the assignee agent from an active stream via removeAgent', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} active bound owner`,
        agentIds: [agent.id],
        assigneeAgentId: agent.id,
      })

      await expect(ws.removeAgent(agent.id)).rejects.toThrow(/active.*assignee/i)
      expect(ws.agentIds).toContain(agent.id)
      expect(ws.assigneeAgentId).toBe(agent.id)
    })
  })

  describe('review lifecycle (typed waits)', () => {
    it.each(['review-approval', 'pr-merge', 'pr-auto-merge', 'direct-merge'] as const)(
      'Approve closes the wait AND terminalizes in one transaction (%s)',
      async (completionMode) => {
        const ws = await storedLegacyWorkStream({
          squadId: testSquad.id,
          title: `${testPrefix} ${completionMode}`,
          completionMode,
        })
        const { wait } = await ws.handoffForReview({ message: 'Review' })
        await ws.resolveWait(wait.id, { resolution: 'approved' })
        expect(ws.status).toBe('done')
        const history = await listReviewHistory(db, ws.id)
        expect(history).toHaveLength(1)
        expect(history[0].resolution).toBe('approved')
        expect(history[0].closedAt).not.toBeNull()
      }
    )

    it('second handoff while a review wait is open is an idempotent no-op (pinned)', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} double handoff` })
      const first = await ws.handoffForReview({ message: 'round one' })
      expect(first.alreadyOpen).toBe(false)
      const second = await ws.handoffForReview({ message: 'round one again' })
      expect(second.alreadyOpen).toBe(true)
      expect(second.wait.id).toBe(first.wait.id)
      expect(await listReviewHistory(db, ws.id)).toHaveLength(1)
    })

    it('send-back closes the wait with the note; the stream stays active and the round is countable', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} unassigned review` })
      const { wait } = await ws.handoffForReview({ message: 'Review' })
      await ws.resolveWait(wait.id, { resolution: 'sent_back', note: 'Changes requested' })
      expect(ws.status).toBe('active')
      expect(await ws.getOpenWaits()).toHaveLength(0)
      const history = await listReviewHistory(db, ws.id)
      expect(history).toHaveLength(1)
      expect(history[0].resolution).toBe('sent_back')
      expect(history[0].resolutionNote).toBe('Changes requested')

      // A new handoff opens round two; closed rounds accumulate.
      await ws.handoffForReview({ message: 'Round two' })
      await ws.sendBackReview('still not right')
      expect(await listReviewHistory(db, ws.id)).toHaveLength(2)
    })

    it('send-back requires a note', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} noteless send-back` })
      await ws.handoffForReview({})
      await expect(ws.sendBackReview('')).rejects.toThrow(/note/i)
      await expect(ws.sendBackReview('   ')).rejects.toThrow(/note/i)
      // The wait is still open — nothing closed without a note.
      expect((await ws.getOpenWaits()).some((w) => w.type === 'review')).toBe(true)
    })

    it('approve without an open review wait throws and changes nothing', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} no wait approve` })
      await expect(ws.approveReview()).rejects.toThrow(/no open review wait/i)
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')
    })

    it('transactional approve: an abort between wait-close+terminalize and commit leaves NEITHER', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} atomic approve` })
      await ws.handoffForReview({ message: 'Review' })

      // Abort the transaction AFTER the wait-close and the done-transition
      // both executed — the deterministic crash window.
      await expect(
        ws.approveReview({
          testHooks: {
            beforeCommit: async () => {
              throw new Error('simulated crash before commit')
            },
          },
        })
      ).rejects.toThrow('simulated crash before commit')

      // Neither took effect: status untouched, review wait still OPEN.
      const fresh = await WorkStream.mustFind(ws.id)
      expect(fresh.status).toBe('active')
      const open = await fresh.getOpenWaits()
      expect(open.some((w) => w.type === 'review' && w.closedAt === null)).toBe(true)
      expect((await listReviewHistory(db, ws.id)).filter((w) => w.resolution === 'approved')).toHaveLength(0)

      // And a clean approve afterwards still works (no poisoned state).
      await ws.reload()
      await ws.approveReview()
      expect(ws.status).toBe('done')
    })
  })

  describe('resolveWait (typed wait resolution)', () => {
    async function resolveErrorCode(promise: Promise<unknown>): Promise<string> {
      try {
        await promise
      } catch (error) {
        expect(error).toBeInstanceOf(WorkStreamWaitResolveError)
        return (error as WorkStreamWaitResolveError).code
      }
      throw new Error('expected resolveWait to reject')
    }

    it('review + sent_back requires a non-empty note, then closes exactly that wait with the note', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} resolve sent_back` })
      const { wait } = await ws.handoffForReview({ message: 'round one' })

      expect(await resolveErrorCode(ws.resolveWait(wait.id, { resolution: 'sent_back' }))).toBe('invalid_resolution')
      expect(await resolveErrorCode(ws.resolveWait(wait.id, { resolution: 'sent_back', note: '   ' }))).toBe(
        'invalid_resolution'
      )
      // Nothing closed without a note.
      expect((await ws.getOpenWaits()).some((w) => w.id === wait.id)).toBe(true)

      const closed = await ws.resolveWait(wait.id, { resolution: 'sent_back', note: 'fix the tests' })
      expect(closed.id).toBe(wait.id)
      expect(closed.resolution).toBe('sent_back')
      expect(closed.resolutionNote).toBe('fix the tests')
      expect(ws.status).toBe('active')
      expect(await ws.getOpenWaits()).toHaveLength(0)
    })

    it('rejects invalid resolution-vs-type combos and leaves the wait open', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} invalid combos` })
      const { wait: review } = await ws.handoffForReview({ message: 'review me' })
      const manual = await ws.block({ message: 'need input' })

      expect(await resolveErrorCode(ws.resolveWait(review.id, { resolution: 'cleared' }))).toBe('invalid_resolution')
      expect(await resolveErrorCode(ws.resolveWait(manual.id, { resolution: 'approved' }))).toBe('invalid_resolution')
      expect(await resolveErrorCode(ws.resolveWait(manual.id, { resolution: 'sent_back', note: 'nope' }))).toBe(
        'invalid_resolution'
      )

      // Every invalid attempt left the waits open and the stream untouched.
      const open = await ws.getOpenWaits()
      expect(open.some((w) => w.id === review.id)).toBe(true)
      expect(open.some((w) => w.id === manual.id)).toBe(true)
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')
    })

    it('question and dependency waits are never resolvable through resolveWait', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} system waits` })
      const { wait: question } = await openWait(db, { workStreamId: ws.id, type: 'question' })
      const { wait: dependency } = await openWait(db, {
        workStreamId: ws.id,
        type: 'dependency',
        referenceId: crypto.randomUUID(),
      })

      for (const resolution of ['approved', 'sent_back', 'cleared'] as const) {
        expect(await resolveErrorCode(ws.resolveWait(question.id, { resolution, note: 'n' }))).toBe(
          'invalid_resolution'
        )
        expect(await resolveErrorCode(ws.resolveWait(dependency.id, { resolution, note: 'n' }))).toBe(
          'invalid_resolution'
        )
      }
      expect(await ws.getOpenWaits()).toHaveLength(2)
    })

    it('rejects wrong-stream and already-closed wait ids with typed errors', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} target stream` })
      const other = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} other stream` })
      const otherWait = await other.block({ message: 'other stream input' })

      expect(await resolveErrorCode(ws.resolveWait(otherWait.id, { resolution: 'cleared' }))).toBe('wait_not_found')
      expect(await resolveErrorCode(ws.resolveWait(crypto.randomUUID(), { resolution: 'cleared' }))).toBe(
        'wait_not_found'
      )
      // The other stream's wait survived the wrong-stream attempt.
      expect((await other.getOpenWaits()).some((w) => w.id === otherWait.id)).toBe(true)

      const mine = await ws.block({ message: 'mine' })
      await ws.resolveWait(mine.id, { resolution: 'cleared' })
      expect(await resolveErrorCode(ws.resolveWait(mine.id, { resolution: 'cleared' }))).toBe('wait_already_closed')
    })

    it('normalizes explicit review close races and terminal streams as typed conflicts', async () => {
      const raced = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} explicit close race` })
      const { wait: review } = await raced.handoffForReview({ message: 'race me' })
      await closeOpenWaits(db, { waitId: review.id }, 'sent_back', {
        note: 'other winner',
      })
      expect(await resolveErrorCode(raced.approveReview({ waitId: review.id }))).toBe('wait_already_closed')

      const terminal = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} terminal resolution`,
      })
      const manual = await terminal.block({ message: 'input before terminal transition' })
      await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, terminal.id))
      expect(await resolveErrorCode(terminal.resolveWait(manual.id, { resolution: 'cleared' }))).toBe(
        'work_stream_terminal'
      )
      expect((await terminal.getOpenWaits()).some((wait) => wait.id === manual.id)).toBe(true)
    })

    it('manual + cleared closes exactly that wait and delivers the note to the assignee', async () => {
      const worker = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} targeted clear`,
        assigneeAgentId: worker.id,
        agentIds: [worker.id],
      })
      const first = await ws.block({ message: 'first input request' })
      const second = await ws.block({ message: 'second input request' })
      await db.delete(inbox).where(eq(inbox.recipientId, worker.id))

      const closed = await ws.resolveWait(first.id, { resolution: 'cleared', note: 'use the staging key' })
      expect(closed.id).toBe(first.id)
      expect(closed.resolution).toBe('cleared')
      expect(closed.resolutionNote).toBe('use the staging key')

      // Targeted: the OTHER manual wait is untouched (unblock() remains the clear-all verb).
      const open = await ws.getOpenWaits()
      expect(open.map((w) => w.id)).toEqual([second.id])

      // The note reaches the assignee like an unblock does.
      const content = await getWorkStreamInboxContent(ws.id, 'unblocked', worker.id)
      expect(content).toContain('use the staging key')
    })
  })

  describe('durable side effects', () => {
    it('creates assignment inbox directly and event fallback does not duplicate', async () => {
      const manager = await createTestAgent()
      const worker = await createTestAgent()
      await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, testSquad.id))

      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Assigned`,
      })

      await ws.update({ assigneeAgentId: worker.id })

      expect(await countWorkStreamInbox(ws.id, 'assigned', worker.id)).toBe(1)
      eventEmitter.emit('workStream.assigned', { workStreamId: ws.id, squadId: ws.squadId, agentId: worker.id })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await countWorkStreamInbox(ws.id, 'assigned', worker.id)).toBe(1)
    })

    it('creates lifecycle inbox directly and allows a later repeated transition', async () => {
      const manager = await createTestAgent()
      const worker = await createTestAgent()
      await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, testSquad.id))
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Blocked`,
        assigneeAgentId: worker.id,
      })

      await ws.block({ message: 'help' })
      expect(await countWorkStreamInbox(ws.id, 'blocked', manager.id)).toBe(1)
      eventEmitter.emit('workStream.blocked', { workStreamId: ws.id, squadId: ws.squadId })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await countWorkStreamInbox(ws.id, 'blocked', manager.id)).toBe(1)

      await ws.unblock({ note: 'ok' })
      await ws.block({ message: 'again' })
      expect(await countWorkStreamInbox(ws.id, 'blocked', manager.id)).toBe(2)
    })

    it('includes next steps in the done notification to the manager', async () => {
      const manager = await createTestAgent()
      await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, testSquad.id))
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Done next steps`,
      })

      await ws.update({ status: 'done', nextSteps: 'Scope a follow-up for monitoring.' })

      const rows = await db
        .select({ content: inbox.content, metadata: inbox.metadata })
        .from(inbox)
        .where(
          and(
            eq(inbox.recipientId, manager.id),
            sql`${inbox.metadata}->>'workStreamId' = ${ws.id}`,
            sql`${inbox.metadata}->>'event' = 'done'`
          )
        )
      expect(rows).toHaveLength(1)
      expect(rows[0].content).toContain('Next steps: Scope a follow-up for monitoring.')
      expect((rows[0].metadata as Record<string, unknown>).nextSteps).toBe('Scope a follow-up for monitoring.')
    })

    it('keeps lifecycle event fallbacks from duplicating direct notifications', async () => {
      const manager = await createTestAgent()
      const worker = await createTestAgent()
      await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, testSquad.id))
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Lifecycle`,
        assigneeAgentId: worker.id,
      })

      await ws.handoffForReview({ message: 'review' })
      expect(await countWorkStreamInbox(ws.id, 'review', manager.id)).toBe(1)
      eventEmitter.emit('workStream.review', { workStreamId: ws.id, squadId: ws.squadId })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await countWorkStreamInbox(ws.id, 'review', manager.id)).toBe(1)

      await ws.sendBackReview('changes please')
      expect(await countWorkStreamInbox(ws.id, 'reviewed', worker.id)).toBe(1)
      eventEmitter.emit('workStream.responded', {
        workStreamId: ws.id,
        squadId: ws.squadId,
        resolvedWaitType: 'review',
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await countWorkStreamInbox(ws.id, 'reviewed', worker.id)).toBe(1)

      await ws.update({ status: 'done' })
      expect(await countWorkStreamInbox(ws.id, 'done', manager.id)).toBe(1)
      eventEmitter.emit('workStream.done', { workStreamId: ws.id, squadId: ws.squadId, agentIds: [] })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await countWorkStreamInbox(ws.id, 'done', manager.id)).toBe(1)

      const cancelWs = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Cancel`,
        agentIds: [worker.id],
      })
      await cancelWs.cancel()
      expect(await countWorkStreamInbox(cancelWs.id, 'canceled', manager.id)).toBe(1)
      expect(await countWorkStreamInbox(cancelWs.id, 'canceled', worker.id)).toBe(1)
      eventEmitter.emit('workStream.canceled', {
        workStreamId: cancelWs.id,
        squadId: cancelWs.squadId,
        agentIds: [worker.id],
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await countWorkStreamInbox(cancelWs.id, 'canceled', manager.id)).toBe(1)
      expect(await countWorkStreamInbox(cancelWs.id, 'canceled', worker.id)).toBe(1)
    })

    it('cleans up agents directly on done, canceled, and removeAgent transitions', async () => {
      const doneAgent = await createTestAgent()
      const doneWs = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Done cleanup`,
        agentIds: [doneAgent.id],
      })
      await doneWs.update({ status: 'done' })
      expect(await Agent.mustFind(doneAgent.id)).toMatchObject({
        status: 'dormant',
        dormantAt: expect.any(Date),
        terminatedAt: null,
      })

      const canceledAgent = await createTestAgent()
      const canceledWs = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Cancel cleanup`,
        agentIds: [canceledAgent.id],
      })
      await canceledWs.cancel()
      expect(await Agent.mustFind(canceledAgent.id)).toMatchObject({
        status: 'dormant',
        dormantAt: expect.any(Date),
        terminatedAt: null,
      })

      const removedAgent = await createTestAgent()
      const removeWs = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Remove cleanup`,
        agentIds: [removedAgent.id],
      })
      await removeWs.removeAgent(removedAgent.id)
      expect(await Agent.mustFind(removedAgent.id)).toMatchObject({
        status: 'dormant',
        dormantAt: expect.any(Date),
        terminatedAt: null,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // owner
  // ---------------------------------------------------------------------------

  describe('ownerAgentId', () => {
    it('persists ownerAgentId from create input and defaults to the squad manager', async () => {
      const owner = await createTestAgent()
      const owned = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Owned`,
        ownerAgentId: owner.id,
      })
      const unowned = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} Unowned` })

      expect(owned.ownerAgentId).toBe(owner.id)
      expect(owned.toJson().ownerAgentId).toBe(owner.id)
      // An ownerless creation routes to the squad manager (see 'owner
      // defaulting at creation') so somebody is always notified of the new
      // stream; null is reserved for squads with no manager at all.
      const [squadRow] = await db.select({ m: squads.managerAgentId }).from(squads).where(eq(squads.id, testSquad.id))
      expect(unowned.ownerAgentId).toBe(squadRow.m)
    })

    it('updates and clears ownerAgentId through the normal update flow', async () => {
      const owner = await createTestAgent()
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} Reassign owner` })

      await ws.update({ ownerAgentId: owner.id })
      const reloaded = await WorkStream.find(ws.id)
      expect(reloaded!.ownerAgentId).toBe(owner.id)

      await ws.update({ ownerAgentId: null })
      expect(ws.ownerAgentId).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // source links
  // ---------------------------------------------------------------------------

  describe('metadata.sources', () => {
    it('persists source links on create and fills addedAt', async () => {
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} Handle refund`,
        metadata: {
          sources: [
            {
              kind: 'slack_thread',
              url: 'https://acme.slack.com/archives/C0/p1700000000000000',
              snippet: 'Customer asks for refund',
            },
          ],
        },
      })

      expect(ws.metadata.sources).toHaveLength(1)
      expect((ws.metadata.sources as Record<string, unknown>[])[0]).toMatchObject({
        kind: 'slack_thread',
        url: 'https://acme.slack.com/archives/C0/p1700000000000000',
        snippet: 'Customer asks for refund',
        addedAt: expect.any(String),
      })
    })

    it('does not warn for memory document source links that resolve', async () => {
      const { IndexingService } = await import('../services/memory/indexer/IndexingService')
      await IndexingService.instance().indexFile({
        squadId: testSquad.id,
        path: '/memory/work-log/refund.md',
        content: '---\nkind: reference\ntitle: Refund\n---\n\nRefund notes',
      })

      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} existing memory source`,
        metadata: {
          sources: [{ kind: 'memory_document', sourceSquadId: testSquad.id, path: '/memory/work-log/refund.md' }],
        },
      })

      expect(ws.metadata.sourceWarnings).toBeUndefined()
    })

    it('adds non-blocking warnings for unresolved memory document source links on create and update', async () => {
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} unresolved memory source`,
        metadata: {
          sources: [{ kind: 'memory_document', sourceSquadId: testSquad.id, path: '/memory/missing.md' }],
        },
      })

      expect(ws.metadata.sources).toHaveLength(1)
      expect(ws.metadata.sourceWarnings).toEqual([
        {
          code: 'memory_document_not_found',
          message: `Memory document source not found: ${testSquad.id} /memory/missing.md`,
          sourceIndex: 0,
          sourceKind: 'memory_document',
          sourceSquadId: testSquad.id,
          path: '/memory/missing.md',
        },
      ])

      await ws.update({
        metadata: {
          sources: [{ kind: 'memory_document', sourceSquadId: testSquad.id, path: '/memory/still-missing.md' }],
        },
      })

      expect(ws.metadata.sourceWarnings).toEqual([
        expect.objectContaining({
          code: 'memory_document_not_found',
          sourceIndex: 0,
          path: '/memory/still-missing.md',
        }),
      ])
    })

    it('clears derived source warnings when sources are deleted', async () => {
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: `${testPrefix} delete sources and warnings`,
        metadata: {
          sources: [{ kind: 'memory_document', sourceSquadId: testSquad.id, path: '/memory/missing.md' }],
        },
      })
      expect(ws.metadata.sources).toHaveLength(1)
      expect(ws.metadata.sourceWarnings).toHaveLength(1)

      await ws.update({ metadata: { sources: null } })

      expect(ws.metadata).not.toHaveProperty('sources')
      expect(ws.metadata).not.toHaveProperty('sourceWarnings')
    })

    it('rejects malformed source links', async () => {
      await expect(
        WorkStream.create({
          squadId: testSquad.id,
          title: `${testPrefix} malformed source`,
          metadata: { sources: [{ kind: 'memory_document' }] },
        })
      ).rejects.toThrow(/path|sourceSquadId/i)
    })

    it('rejects non-array metadata.sources', async () => {
      await expect(
        WorkStream.create({
          squadId: testSquad.id,
          title: `${testPrefix} malformed sources`,
          metadata: { sources: { kind: 'url', url: 'https://example.com' } },
        })
      ).rejects.toThrow(/sources must be an array/i)
    })
  })

  // ---------------------------------------------------------------------------
  // completion modes and typed fields
  // ---------------------------------------------------------------------------

  describe('completion modes and typed fields', () => {
    it('persists a stable completion time across later terminal edits', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Stable completion`,
      })

      expect(ws.toJson().completedAt).toBeUndefined()
      await ws.update({ status: 'done' })
      const completedAt = ws.toJson().completedAt
      expect(completedAt).toBeInstanceOf(Date)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe(completedAt!.toISOString())

      await ws.update({
        title: `${testPrefix} Stable completion edited`,
        metadata: { github: { pr: 42 } },
      })

      expect(ws.toJson().completedAt).toEqual(completedAt)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe(completedAt!.toISOString())
      expect(ws.metadata.github).toEqual({ pr: 42 })
    })

    it('keeps canonical completion stable when terminal membership changes later', async () => {
      const member = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Stable completion membership`,
      })
      await ws.update({ status: 'done' })
      const completedAt = ws.toJson().completedAt

      await ws.update({ agentIds: [member.id] })

      expect(ws.agentIds).toEqual([member.id])
      expect(ws.toJson().completedAt).toEqual(completedAt)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe(completedAt!.toISOString())
    })

    it('persists completion time when approving a review', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Approved completion`,
      })
      await ws.handoffForReview({ message: 'Ready' })

      await ws.approveReview()

      const completedAt = ws.toJson().completedAt
      expect(completedAt).toBeInstanceOf(Date)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe(completedAt!.toISOString())
    })

    it('uses updatedAt for legacy terminals without a reserved completion time', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Legacy completion`,
      })
      const legacyUpdatedAt = new Date('2026-01-02T03:04:05.000Z')
      await db
        .update(workStreams)
        .set({ status: 'done', metadata: { legacy: true }, updatedAt: legacyUpdatedAt })
        .where(eq(workStreams.id, ws.id))
      await ws.reload()

      expect(ws.toJson().completedAt).toEqual(legacyUpdatedAt)
      expect(ws.metadata).not.toHaveProperty('completion')

      await ws.update({ title: `${testPrefix} Legacy completion edited` })

      expect(ws.toJson().completedAt).toEqual(legacyUpdatedAt)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe(legacyUpdatedAt.toISOString())
    })

    it('preserves malformed terminal completion metadata as fail-closed across edits', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} Malformed completion` })
      await db
        .update(workStreams)
        .set({
          status: 'done',
          metadata: { completion: { completedAt: 'not-a-date' } },
          updatedAt: new Date('2026-01-03T00:00:00.000Z'),
        })
        .where(eq(workStreams.id, ws.id))
      await ws.reload()

      expect(ws.toJson().completedAt).toBeInstanceOf(Date)
      expect(Number.isNaN(ws.toJson().completedAt!.getTime())).toBe(true)
      await ws.update({ title: `${testPrefix} Malformed completion edited` })
      expect(Number.isNaN(ws.toJson().completedAt!.getTime())).toBe(true)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe('not-a-date')
    })

    it('uses locked terminal state when stabilizing a stale instance completion time', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Stale completion`,
      })
      const terminalUpdatedAt = new Date('2026-01-03T03:04:05.000Z')
      await db
        .update(workStreams)
        .set({ status: 'done', metadata: { legacy: true }, updatedAt: terminalUpdatedAt })
        .where(eq(workStreams.id, ws.id))
      expect(ws.status).toBe('active')

      await ws.update({ metadata: { github: { pr: 43 } } })

      expect(ws.status).toBe('done')
      expect(ws.toJson().completedAt).toEqual(terminalUpdatedAt)
      expect((ws.metadata.completion as Record<string, unknown>).completedAt).toBe(terminalUpdatedAt.toISOString())
    })

    it('removes the reserved completion time when reopening a terminal stream', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Reopened completion`,
      })
      await ws.update({ status: 'done' })
      expect(ws.toJson().completedAt).toBeInstanceOf(Date)

      await ws.reopen()

      expect(ws.toJson().completedAt).toBeUndefined()
      expect(ws.metadata).not.toHaveProperty('completion')
    })

    it('does not expose a completion time for nonterminal streams', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Active completion`,
        metadata: { completion: { completedAt: '2026-01-02T03:04:05.000Z' } },
      })

      expect(ws.status).toBe('active')
      expect(ws.toJson().completedAt).toBeUndefined()
    })

    it('defaults completionMode to pr-merge when unset', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} Default mode` })

      expect(ws.completionMode).toBe('pr-merge')
      expect(ws.branch).toBeUndefined()
      expect(ws.baseBranch).toBeUndefined()
    })

    it('persists completionMode and git fields via create', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Typed fields create`,
        completionMode: 'review-approval',
        branch: 'feat-review',
        worktree: '/tmp/tau/feat-review',
        baseBranch: 'main',
      })

      expect(ws.completionMode).toBe('review-approval')
      expect(ws.branch).toBe('feat-review')
      expect(ws.worktree).toBe('/tmp/tau/feat-review')
      expect(ws.baseBranch).toBe('main')
      expect(ws.metadata).toEqual({
        completion: { mode: 'review-approval' },
        git: { branch: 'feat-review', worktree: '/tmp/tau/feat-review', baseBranch: 'main' },
      })
    })

    it('reads pr-auto-merge from a stored legacy stream', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Auto merge mode`,
        completionMode: 'pr-auto-merge',
      })

      expect(ws.completionMode).toBe('pr-auto-merge')
      expect(ws.metadata).toEqual({ completion: { mode: 'pr-auto-merge' } })
    })

    it('updates typed fields without clobbering unrelated metadata', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Preserve metadata`,
        metadata: { github: { issue: '123' } },
        completionMode: 'pr-merge',
      })

      await ws.update({ completionMode: 'direct-merge', baseBranch: 'main' })

      expect(ws.completionMode).toBe('direct-merge')
      expect(ws.baseBranch).toBe('main')
      expect(ws.metadata).toEqual({
        github: { issue: '123' },
        completion: { mode: 'direct-merge' },
        git: { baseBranch: 'main' },
      })
    })

    it('recursively merges metadata and applies typed fields last', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Metadata precedence`,
        metadata: {
          github: { issue: '7', repo: 'keep/repo' },
          completion: { mode: 'pr-merge' },
          labels: ['old'],
          outside: 'keep',
        },
      })

      await ws.update({
        metadata: { github: { issue: '8' }, completion: null, labels: ['new'] },
        completionMode: 'direct-merge',
      })

      expect(ws.completionMode).toBe('direct-merge')
      expect(ws.metadata).toEqual({
        github: { issue: '8', repo: 'keep/repo' },
        completion: { mode: 'direct-merge' },
        labels: ['new'],
        outside: 'keep',
      })
    })

    it('returns pr-merge default for unrecognized stored mode', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Unknown mode`,
        metadata: { completion: { mode: 'something-else' } },
      })

      expect(ws.completionMode).toBe('pr-merge')
    })

    it('toJson() exposes derived typed fields', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Json typed fields`,
        completionMode: 'direct-merge',
        branch: 'feat-x',
        baseBranch: 'main',
      })

      const json = ws.toJson()

      expect(json.completionMode).toBe('direct-merge')
      expect(json.branch).toBe('feat-x')
      expect(json.baseBranch).toBe('main')
    })
  })

  // ---------------------------------------------------------------------------
  // assignment notifications
  // ---------------------------------------------------------------------------

  describe('assignment notifications', () => {
    it('persists and delivers an inbox handoff when directly assigning a work stream', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Direct handoff`,
        agentIds: [agent.id],
      })

      await ws.update({
        status: 'active',
        assigneeAgentId: agent.id,
        handoffMessage: 'Please continue implementation.',
      })

      const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
      expect(rows).toHaveLength(1)
      expect(rows[0].subject).toBe(`Work stream handed off to you: #${ws.number} · ${ws.title}`)
      expect(rows[0].content).toContain('Please continue implementation.')
      expect(rows[0].deliveredAt).not.toBeNull()

      const execution = await agent.getActiveExecution()
      expect(execution?.status).toBe('queued')
    })

    it('defers queued reassignment delivery until promotion', async () => {
      await testSquad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} holder` })
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} queued handoff`,
        agentIds: [agent.id],
      })
      expect(ws.status).toBe('queued')

      await ws.update({ assigneeAgentId: agent.id, handoffMessage: 'Review when admitted.' })
      const prePromotionInbox = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
      const prePromotionExecution = await agent.getActiveExecution()
      expect({
        streamStatus: (await WorkStream.mustFind(ws.id)).status,
        inboxCount: prePromotionInbox.length,
        executionStatus: prePromotionExecution?.status ?? null,
      }).toEqual({ streamStatus: 'queued', inboxCount: 0, executionStatus: null })

      await holder.update({ status: 'done' })
      await promoteEligibleQueuedStreams(testSquad.id)
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))).toHaveLength(1)
      expect((await agent.getActiveExecution())?.status).toBe('queued')
    })

    it('records queued reassignment behind dependency, manual, and review waits without delivery', async () => {
      await testSquad.update({ maxConcurrentWorkStreams: 1 })
      const holder = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} wait holder` })
      const agent = await createTestAgent()
      const dependency = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} dependency wait`,
        agentIds: [agent.id],
        dependsOn: [holder.id],
      })
      const manual = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} manual wait`,
        agentIds: [agent.id],
      })
      const review = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} review wait`,
        agentIds: [agent.id],
      })
      await manual.block({ message: 'blocked' })
      await review.handoffForReview({ message: 'review' })
      for (const ws of [dependency, manual, review]) {
        await ws.update({ assigneeAgentId: agent.id, handoffMessage: 'Deferred' })
        expect((await WorkStream.mustFind(ws.id)).status).toBe('queued')
      }
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))).toHaveLength(0)
      expect(await agent.getActiveExecution()).toBeNull()
    })

    it('dedupes assignment notifications from event fallback handlers', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Dedupe handoff`,
        agentIds: [agent.id],
      })

      await ws.update({
        status: 'active',
        assigneeAgentId: agent.id,
        handoffMessage: 'Same handoff.',
      })

      const { notifyWorkStreamAssigned } = await import('../services/squad/work-stream-notifications')
      await notifyWorkStreamAssigned({ workStreamId: ws.id, squadId: ws.squadId, agentId: agent.id })

      const rows = await db.select().from(inbox).where(eq(inbox.recipientId, agent.id))
      expect(rows).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // cancellation
  // ---------------------------------------------------------------------------

  describe('done-guard (spec §5): open waits block completion', () => {
    it('rejects done with an open review wait, naming it; resolving the wait unblocks completion', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} done guard review` })
      const { wait } = await ws.handoffForReview({ message: 'review me' })

      let caught: unknown
      await ws.update({ status: 'done' }).catch((error) => (caught = error))
      expect(caught).toBeInstanceOf(WorkStreamOpenWaitsError)
      expect((caught as Error).message).toMatch(/resolve or cancel the open waits/i)
      expect((caught as Error).message).toContain(wait.id)
      expect((caught as Error).message).toContain('review')

      // Nothing changed: still active, wait still open.
      const fresh = await WorkStream.mustFind(ws.id)
      expect(fresh.status).toBe('active')
      expect((await fresh.getOpenWaits()).map((w) => w.id)).toContain(wait.id)

      await fresh.resolveWait(wait.id, { resolution: 'sent_back', note: 'checked, finishing up' })
      await fresh.update({ status: 'done' })
      expect(fresh.status).toBe('done')
    })

    it('rejects done with an open manual wait; clearing it unblocks completion', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} done guard manual` })
      const wait = await ws.block({ message: 'need input' })

      let caught: unknown
      await ws.update({ status: 'done' }).catch((error) => (caught = error))
      expect(caught).toBeInstanceOf(WorkStreamOpenWaitsError)
      expect((caught as Error).message).toContain(wait.id)
      expect((caught as Error).message).toContain('manual')
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')

      await ws.resolveWait(wait.id, { resolution: 'cleared' })
      await ws.update({ status: 'done' })
      expect(ws.status).toBe('done')
    })

    it('cancel still force-clears open waits (abandonment discards conversations)', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} cancel clears` })
      await ws.block({ message: 'pending input' })
      await ws.handoffForReview({ message: 'pending review' })
      await ws.cancel()
      expect(ws.status).toBe('canceled')
      expect(await ws.getOpenWaits()).toHaveLength(0)
      const history = await listReviewHistory(db, ws.id)
      expect(history[0].resolution).toBe('cleared')
    })
  })

  describe('completesOnApproval (spec §4)', () => {
    async function readContinuation(workStreamId: string) {
      const [row] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, workStreamId))
      return row
    }

    it('defaults true: approving the review completes the stream in one transaction', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} completing review` })
      const { wait } = await ws.handoffForReview({ message: 'final review' })
      expect(wait.completesOnApproval).toBe(true)
      await ws.resolveWait(wait.id, { resolution: 'approved' })
      expect(ws.status).toBe('done')
      expect(
        await db.select().from(schema.worktreeCleanupJobs).where(eq(schema.worktreeCleanupJobs.workStreamId, ws.id))
      ).toHaveLength(1)
    })

    it('false: approval resolves the wait only — the stream continues, continuation resets, note delivered', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} checkpoint review`,
        assigneeAgentId: agent.id,
      })
      const before = await readContinuation(ws.id)
      const { wait } = await ws.handoffForReview({ message: 'checkpoint', completesOnApproval: false })
      expect(wait.completesOnApproval).toBe(false)

      await ws.resolveWait(wait.id, { resolution: 'approved', note: 'looks good so far' })

      // Stream continues; the wait is closed approved with the note.
      expect(ws.status).toBe('active')
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')
      expect(await ws.getOpenWaits()).toHaveLength(0)
      const history = await listReviewHistory(db, ws.id)
      expect(history).toHaveLength(1)
      expect(history[0].resolution).toBe('approved')
      expect(history[0].resolutionNote).toBe('looks good so far')

      // Work resumes: fresh continuation retry budget (observable reset).
      const after = await readContinuation(ws.id)
      expect(after.generation).toBe(before.generation + 1)

      // Notified like a resolved wait (the assignee gets the note).
      expect(await countWorkStreamInbox(ws.id, 'reviewed', agent.id)).toBe(1)
    })

    it('a later completing review still completes after a checkpoint round', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} checkpoint then final` })
      const first = await ws.handoffForReview({ message: 'checkpoint', completesOnApproval: false })
      await ws.resolveWait(first.wait.id, { resolution: 'approved' })
      expect(ws.status).toBe('active')

      const second = await ws.handoffForReview({ message: 'final' })
      expect(second.alreadyOpen).toBe(false)
      expect(second.wait.completesOnApproval).toBe(true)
      await ws.resolveWait(second.wait.id, { resolution: 'approved' })
      expect(ws.status).toBe('done')
    })
  })

  describe('approval notes (spec §4b)', () => {
    async function inboxContents(workStreamId: string, event: string, recipientId: string): Promise<string[]> {
      const rows = await db
        .select({ content: inbox.content })
        .from(inbox)
        .where(
          and(
            eq(inbox.recipientId, recipientId),
            sql`${inbox.metadata}->>'workStreamId' = ${workStreamId}`,
            sql`${inbox.metadata}->>'event' = ${event}`
          )
        )
      return rows.map((r) => r.content)
    }

    it('completing approval records the note on the wait AND delivers it with the completion notice', async () => {
      const owner = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} approve note completing`,
        ownerAgentId: owner.id,
      })
      const { wait } = await ws.handoffForReview({ message: 'final review' })

      await ws.resolveWait(wait.id, { resolution: 'approved', note: 'ship it — great work' })

      expect(ws.status).toBe('done')
      const history = await listReviewHistory(db, ws.id)
      expect(history[0].resolution).toBe('approved')
      expect(history[0].resolutionNote).toBe('ship it — great work')

      const notices = await inboxContents(ws.id, 'done', owner.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain('Approval note: ship it — great work')
    })

    it('checkpoint approval records the note on the wait AND delivers it to the assignee', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} approve note checkpoint`,
        assigneeAgentId: agent.id,
      })
      const { wait } = await ws.handoffForReview({ message: 'checkpoint', completesOnApproval: false })

      await ws.resolveWait(wait.id, { resolution: 'approved', note: 'direction confirmed' })

      expect(ws.status).toBe('active')
      const history = await listReviewHistory(db, ws.id)
      expect(history[0].resolutionNote).toBe('direction confirmed')

      const notices = await inboxContents(ws.id, 'reviewed', agent.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain('direction confirmed')
    })

    it('approve without a note stays valid (no note recorded, plain completion notice)', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} approve noteless` })
      const { wait } = await ws.handoffForReview({ message: 'final' })
      await ws.resolveWait(wait.id, { resolution: 'approved' })
      expect(ws.status).toBe('done')
      expect((await listReviewHistory(db, ws.id))[0].resolutionNote).toBeNull()
    })
  })

  describe('reopen (spec §6)', () => {
    it('reopen from done re-enters admission, promotes under a free slot, clears completedAt, and notifies', async () => {
      const owner = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} reopen free slot`,
        ownerAgentId: owner.id,
      })
      await ws.update({ status: 'done' })
      expect(ws.toJson().completedAt).toBeInstanceOf(Date)

      const events: unknown[] = []
      const off = eventEmitter.on('workStream.reopened', (data) => events.push(data))
      try {
        await ws.reopen()
      } finally {
        off()
      }

      // Unlimited cap: best-effort promotion admits it straight to active.
      expect(ws.status).toBe('active')
      expect(ws.toJson().completedAt).toBeUndefined()
      expect(ws.metadata).not.toHaveProperty('completion')
      // actorAgentId is null: this reopen came from the entity API with no
      // acting agent, so every recipient is notified (the historical default).
      expect(events).toEqual([
        { workStreamId: ws.id, squadId: testSquad.id, previousStatus: 'done', actorAgentId: null },
      ])
      expect(await countWorkStreamInbox(ws.id, 'reopened', owner.id)).toBe(1)
    })

    it('reopen under a full cap re-enters admission and stays queued', async () => {
      await testSquad.update({ maxConcurrentWorkStreams: 0 })
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} reopen full cap` })
      expect(ws.status).toBe('queued')
      await ws.update({ status: 'done' })

      await ws.reopen()

      expect(ws.status).toBe('queued')
      expect((await WorkStream.mustFind(ws.id)).status).toBe('queued')
      expect(ws.toJson().completedAt).toBeUndefined()
    })

    it('reopen works from canceled', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} reopen canceled` })
      await ws.cancel()
      await ws.reopen()
      expect(ws.status).toBe('active')
      expect(ws.toJson().completedAt).toBeUndefined()
    })

    it('reopen is rejected from active and queued', async () => {
      const active = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} reopen active` })
      await expect(active.reopen()).rejects.toThrow(WorkStreamNotReopenableError)
      expect((await WorkStream.mustFind(active.id)).status).toBe('active')

      await testSquad.update({ maxConcurrentWorkStreams: 0 })
      const queued = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} reopen queued` })
      expect(queued.status).toBe('queued')
      await expect(queued.reopen()).rejects.toThrow(WorkStreamNotReopenableError)
    })

    it('re-syncs dependency waits: done deps stay satisfied; a not-done dep reopens the wait and blocks admission', async () => {
      const dep = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} reopen dep` })
      await dep.update({ status: 'done' })
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} reopen dependent`,
        dependsOn: [dep.id],
      })
      await ws.update({ status: 'done' })

      // Dependency still done at reopen time: no dependency wait, admitted.
      await ws.reopen()
      expect((await ws.getOpenWaits()).filter((w) => w.type === 'dependency')).toHaveLength(0)
      expect(ws.status).toBe('active')

      // Finish again, reopen the DEPENDENCY, then reopen the dependent: the
      // dependency is no longer done, so its wait reopens and blocks
      // admission even though slots are free.
      await ws.update({ status: 'done' })
      await dep.reopen()
      await ws.reopen()
      const depWaits = (await ws.getOpenWaits()).filter((w) => w.type === 'dependency')
      expect(depWaits).toHaveLength(1)
      expect(depWaits[0].referenceId).toBe(dep.id)
      expect(ws.status).toBe('queued')
    })

    it('terminal-status PATCH backdoor is closed: no raw status writes out of done/canceled', async () => {
      const done = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} backdoor done` })
      await done.update({ status: 'done' })
      await expect(done.update({ status: 'active' })).rejects.toThrow(/use reopen/i)
      await expect(done.update({ status: 'queued' })).rejects.toThrow(/use reopen/i)
      await expect(done.update({ status: 'canceled' })).rejects.toThrow(/use reopen/i)
      expect((await WorkStream.mustFind(done.id)).status).toBe('done')

      // Same-status write stays a valid no-op (preserves completedAt).
      const completedAt = done.toJson().completedAt
      await done.update({ status: 'done' })
      expect(done.toJson().completedAt).toEqual(completedAt)
    })
  })

  describe('WorkStream.cancel', () => {
    it('cancels an active work stream and emits workStream.canceled', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Cancel me`,
        agentIds: [agent.id],
        assigneeAgentId: agent.id,
      })
      await ws.block({ message: 'stale' })

      const events: unknown[] = []
      const unsub = eventEmitter.on('workStream.canceled', (data) => events.push(data))
      await ws.cancel()
      unsub()

      expect(ws.status).toBe('canceled')
      expect(ws.assigneeAgentId).toBeNull()
      // Terminal transitions clear remaining open waits ('cleared').
      expect(await ws.getOpenWaits()).toHaveLength(0)
      expect(events).toEqual([{ workStreamId: ws.id, squadId: ws.squadId, agentIds: [agent.id], actorAgentId: null }])
    })

    it('is idempotent for already canceled work streams', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} Already canceled` })
      await ws.cancel()
      await ws.cancel()
      expect(ws.status).toBe('canceled')
    })

    it('rejects updates that would continue a canceled work stream', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} No more work` })
      await ws.cancel()

      await expect(ws.update({ status: 'active' })).rejects.toThrow(/canceled work stream/i)
      await expect(ws.update({ assigneeAgentId: agent.id })).rejects.toThrow(/canceled work stream/i)
    })

    it('terminal cleanup stops the execution before the secondary stop scan', async () => {
      const agent = await createTestAgent()
      const execution = await agent.queueExecution({ message: 'working' })
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Stop active execution`,
        agentIds: [agent.id],
        assigneeAgentId: agent.id,
      })

      const result = await ws.cancelWithSideEffects()

      expect(result.stopResults).toEqual([{ agentId: agent.id, stopped: false, reason: 'no active execution' }])
      expect(ws.status).toBe('canceled')
      const stopped = await Execution.find(execution.id)
      expect(stopped?.status).toBe('stopped')
    })

    it('persists cancellation before scanning active executions', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Cancellation ordering`,
        agentIds: [agent.id],
        assigneeAgentId: agent.id,
      })
      let statusDuringScan: string | undefined
      ws.requestStopForActiveAgentExecutions = async () => {
        statusDuringScan = (await WorkStream.mustFind(ws.id)).status
        return []
      }

      await ws.cancelWithSideEffects()

      expect(statusDuringScan).toBe('canceled')
    })

    it('cancelWithSideEffects rejects completed work streams before stop side effects', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Done no side effect`,
        agentIds: [agent.id],
        assigneeAgentId: agent.id,
      })
      await ws.update({ status: 'done' })
      await agent.reload()
      const execution = await agent.queueExecution({ message: 'working after completion' })

      await expect(ws.cancelWithSideEffects()).rejects.toThrow(/completed work stream/i)
      const stillQueued = await Execution.find(execution.id)
      expect(stillQueued?.status).toBe('queued')
    })
  })

  // ---------------------------------------------------------------------------
  // getMetrics
  // ---------------------------------------------------------------------------

  describe('WorkStream.getMetrics', () => {
    it('returns null for work stream with no agents', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} No Agents WS`,
      })

      const metrics = await ws.getMetrics()
      expect(metrics).toBeNull()
    })

    it('returns null for work stream with empty agentIds array', async () => {
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Empty Agents WS`,
        agentIds: [],
      })

      const metrics = await ws.getMetrics()
      expect(metrics).toBeNull()
    })

    it('returns zero metrics for work stream with agents but no executions', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} No Executions WS`,
        agentIds: [agent.id],
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      expect(metrics!.tokens.total).toBe(0)
      expect(metrics!.cost).toBe(0)
      expect(metrics!.executions.total).toBe(0)
      expect(metrics!.byAgent).toEqual({})
    })

    it('does not accrue runtime for settled executions missing endedAt', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} missing-ended-metrics`,
        agentIds: [agent.id],
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 10_000),
      })
      const m = await ws.getMetrics()
      expect(m!.duration.totalMs).toBe(0)
    })

    it('includes running executions in duration.totalMs', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} running-metrics`,
        agentIds: [agent.id],
      })
      const sDone = new Date(Date.now() - 60_000)
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: sDone,
        endedAt: new Date(sDone.getTime() + 30_000),
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'running',
        startedAt: new Date(Date.now() - 4_000),
      })
      const m = await ws.getMetrics()
      expect(m).not.toBeNull()
      expect(m!.duration.totalMs).toBeGreaterThanOrEqual(33_000)
      expect(m!.duration.totalMs).toBeLessThanOrEqual(40_000)
    })

    it('excludes queued executions from duration.totalMs', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} queued-only`,
        agentIds: [agent.id],
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'queued',
        startedAt: new Date(Date.now() - 10_000),
      })
      const m = await ws.getMetrics()
      expect(m!.duration.totalMs).toBe(0)
    })

    it('backfilling historical rows preserves the reported total and fills in per-execution deltas', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} backfill-metrics`,
        agentIds: [agent.id],
      })
      const legacy = (cumulative: number, cost: number) => ({
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2,
          tokens: {
            input: cumulative / 10,
            output: cumulative / 10,
            cacheRead: cumulative * 0.8,
            cacheWrite: 0,
            total: cumulative,
          },
          cost,
        },
        context: null,
      })
      const base = Date.now() - 600_000
      for (const [index, [cumulative, cost]] of (
        [
          [100_000, 1],
          [450_000, 4.5],
          [900_000, 9],
        ] as const
      ).entries()) {
        await db.insert(executions).values({
          agentId: agent.id,
          status: 'completed',
          startedAt: new Date(base + index * 60_000),
          endedAt: new Date(base + index * 60_000 + 30_000),
          usage: legacy(cumulative, cost),
        })
      }

      const before = await ws.getMetrics()
      expect(before!.tokens.total).toBe(900_000)

      const dryRun = await backfillExecutionUsage({ agentIds: [agent.id], apply: false })
      expect(dryRun.executionsUpdated).toBe(3)
      const stillLegacy = await db.select().from(executions).where(eq(executions.agentId, agent.id))
      expect(stillLegacy.every((row) => (row.usage as { delta?: unknown } | null)?.delta === undefined)).toBe(true)

      const applied = await backfillExecutionUsage({ agentIds: [agent.id], apply: true })
      expect(applied.executionsUpdated).toBe(3)

      const after = await ws.getMetrics()
      // The whole point: reconstructing deltas must not move the number.
      expect(after!.tokens.total).toBe(before!.tokens.total)
      expect(after!.cost).toBeCloseTo(before!.cost, 6)

      const rows = await db.select().from(executions).where(eq(executions.agentId, agent.id))
      const deltas = rows
        .map((row) => (row.usage as { delta?: { tokens: { total: number } } }).delta!.tokens.total)
        .sort((a, b) => a - b)
      expect(deltas).toEqual([100_000, 350_000, 450_000])

      // Running it again writes nothing.
      expect((await backfillExecutionUsage({ agentIds: [agent.id], apply: true })).executionsUpdated).toBe(0)
    })

    it('sums per-execution deltas instead of re-counting the cumulative snapshot', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} delta-metrics`,
        agentIds: [agent.id],
      })
      // One session observed three times: 100k -> 450k -> 900k cumulative.
      // Summing `stats` would report 1,450,000; the truth is 900,000.
      const rows = [
        { cumulative: 100_000, delta: 100_000, cost: 1, deltaCost: 1 },
        { cumulative: 450_000, delta: 350_000, cost: 4.5, deltaCost: 3.5 },
        { cumulative: 900_000, delta: 450_000, cost: 9, deltaCost: 4.5 },
      ]
      for (const row of rows) {
        await db.insert(executions).values({
          agentId: agent.id,
          status: 'completed',
          startedAt: new Date(Date.now() - 10_000),
          endedAt: new Date(),
          usage: {
            stats: {
              userMessages: 1,
              assistantMessages: 1,
              totalMessages: 2,
              tokens: {
                input: row.cumulative / 10,
                output: row.cumulative / 10,
                cacheRead: row.cumulative * 0.8,
                cacheWrite: 0,
                total: row.cumulative,
              },
              cost: row.cost,
            },
            context: null,
            delta: {
              tokens: {
                input: row.delta / 10,
                output: row.delta / 10,
                cacheRead: row.delta * 0.8,
                cacheWrite: 0,
                total: row.delta,
              },
              cost: row.deltaCost,
            },
          },
        })
      }

      const metrics = await ws.getMetrics()
      expect(metrics!.tokens.total).toBe(900_000)
      expect(metrics!.tokens.input).toBe(90_000)
      expect(metrics!.tokens.cacheRead).toBe(720_000)
      expect(metrics!.cost).toBeCloseTo(9, 6)
      expect(metrics!.byAgent[agent.id]!.tokens).toBe(900_000)
    })

    it('reconciles legacy cumulative rows with newer delta rows without double counting', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} mixed-era-metrics`,
        agentIds: [agent.id],
      })
      const legacy = (cumulative: number, cost: number) => ({
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cumulative },
          cost,
        },
        context: null,
      })
      for (const [cumulative, cost] of [
        [200_000, 2],
        [500_000, 5],
      ] as const) {
        await db.insert(executions).values({
          agentId: agent.id,
          status: 'completed',
          startedAt: new Date(Date.now() - 10_000),
          endedAt: new Date(),
          usage: legacy(cumulative, cost),
        })
      }
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 10_000),
        endedAt: new Date(),
        usage: {
          ...legacy(800_000, 8),
          delta: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 300_000 }, cost: 3 },
        },
      })

      const metrics = await ws.getMetrics()
      // 500k observed before deltas existed + 300k measured since = 800k.
      expect(metrics!.tokens.total).toBe(800_000)
      expect(metrics!.cost).toBeCloseTo(8, 6)
    })

    it('binds each token field key independently for legacy and delta rows', async () => {
      // Distinct values per field so a mis-bound JSON key (e.g. every field
      // reading 'total') cannot accidentally pass: legacy MAX per field plus
      // delta SUM per field, each independently.
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} field-keys`,
        agentIds: [agent.id],
      })
      const tokens = (i: number, o: number, cr: number, cw: number) => ({
        input: i,
        output: o,
        cacheRead: cr,
        cacheWrite: cw,
        total: i + o + cr + cw,
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 20_000),
        endedAt: new Date(),
        usage: {
          stats: { userMessages: 1, assistantMessages: 1, totalMessages: 2, tokens: tokens(10, 20, 30, 40), cost: 0.5 },
          context: null,
        } as any,
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 10_000),
        endedAt: new Date(),
        usage: {
          stats: {
            userMessages: 2,
            assistantMessages: 2,
            totalMessages: 4,
            tokens: tokens(1_000, 2_000, 4_000, 8_000),
            cost: 2,
          },
          context: null,
          delta: { tokens: tokens(1, 2, 4, 8), cost: 0.25 },
        } as any,
      })

      const m = await ws.getMetrics()

      expect(m!.tokens.input).toBe(10 + 1)
      expect(m!.tokens.output).toBe(20 + 2)
      expect(m!.tokens.cacheRead).toBe(30 + 4)
      expect(m!.tokens.cacheWrite).toBe(40 + 8)
      expect(m!.tokens.total).toBe(100 + 15)
      expect(m!.cost).toBeCloseTo(0.5 + 0.25, 6)
    })

    it('reconciles each agent independently when two agents mix eras differently', async () => {
      const agent1 = await createTestAgent()
      const agent2 = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} multi-agent-mixed-era`,
        agentIds: [agent1.id, agent2.id],
      })
      const legacy = (i: number, o: number, cr: number, cost: number) => ({
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2,
          tokens: { input: i, output: o, cacheRead: cr, cacheWrite: 0, total: i + o + cr },
          cost,
        },
        context: null,
      })
      // Agent 1: legacy era only, cumulative 500 tokens.
      await db.insert(executions).values({
        agentId: agent1.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 30_000),
        endedAt: new Date(),
        usage: legacy(50, 50, 400, 5) as any,
      })
      // Agent 2: legacy era 200 tokens, then a delta-era execution consuming 300.
      await db.insert(executions).values({
        agentId: agent2.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 25_000),
        endedAt: new Date(),
        usage: legacy(20, 20, 160, 2) as any,
      })
      await db.insert(executions).values({
        agentId: agent2.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 20_000),
        endedAt: new Date(),
        usage: {
          ...legacy(50, 50, 900, 5),
          delta: { tokens: { input: 30, output: 30, cacheRead: 240, cacheWrite: 0, total: 300 }, cost: 3 },
        } as any,
      })

      const metrics = await ws.getMetrics()

      // Each agent reconciles its own eras: 500 for agent1 (MAX only),
      // 200 + 300 = 500 for agent2 (MAX + SUM). Cross-agent contamination
      // (e.g. one agent's legacy snapshot anchoring the other's steps) shows
      // up immediately in these numbers.
      expect(metrics!.byAgent[agent1.id]!.tokens).toBe(500)
      expect(metrics!.byAgent[agent2.id]!.tokens).toBe(500)
      expect(metrics!.tokens.total).toBe(1_000)
      expect(metrics!.byAgent[agent1.id]!.cost).toBeCloseTo(5, 6)
      expect(metrics!.byAgent[agent2.id]!.cost).toBeCloseTo(5, 6)
      expect(metrics!.cost).toBeCloseTo(10, 6)
    })

    it('does not overflow on a cumulative total above the 32-bit integer limit', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} bigint-metrics`,
        agentIds: [agent.id],
      })
      const huge = 3_000_000_000
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 10_000),
        endedAt: new Date(),
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: huge },
            cost: 1,
          },
          context: null,
        },
      })

      const metrics = await ws.getMetrics()
      expect(metrics!.tokens.total).toBe(huge)
    })

    it('reads one agent as the LAST cumulative snapshot, not the sum of its snapshots', async () => {
      // pi's session stats are cumulative, so these two rows are the same
      // session observed twice (315 tokens, then 430 total). Summing them
      // reported 745 and was the source of the 185.3B figure seen in the UI.

      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Single Agent WS`,
        agentIds: [agent.id],
      })

      // Create executions with usage data
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 100, output: 200, cacheRead: 10, cacheWrite: 5, total: 315 },
            cost: 0.01,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 150, output: 250, cacheRead: 20, cacheWrite: 10, total: 430 },
            cost: 0.02,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      expect(metrics!.tokens.input).toBe(150)
      expect(metrics!.tokens.output).toBe(250)
      expect(metrics!.tokens.cacheRead).toBe(20)
      expect(metrics!.tokens.cacheWrite).toBe(10)
      expect(metrics!.tokens.total).toBe(430)
      expect(metrics!.cost).toBeCloseTo(0.02, 4)
      expect(metrics!.executions.total).toBe(2)
      expect(metrics!.executions.completed).toBe(2)
    })

    it('aggregates across multiple agents', async () => {
      const agent1 = await createTestAgent()
      const agent2 = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Multi Agent WS`,
        agentIds: [agent1.id, agent2.id],
      })

      // Agent 1 execution
      await db.insert(executions).values({
        agentId: agent1.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
            cost: 0.01,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      // Agent 2 execution
      await db.insert(executions).values({
        agentId: agent2.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 300, output: 300, cacheRead: 0, cacheWrite: 0, total: 600 },
            cost: 0.02,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      expect(metrics!.tokens.total).toBe(800)
      expect(metrics!.cost).toBeCloseTo(0.03, 4)
      expect(metrics!.executions.total).toBe(2)

      // Verify per-agent breakdown
      expect(metrics!.byAgent[agent1.id].tokens).toBe(200)
      expect(metrics!.byAgent[agent1.id].cost).toBeCloseTo(0.01, 4)
      expect(metrics!.byAgent[agent1.id].executions).toBe(1)

      expect(metrics!.byAgent[agent2.id].tokens).toBe(600)
      expect(metrics!.byAgent[agent2.id].cost).toBeCloseTo(0.02, 4)
      expect(metrics!.byAgent[agent2.id].executions).toBe(1)
    })

    it('counts completed and failed executions separately', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Status Count WS`,
        agentIds: [agent.id],
      })

      // One completed execution
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
            cost: 0.01,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      // One failed execution
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'failed',
        error: 'Test error',
        endedAt: new Date(),
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      expect(metrics!.executions.total).toBe(2)
      expect(metrics!.executions.completed).toBe(1)
      expect(metrics!.executions.failed).toBe(1)
    })

    it('handles executions without usage data gracefully', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} No Usage WS`,
        agentIds: [agent.id],
      })

      // Execution without usage (null usage field)
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        endedAt: new Date(),
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      expect(metrics!.tokens.total).toBe(0)
      expect(metrics!.cost).toBe(0)
      expect(metrics!.executions.total).toBe(1)
      expect(metrics!.executions.completed).toBe(1)
    })

    it('calculates execution duration correctly', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Duration WS`,
        agentIds: [agent.id],
      })

      const startTime1 = new Date('2026-02-28T10:00:00Z')
      const endTime1 = new Date('2026-02-28T10:01:00Z') // 1 minute = 60,000 ms

      const startTime2 = new Date('2026-02-28T10:05:00Z')
      const endTime2 = new Date('2026-02-28T10:07:00Z') // 2 minutes = 120,000 ms

      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: startTime1,
        endedAt: endTime1,
      })

      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: startTime2,
        endedAt: endTime2,
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      expect(metrics!.duration.totalMs).toBe(180000) // 60,000 + 120,000 ms
      expect(metrics!.duration.firstStartedAt).toBe(startTime1.toISOString())
      expect(metrics!.duration.lastEndedAt).toBe(endTime2.toISOString())
    })

    it('ignores executions from agents not in agentIds', async () => {
      const agent1 = await createTestAgent()
      const agent2 = await createTestAgent()

      // Work stream only includes agent1
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} Filtered Agents WS`,
        agentIds: [agent1.id],
      })

      // Agent 1 execution (should be counted)
      await db.insert(executions).values({
        agentId: agent1.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
            cost: 0.01,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      // Agent 2 execution (should NOT be counted)
      await db.insert(executions).values({
        agentId: agent2.id,
        status: 'completed',
        usage: {
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 2000 },
            cost: 0.1,
          },
          context: null,
        },
        endedAt: new Date(),
      })

      const metrics = await ws.getMetrics()

      expect(metrics).not.toBeNull()
      // Only agent1's tokens should be counted
      expect(metrics!.tokens.total).toBe(200)
      expect(metrics!.cost).toBeCloseTo(0.01, 4)
      expect(metrics!.executions.total).toBe(1)
      expect(Object.keys(metrics!.byAgent)).toHaveLength(1)
      expect(metrics!.byAgent[agent1.id]).toBeDefined()
      expect(metrics!.byAgent[agent2.id]).toBeUndefined()
    })
  })

  describe('WorkStream.computeRuntimes', () => {
    it('returns zero runtime for streams without agents', async () => {
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: `${testPrefix} no-agents` })
      const map = await WorkStream.computeRuntimes([ws])
      const r = map.get(ws.id)
      expect(r).toBeDefined()
      expect(r!.totalMs).toBe(0)
      expect(r!.activeCount).toBe(0)
      expect(new Date(r!.computedAt).getTime()).toBeGreaterThan(0)
    })

    it('sums settled execution durations and ignores queued', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} settled`,
        agentIds: [agent.id],
      })

      const s1 = new Date('2026-02-28T10:00:00Z')
      await db
        .insert(executions)
        .values({ agentId: agent.id, status: 'completed', startedAt: s1, endedAt: new Date(s1.getTime() + 30_000) })
      const s2 = new Date('2026-02-28T10:01:00Z')
      await db
        .insert(executions)
        .values({ agentId: agent.id, status: 'failed', startedAt: s2, endedAt: new Date(s2.getTime() + 45_000) })
      const s3 = new Date('2026-02-28T10:02:00Z')
      await db
        .insert(executions)
        .values({ agentId: agent.id, status: 'stopped', startedAt: s3, endedAt: new Date(s3.getTime() + 5_000) })
      await db.insert(executions).values({ agentId: agent.id, status: 'queued', startedAt: new Date() })

      const r = (await WorkStream.computeRuntimes([ws])).get(ws.id)!
      expect(r.totalMs).toBe(80_000)
      expect(r.activeCount).toBe(0)
    })

    it('counts sandbox waits as active without accruing running duration', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} waiting-sandbox`,
        agentIds: [agent.id],
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'waiting-sandbox',
        startedAt: new Date(Date.now() - 60_000),
      })

      const r = (await WorkStream.computeRuntimes([ws])).get(ws.id)!
      expect(r.activeCount).toBe(1)
      expect(r.totalMs).toBe(0)
    })

    it('does not accrue runtime for settled executions missing endedAt', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} missing-ended-runtime`,
        agentIds: [agent.id],
      })
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'failed',
        startedAt: new Date(Date.now() - 10_000),
      })

      const r = (await WorkStream.computeRuntimes([ws])).get(ws.id)!
      expect(r.totalMs).toBe(0)
      expect(r.activeCount).toBe(0)
    })

    it('includes running executions up to computedAt and reports activeCount', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} running`,
        agentIds: [agent.id],
      })
      const sDone = new Date(Date.now() - 60_000)
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'completed',
        startedAt: sDone,
        endedAt: new Date(sDone.getTime() + 10_000),
      })
      const sRun = new Date(Date.now() - 5_000)
      await db.insert(executions).values({ agentId: agent.id, status: 'running', startedAt: sRun })
      await db.insert(executions).values({ agentId: agent.id, status: 'stopping', startedAt: sRun })

      const r = (await WorkStream.computeRuntimes([ws])).get(ws.id)!
      expect(r.activeCount).toBe(2)
      expect(r.totalMs).toBeGreaterThanOrEqual(19_000)
      expect(r.totalMs).toBeLessThanOrEqual(25_000)
    })

    it('returns separate entries per work stream in a batch', async () => {
      const agentA = await createTestAgent()
      const agentB = await createTestAgent()
      const wsA = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} A`,
        agentIds: [agentA.id],
      })
      const wsB = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: `${testPrefix} B`,
        agentIds: [agentB.id],
      })
      const s = new Date('2026-03-01T10:00:00Z')
      await db
        .insert(executions)
        .values({ agentId: agentA.id, status: 'completed', startedAt: s, endedAt: new Date(s.getTime() + 20_000) })
      await db
        .insert(executions)
        .values({ agentId: agentB.id, status: 'completed', startedAt: s, endedAt: new Date(s.getTime() + 7_000) })

      const map = await WorkStream.computeRuntimes([wsA, wsB])
      expect(map.get(wsA.id)!.totalMs).toBe(20_000)
      expect(map.get(wsB.id)!.totalMs).toBe(7_000)
    })

    it('returns empty map for empty input', async () => {
      const map = await WorkStream.computeRuntimes([])
      expect(map.size).toBe(0)
    })
  })

  describe('WorkStream.create creatorAgentId', () => {
    it('persists and exposes creatorAgentId', async () => {
      const creator = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquad.id })
      createdAgentIds.push(creator.id)
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: 'provenance check',
        creatorAgentId: creator.id,
      })
      expect(ws.creatorAgentId).toBe(creator.id)
    })
  })

  describe('owner notification on creation', () => {
    it('identifies consultant agent creators by type, name, and id', async () => {
      const consultantAgentTypeId = `${testPrefix}-consultant`
      await AgentType.create({
        id: consultantAgentTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Consultant',
        systemPrompt: 'You are a consultant agent.',
      })
      const creator = await Agent.create({ agentTypeId: consultantAgentTypeId, squadId: testSquad.id, name: 'Neon' })
      createdAgentIds.push(creator.id)
      const manager = await testSquad.getManagerAgent()
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: 'owner-notify check',
        ownerAgentId: manager!.id,
        creatorAgentId: creator.id,
      })

      const content = await getWorkStreamInboxContent(ws.id, 'created', manager!.id)
      expect(content).toContain(
        `A new work stream you now own was started by the consultant agent Neon (${creator.id}).`
      )
      expect(content).toContain(`Query it with \`ficus workstream get ${ws.number}\` to see the full details.`)
    })

    it('identifies human creators by display name and email', async () => {
      const user = await User.create({ email: `${testPrefix}@example.com`, displayName: 'Noah' })
      const manager = await testSquad.getManagerAgent()
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: 'owner-notify user check',
        ownerAgentId: manager!.id,
        requestingUserId: user.id,
      })

      const content = await getWorkStreamInboxContent(ws.id, 'created', manager!.id)
      expect(content).toContain(`A new work stream you now own was started by the user Noah (${user.email}).`)
      expect(content).toContain(`Query it with \`ficus workstream get ${ws.number}\` to see the full details.`)
    })

    it('does not notify when creator equals owner', async () => {
      const manager = await testSquad.getManagerAgent()
      const ws = await WorkStream.create({
        squadId: testSquad.id,
        title: 'self-owned check',
        ownerAgentId: manager!.id,
        creatorAgentId: manager!.id,
      })
      expect(await countWorkStreamInbox(ws.id, 'created', manager!.id)).toBe(0)
    })

    it('does not double-notify when owner is a non-manager assignee', async () => {
      const creator = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquad.id })
      createdAgentIds.push(creator.id)
      const worker = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquad.id })
      createdAgentIds.push(worker.id)
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: 'owner=assignee worker',
        ownerAgentId: worker.id,
        assigneeAgentId: worker.id,
        creatorAgentId: creator.id,
      })
      const { notifyWorkStreamOwnerOfNewStream } = await import('../services/squad/work-stream-notifications')
      await notifyWorkStreamOwnerOfNewStream(ws)
      // The assignee notification already reached the worker; skip the owner-on-creation notice.
      expect(await countWorkStreamInbox(ws.id, 'created', worker.id)).toBe(0)
    })

    it('notifies when owner=assignee=manager (manager assignees skip the assignee notice)', async () => {
      const creator = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquad.id })
      createdAgentIds.push(creator.id)
      const manager = await testSquad.getManagerAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: 'owner=assignee manager',
        ownerAgentId: manager!.id,
        assigneeAgentId: manager!.id,
        creatorAgentId: creator.id,
      })
      const { notifyWorkStreamOwnerOfNewStream } = await import('../services/squad/work-stream-notifications')
      await notifyWorkStreamOwnerOfNewStream(ws)
      expect(await countWorkStreamInbox(ws.id, 'created', manager!.id)).toBe(1)
    })
  })

  describe('continuation cycle', () => {
    async function readContinuation(workStreamId: string) {
      const [row] = await db
        .select()
        .from(workStreamContinuations)
        .where(eq(workStreamContinuations.workStreamId, workStreamId))
      return row
    }

    it('resets assignment generations and invalidates status transitions', async () => {
      const first = await createTestAgent()
      const second = await createTestAgent()
      const ws = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'Continuation lifecycle' })

      await ws.update({ status: 'active', assigneeAgentId: first.id })
      expect((await readContinuation(ws.id)).generation).toBe(1)

      await ws.update({ assigneeAgentId: first.id, handoffMessage: 'Try again' })
      let cycle = await readContinuation(ws.id)
      expect(cycle.generation).toBe(2)
      await db
        .update(workStreamContinuations)
        .set({ status: 'pending', claimedAt: new Date(), normalAttemptCount: 1, transportAttemptCount: 2 })
        .where(eq(workStreamContinuations.workStreamId, ws.id))

      // Parking (leaving 'active') invalidates the in-flight cycle.
      await ws.update({ status: 'queued' })
      cycle = await readContinuation(ws.id)
      expect(cycle.status).toBe('idle')
      expect(cycle.claimedAt).toBeNull()

      // Re-activation resets with a fresh generation + retry budget.
      await ws.update({ status: 'active' })
      cycle = await readContinuation(ws.id)
      expect(cycle.generation).toBe(3)
      expect(cycle.normalAttemptCount).toBe(0)
      expect(cycle.transportAttemptCount).toBe(0)

      await ws.update({ assigneeAgentId: second.id })
      cycle = await readContinuation(ws.id)
      expect(cycle.generation).toBe(4)
      expect(cycle.assigneeAgentId).toBe(second.id)

      // Leaving 'active' (parking) INVALIDATES the in-flight cycle without
      // bumping the generation, so a continuation already in flight is
      // dropped rather than re-armed under a new generation. Pin that.
      await ws.update({ status: 'queued', assigneeAgentId: null })
      cycle = await readContinuation(ws.id)
      expect(cycle.generation).toBe(4)
      expect(cycle.status).toBe('idle')
      expect(cycle.claimedAt).toBeNull()
    })
  })

  describe('WorkStream.listForAgent', () => {
    it('returns streams where the agent is assignee or in agentIds, filtered by status', async () => {
      const a = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquad.id })
      createdAgentIds.push(a.id)
      const b = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquad.id })
      createdAgentIds.push(b.id)

      const asMember = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'member', agentIds: [a.id] })
      const asAssignee = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: 'assignee',
        assigneeAgentId: a.id,
      })
      const other = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'other', agentIds: [b.id] })
      const doneOne = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'done', agentIds: [a.id] })
      await doneOne.update({ status: 'done' })

      const active = await WorkStream.listForAgent(a.id, ['active'])
      const ids = active.map((w) => w.id).sort()

      expect(ids).toEqual([asMember.id, asAssignee.id].sort())
      expect(ids).not.toContain(other.id)
      expect(ids).not.toContain(doneOne.id)
    })
  })

  describe('priority', () => {
    it('defaults to normal and persists an explicit priority at creation', async () => {
      const defaulted = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'default prio' })
      expect(defaulted.priority).toBe('normal')

      const critical = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'crit prio', priority: 'critical' })
      expect(critical.priority).toBe('critical')
      expect((await WorkStream.mustFind(critical.id)).priority).toBe('critical')
      expect(critical.toJson().priority).toBe('critical')
    })

    it('is updatable without touching status (advisory)', async () => {
      const agent = await createTestAgent()
      const ws = await storedLegacyWorkStream({
        squadId: testSquad.id,
        title: 'advisory prio',
        agentIds: [agent.id],
        assigneeAgentId: agent.id,
      })
      await ws.update({ status: 'active' })

      const statusEvents: string[] = []
      const record = () => statusEvents.push('transition')
      const unsubscribes = [
        eventEmitter.on('workStream.blocked', record),
        eventEmitter.on('workStream.review', record),
        eventEmitter.on('workStream.done', record),
      ]
      try {
        await ws.update({ priority: 'critical' })
      } finally {
        for (const unsubscribe of unsubscribes) unsubscribe()
      }

      expect(ws.priority).toBe('critical')
      expect(ws.status).toBe('active')
      expect((await WorkStream.mustFind(ws.id)).status).toBe('active')
      expect(statusEvents).toEqual([])
    })
  })

  describe('dependsOn cycle rejection', () => {
    it('rejects self, direct and transitive cycles but keeps the acyclic graph writable', async () => {
      const a = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'Cycle A' })
      const b = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'Cycle B', dependsOn: [a.id] })
      const c = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'Cycle C', dependsOn: [b.id] })

      // self-edge
      await expect(a.update({ dependsOn: [a.id] })).rejects.toThrow(/cycle/)
      // direct: b -> a exists; a -> b closes the loop
      await expect(a.update({ dependsOn: [b.id] })).rejects.toThrow(/cycle/)
      // transitive: c -> b -> a exists; a -> c closes a 3-cycle, path named
      await expect(a.update({ dependsOn: [c.id] })).rejects.toThrow('Cycle A → Cycle C → Cycle B → Cycle A')

      // the pre-existing acyclic graph stays writable
      const d = await storedLegacyWorkStream({ squadId: testSquad.id, title: 'Cycle D' })
      await c.update({ dependsOn: [b.id, d.id] })
      expect(c.dependsOn.sort()).toEqual([b.id, d.id].sort())
      // nothing was persisted by the refused writes
      expect((await WorkStream.mustFind(a.id)).dependsOn).toEqual([])
    })
  })
})
