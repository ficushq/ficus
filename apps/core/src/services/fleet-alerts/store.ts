import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { isSandboxOverloaded, SYSTEM_RECIPIENT_ID, type SandboxPressure } from '@ficus/shared'
import type { ProviderHealthRecord } from '@ficus/shared/provider-health'
import { db } from '../../db'
import { agents, fleetIncidentNotifications, fleetIncidents, squads, type FleetIncidentKind } from '../../db/schema'
import {
  planFleetAlert,
  planSandboxAlert,
  planSandboxOverloadAlert,
  SANDBOX_OVERLOAD_ALERT_AFTER_MS,
  SANDBOX_OVERLOAD_STALE_MS,
  type FleetIncidentAudience,
} from './audience-policy'
import { sanitizeProviderRecord } from './cause'

const PROVIDER_ALERT_WINDOW_MS = 15 * 60 * 1000
const DEAD_FLEET_ALERT_WINDOW_MS = 30 * 60 * 1000
/**
 * Minimum gap between dead-fleet ALERTS for one squad. A partially degraded
 * fleet oscillates: demand stalls, ONE execution eventually starts (which is
 * all `recoveredByRun` requires), the incident resolves and notifies recovery,
 * the still-unserved demand opens a fresh incident, and 30 minutes later it
 * alerts again — pairs of "needs attention"/"recovered" mails for a fleet whose
 * state never actually changed. Holding the next alert down for one window
 * collapses that into one alert per window; the recovery notice is only queued
 * when an alert was sent for that incident, so suppressing the alert suppresses
 * the pair. A fleet that stays healthy past the window alerts normally on its
 * next genuine stall.
 */
const DEAD_FLEET_REALERT_COOLDOWN_MS = DEAD_FLEET_ALERT_WINDOW_MS
const PROVIDER_WIDE_ACCOUNT = '__provider__'

/**
 * Cause of last resort for a stalled fleet. It describes the OBSERVED stall —
 * never the absence of some other diagnostic. The previous text ("No provider
 * probe error is currently available") reported that a provider probe was
 * missing, which is not a cause at all: operators saw it for every stall whose
 * cause was not a provider (transport wedges, dead sandboxes, stuck pickup) and
 * were pointed at provider tooling that had nothing to say.
 */
function describeStall(
  demandCount: number,
  firstDemandAt: Date,
  now: Date,
  lastRunStartedAt?: Date
): {
  code: string
  summary: string
  remediation: string
} {
  const oldestMin = Math.max(1, Math.round((now.getTime() - firstDemandAt.getTime()) / 60_000))
  const stalledSince = Math.max(firstDemandAt.getTime(), lastRunStartedAt?.getTime() ?? firstDemandAt.getTime())
  const stalledMin = Math.max(1, Math.round((now.getTime() - stalledSince) / 60_000))
  // The aggregate also includes inbox messages, schedules, and work streams;
  // its oldest row may predate recent progress by days.
  const work = demandCount === 1 ? '1 pending work item remains' : `${demandCount} pending work items remain`
  return {
    code: 'demand-not-served',
    summary: `${work}; oldest is ${oldestMin}m old. No execution run has started in the last ${stalledMin}m of pending demand, and no open provider or sandbox incident explains the delay.`,
    remediation:
      'Check machine + sandbox health first (`ficus machines list`, then the box/tunnel logs for that machine), then worker pickup (`ficus worker status`).',
  }
}

export type ProviderIncidentObservation =
  | { status: 'unhealthy'; record: ProviderHealthRecord; now: Date }
  | { status: 'healthy' | 'indeterminate'; provider: string; accountId?: string; now: Date }

export interface ProviderIncidentStoreAdapter {
  /** Test transaction seam invoked inside the transaction before lock acquisition. */
  onTransactionStarted?: (scopeKey: string) => void
  /** Test synchronization seam after provider advisory ownership is acquired. */
  afterProviderLock?: (scopeKey: string) => Promise<void>
}

export type DeadFleetObservation =
  | {
      status: 'stalled'
      squadId: string
      demandCount: number
      /** Proven by the current executable demand routes and routing cooldown. */
      providerCause?: ProviderHealthRecord
      firstDemandAt: Date
      lastRunStartedAt?: Date | undefined
      now: Date
    }
  | { status: 'quiet'; squadId: string; lastRunStartedAt?: Date | undefined; now: Date }

export interface DeadFleetIncidentStoreAdapter {
  /** Test transaction seam invoked inside the transaction before lock acquisition. */
  onTransactionStarted?: (scopeKey: string) => void
  /** Test synchronization seam after dead-fleet advisory ownership is acquired. */
  afterDeadFleetLock?: (scopeKey: string) => Promise<void>
}

type FleetAlertTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function humanDeliveryKey(incidentId: string, phase: 'alert' | 'recovery'): string {
  return `fleet-incident:${incidentId}:${phase}:human:system`
}

async function materializeAlertDelivery(
  tx: FleetAlertTx,
  input: {
    incidentId: string
    audience: FleetIncidentAudience
    dueAt: Date
    status?: 'pending' | 'skipped'
    now: Date
  }
): Promise<void> {
  const human = input.audience === 'human'
  await tx
    .insert(fleetIncidentNotifications)
    .values({
      incidentId: input.incidentId,
      kind: 'alert',
      audience: input.audience,
      status: input.status ?? 'pending',
      recipientId: human ? SYSTEM_RECIPIENT_ID : null,
      idempotencyKey: human ? humanDeliveryKey(input.incidentId, 'alert') : null,
      nextAttemptAt: input.dueAt,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
}

async function materializeManagerRoutedAlert(
  tx: FleetAlertTx,
  input: {
    incidentId: string
    managerDueAt: Date
    managerStatus?: 'pending' | 'skipped'
    humanDelayMs: number
    now: Date
  }
): Promise<void> {
  const existing = await tx
    .select({ audience: fleetIncidentNotifications.audience })
    .from(fleetIncidentNotifications)
    .where(
      and(eq(fleetIncidentNotifications.incidentId, input.incidentId), eq(fleetIncidentNotifications.kind, 'alert'))
    )
  const audiences = new Set(existing.map((row) => row.audience))
  // A human-only row marks an episode that a pre-audience Core alerted before
  // this upgrade. Do not inject a late manager alert into that episode: the
  // human already owns it, and a manager alert now would double-notify.
  if (audiences.has('human') && !audiences.has('manager')) return

  await materializeAlertDelivery(tx, {
    incidentId: input.incidentId,
    audience: 'manager',
    dueAt: input.managerDueAt,
    status: input.managerStatus,
    now: input.now,
  })
  // A historical incident threshold may already be overdue when the alert rows
  // are first materialized. Start the human grace now; the unique audience row
  // and conflict no-op preserve this first deadline across later observations.
  await materializeAlertDelivery(tx, {
    incidentId: input.incidentId,
    audience: 'human',
    dueAt: new Date(input.now.getTime() + input.humanDelayMs),
    now: input.now,
  })
  if (input.humanDelayMs === 0) {
    await movePendingHumanAlertEarlier(tx, input.incidentId, input.managerDueAt, input.now)
  }
}

async function movePendingHumanAlertEarlier(
  tx: FleetAlertTx,
  incidentId: string,
  dueAt: Date,
  now: Date
): Promise<void> {
  await tx
    .update(fleetIncidentNotifications)
    .set({
      nextAttemptAt: sql`LEAST(${fleetIncidentNotifications.nextAttemptAt}, ${dueAt.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(fleetIncidentNotifications.incidentId, incidentId),
        eq(fleetIncidentNotifications.kind, 'alert'),
        eq(fleetIncidentNotifications.audience, 'human'),
        eq(fleetIncidentNotifications.status, 'pending')
      )
    )
}

async function resolveFleetIncident(tx: FleetAlertTx, incidentId: string, now: Date): Promise<void> {
  await tx
    .update(fleetIncidents)
    .set({ resolvedAt: now, lastObservedAt: now, updatedAt: now })
    .where(and(eq(fleetIncidents.id, incidentId), isNull(fleetIncidents.resolvedAt)))

  const deliveredAlerts = await tx
    .select({ audience: fleetIncidentNotifications.audience })
    .from(fleetIncidentNotifications)
    .where(
      and(
        eq(fleetIncidentNotifications.incidentId, incidentId),
        eq(fleetIncidentNotifications.kind, 'alert'),
        eq(fleetIncidentNotifications.status, 'delivered')
      )
    )
  for (const alert of deliveredAlerts) {
    const human = alert.audience === 'human'
    await tx
      .insert(fleetIncidentNotifications)
      .values({
        incidentId,
        kind: 'recovery',
        audience: alert.audience,
        recipientId: human ? SYSTEM_RECIPIENT_ID : null,
        idempotencyKey: human ? humanDeliveryKey(incidentId, 'recovery') : null,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
  }
  await tx
    .update(fleetIncidentNotifications)
    .set({ status: 'canceled', updatedAt: now })
    .where(
      and(
        eq(fleetIncidentNotifications.incidentId, incidentId),
        eq(fleetIncidentNotifications.kind, 'alert'),
        eq(fleetIncidentNotifications.status, 'pending')
      )
    )
}

async function validCurrentManagerForSquad(tx: FleetAlertTx, squadId: string | null): Promise<string | null> {
  if (!squadId) return null
  const [route] = await tx
    .select({ managerId: squads.managerAgentId })
    .from(squads)
    .where(and(eq(squads.id, squadId), eq(squads.status, 'active'), isNull(squads.archivedAt)))
    .limit(1)
  if (!route?.managerId) return null
  const [manager] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, route.managerId),
        eq(agents.squadId, squadId),
        eq(agents.agentTypeId, 'manager'),
        ne(agents.status, 'terminated')
      )
    )
    .limit(1)
  return manager?.id ?? null
}

function scopeIdentity(provider: string, accountId?: string): string {
  return `provider:${provider}:account:${accountId ?? PROVIDER_WIDE_ACCOUNT}`
}

/** Persist one shared provider-health observation under provider+account ownership. */
export async function observeProvider(
  input: ProviderIncidentObservation,
  adapter: ProviderIncidentStoreAdapter = {}
): Promise<string | undefined> {
  if (input.status === 'indeterminate') return undefined

  const provider = input.status === 'unhealthy' ? input.record.provider : input.provider
  const accountId = input.status === 'unhealthy' ? input.record.accountId : input.accountId
  const scopeKey = scopeIdentity(provider, accountId)
  return db.transaction(async (tx) => {
    adapter.onTransactionStarted?.(scopeKey)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'fleet-incident:provider_unhealthy:' + scopeKey}))`)
    await adapter.afterProviderLock?.(scopeKey)

    const [openIncident] = await tx
      .select()
      .from(fleetIncidents)
      .where(
        and(
          eq(fleetIncidents.kind, 'provider_unhealthy'),
          eq(fleetIncidents.scopeKey, scopeKey),
          isNull(fleetIncidents.resolvedAt)
        )
      )
      .limit(1)

    if (input.status !== 'unhealthy') {
      if (!openIncident) return undefined
      await resolveFleetIncident(tx, openIncident.id, input.now)
      return openIncident.id
    }

    const record = input.record
    const safeCause = sanitizeProviderRecord(record)
    const startedAt = new Date(record.since)
    const values = {
      accountId: record.accountId ?? null,
      healthKind: record.kind,
      providerRetryAt: record.retryAt != null ? new Date(record.retryAt) : null,
      providerLastSuccessAt: record.lastSuccessAt != null ? new Date(record.lastSuccessAt) : null,
      lastObservedAt: input.now,
      causeCode: safeCause.kind,
      causeSummary: safeCause.summary,
      remediation: safeCause.remediation ?? null,
      updatedAt: input.now,
    }
    const incident =
      openIncident ??
      (
        await tx
          .insert(fleetIncidents)
          .values({
            kind: 'provider_unhealthy',
            scopeKey,
            provider: record.provider,
            ...values,
            startedAt,
            alertAfter: new Date(record.since + PROVIDER_ALERT_WINDOW_MS),
            details: {},
          })
          .returning()
      )[0]
    if (!incident) throw new Error('Failed to persist provider fleet incident')

    if (openIncident) {
      await tx.update(fleetIncidents).set(values).where(eq(fleetIncidents.id, incident.id))
    }

    // The authoritative boundary is strictly older than 15 minutes.
    if (input.now.getTime() <= incident.alertAfter.getTime()) return incident.id

    const audiencePlan = planFleetAlert({
      kind: 'provider_unhealthy',
      causeCode: safeCause.kind,
      hasValidManager: false,
    })
    await materializeAlertDelivery(tx, {
      incidentId: incident.id,
      audience: 'human',
      dueAt: new Date(incident.alertAfter.getTime() + audiencePlan.humanDelayMs),
      now: input.now,
    })
    return incident.id
  })
}

/** Persist one squad dead-fleet observation under durable squad ownership. */
export async function observeDeadFleet(
  input: DeadFleetObservation,
  adapter: DeadFleetIncidentStoreAdapter = {}
): Promise<string | undefined> {
  const scopeKey = `squad:${input.squadId}`
  return db.transaction(async (tx) => {
    adapter.onTransactionStarted?.(scopeKey)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'fleet-incident:squad_dead_fleet:' + scopeKey}))`)
    await adapter.afterDeadFleetLock?.(scopeKey)

    const [openIncident] = await tx
      .select()
      .from(fleetIncidents)
      .where(
        and(
          eq(fleetIncidents.kind, 'squad_dead_fleet'),
          eq(fleetIncidents.scopeKey, scopeKey),
          isNull(fleetIncidents.resolvedAt)
        )
      )
      .limit(1)

    const recoveredByRun =
      openIncident != null &&
      input.lastRunStartedAt != null &&
      input.lastRunStartedAt.getTime() > openIncident.startedAt.getTime()
    if (input.status === 'quiet' || recoveredByRun) {
      if (!openIncident) return undefined
      await resolveFleetIncident(tx, openIncident.id, input.now)
      return openIncident.id
    }

    // Attribution arrives from current demand routes, never the newest global
    // health incident. Provider persistence can race this transaction safely.
    const providerCause = input.providerCause
    const provider = providerCause ? sanitizeProviderRecord(providerCause) : undefined
    // Scoped to THIS squad: another squad's degraded box does not explain this
    // squad's stall, and blaming it would be worse than saying nothing.
    const [sandboxIncident] = provider
      ? []
      : await tx
          .select({
            id: fleetIncidents.id,
            causeCode: fleetIncidents.causeCode,
            causeSummary: fleetIncidents.causeSummary,
            remediation: fleetIncidents.remediation,
            details: fleetIncidents.details,
          })
          .from(fleetIncidents)
          .where(
            and(
              eq(fleetIncidents.kind, 'sandbox_degraded'),
              eq(fleetIncidents.squadId, input.squadId),
              isNull(fleetIncidents.resolvedAt)
            )
          )
          .orderBy(desc(fleetIncidents.lastObservedAt), desc(fleetIncidents.id))
          .limit(1)
    const sandboxReasons = Array.isArray((sandboxIncident?.details as { reasons?: unknown } | null)?.reasons)
      ? ((sandboxIncident!.details as { reasons: string[] }).reasons ?? []).slice(0, 5)
      : []
    const explaining = provider
      ? { causeCode: provider.kind, causeSummary: provider.summary, remediation: provider.remediation ?? null }
      : sandboxIncident
    const cause = explaining
      ? {
          code: explaining.causeCode,
          // Name the concrete reasons the sandbox incident recorded (e.g.
          // callback_transport_degraded) instead of only its generic summary.
          summary:
            sandboxIncident && sandboxReasons.length
              ? `${explaining.causeSummary} Reasons: ${sandboxReasons.join(', ')}.`
              : explaining.causeSummary,
          remediation: explaining.remediation,
        }
      : describeStall(input.demandCount, input.firstDemandAt, input.now, input.lastRunStartedAt)
    // Structured facts let delivery name the provider and phrase reasons and durations for readers.
    const details = {
      demandCount: input.demandCount,
      oldestDemandAt: input.firstDemandAt.toISOString(),
      ...(providerCause
        ? {
            provider: providerCause.provider,
            providerRouteBlocked: true,
          }
        : {}),
      ...(sandboxIncident ? { sandboxIncidentId: sandboxIncident.id, sandboxReasons } : {}),
    }
    const audiencePlan = planFleetAlert({
      kind: 'squad_dead_fleet',
      causeCode: cause.code,
      hasValidManager: true,
    })

    if (openIncident) {
      await tx
        .update(fleetIncidents)
        .set({
          lastObservedAt: input.now,
          causeCode: cause.code,
          causeSummary: cause.summary,
          remediation: cause.remediation,
          details,
          updatedAt: input.now,
        })
        .where(eq(fleetIncidents.id, openIncident.id))
      if (input.now.getTime() < openIncident.alertAfter.getTime()) return openIncident.id

      await materializeManagerRoutedAlert(tx, {
        incidentId: openIncident.id,
        managerDueAt: openIncident.alertAfter,
        humanDelayMs: audiencePlan.humanDelayMs,
        now: input.now,
      })
      return openIncident.id
    }

    const episodeStartedAt =
      input.lastRunStartedAt != null && input.lastRunStartedAt.getTime() > input.firstDemandAt.getTime()
        ? input.lastRunStartedAt
        : input.firstDemandAt
    // Hold the alert down when this squad just came out of one (see
    // DEAD_FLEET_REALERT_COOLDOWN_MS) so an oscillating fleet cannot mail a
    // fresh alert/recovery pair every episode.
    const [lastResolved] = await tx
      .select({ resolvedAt: fleetIncidents.resolvedAt })
      .from(fleetIncidents)
      .where(
        and(
          eq(fleetIncidents.kind, 'squad_dead_fleet'),
          eq(fleetIncidents.scopeKey, scopeKey),
          isNotNull(fleetIncidents.resolvedAt)
        )
      )
      .orderBy(desc(fleetIncidents.resolvedAt))
      .limit(1)
    const alertAfter = new Date(
      Math.max(
        episodeStartedAt.getTime() + DEAD_FLEET_ALERT_WINDOW_MS,
        lastResolved?.resolvedAt ? lastResolved.resolvedAt.getTime() + DEAD_FLEET_REALERT_COOLDOWN_MS : 0
      )
    )
    const [incident] = await tx
      .insert(fleetIncidents)
      .values({
        kind: 'squad_dead_fleet',
        scopeKey,
        squadId: input.squadId,
        startedAt: episodeStartedAt,
        alertAfter,
        lastObservedAt: input.now,
        causeCode: cause.code,
        causeSummary: cause.summary,
        remediation: cause.remediation,
        details,
        updatedAt: input.now,
      })
      .returning()
    if (!incident) throw new Error('Failed to persist dead fleet incident')

    if (input.now.getTime() >= incident.alertAfter.getTime()) {
      await materializeManagerRoutedAlert(tx, {
        incidentId: incident.id,
        managerDueAt: incident.alertAfter,
        humanDelayMs: audiencePlan.humanDelayMs,
        now: input.now,
      })
    }
    return incident.id
  })
}

export type SandboxDegradationObservation =
  | {
      status: 'degraded'
      sandboxId: string
      attemptCount: number
      reasons: string[]
      nextAttemptAt?: Date
      squadId?: string
      now: Date
    }
  | { status: 'ready'; sandboxId: string; now: Date }

/** Persist one deduplicated degraded-setup episode per sandbox. */
export async function observeSandboxDegradation(input: SandboxDegradationObservation): Promise<string | undefined> {
  const scopeKey = `sandbox:${input.sandboxId}`
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'fleet-incident:sandbox_degraded:' + scopeKey}))`)
    const [openIncident] = await tx
      .select()
      .from(fleetIncidents)
      .where(
        and(
          eq(fleetIncidents.kind, 'sandbox_degraded'),
          eq(fleetIncidents.scopeKey, scopeKey),
          isNull(fleetIncidents.resolvedAt)
        )
      )
      .limit(1)

    if (input.status === 'ready') {
      if (!openIncident) return undefined
      await resolveFleetIncident(tx, openIncident.id, input.now)
      return openIncident.id
    }

    let validInputSquadId: string | null = null
    if (input.squadId && UUID_PATTERN.test(input.squadId)) {
      const [existingSquad] = await tx
        .select({ id: squads.id })
        .from(squads)
        .where(eq(squads.id, input.squadId))
        .limit(1)
      validInputSquadId = existingSquad?.id ?? null
    }
    const reasons = [...new Set(input.reasons)]
      .filter((reason) =>
        [
          'devbox_unavailable',
          'bashrc_unavailable',
          'git_credentials_unavailable',
          'transport_recovery_failed',
          'callback_transport_degraded',
          'command_outcome_ambiguous',
        ].includes(reason)
      )
      .slice(0, 5)
    const details = {
      sandboxId: input.sandboxId,
      reasons,
      attemptCount: Math.max(0, input.attemptCount),
      ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt.toISOString() } : {}),
    }
    const incident =
      openIncident ??
      (
        await tx
          .insert(fleetIncidents)
          .values({
            kind: 'sandbox_degraded',
            scopeKey,
            squadId: validInputSquadId,
            startedAt: input.now,
            alertAfter: input.now,
            lastObservedAt: input.now,
            causeCode: 'sandbox-setup-degraded',
            causeSummary: 'VM sandbox best-effort setup remains degraded.',
            remediation: 'Inspect VM sandbox transport and setup reconciliation logs.',
            details,
            updatedAt: input.now,
          })
          .returning()
      )[0]
    if (!incident) throw new Error('Failed to persist sandbox degraded incident')
    if (openIncident) {
      await tx
        .update(fleetIncidents)
        .set({
          squadId: openIncident.squadId ?? validInputSquadId,
          lastObservedAt: input.now,
          details,
          updatedAt: input.now,
        })
        .where(eq(fleetIncidents.id, incident.id))
    }

    if (input.attemptCount >= 3) {
      const currentSquadId = openIncident?.squadId ?? validInputSquadId
      const hasValidManager = (await validCurrentManagerForSquad(tx, currentSquadId)) != null
      const plan = planSandboxAlert(input.reasons, hasValidManager)
      await materializeManagerRoutedAlert(tx, {
        incidentId: incident.id,
        managerDueAt: input.now,
        managerStatus: plan.manager === 'skip' ? 'skipped' : 'pending',
        humanDelayMs: plan.humanDelayMs,
        now: input.now,
      })
    }
    return incident.id
  })
}

export type SandboxOverloadObservation =
  | { status: 'sampled'; sandboxId: string; pressure: SandboxPressure; now: Date }
  | { status: 'unobserved'; sandboxId: string; now: Date }

/** What an overload incident records for rendering; everything else about the box stays out. */
export interface SandboxOverloadDetails extends Record<string, unknown> {
  sandboxId: string
  cpus: number
  /** Latest 1, 5 and 15 minute load averages. */
  load: [number, number, number]
  /** Highest one-minute load seen this episode. */
  peakLoad: number
  memTotalMb: number
  memAvailableMb: number
  /** Why the episode closed: load fell below the CPU count, or no reading for a while. */
  resolvedBy?: 'load' | 'unobserved'
}

function validPressure(pressure: SandboxPressure): boolean {
  return (
    Number.isInteger(pressure.cpus) &&
    pressure.cpus > 0 &&
    Array.isArray(pressure.load) &&
    pressure.load.length === 3 &&
    pressure.load.every((value) => Number.isFinite(value) && value >= 0) &&
    Number.isFinite(pressure.memTotalMb) &&
    Number.isFinite(pressure.memAvailableMb)
  )
}

const round1 = (value: number) => Math.round(value * 10) / 10

function sandboxOverloadRemediation(sandboxId: string): string {
  const [, kind, id] = /^(squad|agent)_(.+)$/.exec(sandboxId) ?? []
  if (kind === 'agent' && id && UUID_PATTERN.test(id)) {
    return `Find and stop the runaway job with \`ficus agent sandbox-ps ${id}\` (or the agent's sandbox controls → Processes), then \`ficus agent sandbox-kill\` / \`sandbox-stop-container\`.`
  }
  if (kind === 'squad' && id && UUID_PATTERN.test(id)) {
    return `Find and stop the runaway job with \`ficus squad sandbox-ps ${id}\` (or Workspace settings → Processes), then \`ficus squad sandbox-kill\` / \`sandbox-stop-container\`.`
  }
  return 'Find and stop the runaway job with `ficus squad sandbox-ps` or `ficus agent sandbox-ps`, then `sandbox-kill` / `sandbox-stop-container`.'
}

/** The squad a sandbox belongs to: its own squad, or the owning agent's squad. */
async function sandboxSquadId(tx: FleetAlertTx, sandboxId: string): Promise<string | null> {
  const [, kind, id] = /^(squad|agent)_(.+)$/.exec(sandboxId) ?? []
  if (!id || !UUID_PATTERN.test(id)) return null
  if (kind === 'squad') {
    const [squad] = await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, id)).limit(1)
    return squad?.id ?? null
  }
  const [agent] = await tx.select({ squadId: agents.squadId }).from(agents).where(eq(agents.id, id)).limit(1)
  return agent?.squadId ?? null
}

/**
 * Persist one sandbox load reading. An episode opens on the first overloaded
 * reading (one-minute load at least twice the CPU count) and alerts only when
 * a reading is still overloaded {@link SANDBOX_OVERLOAD_ALERT_AFTER_MS} later.
 * It resolves with hysteresis — only once the one-minute load drops below the
 * CPU count — so a box hovering around the threshold cannot flap. Readings in
 * between keep the episode open without alerting.
 */
export async function observeSandboxOverload(input: SandboxOverloadObservation): Promise<string | undefined> {
  if (input.status === 'sampled' && !validPressure(input.pressure)) return undefined
  const scopeKey = `sandbox:${input.sandboxId}`
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'fleet-incident:sandbox_overloaded:' + scopeKey}))`)
    const [current] = await tx
      .select()
      .from(fleetIncidents)
      .where(
        and(
          eq(fleetIncidents.kind, 'sandbox_overloaded'),
          eq(fleetIncidents.scopeKey, scopeKey),
          isNull(fleetIncidents.resolvedAt)
        )
      )
      .limit(1)

    // An episode nobody has read for the stale window closes, whether this is
    // the detector noticing (unobserved) or a reading arriving after the gap.
    const stale = current != null && input.now.getTime() - current.lastObservedAt.getTime() >= SANDBOX_OVERLOAD_STALE_MS
    if (current && stale) {
      await tx
        .update(fleetIncidents)
        .set({ details: { ...current.details, resolvedBy: 'unobserved' }, updatedAt: input.now })
        .where(eq(fleetIncidents.id, current.id))
      await resolveFleetIncident(tx, current.id, input.now)
      if (input.status === 'unobserved') return current.id
    }
    const openIncident = stale ? undefined : current
    if (input.status === 'unobserved') return openIncident?.id

    const pressure = input.pressure
    const overloaded = isSandboxOverloaded(pressure)
    const cleared = pressure.load[0] < pressure.cpus
    const reading = {
      sandboxId: input.sandboxId,
      cpus: pressure.cpus,
      load: pressure.load.map(round1) as [number, number, number],
      memTotalMb: Math.round(pressure.memTotalMb),
      memAvailableMb: Math.round(pressure.memAvailableMb),
    }

    if (!openIncident) {
      if (!overloaded) return undefined
      const details: SandboxOverloadDetails = { ...reading, peakLoad: reading.load[0] }
      const [incident] = await tx
        .insert(fleetIncidents)
        .values({
          kind: 'sandbox_overloaded',
          scopeKey,
          squadId: await sandboxSquadId(tx, input.sandboxId),
          startedAt: input.now,
          alertAfter: new Date(input.now.getTime() + SANDBOX_OVERLOAD_ALERT_AFTER_MS),
          lastObservedAt: input.now,
          causeCode: 'sandbox-overloaded',
          causeSummary:
            'More work is running than the machine has CPUs for, often a detached build, test run, or container left behind. On a shared machine, another sandbox can cause it too.',
          remediation: sandboxOverloadRemediation(input.sandboxId),
          details,
          updatedAt: input.now,
        })
        .returning()
      if (!incident) throw new Error('Failed to persist sandbox overload incident')
      return incident.id
    }

    const previous = openIncident.details as Partial<SandboxOverloadDetails>
    const details: SandboxOverloadDetails = {
      ...reading,
      peakLoad: Math.max(typeof previous.peakLoad === 'number' ? previous.peakLoad : 0, reading.load[0]),
      ...(cleared ? { resolvedBy: 'load' as const } : {}),
    }
    await tx
      .update(fleetIncidents)
      .set({ lastObservedAt: input.now, details, updatedAt: input.now })
      .where(eq(fleetIncidents.id, openIncident.id))

    if (cleared) {
      await resolveFleetIncident(tx, openIncident.id, input.now)
      return openIncident.id
    }
    if (!overloaded || input.now.getTime() < openIncident.alertAfter.getTime()) return openIncident.id

    const hasValidManager = (await validCurrentManagerForSquad(tx, openIncident.squadId)) != null
    const plan = planSandboxOverloadAlert(hasValidManager)
    await materializeManagerRoutedAlert(tx, {
      incidentId: openIncident.id,
      managerDueAt: input.now,
      managerStatus: plan.manager === 'skip' ? 'skipped' : 'pending',
      humanDelayMs: plan.humanDelayMs,
      now: input.now,
    })
    return openIncident.id
  })
}

/** Sandboxes with an open overload episode, so the detector can close ones it no longer sees. */
/**
 * The latest load reading of a sandbox's open overload episode. Sandbox status
 * rarely probes a box itself (a probe would wake or keep alive a socket-activated
 * box), so this reading from the overload detector is what surfaces overload in
 * status views.
 */
export async function openSandboxOverloadPressure(sandboxId: string): Promise<SandboxPressure | undefined> {
  const [row] = await db
    .select({ details: fleetIncidents.details })
    .from(fleetIncidents)
    .where(
      and(
        eq(fleetIncidents.kind, 'sandbox_overloaded'),
        eq(fleetIncidents.scopeKey, `sandbox:${sandboxId}`),
        isNull(fleetIncidents.resolvedAt)
      )
    )
    .limit(1)
  const details = row?.details as Partial<SandboxOverloadDetails> | undefined
  if (!details || typeof details.cpus !== 'number' || !Array.isArray(details.load)) return undefined
  return {
    cpus: details.cpus,
    load: details.load,
    memTotalMb: details.memTotalMb ?? 0,
    memAvailableMb: details.memAvailableMb ?? 0,
  }
}

export async function listOpenSandboxOverloadSandboxIds(): Promise<string[]> {
  const rows = await db
    .select({ scopeKey: fleetIncidents.scopeKey })
    .from(fleetIncidents)
    .where(and(eq(fleetIncidents.kind, 'sandbox_overloaded'), isNull(fleetIncidents.resolvedAt)))
  return rows.flatMap((row) => (row.scopeKey.startsWith('sandbox:') ? [row.scopeKey.slice('sandbox:'.length)] : []))
}

export interface FleetIncidentNotificationClaim {
  notificationId: string
  incidentId: string
  audience: 'manager' | 'human'
  recipientId: string | null
  idempotencyKey: string | null
  phase: 'alert' | 'recovery'
  claimToken: string
  attempts: number
  incidentResolvedAt: Date | null
  incidentStartedAt: Date
  incidentKind: FleetIncidentKind
  squadId?: string | undefined
  provider?: string | undefined
  scopeKey: string
  causeCode: string
  causeSummary: string
  remediation?: string | undefined
  /** Structured facts for rendering; readers must allowlist the keys they use. */
  details: Record<string, unknown>
}

export interface FleetIncidentDeliveryTarget {
  recipientId: string
  idempotencyKey: string
}

interface FleetIncidentNotificationCandidateRow extends Record<string, unknown> {
  id: string
}

const MAX_FLEET_NOTIFICATION_CLAIM_LIMIT = 100
const MAX_MANAGER_DELIVERY_ATTEMPTS = 5
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Atomically claim due fleet notifications with a bounded delivery lease. */
export async function claimDueFleetIncidentNotifications(input: {
  now: Date
  limit?: number
  /** Test isolation scope; production omits this to drain every incident. */
  incidentIds?: readonly string[]
}): Promise<FleetIncidentNotificationClaim[]> {
  const limit = input.limit ?? 32
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_NOTIFICATION_CLAIM_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_FLEET_NOTIFICATION_CLAIM_LIMIT}`)
  }
  const now = input.now.toISOString()
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<FleetIncidentNotificationCandidateRow>(sql`
      SELECT notification.id
      FROM fleet_incident_notifications AS notification
      WHERE notification.next_attempt_at <= ${now}::timestamptz
        AND (
          notification.status = 'pending'
          OR (
            notification.status = 'delivering'
            AND notification.claimed_at + interval '60 seconds' <= ${now}::timestamptz
          )
        )
        AND ${
          input.incidentIds == null
            ? sql`TRUE`
            : input.incidentIds.length === 0
              ? sql`FALSE`
              : sql`notification.incident_id IN (${sql.join(
                  input.incidentIds.map((id) => sql`${id}::uuid`),
                  sql`, `
                )})`
        }
        AND (
          notification.kind = 'alert'
          OR EXISTS (
            SELECT 1
            FROM fleet_incident_notifications AS alert
            WHERE alert.incident_id = notification.incident_id
              AND alert.audience = notification.audience
              AND alert.kind = 'alert'
              AND alert.status = 'delivered'
          )
        )
      ORDER BY notification.next_attempt_at, notification.created_at, notification.id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `)
    if (candidates.length === 0) return []

    const claimed = await tx
      .update(fleetIncidentNotifications)
      .set({
        status: 'delivering',
        claimToken: sql`gen_random_uuid()`,
        claimedAt: input.now,
        attempts: sql`${fleetIncidentNotifications.attempts} + 1`,
        updatedAt: input.now,
      })
      .where(
        inArray(
          fleetIncidentNotifications.id,
          candidates.map((candidate) => candidate.id)
        )
      )
      .returning({ id: fleetIncidentNotifications.id })

    const rows = await tx
      .select({
        notificationId: fleetIncidentNotifications.id,
        incidentId: fleetIncidentNotifications.incidentId,
        audience: fleetIncidentNotifications.audience,
        recipientId: fleetIncidentNotifications.recipientId,
        idempotencyKey: fleetIncidentNotifications.idempotencyKey,
        phase: fleetIncidentNotifications.kind,
        claimToken: fleetIncidentNotifications.claimToken,
        attempts: fleetIncidentNotifications.attempts,
        incidentResolvedAt: fleetIncidents.resolvedAt,
        incidentStartedAt: fleetIncidents.startedAt,
        incidentKind: fleetIncidents.kind,
        squadId: fleetIncidents.squadId,
        provider: fleetIncidents.provider,
        scopeKey: fleetIncidents.scopeKey,
        causeCode: fleetIncidents.causeCode,
        causeSummary: fleetIncidents.causeSummary,
        remediation: fleetIncidents.remediation,
        details: fleetIncidents.details,
      })
      .from(fleetIncidentNotifications)
      .innerJoin(fleetIncidents, eq(fleetIncidents.id, fleetIncidentNotifications.incidentId))
      .where(
        inArray(
          fleetIncidentNotifications.id,
          claimed.map((notification) => notification.id)
        )
      )
      .orderBy(
        asc(fleetIncidentNotifications.nextAttemptAt),
        asc(fleetIncidentNotifications.createdAt),
        asc(fleetIncidentNotifications.id)
      )

    return rows.map((row) => {
      if (!row.claimToken) throw new Error(`Claimed notification ${row.notificationId} has no claim token`)
      return {
        ...row,
        claimToken: row.claimToken,
        squadId: row.squadId ?? undefined,
        provider: row.provider ?? undefined,
        remediation: row.remediation ?? undefined,
        details: (row.details ?? {}) as Record<string, unknown>,
      }
    })
  })
}

/** Bind an unbound manager delivery to the current valid manager under the exact lease token. */
export async function bindFleetIncidentManagerTarget(
  claim: FleetIncidentNotificationClaim
): Promise<FleetIncidentDeliveryTarget> {
  if (claim.audience !== 'manager') throw new Error('Only manager deliveries may bind a manager target')
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({
        incidentId: fleetIncidentNotifications.incidentId,
        phase: fleetIncidentNotifications.kind,
        recipientId: fleetIncidentNotifications.recipientId,
        idempotencyKey: fleetIncidentNotifications.idempotencyKey,
        squadId: fleetIncidents.squadId,
      })
      .from(fleetIncidentNotifications)
      .innerJoin(fleetIncidents, eq(fleetIncidents.id, fleetIncidentNotifications.incidentId))
      .where(
        and(
          eq(fleetIncidentNotifications.id, claim.notificationId),
          eq(fleetIncidentNotifications.status, 'delivering'),
          eq(fleetIncidentNotifications.claimToken, claim.claimToken)
        )
      )
      .limit(1)
    if (!owned) throw new Error('Fleet manager delivery claim is stale')
    if (owned.recipientId && owned.idempotencyKey) {
      return { recipientId: owned.recipientId, idempotencyKey: owned.idempotencyKey }
    }
    if (!owned.squadId) throw new Error('Fleet incident has no current manager route')

    const [route] = await tx
      .select({ managerId: squads.managerAgentId })
      .from(squads)
      .where(and(eq(squads.id, owned.squadId), eq(squads.status, 'active'), isNull(squads.archivedAt)))
      .limit(1)
    if (!route?.managerId) throw new Error('Fleet incident has no current manager')
    const [manager] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, route.managerId),
          eq(agents.squadId, owned.squadId),
          eq(agents.agentTypeId, 'manager'),
          ne(agents.status, 'terminated')
        )
      )
      .limit(1)
    if (!manager) throw new Error('Fleet incident manager is unavailable')

    const idempotencyKey = `fleet-incident:${owned.incidentId}:${owned.phase}:manager:${manager.id}`
    if (idempotencyKey.length > 200) throw new Error('Fleet manager idempotency key is too long')
    const [bound] = await tx
      .update(fleetIncidentNotifications)
      .set({ recipientId: manager.id, idempotencyKey, updatedAt: new Date() })
      .where(
        and(
          eq(fleetIncidentNotifications.id, claim.notificationId),
          eq(fleetIncidentNotifications.status, 'delivering'),
          eq(fleetIncidentNotifications.claimToken, claim.claimToken),
          isNull(fleetIncidentNotifications.recipientId),
          isNull(fleetIncidentNotifications.idempotencyKey)
        )
      )
      .returning({
        recipientId: fleetIncidentNotifications.recipientId,
        idempotencyKey: fleetIncidentNotifications.idempotencyKey,
      })
    if (!bound?.recipientId || !bound.idempotencyKey)
      throw new Error('Fleet manager delivery claim lost binding ownership')
    return { recipientId: bound.recipientId, idempotencyKey: bound.idempotencyKey }
  })
}

/** Retry one failed delivery under its exact token, terminalizing bounded manager failures. */
export async function retryFleetIncidentNotification(input: {
  claim: FleetIncidentNotificationClaim
  now: Date
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ phase: fleetIncidentNotifications.kind, resolvedAt: fleetIncidents.resolvedAt })
      .from(fleetIncidentNotifications)
      .innerJoin(fleetIncidents, eq(fleetIncidents.id, fleetIncidentNotifications.incidentId))
      .where(
        and(
          eq(fleetIncidentNotifications.id, input.claim.notificationId),
          eq(fleetIncidentNotifications.status, 'delivering'),
          eq(fleetIncidentNotifications.claimToken, input.claim.claimToken)
        )
      )
      .limit(1)
    if (!owned) return false
    const canceled = owned.phase === 'alert' && owned.resolvedAt != null
    const managerExhausted = input.claim.audience === 'manager' && input.claim.attempts >= MAX_MANAGER_DELIVERY_ATTEMPTS
    const delay = Math.min(60_000 * 2 ** Math.max(0, input.claim.attempts - 1), 60 * 60_000)
    const [updated] = await tx
      .update(fleetIncidentNotifications)
      .set({
        status: canceled ? 'canceled' : managerExhausted ? 'undeliverable' : 'pending',
        nextAttemptAt: canceled || managerExhausted ? input.now : new Date(input.now.getTime() + delay),
        claimToken: null,
        claimedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(fleetIncidentNotifications.id, input.claim.notificationId),
          eq(fleetIncidentNotifications.status, 'delivering'),
          eq(fleetIncidentNotifications.claimToken, input.claim.claimToken)
        )
      )
      .returning({ id: fleetIncidentNotifications.id })
    return Boolean(updated)
  })
}

/** Settle a delivery only while the caller still owns its exact claim token. */
export async function markFleetIncidentNotificationDelivered(input: {
  notificationId: string
  claimToken: string
  inboxMessageId: string
  now: Date
}): Promise<boolean> {
  if (
    !UUID_PATTERN.test(input.notificationId) ||
    !UUID_PATTERN.test(input.claimToken) ||
    !UUID_PATTERN.test(input.inboxMessageId)
  ) {
    return false
  }
  return db.transaction(async (tx) => {
    const [delivered] = await tx
      .update(fleetIncidentNotifications)
      .set({
        status: 'delivered',
        inboxMessageId: input.inboxMessageId,
        deliveredAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(fleetIncidentNotifications.id, input.notificationId),
          eq(fleetIncidentNotifications.status, 'delivering'),
          eq(fleetIncidentNotifications.claimToken, input.claimToken)
        )
      )
      .returning({
        incidentId: fleetIncidentNotifications.incidentId,
        phase: fleetIncidentNotifications.kind,
        audience: fleetIncidentNotifications.audience,
      })
    if (!delivered) return false

    if (delivered.phase === 'alert') {
      const [incident] = await tx
        .select({ resolvedAt: fleetIncidents.resolvedAt })
        .from(fleetIncidents)
        .where(eq(fleetIncidents.id, delivered.incidentId))
        .limit(1)
      if (incident?.resolvedAt) {
        const human = delivered.audience === 'human'
        await tx
          .insert(fleetIncidentNotifications)
          .values({
            incidentId: delivered.incidentId,
            kind: 'recovery',
            audience: delivered.audience,
            recipientId: human ? SYSTEM_RECIPIENT_ID : null,
            idempotencyKey: human ? humanDeliveryKey(delivered.incidentId, 'recovery') : null,
            nextAttemptAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoNothing()
      }
    }
    return true
  })
}
