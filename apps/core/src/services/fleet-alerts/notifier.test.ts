import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { eq, inArray, like } from 'drizzle-orm'
import { db } from '../../db'
import { agents, fleetIncidentNotifications, fleetIncidents, inbox, squads } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { Agent } from '../../entities/Agent'
import { makeDormant } from '../agent/lifecycle'
import { FleetIncidentNotifier } from './notifier'
import { bindFleetIncidentManagerTarget, observeSandboxOverload, retryFleetIncidentNotification } from './store'

const NOW = new Date('2026-08-18T12:00:00Z')
const LEASE_MS = 60_000

describe('fleet incident notifier', () => {
  let prefix: string
  let ownedNotificationIds: string[]
  let ownedIncidentIds: string[]
  let ownedSquadIds: string[]
  let ownedAgentIds: string[]

  beforeEach(() => {
    prefix = `fleet-notifier-${crypto.randomUUID()}`
    ownedNotificationIds = []
    ownedIncidentIds = []
    ownedSquadIds = []
    ownedAgentIds = []
  })

  afterEach(async () => {
    if (ownedNotificationIds.length) {
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.id, ownedNotificationIds))
    }
    if (ownedIncidentIds.length) {
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, ownedIncidentIds))
    }
    await db.delete(inbox).where(like(inbox.idempotencyKey, `${prefix}:%`))
    for (const incidentId of ownedIncidentIds) {
      await db.delete(inbox).where(like(inbox.idempotencyKey, `fleet-incident:${incidentId}:%`))
    }
    if (ownedAgentIds.length) await db.delete(agents).where(inArray(agents.id, ownedAgentIds))
    if (ownedSquadIds.length) await db.delete(squads).where(inArray(squads.id, ownedSquadIds))
  })

  async function addIncident(
    input: {
      kind?: 'provider_unhealthy' | 'squad_dead_fleet'
      provider?: string
      squadId?: string
      details?: Record<string, unknown>
    } = {}
  ) {
    const id = crypto.randomUUID()
    ownedIncidentIds.push(id)
    const kind = input.kind ?? 'provider_unhealthy'
    const [incident] = await db
      .insert(fleetIncidents)
      .values({
        id,
        kind,
        scopeKey: `${prefix}:scope:${id}`,
        squadId: input.squadId,
        provider: input.provider,
        startedAt: new Date(NOW.getTime() - 60 * 60_000),
        alertAfter: new Date(NOW.getTime() - 30 * 60_000),
        lastObservedAt: NOW,
        causeCode: 'expired-oauth',
        causeSummary: 'OAuth refresh credential expired or was revoked.',
        remediation: 'Run `ficus pa login openai-codex` to authenticate again.',
        details: input.details ?? {},
        updatedAt: NOW,
      })
      .returning()
    return incident!
  }

  async function addInboxLedger(label: string) {
    const id = crypto.randomUUID()
    await db.insert(inbox).values({
      id,
      recipientType: 'system',
      recipientId: SYSTEM_RECIPIENT_ID,
      senderType: 'system',
      content: label,
      idempotencyKey: `${prefix}:fixture:${id}`,
    })
    return id
  }

  async function addNotification(
    incidentId: string,
    kind: 'alert' | 'recovery',
    options: {
      audience?: 'manager' | 'human'
      nextAttemptAt?: Date
      status?: 'pending' | 'delivering' | 'delivered' | 'canceled' | 'skipped' | 'undeliverable'
      recipientId?: string | null
      idempotencyKey?: string | null
      attempts?: number
    } = {}
  ) {
    const audience = options.audience ?? 'human'
    const [notification] = await db
      .insert(fleetIncidentNotifications)
      .values({
        incidentId,
        kind,
        audience,
        status: options.status ?? 'pending',
        recipientId:
          options.recipientId === undefined ? (audience === 'human' ? SYSTEM_RECIPIENT_ID : null) : options.recipientId,
        idempotencyKey:
          options.idempotencyKey === undefined ? `${prefix}:${incidentId}:${kind}:${audience}` : options.idempotencyKey,
        nextAttemptAt: options.nextAttemptAt ?? NOW,
        attempts: options.attempts ?? 0,
        updatedAt: NOW,
      })
      .returning()
    ownedNotificationIds.push(notification!.id)
    return notification!
  }

  async function addManagedSquad() {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({
      id: squadId,
      name: `Notifier ${squadId}`,
      purpose: 'Fleet notifier test',
      status: 'active',
    })
    const [manager] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
    ownedAgentIds.push(manager.id)
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))
    return { squadId, manager }
  }

  test('delivers a safe system-authored manager message and wakes a dormant manager', async () => {
    const { squadId, manager } = await addManagedSquad()
    await makeDormant(await Agent.mustFind(manager.id))
    const incident = await addIncident({
      kind: 'squad_dead_fleet',
      squadId,
      details: { secret: 'manager-secret-must-not-leak' },
    })
    const notification = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })

    await new FleetIncidentNotifier().drain({ now: NOW, incidentIds: [incident.id] })

    const [persisted] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, notification.id))
    expect(persisted.status).toBe('delivered')
    expect(persisted.recipientId).toBe(manager.id)
    const [message] = await db.select().from(inbox).where(eq(inbox.id, persisted.inboxMessageId!))
    expect(message).toMatchObject({
      recipientType: 'agent',
      recipientId: manager.id,
      senderType: 'system',
      deliveryMode: 'steer',
      metadata: {
        source: 'fleet-incident-manager',
        wakeEligible: true,
        audience: 'manager',
        incidentId: incident.id,
        incidentKind: 'squad_dead_fleet',
        phase: 'alert',
        squadId,
      },
    })
    expect((await db.select({ status: agents.status }).from(agents).where(eq(agents.id, manager.id)))[0]?.status).toBe(
      'idle'
    )
    expect(message.content).toContain('Diagnose')
    expect(message.content).toContain('safe recovery or rerouting')
    expect(message.content).toContain('credentials, approval, billing')
    expect(message.content).not.toContain('manager-secret-must-not-leak')
  })

  test('delivers a due human fallback when manager resolution fails', async () => {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({
      id: squadId,
      name: `Notifier ${squadId}`,
      purpose: 'Missing manager test',
      status: 'active',
    })
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    const manager = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const humanDueAt = new Date(NOW.getTime() + 15 * 60_000)
    const human = await addNotification(incident.id, 'alert', {
      audience: 'human',
      nextAttemptAt: humanDueAt,
    })

    await new FleetIncidentNotifier().drain({ now: NOW, incidentIds: [incident.id] })

    let persisted = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(inArray(fleetIncidentNotifications.id, [manager.id, human.id]))
    expect(persisted.find((row) => row.id === manager.id)).toMatchObject({ status: 'pending', attempts: 1 })
    expect(persisted.find((row) => row.id === human.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: humanDueAt,
    })

    await new FleetIncidentNotifier().drain({ now: humanDueAt, incidentIds: [incident.id] })
    persisted = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(inArray(fleetIncidentNotifications.id, [manager.id, human.id]))
    expect(persisted.find((row) => row.id === human.id)).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  test('adopts a manager inbox winner after crash even when the bound manager terminates', async () => {
    const { squadId, manager: managerA } = await addManagedSquad()
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    const notification = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const crash = new Error('manager crash after sendOnce')
    await expect(
      new FleetIncidentNotifier({ afterSendOnce: async () => Promise.reject(crash) }).drain({
        now: NOW,
        incidentIds: [incident.id],
      })
    ).rejects.toBe(crash)
    const [afterCrash] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, notification.id))
    const firstRows = await db.select().from(inbox).where(eq(inbox.idempotencyKey, afterCrash.idempotencyKey!))
    expect(firstRows).toHaveLength(1)

    await db.update(agents).set({ terminatedAt: NOW }).where(eq(agents.id, managerA.id))
    const [managerB] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
    ownedAgentIds.push(managerB.id)
    await db.update(squads).set({ managerAgentId: managerB.id }).where(eq(squads.id, squadId))
    await new FleetIncidentNotifier().drain({
      now: new Date(NOW.getTime() + LEASE_MS),
      incidentIds: [incident.id],
    })

    const rows = await db.select().from(inbox).where(eq(inbox.idempotencyKey, afterCrash.idempotencyKey!))
    expect(rows.map((row) => row.id)).toEqual([firstRows[0].id])
    const [settled] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, notification.id))
    expect(settled).toMatchObject({ status: 'delivered', recipientId: managerA.id, inboxMessageId: firstRows[0].id })
  })

  test('binds a manager claim once and pins retries after manager replacement', async () => {
    const { squadId, manager: managerA } = await addManagedSquad()
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    const notification = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const humanDueAt = new Date(NOW.getTime() + 15 * 60_000)
    const human = await addNotification(incident.id, 'alert', {
      audience: 'human',
      nextAttemptAt: humanDueAt,
    })
    const notifier = new FleetIncidentNotifier()
    const [first] = await notifier.claimDue({ now: NOW, incidentIds: [incident.id] })
    const targetA = await bindFleetIncidentManagerTarget(first)
    expect(targetA).toEqual({
      recipientId: managerA.id,
      idempotencyKey: `fleet-incident:${incident.id}:alert:manager:${managerA.id}`,
    })

    const [managerB] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
    ownedAgentIds.push(managerB.id)
    await db.update(squads).set({ managerAgentId: managerB.id }).where(eq(squads.id, squadId))
    const [reclaimed] = await notifier.claimDue({
      now: new Date(NOW.getTime() + LEASE_MS),
      incidentIds: [incident.id],
    })
    expect(await bindFleetIncidentManagerTarget(reclaimed)).toEqual(targetA)

    const [persisted] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, notification.id))
    expect(persisted).toMatchObject({ recipientId: managerA.id, idempotencyKey: targetA.idempotencyKey })

    const [persistedHuman] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, human.id))
    expect(persistedHuman).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: humanDueAt })
  })

  test('binds manager recovery independently to the then-current manager', async () => {
    const { squadId, manager: managerA } = await addManagedSquad()
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    await addNotification(incident.id, 'alert', {
      audience: 'manager',
      status: 'delivered',
      recipientId: managerA.id,
      idempotencyKey: `${prefix}:manager-alert`,
    })
    const recovery = await addNotification(incident.id, 'recovery', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const [managerB] = await db.insert(agents).values({ agentTypeId: 'manager', squadId }).returning()
    ownedAgentIds.push(managerB.id)
    await db.update(squads).set({ managerAgentId: managerB.id }).where(eq(squads.id, squadId))

    const [claim] = await new FleetIncidentNotifier().claimDue({ now: NOW, incidentIds: [incident.id] })
    expect(claim.notificationId).toBe(recovery.id)
    expect(await bindFleetIncidentManagerTarget(claim)).toEqual({
      recipientId: managerB.id,
      idempotencyKey: `fleet-incident:${incident.id}:recovery:manager:${managerB.id}`,
    })
  })

  test('rejects stale manager binding tokens', async () => {
    const { squadId } = await addManagedSquad()
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    await addNotification(incident.id, 'alert', { audience: 'manager', recipientId: null, idempotencyKey: null })
    const notifier = new FleetIncidentNotifier()
    const [stale] = await notifier.claimDue({ now: NOW, incidentIds: [incident.id] })
    const [successor] = await notifier.claimDue({
      now: new Date(NOW.getTime() + LEASE_MS),
      incidentIds: [incident.id],
    })
    await expect(bindFleetIncidentManagerTarget(stale)).rejects.toThrow('stale')
    await expect(bindFleetIncidentManagerTarget(successor)).resolves.toBeDefined()
  })

  test('claims the human fallback at its exact due boundary independently of manager state', async () => {
    const incident = await addIncident({ kind: 'squad_dead_fleet' })
    const dueAt = new Date(NOW.getTime() + 15 * 60_000)
    const manager = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      status: 'undeliverable',
      recipientId: null,
      idempotencyKey: null,
    })
    const human = await addNotification(incident.id, 'alert', { audience: 'human', nextAttemptAt: dueAt })
    const notifier = new FleetIncidentNotifier()

    expect(await notifier.claimDue({ now: new Date(dueAt.getTime() - 1), incidentIds: [incident.id] })).toEqual([])
    const claims = await notifier.claimDue({ now: dueAt, incidentIds: [incident.id] })
    expect(claims.map((claim) => claim.notificationId)).toEqual([human.id])
    expect(claims[0]).toMatchObject({ audience: 'human', recipientId: SYSTEM_RECIPIENT_ID })
    expect(claims.some((claim) => claim.notificationId === manager.id)).toBe(false)
  })

  test('requires a delivered alert for the same audience before recovery claims', async () => {
    const incident = await addIncident({ kind: 'squad_dead_fleet' })
    const humanAlert = await addNotification(incident.id, 'alert', { audience: 'human', status: 'delivered' })
    const managerAlert = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const managerRecovery = await addNotification(incident.id, 'recovery', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const claims = await new FleetIncidentNotifier().claimDue({ now: NOW, incidentIds: [incident.id] })
    expect(claims.map((claim) => claim.notificationId)).toEqual([managerAlert.id])
    expect(humanAlert.status).toBe('delivered')
    expect(claims.some((claim) => claim.notificationId === managerRecovery.id)).toBe(false)
  })

  test('backs off manager failures for four attempts and terminalizes the fifth', async () => {
    const incident = await addIncident({ kind: 'squad_dead_fleet' })
    const notification = await addNotification(incident.id, 'alert', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const notifier = new FleetIncidentNotifier()
    for (const attempt of [1, 2, 3, 4, 5]) {
      const now = new Date(NOW.getTime() + (attempt - 1) * 20 * 60_000)
      await db
        .update(fleetIncidentNotifications)
        .set({ status: 'pending', nextAttemptAt: now })
        .where(eq(fleetIncidentNotifications.id, notification.id))
      const [claim] = await notifier.claimDue({ now, incidentIds: [incident.id] })
      expect(claim.attempts).toBe(attempt)
      expect(await retryFleetIncidentNotification({ claim, now })).toBe(true)
      const [persisted] = await db
        .select()
        .from(fleetIncidentNotifications)
        .where(eq(fleetIncidentNotifications.id, notification.id))
      if (attempt < 5) {
        expect(persisted.status).toBe('pending')
        expect(persisted.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000 * 2 ** (attempt - 1))
      } else {
        expect(persisted.status).toBe('undeliverable')
        expect(await notifier.claimDue({ now: new Date(now.getTime() + 60_000), incidentIds: [incident.id] })).toEqual(
          []
        )
      }
      expect(persisted.claimToken).toBeNull()
      expect(persisted.claimedAt).toBeNull()
    }
  })

  test('terminalizes an unbound manager recovery after five missing-manager attempts', async () => {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({
      id: squadId,
      name: `Notifier ${squadId}`,
      purpose: 'Missing recovery manager test',
      status: 'active',
    })
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    await addNotification(incident.id, 'alert', {
      audience: 'manager',
      status: 'delivered',
      recipientId: crypto.randomUUID(),
      idempotencyKey: `${prefix}:delivered-manager-alert`,
    })
    const recovery = await addNotification(incident.id, 'recovery', {
      audience: 'manager',
      recipientId: null,
      idempotencyKey: null,
    })
    const notifier = new FleetIncidentNotifier()
    for (const minutes of [0, 1, 3, 7, 15]) {
      await notifier.drain({ now: new Date(NOW.getTime() + minutes * 60_000), incidentIds: [incident.id] })
    }
    const [persisted] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, recovery.id))
    expect(persisted).toMatchObject({
      status: 'undeliverable',
      attempts: 5,
      recipientId: null,
      idempotencyKey: null,
      claimToken: null,
      claimedAt: null,
    })
  })

  test('concurrently drains manager and human audiences with distinct inbox events', async () => {
    const { squadId, manager } = await addManagedSquad()
    const incident = await addIncident({ kind: 'squad_dead_fleet', squadId })
    await addNotification(incident.id, 'alert', { audience: 'manager', recipientId: null, idempotencyKey: null })
    await addNotification(incident.id, 'alert', { audience: 'human' })
    const received: string[] = []
    const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
      if (
        (event.recipientType === 'agent' && event.recipientId === manager.id) ||
        (event.recipientType === 'system' && event.recipientId === SYSTEM_RECIPIENT_ID)
      ) {
        received.push(event.messageId)
      }
    })
    try {
      await Promise.all([
        new FleetIncidentNotifier().drain({ now: NOW, limit: 1, incidentIds: [incident.id] }),
        new FleetIncidentNotifier().drain({ now: NOW, limit: 1, incidentIds: [incident.id] }),
      ])
      const keys = [`fleet-incident:${incident.id}:alert:manager:${manager.id}`, `${prefix}:${incident.id}:alert:human`]
      const rows = await db.select().from(inbox).where(inArray(inbox.idempotencyKey, keys))
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.idempotencyKey))).toEqual(new Set(keys))
      expect(new Set(received)).toEqual(new Set(rows.map((row) => row.id)))
    } finally {
      unsubscribe()
    }
  })

  test('settling an in-flight alert after resolution creates one same-audience recovery', async () => {
    const incident = await addIncident({ provider: 'resolution-race-provider' })
    const alert = await addNotification(incident.id, 'alert', { audience: 'human' })
    const notifier = new FleetIncidentNotifier()
    const [claim] = await notifier.claimDue({ now: NOW, incidentIds: [incident.id] })
    await db.update(fleetIncidents).set({ resolvedAt: NOW }).where(eq(fleetIncidents.id, incident.id))
    const inboxMessageId = await addInboxLedger('resolution race winner')

    expect(
      await notifier.markDelivered({
        notificationId: alert.id,
        claimToken: claim.claimToken,
        inboxMessageId,
        now: new Date(NOW.getTime() + 1),
      })
    ).toBe(true)
    expect(
      await notifier.markDelivered({
        notificationId: alert.id,
        claimToken: claim.claimToken,
        inboxMessageId,
        now: new Date(NOW.getTime() + 2),
      })
    ).toBe(false)
    const rows = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.incidentId, incident.id))
    expect(rows.map((row) => `${row.kind}:${row.audience}:${row.status}`).sort()).toEqual([
      'alert:human:delivered',
      'recovery:human:pending',
    ])
    expect(rows.find((row) => row.kind === 'recovery')?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1))
  })

  test('a failed in-flight alert cancels instead of retrying after resolution', async () => {
    const incident = await addIncident({ provider: 'failed-resolution-race-provider' })
    const alert = await addNotification(incident.id, 'alert', { audience: 'human' })
    const [claim] = await new FleetIncidentNotifier().claimDue({ now: NOW, incidentIds: [incident.id] })
    await db.update(fleetIncidents).set({ resolvedAt: NOW }).where(eq(fleetIncidents.id, incident.id))

    expect(await retryFleetIncidentNotification({ claim, now: new Date(NOW.getTime() + 1) })).toBe(true)
    const [persisted] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, alert.id))
    expect(persisted).toMatchObject({ status: 'canceled', claimToken: null, claimedAt: null })
    expect(await retryFleetIncidentNotification({ claim, now: new Date(NOW.getTime() + 2) })).toBe(false)
  })

  test('two concurrent claimers partition all due alerts without overlap and increment attempts', async () => {
    const notifications = []
    for (let index = 0; index < 3; index++) {
      const incident = await addIncident({ provider: `provider-${index}` })
      notifications.push(await addNotification(incident.id, 'alert'))
    }

    const [first, second] = await Promise.all([
      new FleetIncidentNotifier().claimDue({ now: NOW, limit: 2, incidentIds: ownedIncidentIds }),
      new FleetIncidentNotifier().claimDue({ now: NOW, limit: 2, incidentIds: ownedIncidentIds }),
    ])
    const firstIds = first.map((claim) => claim.notificationId)
    const secondIds = second.map((claim) => claim.notificationId)

    expect(Math.max(first.length, second.length)).toBeLessThanOrEqual(2)
    expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(notifications.map((row) => row.id)))
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([])
    const persisted = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(
        inArray(
          fleetIncidentNotifications.id,
          notifications.map((row) => row.id)
        )
      )
    expect(persisted.map((row) => row.attempts).sort()).toEqual([1, 1, 1])
    expect(persisted.every((row) => row.status === 'delivering' && row.claimToken != null)).toBe(true)

    for (let index = 3; index < 6; index++) {
      const incident = await addIncident({ provider: `provider-${index}` })
      await addNotification(incident.id, 'alert')
    }
    expect(await new FleetIncidentNotifier().claimDue({ now: NOW, incidentIds: ownedIncidentIds })).toHaveLength(3)
  })

  test('leases remain unavailable at 59:59 and reclaim at exactly 60 seconds with token fencing', async () => {
    const incident = await addIncident({ provider: 'lease-provider' })
    const notification = await addNotification(incident.id, 'alert')
    const notifier = new FleetIncidentNotifier()
    const at60 = new Date(NOW.getTime() + LEASE_MS)
    const invalidLimit = /^limit must be an integer between 1 and 100$/

    await expect(notifier.claimDue({ now: NOW, limit: 0 })).rejects.toThrow(invalidLimit)
    await expect(notifier.claimDue({ now: NOW, limit: 101 })).rejects.toThrow(invalidLimit)
    await expect(notifier.claimDue({ now: NOW, limit: 1.5 })).rejects.toThrow(invalidLimit)

    const [first] = await notifier.claimDue({ now: NOW, limit: 1, incidentIds: ownedIncidentIds })
    expect(
      await notifier.claimDue({ now: new Date(NOW.getTime() + LEASE_MS - 1), limit: 1, incidentIds: ownedIncidentIds })
    ).toEqual([])
    const [reclaimed] = await notifier.claimDue({ now: at60, limit: 1, incidentIds: ownedIncidentIds })
    const [persistedClaim] = await db
      .select({
        claimedAt: fleetIncidentNotifications.claimedAt,
        updatedAt: fleetIncidentNotifications.updatedAt,
      })
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, notification.id))

    expect(persistedClaim).toEqual({ claimedAt: at60, updatedAt: at60 })
    expect(reclaimed.notificationId).toBe(notification.id)
    expect(reclaimed.claimToken).not.toBe(first.claimToken)
    await expect(
      notifier.markDelivered({
        notificationId: 'malformed',
        claimToken: reclaimed.claimToken,
        inboxMessageId: crypto.randomUUID(),
        now: new Date(NOW.getTime() + LEASE_MS),
      })
    ).resolves.toBe(false)
    await expect(
      notifier.markDelivered({
        notificationId: notification.id,
        claimToken: 'malformed',
        inboxMessageId: crypto.randomUUID(),
        now: new Date(NOW.getTime() + LEASE_MS),
      })
    ).resolves.toBe(false)
    await expect(
      notifier.markDelivered({
        notificationId: notification.id,
        claimToken: reclaimed.claimToken,
        inboxMessageId: 'malformed',
        now: new Date(NOW.getTime() + LEASE_MS),
      })
    ).resolves.toBe(false)
    expect(
      await notifier.markDelivered({
        notificationId: notification.id,
        claimToken: first.claimToken,
        inboxMessageId: crypto.randomUUID(),
        now: new Date(NOW.getTime() + LEASE_MS),
      })
    ).toBe(false)
    const inboxMessageId = await addInboxLedger('matching-token delivery')
    expect(
      await notifier.markDelivered({
        notificationId: notification.id,
        claimToken: reclaimed.claimToken,
        inboxMessageId,
        now: new Date(NOW.getTime() + LEASE_MS),
      })
    ).toBe(true)
    const [persisted] = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(eq(fleetIncidentNotifications.id, notification.id))
    expect(persisted).toMatchObject({
      status: 'delivered',
      attempts: 2,
      inboxMessageId,
      claimedAt: at60,
      updatedAt: at60,
      deliveredAt: at60,
    })
    expect([persisted.claimedAt?.getTime(), persisted.updatedAt?.getTime(), persisted.deliveredAt?.getTime()]).toEqual([
      at60.getTime(),
      at60.getTime(),
      at60.getTime(),
    ])
    expect(
      await notifier.markDelivered({
        notificationId: notification.id,
        claimToken: reclaimed.claimToken,
        inboxMessageId: crypto.randomUUID(),
        now: at60,
      })
    ).toBe(false)
  })

  test('recovery cannot claim until its alert is delivered', async () => {
    const incident = await addIncident({ provider: 'ordered-provider' })
    const alert = await addNotification(incident.id, 'alert')
    const recovery = await addNotification(incident.id, 'recovery')
    const secondIncident = await addIncident({ provider: 'second-ordered-provider' })
    const secondAlert = await addNotification(secondIncident.id, 'alert')
    const thirdIncident = await addIncident({ provider: 'third-ordered-provider' })
    const thirdAlert = await addNotification(thirdIncident.id, 'alert')
    await db
      .update(fleetIncidentNotifications)
      .set({ createdAt: new Date(NOW.getTime() - 4_000) })
      .where(eq(fleetIncidentNotifications.id, alert.id))
    await db
      .update(fleetIncidentNotifications)
      .set({ createdAt: new Date(NOW.getTime() - 3_000) })
      .where(eq(fleetIncidentNotifications.id, recovery.id))
    await db
      .update(fleetIncidentNotifications)
      .set({ createdAt: new Date(NOW.getTime() - 2_000) })
      .where(eq(fleetIncidentNotifications.id, secondAlert.id))
    await db
      .update(fleetIncidentNotifications)
      .set({ createdAt: new Date(NOW.getTime() - 1_000) })
      .where(eq(fleetIncidentNotifications.id, thirdAlert.id))
    const notifier = new FleetIncidentNotifier()

    const firstClaims = await notifier.claimDue({ now: NOW, limit: 2, incidentIds: ownedIncidentIds })
    expect(firstClaims.map((claim) => claim.notificationId)).toEqual([alert.id, secondAlert.id])
    const alertInboxMessageId = await addInboxLedger('alert delivery')
    expect(
      await notifier.markDelivered({
        notificationId: alert.id,
        claimToken: firstClaims[0]!.claimToken,
        inboxMessageId: alertInboxMessageId,
        now: NOW,
      })
    ).toBe(true)
    expect(
      (await notifier.claimDue({ now: NOW, limit: 2, incidentIds: ownedIncidentIds })).map(
        (claim) => claim.notificationId
      )
    ).toEqual([recovery.id, thirdAlert.id])
  })

  test('two concurrent drains create one system inbox row and one event', async () => {
    const incident = await addIncident({ provider: 'concurrent-provider' })
    const notification = await addNotification(incident.id, 'alert')
    const received: string[] = []
    const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
      if (event.recipientType === 'system' && event.recipientId === SYSTEM_RECIPIENT_ID) {
        received.push(event.messageId)
      }
    })

    try {
      const settled = await Promise.allSettled([
        new FleetIncidentNotifier().drain({ now: NOW, limit: 1, incidentIds: ownedIncidentIds }),
        new FleetIncidentNotifier().drain({ now: NOW, limit: 1, incidentIds: ownedIncidentIds }),
      ])
      expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])

      const rows = await db.select().from(inbox).where(eq(inbox.idempotencyKey, notification.idempotencyKey!))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        recipientType: 'system',
        recipientId: SYSTEM_RECIPIENT_ID,
        senderType: 'system',
        idempotencyKey: notification.idempotencyKey,
        metadata: {
          source: 'fleet-alert',
          incidentId: incident.id,
          incidentKind: 'provider_unhealthy',
          phase: 'alert',
          provider: 'concurrent-provider',
        },
      })
      expect(rows[0]!.metadata).not.toHaveProperty('squadId')
      expect(received).toEqual([rows[0]!.id])
      const [persisted] = await db
        .select()
        .from(fleetIncidentNotifications)
        .where(eq(fleetIncidentNotifications.id, notification.id))
      expect(persisted).toMatchObject({ status: 'delivered', inboxMessageId: rows[0]!.id })
    } finally {
      unsubscribe()
    }
  })

  test('a crash after sendOnce reclaims safely without a second inbox event', async () => {
    const incident = await addIncident({ provider: 'crash-provider' })
    const notification = await addNotification(incident.id, 'alert')
    const received: string[] = []
    const unsubscribe = eventEmitter.on('inbox.messageReceived', (event) => {
      if (event.recipientType === 'system' && event.recipientId === SYSTEM_RECIPIENT_ID) {
        received.push(event.messageId)
      }
    })
    const crash = new Error('injected after sendOnce')
    const crashingNotifier = new FleetIncidentNotifier({
      afterSendOnce: async () => {
        throw crash
      },
    })

    try {
      const [failed] = await Promise.allSettled([
        crashingNotifier.drain({ now: NOW, limit: 1, incidentIds: ownedIncidentIds }),
      ])
      expect(failed).toEqual({ status: 'rejected', reason: crash })
      const firstRows = await db.select().from(inbox).where(eq(inbox.idempotencyKey, notification.idempotencyKey!))
      expect(firstRows).toHaveLength(1)
      expect(received).toEqual([firstRows[0]!.id])

      await new FleetIncidentNotifier().drain({
        now: new Date(NOW.getTime() + LEASE_MS),
        limit: 1,
        incidentIds: ownedIncidentIds,
      })
      const afterRetry = await db.select().from(inbox).where(eq(inbox.idempotencyKey, notification.idempotencyKey!))
      expect(afterRetry.map((row) => row.id)).toEqual([firstRows[0]!.id])
      expect(received).toEqual([firstRows[0]!.id])
      const [persisted] = await db
        .select()
        .from(fleetIncidentNotifications)
        .where(eq(fleetIncidentNotifications.id, notification.id))
      expect(persisted).toMatchObject({ status: 'delivered', attempts: 2, inboxMessageId: firstRows[0]!.id })
    } finally {
      unsubscribe()
    }
  })

  test('delivers alert then recovery once with exact safe metadata and sanitized content', async () => {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({
      id: squadId,
      name: `Notifier ${squadId.slice(0, 8)}`,
      purpose: 'Fleet notifier test',
      status: 'active',
    })
    const incident = await addIncident({
      kind: 'squad_dead_fleet',
      squadId,
      details: { secret: 'credential-token-must-not-leak' },
    })
    const alert = await addNotification(incident.id, 'alert')
    const recovery = await addNotification(incident.id, 'recovery')
    const notifier = new FleetIncidentNotifier()

    await notifier.drain({ now: NOW, limit: 2, incidentIds: ownedIncidentIds })
    await notifier.drain({ now: NOW, limit: 2, incidentIds: ownedIncidentIds })

    const rows = await db
      .select()
      .from(inbox)
      .where(inArray(inbox.idempotencyKey, [alert.idempotencyKey!, recovery.idempotencyKey!]))
    expect(rows).toHaveLength(2)
    const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]))
    const squadName = `Notifier ${squadId.slice(0, 8)}`
    for (const [key, phase, interruptionLevel] of [
      [alert.idempotencyKey!, 'alert', 'active'],
      [recovery.idempotencyKey!, 'recovery', 'passive'],
    ] as const) {
      const row = byKey.get(key)!
      expect(row.metadata).toEqual({
        source: 'fleet-alert',
        audience: 'human',
        incidentId: incident.id,
        incidentKind: 'squad_dead_fleet',
        phase,
        squadId,
        wakeEligible: false,
        push: {
          title: row.subject,
          body: row.content.split('\n')[0],
          subtitle: squadName,
          collapseKey: `fleet:${incident.id}`,
          threadKey: 'fleet',
          interruptionLevel,
        },
      })
      expect(row.recipientType).toBe('system')
      expect(row.recipientId).toBe(SYSTEM_RECIPIENT_ID)
      // Readers see the squad's name; its ID stays in metadata for routing.
      expect(`${row.subject}\n${row.content}`).not.toContain(squadId)
      expect(row.content).not.toContain('credential-token-must-not-leak')
    }
    const alertRow = byKey.get(alert.idempotencyKey)!
    expect(alertRow.subject).toBe(`Squad ${squadName} stalled`)
    expect(alertRow.content).toBe(
      `Work in squad ${squadName} has been stalled for 1h.\n\n` +
        'Cause: OAuth refresh credential expired or was revoked.\n' +
        'Fix: Run `ficus pa login openai-codex` to authenticate again.'
    )
    const recoveryRow = byKey.get(recovery.idempotencyKey)!
    expect(recoveryRow.subject).toBe(`Squad ${squadName} is running again`)
    // A recovery reports the past cause and duration, never the stall's live remediation.
    expect(recoveryRow.content).toBe(
      `Work in squad ${squadName} is running again after being stalled for 1h.\n\n` +
        'Earlier cause: OAuth refresh credential expired or was revoked.'
    )
    const persisted = await db
      .select()
      .from(fleetIncidentNotifications)
      .where(inArray(fleetIncidentNotifications.id, [alert.id, recovery.id]))
    expect(persisted.map((row) => row.status).sort()).toEqual(['delivered', 'delivered'])
  })
  test('names an agent sandbox by the agent and its squad at delivery time', async () => {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({ id: squadId, name: `${prefix} squad`, purpose: 'Fleet names', status: 'active' })
    const [agent] = await db
      .insert(agents)
      .values({ agentTypeId: 'worker', squadId, metadata: { name: 'reviewer' } })
      .returning()
    ownedAgentIds.push(agent!.id)
    const id = crypto.randomUUID()
    ownedIncidentIds.push(id)
    await db.insert(fleetIncidents).values({
      id,
      kind: 'sandbox_degraded',
      scopeKey: `sandbox:agent_${agent!.id}`,
      startedAt: new Date(NOW.getTime() - 20 * 60_000),
      alertAfter: NOW,
      lastObservedAt: NOW,
      causeCode: 'sandbox-setup-degraded',
      causeSummary: 'VM sandbox best-effort setup remains degraded.',
      remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
      details: { sandboxId: `agent_${agent!.id}`, reasons: ['callback_transport_degraded'] },
      updatedAt: NOW,
    })
    const alert = await addNotification(id, 'alert')

    await new FleetIncidentNotifier().drain({ now: NOW, incidentIds: [id] })

    const [row] = await db.select().from(inbox).where(eq(inbox.idempotencyKey, alert.idempotencyKey!))
    expect(row!.subject).toBe(`The sandbox for reviewer in squad ${prefix} squad is degraded`)
    expect(row!.content).toContain('Cause: VM sandbox setup is degraded: callback connection degraded.')
    expect(row!.content).toContain('Started: 20m ago')
    expect(`${row!.subject}\n${row!.content}`).not.toContain(agent!.id)
    expect((row!.metadata as { push?: { subtitle?: string } }).push?.subtitle).toBe(`${prefix} squad`)
  })

  test('delivers an overloaded agent sandbox alert by name with the agent commands', async () => {
    const squadId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    await db.insert(squads).values({ id: squadId, name: `${prefix} squad`, purpose: 'Fleet names', status: 'active' })
    const [agent] = await db
      .insert(agents)
      .values({ agentTypeId: 'worker', squadId, metadata: { name: 'reviewer' } })
      .returning()
    ownedAgentIds.push(agent!.id)
    const sandboxId = `agent_${agent!.id}`
    const pressure = {
      cpus: 4,
      load: [31.9, 30, 25] as [number, number, number],
      memTotalMb: 8000,
      memAvailableMb: 463,
    }
    const start = new Date(NOW.getTime() - 12 * 60_000)
    let incidentId: string | undefined
    for (const minutes of [0, 5, 10, 12]) {
      incidentId = await observeSandboxOverload({
        status: 'sampled',
        sandboxId,
        pressure,
        now: new Date(start.getTime() + minutes * 60_000),
      })
    }
    ownedIncidentIds.push(incidentId!)

    // The squad has no manager, so the human alert is due as soon as the episode is sustained.
    await new FleetIncidentNotifier().drain({ now: NOW, incidentIds: [incidentId!] })

    const [row] = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `fleet-incident:${incidentId}:alert:human:system`))
    expect(row!.subject).toBe(`The sandbox for reviewer in squad ${prefix} squad is overloaded`)
    expect(row!.content).toStartWith(
      `The sandbox for reviewer in squad ${prefix} squad is overloaded: load 31.9 on 4 CPUs for 12m (463 MB free).`
    )
    expect(row!.content).toContain(`\`ficus agent sandbox-ps ${agent!.id}\``)
    expect(row!.metadata).toMatchObject({ source: 'fleet-alert', incidentKind: 'sandbox_overloaded', squadId })
  })
})
