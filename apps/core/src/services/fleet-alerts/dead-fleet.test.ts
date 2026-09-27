import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, inArray, isNull, like } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executions, fleetIncidentNotifications, fleetIncidents, inbox, squads } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'
import type { SquadDemandSnapshot } from './demand'
import { reconcileDeadFleet } from './dead-fleet'
import { FleetIncidentNotifier } from './notifier'

const WINDOW = 30 * 60 * 1000
const HUMAN_FALLBACK = 15 * 60 * 1000
const START = new Date('2026-08-18T12:00:00Z')
const at = (milliseconds: number) => new Date(START.getTime() + milliseconds)

describe('dead fleet reconciliation', () => {
  let squadId: string
  let agentId: string
  let ownedSquadIds: string[]
  let ownedIncidentIds: string[]

  beforeEach(async () => {
    squadId = crypto.randomUUID()
    agentId = crypto.randomUUID()
    ownedSquadIds = [squadId]
    ownedIncidentIds = []
    await db
      .insert(squads)
      .values({ id: squadId, name: `dead-fleet-${squadId}`, purpose: 'Dead fleet test', status: 'active' })
    await db.insert(agents).values({ id: agentId, agentTypeId: 'engineer', squadId, status: 'idle' })
  })

  afterEach(async () => {
    const incidentIds = [
      ...ownedIncidentIds,
      ...(
        await db
          .select({ id: fleetIncidents.id })
          .from(fleetIncidents)
          .where(inArray(fleetIncidents.squadId, ownedSquadIds))
      ).map((row) => row.id),
    ]
    if (incidentIds.length) {
      for (const incidentId of incidentIds) {
        await db.delete(inbox).where(like(inbox.idempotencyKey, `fleet-incident:${incidentId}:%`))
      }
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.incidentId, incidentIds))
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, incidentIds))
    }
    await db.delete(squads).where(inArray(squads.id, ownedSquadIds))
  })

  const demand = (count: number, firstDemandAt: Date | null): Map<string, SquadDemandSnapshot> =>
    new Map([[squadId, { count, firstDemandAt }]])

  const incidents = () =>
    db
      .select()
      .from(fleetIncidents)
      .where(eq(fleetIncidents.scopeKey, `squad:${squadId}`))

  const notifications = (incidentId: string) =>
    db.select().from(fleetIncidentNotifications).where(eq(fleetIncidentNotifications.incidentId, incidentId))

  test('is silent at 29:59, alerts at exactly 30:00, and deduplicates continuous backlog', async () => {
    await reconcileDeadFleet({ now: at(WINDOW - 1000), demand: demand(2, START) })
    const [pending] = await incidents()
    expect(pending).toMatchObject({
      kind: 'squad_dead_fleet',
      squadId,
      startedAt: START,
      alertAfter: at(WINDOW),
      resolvedAt: null,
    })
    expect(await notifications(pending.id)).toEqual([])

    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(3, START) })
    await reconcileDeadFleet({ now: at(WINDOW + 60_000), demand: demand(4, START) })

    expect(await incidents()).toHaveLength(1)
    expect((await incidents())[0]?.details).toEqual({ demandCount: 4, oldestDemandAt: START.toISOString() })
    const deliveries = await notifications(pending.id)
    const byAudience = new Map(deliveries.map((row) => [row.audience, row]))
    expect(byAudience.get('manager')).toMatchObject({ status: 'pending', nextAttemptAt: at(WINDOW) })
    expect(byAudience.get('human')).toMatchObject({
      status: 'pending',
      nextAttemptAt: at(WINDOW + HUMAN_FALLBACK),
    })
  })

  test('anchors a late manager-first human fallback to first alert materialization without deadline drift', async () => {
    const firstMaterializedAt = at(WINDOW + HUMAN_FALLBACK + 60_000)
    const humanDueAt = new Date(firstMaterializedAt.getTime() + HUMAN_FALLBACK)

    await reconcileDeadFleet({ now: firstMaterializedAt, demand: demand(2, START) })
    const [incident] = await incidents()
    let byAudience = new Map((await notifications(incident.id)).map((row) => [row.audience, row]))

    expect(byAudience.get('manager')?.nextAttemptAt).toEqual(at(WINDOW))
    expect(byAudience.get('human')?.nextAttemptAt).toEqual(humanDueAt)

    const notifier = new FleetIncidentNotifier()
    expect(
      (await notifier.claimDue({ now: firstMaterializedAt, incidentIds: [incident.id] })).map((row) => row.audience)
    ).toEqual(['manager'])
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: firstMaterializedAt })
      .where(
        and(eq(fleetIncidentNotifications.incidentId, incident.id), eq(fleetIncidentNotifications.audience, 'manager'))
      )

    await reconcileDeadFleet({
      now: new Date(firstMaterializedAt.getTime() + 60_000),
      demand: demand(3, START),
    })
    byAudience = new Map((await notifications(incident.id)).map((row) => [row.audience, row]))
    expect(byAudience.get('human')?.nextAttemptAt).toEqual(humanDueAt)

    expect(await notifier.claimDue({ now: new Date(humanDueAt.getTime() - 1), incidentIds: [incident.id] })).toEqual([])
    expect(
      (await notifier.claimDue({ now: humanDueAt, incidentIds: [incident.id] })).map((row) => row.audience)
    ).toEqual(['human'])
  })

  test('starts the alert window at worker cold start when backlog predates all run history', async () => {
    const coldStartAt = at(10 * 60 * 1000)
    await reconcileDeadFleet({ now: coldStartAt, coldStartAt, demand: demand(2, START) })
    const [incident] = await incidents()
    expect(incident.startedAt).toEqual(coldStartAt)
    expect(incident.alertAfter).toEqual(new Date(coldStartAt.getTime() + WINDOW))
    expect(await notifications(incident.id)).toEqual([])
  })

  test('starts a new stall window at the latest real run before opening an incident', async () => {
    const runStartedAt = at(5 * 60 * 1000)
    await db.insert(executions).values({
      agentId,
      status: 'running',
      startedAt: at(-60_000),
      runStartedAt,
    })

    await reconcileDeadFleet({
      now: new Date(runStartedAt.getTime() + WINDOW - 1),
      demand: demand(2, START),
    })
    const [incident] = await incidents()
    expect(incident.startedAt).toEqual(runStartedAt)
    expect(await notifications(incident.id)).toEqual([])

    await reconcileDeadFleet({ now: new Date(runStartedAt.getTime() + WINDOW), demand: demand(2, START) })
    expect((await notifications(incident.id)).map((row) => row.audience).sort()).toEqual(['human', 'manager'])
  })

  test('recovers exactly once only from a same-squad runStartedAt after the episode start', async () => {
    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(2, START) })
    const [openIncident] = await incidents()
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: at(WINDOW) })
      .where(
        and(
          eq(fleetIncidentNotifications.incidentId, openIncident.id),
          eq(fleetIncidentNotifications.audience, 'manager')
        )
      )

    await db.insert(executions).values({
      agentId,
      status: 'running',
      startedAt: at(1),
      runStartedAt: null,
    })
    await db.insert(executions).values([
      {
        agentId,
        status: 'running',
        startedAt: at(-60_000),
        runStartedAt: START,
      },
      {
        agentId,
        status: 'running',
        startedAt: at(-60_000),
        runStartedAt: at(WINDOW + 60_000),
      },
    ])
    const crossSquadId = crypto.randomUUID()
    const crossAgentId = crypto.randomUUID()
    ownedSquadIds.push(crossSquadId)
    await db.insert(squads).values({
      id: crossSquadId,
      name: `dead-fleet-${crossSquadId}`,
      purpose: 'Cross-squad run test',
      status: 'active',
    })
    await db
      .insert(agents)
      .values({ id: crossAgentId, agentTypeId: 'engineer', squadId: crossSquadId, status: 'active' })
    await db.insert(executions).values({
      agentId: crossAgentId,
      status: 'running',
      startedAt: at(-60_000),
      runStartedAt: at(WINDOW + 1),
    })
    await reconcileDeadFleet({ now: at(WINDOW + 2), demand: demand(2, START) })
    expect((await incidents()).find((row) => row.id === openIncident.id)?.resolvedAt).toBeNull()

    await db.insert(executions).values({
      agentId,
      status: 'running',
      startedAt: at(-60_000),
      runStartedAt: at(WINDOW + 3),
    })
    await reconcileDeadFleet({ now: at(WINDOW + 4), demand: demand(2, START) })

    const oldIncident = (await incidents()).find((row) => row.id === openIncident.id)!
    expect(oldIncident.resolvedAt).toEqual(at(WINDOW + 4))
    expect((await notifications(oldIncident.id)).map((row) => `${row.kind}:${row.audience}`).sort()).toEqual([
      'alert:human',
      'alert:manager',
      'recovery:manager',
    ])
    expect((await incidents()).filter((row) => row.id !== oldIncident.id)).toEqual([])
  })

  test('does not recover from the current manager run but does recover from a worker run', async () => {
    const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId, status: 'idle' }).returning()
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))
    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(2, START) })
    const [incident] = await incidents()

    await db.insert(executions).values({
      agentId: manager.id,
      status: 'running',
      startedAt: at(WINDOW + 1),
      runStartedAt: at(WINDOW + 1),
    })
    await reconcileDeadFleet({ now: at(WINDOW + 2), demand: demand(2, START) })
    expect((await incidents()).find((row) => row.id === incident.id)?.resolvedAt).toBeNull()

    await db.insert(executions).values({
      agentId,
      status: 'running',
      startedAt: at(WINDOW + 3),
      runStartedAt: at(WINDOW + 3),
    })
    await reconcileDeadFleet({ now: at(WINDOW + 4), demand: demand(2, START) })
    expect((await incidents()).find((row) => row.id === incident.id)?.resolvedAt).toEqual(at(WINDOW + 4))
  })

  test('does not let pre-episode manager history move the dead-fleet window', async () => {
    const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId, status: 'idle' }).returning()
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))
    await db.insert(executions).values({
      agentId: manager.id,
      status: 'running',
      startedAt: at(5 * 60_000),
      runStartedAt: at(5 * 60_000),
    })

    await reconcileDeadFleet({ now: at(10 * 60_000), demand: demand(2, START) })
    const [incident] = await incidents()
    expect(incident.startedAt).toEqual(START)
    expect(incident.alertAfter).toEqual(at(WINDOW))
  })

  test('clearing demand before threshold resolves silently without a recovery notification', async () => {
    await reconcileDeadFleet({ now: at(WINDOW - 1000), demand: demand(1, START) })
    const [incident] = await incidents()

    await reconcileDeadFleet({ now: at(WINDOW - 500), demand: demand(0, null) })

    expect((await incidents()).find((row) => row.id === incident.id)?.resolvedAt).toEqual(at(WINDOW - 500))
    expect(await notifications(incident.id)).toEqual([])
  })

  test.each([
    ['after one minute', 60_000],
    ['one millisecond before the human deadline', HUMAN_FALLBACK - 1],
  ])('suppresses human fan-out when recovery occurs %s', async (_label, recoveryDelayMs) => {
    const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId, status: 'idle' }).returning()
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))

    const firstMaterializedAt = at(WINDOW + HUMAN_FALLBACK + 60_000)
    const humanDueAt = new Date(firstMaterializedAt.getTime() + HUMAN_FALLBACK)
    await reconcileDeadFleet({ now: firstMaterializedAt, demand: demand(2, START) })
    const [incident] = await incidents()

    const humanEvents: string[] = []
    const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
      if (event.source === 'fleet-alert' && event.squadId === squadId) humanEvents.push(event.messageId)
    })
    try {
      const notifier = new FleetIncidentNotifier()
      await notifier.drain({ now: firstMaterializedAt, incidentIds: [incident.id] })
      await reconcileDeadFleet({
        now: new Date(firstMaterializedAt.getTime() + recoveryDelayMs),
        demand: demand(0, null),
      })
      await notifier.drain({ now: humanDueAt, incidentIds: [incident.id] })
    } finally {
      unsubscribe()
    }

    const deliveries = await notifications(incident.id)
    expect(deliveries.find((row) => row.kind === 'alert' && row.audience === 'human')).toMatchObject({
      status: 'canceled',
    })
    expect(deliveries.some((row) => row.kind === 'recovery' && row.audience === 'human')).toBe(false)
    expect(
      await db
        .select()
        .from(inbox)
        .where(like(inbox.idempotencyKey, `fleet-incident:${incident.id}:%:human:%`))
    ).toEqual([])
    expect(humanEvents).toEqual([])
  })

  test('clearing demand resolves an alerted incident exactly once', async () => {
    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(1, START) })
    const [open] = await incidents()
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: at(WINDOW) })
      .where(
        and(eq(fleetIncidentNotifications.incidentId, open.id), eq(fleetIncidentNotifications.audience, 'manager'))
      )
    await reconcileDeadFleet({ now: at(WINDOW + 1), demand: demand(0, null) })
    await reconcileDeadFleet({ now: at(WINDOW + 2), demand: demand(0, null) })

    const [incident] = await incidents()
    expect(incident.resolvedAt).toEqual(at(WINDOW + 1))
    expect((await notifications(incident.id)).map((row) => `${row.kind}:${row.audience}`).sort()).toEqual([
      'alert:human',
      'alert:manager',
      'recovery:manager',
    ])
  })

  test('does not persist incidents for quiet, parked, or open-wait demand represented by zero', async () => {
    const parkedSquadId = crypto.randomUUID()
    ownedSquadIds.push(parkedSquadId)
    await db.insert(squads).values({
      id: parkedSquadId,
      name: `dead-fleet-${parkedSquadId}`,
      purpose: 'Zero-demand test',
      status: 'active',
    })

    await reconcileDeadFleet({
      now: at(WINDOW * 2),
      demand: new Map([
        [squadId, { count: 0, firstDemandAt: null }],
        [parkedSquadId, { count: 0, firstDemandAt: null }],
      ]),
    })

    expect(
      await db
        .select()
        .from(fleetIncidents)
        .where(inArray(fleetIncidents.squadId, [squadId, parkedSquadId]))
    ).toEqual([])
  })

  test('preserves incident continuity across fresh reconciler calls', async () => {
    await reconcileDeadFleet({ now: at(WINDOW - 1), demand: demand(1, START) })
    const [first] = await incidents()

    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(5, START) })
    const [afterRestart] = await incidents()

    expect(afterRestart.id).toBe(first.id)
    expect(afterRestart.startedAt).toEqual(START)
    expect(await notifications(afterRestart.id)).toHaveLength(2)
  })

  test('refreshes a pending incident with the most recent unresolved cause at alert time', async () => {
    await reconcileDeadFleet({ now: at(WINDOW - 1000), demand: demand(2, START) })
    const [pending] = await incidents()
    expect(pending).toMatchObject({ causeCode: 'demand-not-served' })
    // The cause of last resort states the OBSERVED stall (how much work, how
    // long) rather than reporting that some other probe was unavailable.
    expect(pending.causeSummary).toMatch(/2 pending work items remain; oldest is \d+m old/)

    const olderId = crypto.randomUUID()
    const expectedId = crypto.randomUUID()
    const resolvedNewerId = crypto.randomUUID()
    ownedIncidentIds.push(olderId, expectedId, resolvedNewerId)
    await db.insert(fleetIncidents).values([
      {
        id: olderId,
        kind: 'provider_unhealthy',
        scopeKey: `provider:older:account:${crypto.randomUUID()}`,
        provider: 'older',
        startedAt: at(-WINDOW),
        alertAfter: START,
        lastObservedAt: at(-3000),
        causeCode: 'network',
        causeSummary: 'Older sanitized provider failure.',
        remediation: null,
        details: { ignoredSecret: 'older-secret' },
        updatedAt: at(-3000),
      },
      {
        id: expectedId,
        kind: 'provider_unhealthy',
        scopeKey: `provider:openai-codex:account:${crypto.randomUUID()}`,
        provider: 'openai-codex',
        healthKind: 'expired-oauth',
        startedAt: at(-WINDOW),
        alertAfter: START,
        lastObservedAt: at(-2000),
        causeCode: 'expired-oauth',
        causeSummary: 'OAuth refresh credential expired or was revoked.',
        remediation: 'Run `ficus pa login openai-codex` to authenticate again.',
        details: { ignoredSecret: 'expected-secret' },
        updatedAt: at(-2000),
      },
      {
        id: resolvedNewerId,
        kind: 'provider_unhealthy',
        scopeKey: `provider:resolved:account:${crypto.randomUUID()}`,
        provider: 'resolved',
        startedAt: at(-WINDOW),
        alertAfter: START,
        lastObservedAt: at(-1000),
        resolvedAt: at(-500),
        causeCode: 'invalid-credential',
        causeSummary: 'Resolved sanitized provider failure.',
        remediation: 'Resolved remediation.',
        details: { ignoredSecret: 'resolved-secret' },
        updatedAt: at(-500),
      },
    ])

    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(2, START) })

    const deadFleet = (await incidents()).find((row) => row.kind === 'squad_dead_fleet')!
    expect(deadFleet.id).toBe(pending.id)
    expect(deadFleet).toMatchObject({
      causeCode: 'expired-oauth',
      causeSummary: 'OAuth refresh credential expired or was revoked.',
      remediation: 'Run `ficus pa login openai-codex` to authenticate again.',
    })
    expect(deadFleet.details).toEqual({
      demandCount: 2,
      oldestDemandAt: START.toISOString(),
      providerIncidentId: expectedId,
      provider: 'openai-codex',
    })
    expect(JSON.stringify(deadFleet)).not.toContain('secret')
    expect(JSON.stringify(deadFleet)).not.toContain(olderId)
    expect(JSON.stringify(deadFleet)).not.toContain(resolvedNewerId)
    expect((await notifications(deadFleet.id)).map((row) => row.audience).sort()).toEqual(['human', 'manager'])
  })

  test("blames THIS squad's degraded sandbox — the kind that explains transport stalls", async () => {
    // A wedged ssh master / degraded box is exactly why nothing starts, and it
    // is recorded as a sandbox_degraded incident. Before this was consulted, an
    // operator got "No provider probe error is currently available" and was
    // pointed at provider tooling that had nothing to do with the outage.
    const sandboxId = crypto.randomUUID()
    ownedIncidentIds.push(sandboxId)
    await db.insert(fleetIncidents).values({
      id: sandboxId,
      kind: 'sandbox_degraded',
      scopeKey: `sandbox:agent_${agentId}`,
      squadId,
      startedAt: START,
      alertAfter: START,
      lastObservedAt: START,
      causeCode: 'sandbox-setup-degraded',
      causeSummary: 'VM sandbox best-effort setup remains degraded.',
      remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
      details: { sandboxId: `agent_${agentId}`, reasons: ['callback_transport_degraded'], attemptCount: 3 },
      updatedAt: START,
    })

    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(1, START) })

    const [incident] = await incidents()
    expect(incident).toMatchObject({
      causeCode: 'sandbox-setup-degraded',
      remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
      details: { sandboxIncidentId: sandboxId, sandboxReasons: ['callback_transport_degraded'] },
    })
    // The concrete reason is surfaced, not just the generic summary.
    expect(incident.causeSummary).toContain('callback_transport_degraded')
  })

  test("ignores another squad's degraded sandbox rather than blaming it", async () => {
    const otherSquadId = crypto.randomUUID()
    ownedSquadIds.push(otherSquadId)
    await db
      .insert(squads)
      .values({ id: otherSquadId, name: `other-${otherSquadId}`, purpose: 'other', status: 'active' })
    const foreignId = crypto.randomUUID()
    ownedIncidentIds.push(foreignId)
    await db.insert(fleetIncidents).values({
      id: foreignId,
      kind: 'sandbox_degraded',
      scopeKey: `sandbox:agent_${crypto.randomUUID()}`,
      squadId: otherSquadId,
      startedAt: START,
      alertAfter: START,
      lastObservedAt: START,
      causeCode: 'sandbox-setup-degraded',
      causeSummary: 'VM sandbox best-effort setup remains degraded.',
      remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
      details: { reasons: ['devbox_unavailable'] },
      updatedAt: START,
    })

    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(1, START) })

    const [incident] = await incidents()
    // Falls through to the observed stall — a foreign squad's box explains nothing.
    expect(incident.causeCode).toBe('demand-not-served')
    expect(incident.details).not.toMatchObject({ sandboxIncidentId: foreignId })
  })

  test('does not re-alert immediately after a recovery (flap suppression)', async () => {
    // The real flap: a BACKLOG that has been waiting a long time. Each new
    // episode inherits that old firstDemandAt, so its 30-minute window has
    // already elapsed and the incident alerts the instant it is opened.
    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(3, START) })
    const [first] = await incidents()
    expect((await notifications(first.id)).map((row) => row.audience).sort()).toEqual(['human', 'manager'])
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: at(WINDOW) })
      .where(
        and(eq(fleetIncidentNotifications.incidentId, first.id), eq(fleetIncidentNotifications.audience, 'manager'))
      )

    // ONE execution starts — all `recoveredByRun` needs — so the incident
    // resolves and a recovery is queued, even though the backlog is unserved.
    await reconcileDeadFleet({ now: at(WINDOW + 60_000), demand: demand(0, null) })
    expect((await notifications(first.id)).map((row) => `${row.kind}:${row.audience}`).sort()).toEqual([
      'alert:human',
      'alert:manager',
      'recovery:manager',
    ])

    // The next sweep sees the same old backlog and opens a fresh incident.
    // WITHOUT the cooldown its alertAfter is already in the past (START+30m),
    // so it alerts immediately — an endless alert/recovery pair for a fleet
    // whose state never changed.
    await reconcileDeadFleet({ now: at(WINDOW + 120_000), demand: demand(3, START) })
    const second = (await incidents()).find((row) => row.id !== first.id)
    expect(second).toBeDefined()
    expect(await notifications(second!.id)).toHaveLength(0)

    // Still silent late in the cooldown (recovery was at 12:31 → hold to 13:01).
    await reconcileDeadFleet({ now: at(59 * 60_000), demand: demand(3, START) })
    expect(await notifications(second!.id)).toHaveLength(0)

    // Once the cooldown since that recovery elapses, a still-stalled fleet
    // alerts again — suppression delays the alert, it never hides a real stall.
    await reconcileDeadFleet({ now: at(62 * 60_000), demand: demand(3, START) })
    expect((await notifications(second!.id)).map((row) => row.audience).sort()).toEqual(['human', 'manager'])
  })

  test('reports backlog age separately from the time since the last run started', async () => {
    const oldest = at(-4115 * 60_000)
    await db.insert(executions).values({ agentId, status: 'completed', startedAt: START, runStartedAt: START })
    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(2, oldest) })
    const [incident] = await incidents()
    expect(incident.causeSummary).toBe(
      '2 pending work items remain; oldest is 4145m old. No execution run has started in the last 30m of pending demand, and no open provider or sandbox incident explains the delay.'
    )
  })

  test('falls back to the observed stall when no provider or sandbox incident explains it', async () => {
    expect(
      await db
        .select()
        .from(fleetIncidents)
        .where(and(eq(fleetIncidents.kind, 'provider_unhealthy'), isNull(fleetIncidents.resolvedAt)))
    ).toEqual([])

    await reconcileDeadFleet({ now: at(WINDOW), demand: demand(1, START) })

    const [incident] = await incidents()
    expect(incident).toMatchObject({
      causeCode: 'demand-not-served',
      remediation:
        'Check machine + sandbox health first (`ficus machines list`, then the box/tunnel logs for that machine), then worker pickup (`ficus worker status`).',
      details: { demandCount: 1 },
    })
    // Demand also includes inbox messages, schedules, and work streams.
    expect(incident.causeSummary).toBe(
      '1 pending work item remains; oldest is 30m old. No execution run has started in the last 30m of pending demand, and no open provider or sandbox incident explains the delay.'
    )
    expect(incident.causeSummary).not.toMatch(/provider probe/)
    expect((await notifications(incident.id)).map((row) => row.audience).sort()).toEqual(['human', 'manager'])
  })
})
