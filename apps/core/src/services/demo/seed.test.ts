import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestions,
  agents,
  deviceTokens,
  inbox,
  messages,
  roleAssignments,
  roles,
  squads,
  users,
  workStreamWaits,
  workStreams,
} from '../../db/schema'
import { createDeviceToken } from '../auth/device-tokens'
import { DEMO_REVIEWER_EMAIL, DEMO_REVIEWER_ROLE_SLUG } from './access'
import { DEMO_CONTENT, DEMO_SEED_VERSION, revokeDemoReviewerDevices, seedDemoInstance } from './seed'

async function removeDemoWorld() {
  const demoSquads = await db
    .select({ id: squads.id })
    .from(squads)
    .where(sql`${squads.metadata}->'demo' IS NOT NULL`)
  for (const { id } of demoSquads) {
    await db.delete(agents).where(eq(agents.squadId, id))
    await db.delete(squads).where(eq(squads.id, id))
  }
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
  if (user) {
    await db.delete(inbox).where(and(eq(inbox.recipientType, 'user'), eq(inbox.recipientId, user.id)))
    await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
  }
}

describe('demo seed', () => {
  beforeAll(removeDemoWorld)
  afterAll(removeDemoWorld)

  it('builds the reviewer account and its world once, and finds it again on re-run', async () => {
    const first = await seedDemoInstance()
    expect(first.version).toBe(DEMO_SEED_VERSION)
    expect(first.user.email).toBe(DEMO_REVIEWER_EMAIL)
    expect(first.user.role).toBe(DEMO_REVIEWER_ROLE_SLUG)
    expect(first.squads.map((s) => s.name)).toEqual(DEMO_CONTENT.map((s) => s.name))
    expect(first.created.length).toBeGreaterThan(0)

    // Role assignment at system scope, exactly once.
    const assignments = await db
      .select({ scope: roleAssignments.scope })
      .from(roleAssignments)
      .where(eq(roleAssignments.subjectId, first.user.id))
    expect(assignments).toEqual([{ scope: 'system' }])

    // Each squad has its manager plus the requested default agents.
    for (const [index, spec] of DEMO_CONTENT.entries()) {
      expect(first.squads[index].agents).toBe(spec.defaultAgents.length + 1)
      expect(first.squads[index].workStreams).toBe(spec.streams.length)
    }

    // Stream states: review waits are open, done streams are done, the rest are live.
    const streams = await db
      .select({ id: workStreams.id, title: workStreams.title, status: workStreams.status })
      .from(workStreams)
      .where(sql`${workStreams.metadata}->'demo' IS NOT NULL`)
    const specs = DEMO_CONTENT.flatMap((s) => s.streams)
    expect(streams.length).toBe(specs.length)
    for (const spec of specs) {
      const row = streams.find((s) => s.title === spec.title)!
      if (spec.state === 'done') expect(row.status).toBe('done')
      else expect(['active', 'queued']).toContain(row.status)
      const openReview = await db
        .select({ id: workStreamWaits.id, message: workStreamWaits.message })
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.workStreamId, row.id),
            eq(workStreamWaits.type, 'review'),
            isNull(workStreamWaits.closedAt)
          )
        )
      expect(openReview.length).toBe(spec.state === 'review' ? 1 : 0)
      if (spec.state === 'review') expect(openReview[0].message).toBe(spec.reviewRequest ?? 'Ready for review.')
    }

    // Questions reach the reviewer through the recipients table.
    const questionCount = DEMO_CONTENT.reduce((n, s) => n + s.questions.length, 0)
    const recipients = await db
      .select({ questionId: agentQuestionRecipients.questionId })
      .from(agentQuestionRecipients)
      .where(eq(agentQuestionRecipients.userId, first.user.id))
    expect(recipients.length).toBe(questionCount)
    const open = await db
      .select({ status: agentQuestions.status })
      .from(agentQuestions)
      .where(
        inArray(
          agentQuestions.id,
          recipients.map((r) => r.questionId)
        )
      )
    expect(open.every((q) => q.status === 'open')).toBe(true)

    // Second run: same ids, nothing new.
    const second = await seedDemoInstance()
    expect(second.created).toEqual([])
    expect(second.user.id).toBe(first.user.id)
    expect(second.squads.map((s) => s.id)).toEqual(first.squads.map((s) => s.id))
    expect(second.transcriptMessages).toBe(first.transcriptMessages)
    const transcriptRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(sql`${messages.metadata}->'demo' IS NOT NULL`)
    expect(transcriptRows.length).toBe(DEMO_CONTENT.reduce((n, s) => n + s.transcript.length, 0))
    const inboxRows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(and(eq(inbox.recipientType, 'user'), eq(inbox.recipientId, first.user.id)))
    expect(inboxRows.length).toBe(DEMO_CONTENT.reduce((n, s) => n + s.inbox.length, 0))
  })

  it('revokes every paired reviewer device and re-enables a disabled account on re-seed', async () => {
    const seeded = await seedDemoInstance()
    await createDeviceToken({ userId: seeded.user.id, name: 'Reviewer iPhone', platform: 'ios' })
    await createDeviceToken({ userId: seeded.user.id, name: 'Reviewer iPad', platform: 'ios' })
    expect(await revokeDemoReviewerDevices()).toBe(2)
    expect(await revokeDemoReviewerDevices()).toBe(0)
    const live = await db
      .select({ id: deviceTokens.id })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.userId, seeded.user.id), isNull(deviceTokens.revokedAt)))
    expect(live).toEqual([])

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, seeded.user.id))
    const again = await seedDemoInstance()
    expect(again.created).toEqual(['re-enabled the demo account'])
    const [row] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, seeded.user.id))
    expect(row.disabledAt).toBeNull()
  })

  it('takes a default role (the farm) back from the reviewer on re-seed', async () => {
    const seeded = await seedDemoInstance()
    const [farmer] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, 'farmer'))
    expect(farmer).toBeDefined()
    // As an upgrade that granted it to everyone would have.
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: seeded.user.id, roleId: farmer!.id, scope: 'system' })
    const again = await seedDemoInstance()
    expect(again.created).toEqual(['removed default roles from the demo account'])
    const held = await db
      .select({ roleId: roleAssignments.roleId })
      .from(roleAssignments)
      .where(eq(roleAssignments.subjectId, seeded.user.id))
    expect(held.map((a) => a.roleId)).not.toContain(farmer!.id)
    expect(held).toHaveLength(1)
  })
})
