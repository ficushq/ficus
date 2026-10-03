import { createBlankWorkflow } from '@ficus/shared'
import * as flowExecution from '../services/workflows/execution'
import { deliverInboxMessagesToAgent } from '../services/inbox/inboxDelivery'
import { persistTerminalObservers, reconcileObserverDeliveries } from '../services/work-streams/observers'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  agents,
  agentTypes,
  executions,
  inbox,
  messages,
  chatSendReceipts,
  squads,
  workStreams,
  workStreamObservers,
} from '../db/schema'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { WorkStream } from '../entities/WorkStream'
import { identityMiddleware } from '../middleware/identity'
import { workStreamsRouter } from './work-streams'
import { authHeaders, createTestAgentToken, createTestAdmin, cleanupTestRbac } from '../test-utils'
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'

const app = new Hono().use('*', identityMiddleware).route('/api/workstreams', workStreamsRouter)
let squad: Squad
let observer: Agent
let token: string
let typeId: string
let stream: WorkStream
beforeEach(async () => {
  typeId = `observer-${crypto.randomUUID()}`
  await db.insert(agentTypes).values({
    id: typeId,
    name: 'Observer',
    systemPrompt: 'Test',
    model: 'anthropic:claude-sonnet-4-5',
    extraScopes: ['workstreams:read', 'workstreams:create'],
  })
  squad = await Squad.create({ name: typeId, purpose: 'Test observers' })
  observer = await Agent.create({ agentTypeId: typeId, squadId: squad.id })
  token = (await createTestAgentToken({ agentId: observer.id, squadId: squad.id })).token
  stream = await storedLegacyWorkStream({ squadId: squad.id, title: 'Observed result' })
})
afterEach(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [observer.id, squad.managerAgentId!]))
  await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
  const ids = (await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squad.id))).map((a) => a.id)
  if (ids.length) {
    await db.delete(chatSendReceipts).where(inArray(chatSendReceipts.agentId, ids))
    await db.delete(executions).where(inArray(executions.agentId, ids))
  }
  await db.delete(agents).where(eq(agents.squadId, squad.id))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
})
function request(path: string, method = 'GET', body?: unknown, bearer = token) {
  return app.request(`/api/workstreams${path ? `/${path}` : ''}`, {
    method,
    headers: { ...authHeaders(bearer), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function notices() {
  return db
    .select()
    .from(inbox)
    .where(sql`${inbox.metadata}->>'source' = 'work-stream-observer' AND ${inbox.recipientId} = ${observer.id}`)
}
it('registers only the caller, idempotently, survives owner changes, and consumes on done', async () => {
  for (let i = 0; i < 2; i++) {
    const result = await request(`${stream.number}/observe`, 'POST', { events: 'terminal' })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ observing: true, events: 'terminal' })
  }
  await stream.update({ ownerAgentId: observer.id })
  await stream.update({ ownerAgentId: squad.managerAgentId })
  expect(await notices()).toHaveLength(0)
  await stream.update({ status: 'done' })
  await stream.update({ title: 'Edited after completion' })
  const rows = await notices()
  expect(rows).toHaveLength(1)
  expect(rows[0].content).toContain('No management action required')
  expect(rows[0].content).toContain(squad.managerAgentId!)
  expect(rows[0].metadata).toMatchObject({ event: 'done', wakeEligible: false })
  expect((await (await request(`${stream.id}/observation`)).json()).observing).toBe(false)
  expect((await request(`${stream.id}/observe`, 'POST')).status).toBe(409)
  await stream.reopen()
  await stream.cancel()
  expect(await notices()).toHaveLength(1)
})
it('unobserve is idempotent and cancellation is terminal', async () => {
  expect((await request(`${stream.id}/observe`, 'POST')).status).toBe(200)
  for (let i = 0; i < 2; i++) expect((await request(`${stream.id}/observe`, 'DELETE')).status).toBe(200)
  await stream.cancel()
  expect(await notices()).toHaveLength(0)
  await stream.reopen()
  await request(`${stream.id}/observe`, 'POST')
  await stream.cancel()
  expect(await notices()).toHaveLength(1)
  expect((await notices())[0].metadata.event).toBe('canceled')
})
it('does not duplicate the owner terminal notification', async () => {
  await request(`${stream.id}/observe`, 'POST')
  await stream.update({ ownerAgentId: observer.id })
  await stream.update({ status: 'done' })
  expect(await notices()).toHaveLength(0)
  const rows = await db
    .select()
    .from(inbox)
    .where(sql`${inbox.recipientId} = ${observer.id} AND ${inbox.metadata}->>'event' = 'done'`)
  expect(rows).toHaveLength(1)
  expect((await (await request(`${stream.id}/observation`)).json()).observing).toBe(false)
})
it('rejects unsupported events and arbitrary recipients without changing user subscriptions', async () => {
  expect((await request(`${stream.id}/observe`, 'POST', { events: 'blocked' })).status).toBe(400)
  expect((await request(`${stream.id}/observe`, 'POST', { agentId: squad.managerAgentId })).status).toBe(400)
  expect((await request(`${stream.id}/observe`, 'POST', undefined, 'invalid')).status).toBe(401)
  const result = await request(`${stream.id}/subscribe`, 'POST')
  expect(result.status).toBe(403)
})

it('creation shorthand registers before dispatch, even for immediate cancellation', async () => {
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = typeId
  const dispatch = spyOn(flowExecution, 'ensureFlowDispatch').mockImplementation(async (id) => {
    expect(await db.select().from(workStreamObservers).where(eq(workStreamObservers.workStreamId, id))).toHaveLength(1)
    await (await WorkStream.mustFind(id)).cancel()
    return false // No participant was dispatched: the stream was canceled immediately.
  })
  try {
    const result = await request('', 'POST', {
      squadId: squad.id,
      title: 'Fast result',
      observe: 'terminal',
      creatorAgentId: squad.managerAgentId,
      workflow: { kind: 'inline', definition },
    })
    expect(result.status).toBe(201)
    const body = await result.json()
    expect(body.creatorAgentId).toBe(observer.id)
    expect(body.status).toBe('canceled')
    expect(body.observing).toBe(false)
    expect(await notices()).toHaveLength(1)
  } finally {
    dispatch.mockRestore()
  }
})
it('rejects cross-squad registration and persists no grants', async () => {
  const other = await Squad.create({ name: `${typeId}-other`, purpose: 'Foreign' })
  try {
    const foreign = await storedLegacyWorkStream({ squadId: other.id, title: 'Foreign' })
    expect((await request(`${foreign.id}/observe`, 'POST')).status).toBe(403)
    expect(
      await db.select().from(workStreamObservers).where(eq(workStreamObservers.workStreamId, foreign.id))
    ).toHaveLength(0)
  } finally {
    await db.delete(workStreams).where(eq(workStreams.squadId, other.id))
    await db.delete(agents).where(eq(agents.squadId, other.id))
    await db.delete(squads).where(eq(squads.id, other.id))
  }
})
it('does not observe review, blocked, pause or notification-only done calls', async () => {
  await request(`${stream.id}/observe`, 'POST')
  const { pauseWorkStream, resumeWorkStream } = await import('../services/work-streams/pause')
  await pauseWorkStream(stream.id)
  expect(await notices()).toHaveLength(0)
  await resumeWorkStream(stream.id)
  await stream.block({ message: 'Need input' })
  expect(await notices()).toHaveLength(0)
  await stream.unblock()
  await stream.handoffForReview({ message: 'Review', completesOnApproval: false })
  await stream.approveReview()
  const { notifyWorkStreamDone } = await import('../services/squad/work-stream-notifications')
  await notifyWorkStreamDone(stream)
  expect(await notices()).toHaveLength(0)
  expect((await (await request(`${stream.id}/observation`)).json()).observing).toBe(true)
  await stream.handoffForReview({ message: 'Final', completesOnApproval: true })
  await stream.approveReview()
  expect(await notices()).toHaveLength(1)
})
it('rolls back watch consumption and inbox together, then delivers exactly once', async () => {
  await request(`${stream.id}/observe`, 'POST')
  await stream.handoffForReview({ message: 'Final', completesOnApproval: true })
  await expect(
    stream.approveReview({
      testHooks: {
        beforeCommit: async () => {
          throw new Error('rollback')
        },
      },
    })
  ).rejects.toThrow('rollback')
  expect(await notices()).toHaveLength(0)
  expect((await (await request(`${stream.id}/observation`)).json()).observing).toBe(true)
  await stream.approveReview()
  await reconcileObserverDeliveries()
  expect(await notices()).toHaveLength(1)
})
it('serializes concurrent observe and terminal writes without losing an accepted registration', async () => {
  const [result] = await Promise.all([request(`${stream.id}/observe`, 'POST'), stream.cancel()])
  expect([200, 409]).toContain(result.status)
  expect(await notices()).toHaveLength(result.status === 200 ? 1 : 0)
  expect(
    await db.select().from(workStreamObservers).where(eq(workStreamObservers.workStreamId, stream.id))
  ).toHaveLength(0)
})
for (const status of ['dormant', 'terminated', 'waiting-input'] as const) {
  it(`expires without waking an observer that is ${status}`, async () => {
    await request(`${stream.id}/observe`, 'POST')
    await db.update(agents).set({ status }).where(eq(agents.id, observer.id))
    await stream.cancel()
    expect(await notices()).toHaveLength(0)
    expect((await Agent.mustFind(observer.id)).status).toBe(status)
    expect(
      await db.select().from(workStreamObservers).where(eq(workStreamObservers.workStreamId, stream.id))
    ).toHaveLength(0)
  })
}
it('keeps delivery failure independent of completion and retries durable inbox once', async () => {
  await request(`${stream.id}/observe`, 'POST')
  const send = spyOn(Agent.prototype, 'sendMessage').mockRejectedValue(new Error('transient delivery failure'))
  try {
    await stream.update({ status: 'done' })
    expect((await WorkStream.mustFind(stream.id)).status).toBe('done')
    expect(await notices()).toHaveLength(1)
    expect((await notices())[0].deliveredAt).toBeNull()
  } finally {
    send.mockRestore()
  }
  await reconcileObserverDeliveries()
  await reconcileObserverDeliveries()
  expect(await notices()).toHaveLength(1)
  expect((await notices())[0].deliveredAt).not.toBeNull()
})
it('does not revive an explicitly stopped conversation during a deferred delivery', async () => {
  await request(`${stream.id}/observe`, 'POST')
  // Commit terminal inbox without post-commit delivery, simulating a process crash.
  await db.transaction(async (tx) => {
    const [row] = await tx.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id)).returning()
    await persistTerminalObservers(tx, row!, [])
  })
  await db.insert(executions).values({ agentId: observer.id, status: 'stopped' })
  const send = spyOn(Agent.prototype, 'sendMessage')
  try {
    await deliverInboxMessagesToAgent(observer.id)
    expect(send).not.toHaveBeenCalled()
  } finally {
    send.mockRestore()
  }
})

it('keeps user subscriptions user-only and denies human observation including creation', async () => {
  const admin = await createTestAdmin({ prefix: typeId })
  try {
    expect((await request(`${stream.id}/observe`, 'POST', undefined, admin.token)).status).toBe(403)
    expect((await request(`${stream.id}/observe`, 'DELETE', undefined, admin.token)).status).toBe(403)
    expect(
      (await request('', 'POST', { squadId: squad.id, title: 'Denied', observe: 'terminal' }, admin.token)).status
    ).toBe(403)
    expect((await request(`${stream.id}/subscribe`, 'POST', undefined, admin.token)).status).toBe(200)
    await request(`${stream.id}/observe`, 'POST')
    await request(`${stream.id}/observe`, 'DELETE')
    const response = await request(`${stream.id}/subscription`, 'GET', undefined, admin.token)
    expect((await response.json()).subscribed).toBe(true)
    await stream.update({ status: 'done' })
    const rows = await db
      .select()
      .from(inbox)
      .where(sql`${inbox.recipientId} = ${admin.id} AND ${inbox.metadata}->>'event' = 'done'`)
    expect(rows).toHaveLength(1)
  } finally {
    await db.delete(inbox).where(eq(inbox.recipientId, admin.id))
    await cleanupTestRbac(typeId)
  }
})
it('expires without disclosing results after read access is revoked', async () => {
  await request(`${stream.id}/observe`, 'POST')
  await db.update(agentTypes).set({ extraScopes: [] }).where(eq(agentTypes.id, typeId))
  await stream.cancel()
  expect(await notices()).toHaveLength(0)
})
it('delivers available result links and notes without modifying ownership or membership', async () => {
  await request(`${stream.id}/observe`, 'POST')
  const before = await WorkStream.mustFind(stream.id)
  // Fixture metadata avoids provider calls; the binding shape is validated by the shared resolver.
  await db
    .update(workStreams)
    .set({
      metadata: {
        codeHost: {
          integration: 'github',
          repository: 'ficushq/ficus',
          changeRequest: { number: 123, url: 'https://github.com/ficushq/ficus/pull/123' },
        },
        nextSteps: 'Verified result',
      },
    })
    .where(eq(workStreams.id, stream.id))
  await stream.update({ status: 'done' })
  const after = await WorkStream.mustFind(stream.id)
  expect(after.ownerAgentId).toBe(before.ownerAgentId)
  expect(after.agentIds).toEqual(before.agentIds)
  expect(after.assigneeAgentId).toBe(before.assigneeAgentId)
  const [notice] = await notices()
  expect(notice.content).toContain('https://github.com/ficushq/ficus/pull/123')
  expect(notice.content).toContain('Verified result')
  expect(notice.deliveryMode).toBe('follow-up')
  expect(await db.select().from(executions).where(eq(executions.agentId, observer.id))).toHaveLength(1)
})

it('checks terminal observer permissions through the same transaction snapshot', async () => {
  await request(`${stream.id}/observe`, 'POST')
  await db.transaction(async (tx) => {
    await tx.update(agentTypes).set({ extraScopes: [] }).where(eq(agentTypes.id, typeId))
    const [row] = await tx.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id)).returning()
    await persistTerminalObservers(tx, row!, [])
  })
  expect(await notices()).toHaveLength(0)
})

it('does not queue an observer wake when stop wins the inbox acceptance lock', async () => {
  await request(`${stream.id}/observe`, 'POST')
  await db.transaction(async (tx) => {
    const [row] = await tx.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id)).returning()
    await persistTerminalObservers(tx, row!, [])
  })
  const { setSendMessageLockedHookForTests } = await import('../entities/Agent')
  setSendMessageLockedHookForTests(async (tx, id) => {
    if (id === observer.id) await tx.insert(executions).values({ agentId: id, status: 'stopped' })
  })
  try {
    await deliverInboxMessagesToAgent(observer.id)
    expect(
      await db
        .select()
        .from(executions)
        .where(sql`${executions.agentId} = ${observer.id} AND ${executions.status} = 'queued'`)
    ).toHaveLength(0)
    expect((await notices())[0].deliveredAt).toBeNull()
  } finally {
    setSendMessageLockedHookForTests()
  }
})

it('replays a durable chat receipt after acceptance succeeds but acknowledgement fails', async () => {
  await request(`${stream.id}/observe`, 'POST')
  const original = Agent.prototype.sendMessage
  const send = spyOn(Agent.prototype, 'sendMessage').mockImplementation(async function (this: Agent, content, options) {
    const result = await original.call(this, content, options)
    if (this.id === observer.id) throw new Error('lost acknowledgement after durable acceptance')
    return result
  })
  try {
    await stream.update({ status: 'done' })
  } finally {
    send.mockRestore()
  }
  await Promise.all([reconcileObserverDeliveries(), reconcileObserverDeliveries()])
  const [notice] = await notices()
  expect(notice.deliveredAt).not.toBeNull()
  const accepted = await db
    .select()
    .from(messages)
    .where(
      sql`${messages.agentId} = ${observer.id} AND ${messages.metadata}->'inboxMessageIds' @> ${JSON.stringify([notice.id])}::jsonb`
    )
  expect(accepted).toHaveLength(1)
})

it('settles pending observer inbox when its conversation has been deleted', async () => {
  await request(`${stream.id}/observe`, 'POST')
  await db.transaction(async (tx) => {
    const [row] = await tx.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id)).returning()
    await persistTerminalObservers(tx, row!, [])
  })
  await db.delete(agents).where(eq(agents.id, observer.id))
  await reconcileObserverDeliveries()
  expect((await notices())[0].readAt).not.toBeNull()
  expect(await Agent.find(observer.id)).toBeNull()
})
