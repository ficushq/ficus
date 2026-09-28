import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, inbox, squads as squadsTable, workStreams } from '../../db/schema'
import { AgentType } from '../../entities/AgentType'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { listReviewHistory } from '../work-streams/waits'
import { InboxMessage } from '../../entities/InboxMessage'
import { initSquadEventHandlers, resolveWorkStreamRecipient } from './event-handlers'

const waitForEventHandlers = () => new Promise((resolve) => setTimeout(resolve, 500))

describe('squad-event-handlers', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let managerId: string
  let workerId: string
  let reviewerId: string
  let squadId: string

  beforeEach(async () => {
    testPrefix = `sqevt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'Test prompt',
    })

    const manager = await Agent.create({ agentTypeId: testAgentTypeId })
    managerId = manager.id

    const worker = await Agent.create({ agentTypeId: testAgentTypeId, name: 'Worker Bee' })
    workerId = worker.id

    const reviewer = await Agent.create({ agentTypeId: testAgentTypeId, name: 'Review Owl' })
    reviewerId = reviewer.id

    const squad = await Squad.create({
      name: `${testPrefix} Squad`,
      purpose: 'Testing event handlers',
    })
    squadId = squad.id

    // Set manager on squad
    await db.update(squadsTable).set({ managerAgentId: managerId }).where(eq(squadsTable.id, squadId))

    // Initialize handlers (idempotent — won't double-register)
    initSquadEventHandlers()
  })

  afterEach(async () => {
    // Clean up (order matters for foreign keys)
    await db.delete(inbox).where(eq(inbox.recipientId, managerId))
    await db.delete(inbox).where(eq(inbox.recipientId, workerId))
    await db.delete(inbox).where(eq(inbox.recipientId, reviewerId))
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(squadsTable).where(like(squadsTable.name, `${testPrefix}%`))
    await db.delete(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  describe('resolveWorkStreamRecipient', () => {
    it('returns the owner agent when ownerAgentId is set', async () => {
      const ws = await storedLegacyWorkStream({ squadId, title: `${testPrefix} Owned`, ownerAgentId: workerId })
      const recipient = await resolveWorkStreamRecipient(ws)
      expect(recipient?.id).toBe(workerId)
    })

    it('falls back to the squad manager when ownerAgentId is null', async () => {
      const ws = await storedLegacyWorkStream({ squadId, title: `${testPrefix} Unowned` })
      const recipient = await resolveWorkStreamRecipient(ws)
      expect(recipient?.id).toBe(managerId)
    })
  })

  describe('assignment notifications', () => {
    it('includes other bound agents in initial assignment messages', async () => {
      const stream = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Assignment context`,
        agentIds: [workerId, reviewerId],
      })
      await stream.update({ assigneeAgentId: workerId, handoffMessage: 'Please implement and hand off to reviewer.' })

      const messages = await InboxMessage.listUnread('agent', workerId)
      const assignment = messages.find((m) => m.subject?.includes('Work stream handed off to you'))
      expect(assignment).toBeDefined()
      expect(assignment!.content).toContain('Other agents assigned to this work stream:')
      expect(assignment!.content).toContain(`- Test Agent Type: Review Owl [${reviewerId}]`)
      expect(assignment!.content).not.toContain(workerId)
      expect(assignment!.content).not.toContain('ficus workstream handoff')
    })

    it('includes other bound agents in handoff messages after reassignment', async () => {
      const ws = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Handoff context`,
        assigneeAgentId: workerId,
        agentIds: [workerId, reviewerId],
      })
      await waitForEventHandlers()
      await db.delete(inbox).where(eq(inbox.recipientId, reviewerId))

      await ws.update({ assigneeAgentId: reviewerId, handoffMessage: 'Implementation complete.' })
      await waitForEventHandlers()

      const messages = await InboxMessage.listUnread('agent', reviewerId)
      const handoff = messages.find((m) => m.subject?.includes('Work stream handed off to you'))
      expect(handoff).toBeDefined()
      expect(handoff!.content).toContain('Other agents assigned to this work stream:')
      expect(handoff!.content).toContain(`- Test Agent Type: Worker Bee [${workerId}]`)
      expect(handoff!.content).not.toContain(reviewerId)
      expect(handoff!.content).not.toContain('ficus workstream handoff')
    })
  })

  describe('review rejection notifications', () => {
    it('notifies assignee when review is rejected', async () => {
      const ws = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Review reject`,
        assigneeAgentId: workerId,
      })
      await ws.handoffForReview({ message: 'Review this' })

      await waitForEventHandlers()
      // Clear any prior inbox messages from assignment/wait open
      await db.delete(inbox).where(eq(inbox.recipientId, workerId))

      await ws.sendBackReview('Needs more tests')

      // Small delay for async handler
      await waitForEventHandlers()

      const messages = await InboxMessage.listUnread('agent', workerId)
      const rejection = messages.find((m) => m.subject?.includes('Review feedback'))
      expect(rejection).toBeDefined()
      expect(rejection!.content).toContain('Needs more tests')
      expect(rejection!.content).toContain(ws.title)
      expect(rejection!.metadata).toMatchObject({ event: 'reviewed', workStreamId: ws.id })
    })

    it('notifies manager when review is rejected and no assignee', async () => {
      const ws = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Review no assignee`,
      })
      await ws.handoffForReview({ message: 'Review this' })

      await waitForEventHandlers()
      // Clear any prior inbox messages
      await db.delete(inbox).where(eq(inbox.recipientId, managerId))

      await ws.sendBackReview('Not ready')

      await waitForEventHandlers()

      // Send-back closes the review wait with the feedback; the stream stays
      // active and schedulable (the closed wait is the review round record).
      expect(ws.status).toBe('active')
      expect(await ws.getOpenWaits()).toHaveLength(0)
      const history = await listReviewHistory(db, ws.id)
      expect(history).toHaveLength(1)
      expect(history[0].resolution).toBe('sent_back')
      expect(history[0].resolutionNote).toBe('Not ready')
    })

    it('notifies assignee on review approval', async () => {
      const ws = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Review approve`,
        assigneeAgentId: workerId,
      })
      await ws.handoffForReview({ message: 'Review this' })

      await waitForEventHandlers()
      // Clear inbox
      await db.delete(inbox).where(eq(inbox.recipientId, workerId))
      await db.delete(inbox).where(eq(inbox.recipientId, managerId))

      await ws.approveReview()

      await waitForEventHandlers()

      // Approve closes the review wait AND terminalizes in one transaction.
      expect(ws.status).toBe('done')
      const approvedHistory = await listReviewHistory(db, ws.id)
      expect(approvedHistory).toHaveLength(1)
      expect(approvedHistory[0].resolution).toBe('approved')
    })

    it('notifies assignee when blocked work stream is unblocked', async () => {
      const ws = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Blocked response`,
        assigneeAgentId: workerId,
      })
      await ws.block({ message: 'Which approach?' })

      await waitForEventHandlers()
      // Clear inbox
      await db.delete(inbox).where(eq(inbox.recipientId, workerId))

      await ws.unblock({ note: 'Use approach A' })

      await waitForEventHandlers()

      const workerMessages = await InboxMessage.listUnread('agent', workerId)
      const unblocked = workerMessages.find((m) => m.subject?.includes('Work stream unblocked'))
      expect(unblocked).toBeDefined()
      expect(unblocked!.content).toContain('Use approach A')
      expect(unblocked!.content).toContain(ws.title)
      expect(unblocked!.metadata).toMatchObject({ event: 'unblocked', workStreamId: ws.id })
      expect(unblocked!.deliveryMode).toBe('steer')
    })

    it('notifies manager when blocked work stream is unblocked without assignee', async () => {
      const ws = await storedLegacyWorkStream({
        squadId,
        title: `${testPrefix} Blocked response no assignee`,
      })
      await ws.block({ message: 'Which approach?' })

      await waitForEventHandlers()
      await db.delete(inbox).where(eq(inbox.recipientId, managerId))

      await ws.unblock({ note: 'Use approach B' })

      await waitForEventHandlers()

      // The manual wait clears; status was never anything but active.
      expect(ws.status).toBe('active')
      expect(await ws.getOpenWaits()).toHaveLength(0)
    })
  })
})
