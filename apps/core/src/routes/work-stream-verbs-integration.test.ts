/**
 * End-to-end integration probes for the work-stream verbs redesign
 * (docs/history/decisions/work-stream-verbs-redesign.md), exercising the full
 * route → entity → db → notification path across the three slices:
 *
 * 1. checkpoint journey: request-review --no-complete → typed resolve
 *    approve WITH note → stream still active, note recorded AND delivered
 *    to the assignee → done then succeeds (no open waits left).
 * 2. input journey: request-input → typed resolve cleared with note →
 *    derived state back to normal, note in the assignee's inbox.
 * 3. reopen under a full cap queues; freeing the cap promotes it.
 * 4. cross-stream waitId isolation at the ROUTE level (attacker-shaped
 *    probe: resolving another stream's wait id must 404 and leave it open).
 * 5. migration 0123 materializes the boolean default on the database
 *    (read back from information_schema, not just through the ORM).
 */
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { and, eq, sql, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { workStreamsRouter } from './work-streams'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import { agents, agentTypes, inbox, squads, workStreams } from '../db/schema'
import { AgentType } from '../entities/AgentType'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { promoteEligibleQueuedStreams } from '../services/work-streams/admission'
import { createTestAdmin, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/workstreams', workStreamsRouter)

const probePrefix = `ws-verbs-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: probePrefix })
})

afterAll(async () => {
  await cleanupTestRbac(probePrefix)
  const squadRows = await db
    .select({ id: squads.id })
    .from(squads)
    .where(sql`${squads.name} like ${probePrefix + '%'}`)
  if (squadRows.length > 0) {
    await db.delete(workStreams).where(
      inArray(
        workStreams.squadId,
        squadRows.map((s) => s.id)
      )
    )
    await db.delete(squads).where(
      inArray(
        squads.id,
        squadRows.map((s) => s.id)
      )
    )
  }
  await db.delete(agents).where(eq(agents.agentTypeId, `${probePrefix}-agent-type`))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${probePrefix}-agent-type`))
})

describe('work-stream verbs end-to-end integration probes', () => {
  let squadId: string
  let assigneeId: string

  async function apiFetch(url: string, init?: { method?: string; body?: string }): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost${url}`, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      })
    )
  }
  // These probes exercise lifecycle routes for persisted pre-flow streams.
  // Creation API/default-flow coverage lives in work-streams.test.ts.
  const storedStream = storedLegacyWorkStream
  const postJson = (url: string, body: unknown) => apiFetch(url, { method: 'POST', body: JSON.stringify(body) })
  const patchJson = (url: string, body: unknown) => apiFetch(url, { method: 'PATCH', body: JSON.stringify(body) })

  async function assigneeInbox(workStreamId: string, event: string): Promise<string[]> {
    const rows = await db
      .select({ content: inbox.content })
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientId, assigneeId),
          sql`${inbox.metadata}->>'workStreamId' = ${workStreamId}`,
          sql`${inbox.metadata}->>'event' = ${event}`
        )
      )
    return rows.map((r) => r.content)
  }

  beforeEach(async () => {
    await AgentType.upsert({
      id: `${probePrefix}-agent-type`,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Verbs Probe Agent Type',
      systemPrompt: 'probe',
    })
    const squad = await Squad.create({
      name: `${probePrefix} squad ${Math.random().toString(36).slice(2, 6)}`,
      purpose: 'verb probes',
    })
    squadId = squad.id
    const assignee = await Agent.create({ agentTypeId: `${probePrefix}-agent-type`, squadId })
    assigneeId = assignee.id
  })

  it('probe 1: checkpoint review journey — request-review --no-complete, approve with note via typed resolve, then done', async () => {
    const created = await storedStream({
      squadId,
      title: `${probePrefix} checkpoint journey`,
      assigneeAgentId: assigneeId,
      agentIds: [assigneeId],
    })
    expect(created.status).toBe('active')

    const reviewRes = await postJson(`/api/workstreams/${created.id}/request-review`, {
      message: 'checkpoint: schema design',
      completesOnApproval: false,
    })
    expect(reviewRes.status).toBe(200)
    const { wait } = await reviewRes.json()
    expect(wait.completesOnApproval).toBe(false)

    const resolveRes = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
      resolution: 'approved',
      note: 'direction confirmed — keep going',
    })
    expect(resolveRes.status).toBe(200)
    const resolved = await resolveRes.json()
    // Stream continues; the wait is approved with the note recorded.
    expect(resolved.status).toBe('active')
    expect(resolved.wait.id).toBe(wait.id)
    expect(resolved.wait.resolution).toBe('approved')
    expect(resolved.wait.resolutionNote).toBe('direction confirmed — keep going')

    // The note reached the assignee (notification layer, not just the row).
    const notices = await assigneeInbox(created.id, 'reviewed')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('direction confirmed — keep going')

    // No open waits remain → done now succeeds (spec §5 guard passes).
    const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
    expect(detail.openWaits ?? []).toHaveLength(0)
    const doneRes = await patchJson(`/api/workstreams/${created.id}`, { status: 'done' })
    expect(doneRes.status).toBe(200)
    expect((await doneRes.json()).status).toBe('done')
  })

  it('probe 2: input journey — request-input, typed resolve cleared with note, derived state normal, note delivered', async () => {
    const created = await storedStream({
      squadId,
      title: `${probePrefix} input journey`,
      assigneeAgentId: assigneeId,
      agentIds: [assigneeId],
    })

    const inputRes = await postJson(`/api/workstreams/${created.id}/request-input`, {
      message: 'Need the staging API key',
    })
    expect(inputRes.status).toBe(200)
    const { wait } = await inputRes.json()
    expect(wait.type).toBe('manual')

    // Derived state shows the input request while the wait is open.
    const blocked = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
    expect((blocked.openWaits ?? []).map((w: { type: string }) => w.type)).toContain('manual')

    const resolveRes = await postJson(`/api/workstreams/${created.id}/waits/${wait.id}/resolve`, {
      resolution: 'cleared',
      note: 'key is ficus-staging-123, rotate after use',
    })
    expect(resolveRes.status).toBe(200)
    const resolved = await resolveRes.json()
    expect(resolved.status).toBe('active')
    expect(resolved.wait.resolution).toBe('cleared')
    expect(resolved.wait.resolutionNote).toBe('key is ficus-staging-123, rotate after use')

    // Back to normal: no open waits in the stream detail.
    const detail = await (await apiFetch(`/api/workstreams/${created.id}`)).json()
    expect(detail.openWaits ?? []).toHaveLength(0)

    // The note reached the assignee's inbox.
    const notices = await assigneeInbox(created.id, 'unblocked')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('key is ficus-staging-123, rotate after use')
  })

  it('probe 3: reopen under a full cap queues; freeing the cap promotes it', async () => {
    const squad = await Squad.mustFind(squadId)
    await squad.update({ maxConcurrentWorkStreams: 1 })

    const holder = await storedStream({ squadId, title: `${probePrefix} cap holder` })
    expect(holder.status).toBe('active')

    // Second stream: complete it while queued, then reopen under the full cap.
    const reopened = await storedStream({ squadId, title: `${probePrefix} reopen target` })
    expect(reopened.status).toBe('queued')
    expect((await patchJson(`/api/workstreams/${reopened.id}`, { status: 'done' })).status).toBe(200)

    const reopenRes = await postJson(`/api/workstreams/${reopened.id}/reopen`, {})
    expect(reopenRes.status).toBe(200)
    const afterReopen = await reopenRes.json()
    // Cap is full (holder active): re-enters ADMISSION, stays queued.
    expect(afterReopen.status).toBe('queued')
    expect(afterReopen.completedAt).toBeUndefined()

    // Free the cap and run the admission tick: the reopened stream promotes.
    expect((await patchJson(`/api/workstreams/${holder.id}`, { status: 'done' })).status).toBe(200)
    await promoteEligibleQueuedStreams(squadId)
    const promoted = await (await apiFetch(`/api/workstreams/${reopened.id}`)).json()
    expect(promoted.status).toBe('active')
  })

  it("probe 4: resolving another stream's wait id through the route 404s and leaves the wait open", async () => {
    const target = await storedStream({ squadId, title: `${probePrefix} attacker target` })
    const victim = await storedStream({ squadId, title: `${probePrefix} victim stream` })
    const { wait: victimWait } = await (
      await postJson(`/api/workstreams/${victim.id}/request-input`, { message: 'victim input' })
    ).json()

    // Attacker-shaped call: victim's wait id under the target stream's id.
    const res = await postJson(`/api/workstreams/${target.id}/waits/${victimWait.id}/resolve`, {
      resolution: 'cleared',
    })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('wait_not_found')

    // The victim's wait survived untouched and still resolves normally.
    const victimDetail = await (await apiFetch(`/api/workstreams/${victim.id}`)).json()
    expect((victimDetail.openWaits ?? []).some((w: { id: string }) => w.id === victimWait.id)).toBe(true)
    const legit = await postJson(`/api/workstreams/${victim.id}/waits/${victimWait.id}/resolve`, {
      resolution: 'cleared',
    })
    expect(legit.status).toBe(200)
  })

  it('probe 5: migration 0123 materializes completes_on_approval as boolean NOT NULL DEFAULT true', async () => {
    const [col] = await db.execute<{ column_default: string; is_nullable: string; data_type: string }>(
      sql`SELECT column_default, is_nullable, data_type
          FROM information_schema.columns
          WHERE table_name = 'work_stream_waits' AND column_name = 'completes_on_approval'`
    )
    expect(col).toBeDefined()
    expect(col.data_type).toBe('boolean')
    expect(col.is_nullable).toBe('NO')
    expect(col.column_default).toBe('true')
  })
})
