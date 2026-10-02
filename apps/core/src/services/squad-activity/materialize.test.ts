import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  inbox,
  messages,
  squadActivity,
  squadActivityMaintenanceLeases,
  squads,
  workStreams,
} from '../../db/schema'
import { materializeSourceGroup } from './materialize'
import { repairSquadActivity } from './repair'
import { projectSquadActivity } from '../squad/activity'
import { projectGlobalActivity } from './global-activity'
import { listSourceGroupPage } from './families'
import type { SourceGroupCursor } from './source-loaders'

const createdSquads: string[] = []
const leaseTasks: string[] = []
const DAY_MS = 24 * 60 * 60 * 1000
afterEach(async () => {
  for (const task of leaseTasks.splice(0))
    await db.delete(squadActivityMaintenanceLeases).where(eq(squadActivityMaintenanceLeases.task, task))
  for (const id of createdSquads.splice(0)) {
    await db.delete(squadActivity).where(eq(squadActivity.squadId, id))
    await db.delete(squads).where(eq(squads.id, id))
  }
})
describe('Activity materialization', () => {
  test('deeply nested original source still materializes and repairs idempotently', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-parser-bound-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'completed', runStartedAt: new Date() })
      .returning()
    const [message] = await db
      .insert(messages)
      .values({
        agentId: agent.id,
        role: 'assistant',
        content: '>'.repeat(12_000) + 'hello',
        metadata: { executionId: execution.id },
      })
      .returning()
    const key = { family: 'chat' as const, groupId: execution.id }
    const result = await materializeSourceGroup(key)
    expect(result.upserted).toHaveLength(1)
    const expected = result.upserted[0]
    expect(expected.summary).toBe(`${'>'.repeat(159)}…`)
    expect([...expected.summary]).toHaveLength(160)
    expect(expected.preview.every((span) => !span.href)).toBe(true)
    await db
      .update(squadActivity)
      .set({ preview: [], summary: 'damaged stored summary', payloadHash: 'old' })
      .where(eq(squadActivity.squadId, squad.id))
    const repairWindow = {
      from: new Date(message.createdAt.getTime() - 1000),
      to: new Date(message.createdAt.getTime() + 1000),
      projectionPass: false,
    }
    expect((await repairSquadActivity(repairWindow)).errors).toBe(0)
    const [row] = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(row.preview).toEqual(expected.preview)
    expect(row.summary).toBe(expected.summary)
    expect((await materializeSourceGroup(key)).upserted).toEqual([])
  })

  test('rejects wrong and expired maintenance fences inside the projection transaction', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-fence-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [stream] = await db.insert(workStreams).values({ squadId: squad.id, title: 'Fenced source' }).returning()
    const task = `repair-fence-${crypto.randomUUID()}`
    const token = crypto.randomUUID()
    leaseTasks.push(task)
    await expect(
      materializeSourceGroup({ family: 'workstream', groupId: stream.id }, { leaseFence: { task, token } } as any)
    ).rejects.toThrow('lease lost')
    await db.insert(squadActivityMaintenanceLeases).values({
      task,
      leaseToken: token,
      leaseUntil: new Date(Date.now() - 1_000),
    })
    await expect(
      materializeSourceGroup({ family: 'workstream', groupId: stream.id }, { leaseFence: { task, token } } as any)
    ).rejects.toThrow('lease lost')
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])
  })

  test('real-time and overlapping repair share extraction and are idempotent', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-materialize-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const fixtureNow = new Date()
    // Keep repair-backed timestamps relative so they stay inside Activity retention as wall time advances.
    const runStartedAt = new Date(fixtureNow.getTime() - DAY_MS)
    expect(fixtureNow.getTime() - runStartedAt.getTime()).toBe(DAY_MS)
    const repairWindow = {
      from: new Date(runStartedAt.getTime() - 60 * 60_000),
      to: new Date(runStartedAt.getTime() + 60 * 60_000),
    }
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        runStartedAt,
        endedAt: new Date(runStartedAt.getTime() + 60_000),
      })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'assistant',
      content: '  Building [#241](ficus:ws:241)\n**ready**',
      metadata: { executionId: execution.id },
      createdAt: new Date(runStartedAt.getTime() + 30_000),
    })
    const realtime = await materializeSourceGroup({ family: 'chat', groupId: execution.id })
    expect(realtime.upserted).toHaveLength(1)
    expect((await materializeSourceGroup({ family: 'chat', groupId: execution.id })).upserted).toEqual([])
    const first = await repairSquadActivity(repairWindow)
    const second = await repairSquadActivity(repairWindow)
    expect(first.errors).toBe(0)
    expect(second.changed).toBe(0)
    const stored = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(stored.map((row) => row.summary)).toContain('Building #241 ready')
    // Simulate a pre-preview materialization. Repair must read original Markdown,
    // not parse the lossy stored summary or leave its old hash untouched.
    await db
      .update(squadActivity)
      .set({ summary: '[broken legacy', preview: [], payloadHash: 'old' })
      .where(eq(squadActivity.squadId, squad.id))
    const regenerated = await repairSquadActivity(repairWindow)
    expect(regenerated.errors).toBe(0)
    const [repaired] = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(repaired.preview).toEqual([
      { text: 'Building ' },
      { text: '#241', href: 'ficus:ws:241' },
      { text: ' ' },
      { text: 'ready', bold: true },
    ])
    expect(repaired.summary).toBe('Building #241 ready')
    expect((await repairSquadActivity(repairWindow)).changed).toBe(0)
  })

  test('subagent report rows identify the recipient through the real inbox loader', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-subagent-parent-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [parent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'reviewer' }).returning()
    const [sub] = await db
      .insert(agents)
      .values({ squadId: squad.id, agentTypeId: 'subagent', parentAgentId: parent.id })
      .returning()
    const [report] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: parent.id,
        senderType: 'agent',
        senderId: sub.id,
        content: 'Final report: all clear',
        deliveryMode: 'follow-up',
        metadata: {},
      })
      .returning()
    try {
      await materializeSourceGroup({ family: 'inbox', groupId: report.id })
      const [row] = await db.select().from(squadActivity).where(eq(squadActivity.sourceGroupId, report.id))
      expect(row).toMatchObject({ lane: 22, kind: 'subagent', agentId: parent.id, agentTypeId: 'reviewer' })
      expect(row.summary.startsWith('Received report from Subagent:')).toBe(true)
    } finally {
      await db.delete(inbox).where(eq(inbox.id, report.id))
    }
  })

  test('bounded repair rewrites legacy received rows, preserves terminated history, and filters by recipient', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-received-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const [recipient] = await db
      .insert(agents)
      .values({ squadId: squad.id, agentTypeId: 'engineer', status: 'terminated' })
      .returning()
    const [sender] = await db
      .insert(agents)
      .values({ squadId: squad.id, agentTypeId: 'subagent', status: 'terminated', metadata: { name: 'audit' } })
      .returning()
    // Older than the automatic 48h sweep; explicit bounded repair is required.
    const createdAt = new Date(Date.now() - 10 * DAY_MS)
    const receipts = await db
      .insert(inbox)
      .values([
        {
          recipientType: 'agent',
          recipientId: recipient.id,
          senderType: 'agent',
          senderId: sender.id,
          content: 'Done',
          createdAt,
        },
        { recipientType: 'agent', recipientId: recipient.id, senderType: 'system', content: 'Notice', createdAt },
      ])
      .returning()
    try {
      for (const receipt of receipts) await materializeSourceGroup({ family: 'inbox', groupId: receipt.id })
      await db
        .update(squadActivity)
        .set({
          agentId: sender.id,
          agentTypeId: 'subagent',
          summary: 'Sent message to Engineer: legacy',
          preview: [{ text: 'legacy' }],
          payloadHash: 'legacy',
        })
        .where(eq(squadActivity.squadId, squad.id))
      const window = {
        from: new Date(createdAt.getTime() - 1_000),
        to: new Date(createdAt.getTime() + 1_000),
        pageSize: 1,
        concurrency: 1,
      }
      const repair = await repairSquadActivity(window)
      expect(repair.errors).toBe(0)
      expect(repair.updated).toBe(2)
      expect(repair.inserted).toBe(0)
      expect(repair.deleted).toBe(0)
      expect((await repairSquadActivity(window)).changed).toBe(0)
      const stored = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
      expect(stored).toHaveLength(2)
      expect(stored.every((row) => row.agentId === recipient.id && row.agentTypeId === 'engineer')).toBe(true)
      expect(stored.map((row) => row.summary).sort()).toEqual([
        'Received report from Subagent (audit): Done',
        'Received system notification: Notice',
      ])
      const access = { agentsRead: true, workstreamsRead: true, inbox: { mode: 'all' as const } }
      const filters = { verbose: false, agentIds: [recipient.id], kinds: [], limit: 20 }
      for (const agentsRead of [true, false]) {
        const scopedAccess = { ...access, agentsRead }
        const squadPage = await projectSquadActivity({ ...filters, squadId: squad.id, access: scopedAccess })
        const globalPage = await projectGlobalActivity({
          ...filters,
          squadAccess: [{ squadId: squad.id, access: scopedAccess }],
        })
        for (const page of [squadPage, globalPage]) {
          expect(page.items).toHaveLength(2)
          expect(page.items.every((item) => item.agentTypeId === (agentsRead ? 'engineer' : null))).toBe(true)
          expect(page.items.every((item) => item.ref.type === 'agent' && item.ref.agentId === recipient.id)).toBe(true)
        }
      }
      expect(
        (await projectSquadActivity({ ...filters, agentIds: [sender.id], squadId: squad.id, access })).items
      ).toEqual([])
      expect(
        (
          await projectSquadActivity({
            ...filters,
            squadId: squad.id,
            access: { ...access, inbox: { mode: 'own', recipientId: sender.id } },
          })
        ).items
      ).toEqual([])
    } finally {
      for (const receipt of receipts) await db.delete(inbox).where(eq(inbox.id, receipt.id))
    }
  })

  test('keyset-pages beyond page size and repairs missed inserts and deletes', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `activity-repair-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    createdSquads.push(squad.id)
    const fixtureNow = new Date()
    // Keep repair-backed timestamps relative so they stay inside Activity retention as wall time advances.
    const createdAt = new Date(fixtureNow.getTime() - DAY_MS)
    expect(fixtureNow.getTime() - createdAt.getTime()).toBe(DAY_MS)
    const repairWindow = {
      from: new Date(createdAt.getTime() - 60_000),
      to: new Date(createdAt.getTime() + 60_000),
    }
    const inserted = await db
      .insert(workStreams)
      .values(Array.from({ length: 7 }, (_, index) => ({ squadId: squad.id, title: `Repair ${index}`, createdAt })))
      .returning({ id: workStreams.id })
    const expected = new Set(inserted.map((row) => row.id))
    const seen = new Set<string>()
    let cursor: SourceGroupCursor | null = null
    do {
      const page = await listSourceGroupPage('workstream', repairWindow.from, repairWindow.to, cursor, 2)
      for (const id of page.groupIds) if (expected.has(id)) seen.add(id)
      cursor = page.next
    } while (cursor)
    expect(seen).toEqual(expected)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toEqual([])

    const repaired = await repairSquadActivity({ ...repairWindow, pageSize: 2 })
    expect(repaired.families.workstream.pages).toBeGreaterThan(3)
    expect(await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))).toHaveLength(7)

    await db.delete(workStreams).where(eq(workStreams.id, inserted[0].id))
    const deletionRepair = await repairSquadActivity({ ...repairWindow, pageSize: 2 })
    expect(deletionRepair.deleted).toBeGreaterThanOrEqual(1)
    const remaining = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
    expect(remaining.map((row) => row.rowId)).not.toContain(inserted[0].id)
  })
})
