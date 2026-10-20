import { reconcileSquadIntegration, rememberSquadIntegrationChoice } from './scope-settings'
import { effectiveConnectionEnabled, integrationEnabledPredicate, invalidateProjection } from './provider-state'
import { and, asc, eq, getTableColumns, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import {
  db,
  integrationAuthorizationFlowReceipts,
  integrationConnectionAssignments,
  integrationConnections,
  integrationCredentialCleanupJobs,
  integrationRevocationJobs,
  squads,
} from '../../db'
import type {
  AssignedIntegrationConnectionRecord,
  CreatePendingConnection,
  IntegrationAssignmentActor,
  IntegrationAssignmentRepository,
  IntegrationConnectionRecord,
  IntegrationConnectionRepository,
  IntegrationConnectionSummary,
  IntegrationConnectionUsage,
} from './connection-repository'
import { insertIntegrationAuditEvent } from './db-audit'

// The worker polls once a minute; waiting until expiry creates a predictable
// authorization outage on every cycle. Leave two polling intervals for refresh,
// without extending validity or changing failed-validation retry backoff.
function nextHealthyValidationAt(now: Date, expiresAt: Date): Date {
  const lifetimeMs = Math.max(0, expiresAt.getTime() - now.getTime())
  return new Date(expiresAt.getTime() - Math.min(120_000, lifetimeMs / 2))
}

export class DbIntegrationConnectionRepository
  implements IntegrationConnectionRepository, IntegrationAssignmentRepository
{
  constructor(
    private readonly hooks: {
      afterSquadLock?: () => Promise<void>
      afterAssignmentConnectionLock?: () => Promise<void>
      afterLifecycleConnectionLock?: () => Promise<void>
      afterReconnectMaterialLock?: () => Promise<void>
      afterTerminalAuthConnectionUpdate?: () => Promise<void>
    } = {}
  ) {}
  async createPending<C>(input: CreatePendingConnection<C>): Promise<IntegrationConnectionRecord<C>> {
    if (input.authorizationFlowId && (await this.getByAuthorizationFlow(input.authorizationFlowId))) {
      throw new Error('Authorization flow already owns a connection')
    }
    return db.transaction(async (tx) => {
      const { adoptStagedRevocationRef, ...connection } = input
      if (adoptStagedRevocationRef && adoptStagedRevocationRef !== input.credentialRef) {
        throw new Error('Staged revocation artifact reference mismatch')
      }
      const [row] = await tx
        .insert(integrationConnections)
        .values({ ...connection, squadId: null })
        .returning()
      if (adoptStagedRevocationRef) {
        const adopted = await tx
          .select({ id: integrationRevocationJobs.id })
          .from(integrationRevocationJobs)
          .where(
            and(
              eq(integrationRevocationJobs.credentialRef, adoptStagedRevocationRef),
              eq(integrationRevocationJobs.providerKey, input.providerKey),
              eq(integrationRevocationJobs.adapterVersion, input.adapterVersion),
              eq(integrationRevocationJobs.clientAuthority, input.clientAuthority ?? 'local'),
              isNull(integrationRevocationJobs.leaseToken),
              isNull(integrationRevocationJobs.leaseExpiresAt),
              eq(integrationRevocationJobs.attempts, 0),
              isNull(integrationRevocationJobs.terminalAt)
            )
          )
          .for('update')
        if (adopted.length !== 1) throw new Error('Staged revocation artifact is not adoptable')
      }
      return map(row) as IntegrationConnectionRecord<C>
    })
  }

  async get(id: string): Promise<IntegrationConnectionRecord | null> {
    const [row] = await db
      .select({ ...getTableColumns(integrationConnections), enabled: effectiveConnectionEnabled() })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id))
      .limit(1)
    return row ? map(row) : null
  }

  async getByAuthorizationFlow(localFlowId: string): Promise<IntegrationConnectionRecord | null> {
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.authorizationFlowId, localFlowId))
      .limit(1)
    return row ? map(row) : null
  }

  /** Minimal pre-authorization lookup; never loads configuration or credential metadata. */
  async providerFor(id: string): Promise<string | null> {
    const [row] = await db
      .select({ providerKey: integrationConnections.providerKey })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id))
      .limit(1)
    return row?.providerKey ?? null
  }

  async list(providerKey: string): Promise<readonly IntegrationConnectionRecord[]> {
    return (
      await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, providerKey))
    ).map(map)
  }

  async listRefreshCandidates(
    providerKey: string,
    currentAuthority: 'local' | 'platform_broker',
    afterId: string | null,
    limit: number,
    authorityFilter: 'matching' | 'mismatched' = 'matching'
  ): Promise<
    readonly {
      id: string
      credentialRef: string
      enabled: boolean
      authState: string
      clientAuthority: 'local' | 'platform_broker'
    }[]
  > {
    return db
      .select({
        id: integrationConnections.id,
        credentialRef: integrationConnections.credentialRef,
        enabled: effectiveConnectionEnabled(),
        authState: integrationConnections.authState,
        clientAuthority: sql<'local' | 'platform_broker'>`${integrationConnections.clientAuthority}`,
      })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.providerKey, providerKey),
          eq(integrationConnections.enabled, true),
          integrationEnabledPredicate(),
          eq(integrationConnections.authState, 'authenticated'),
          authorityFilter === 'matching'
            ? eq(integrationConnections.clientAuthority, currentAuthority)
            : ne(integrationConnections.clientAuthority, currentAuthority),
          afterId === null ? undefined : gt(integrationConnections.id, afterId)
        )
      )
      .orderBy(asc(integrationConnections.id))
      .limit(Math.max(1, Math.min(limit, 100)))
  }

  async getAssigned(squadId: string, providerKey: string): Promise<AssignedIntegrationConnectionRecord | null> {
    await reconcileSquadIntegration(squadId, providerKey)
    const [row] = await db
      .select({ connection: { ...getTableColumns(integrationConnections), enabled: effectiveConnectionEnabled() } })
      .from(integrationConnectionAssignments)
      .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
      .where(
        and(
          eq(integrationConnectionAssignments.squadId, squadId),
          eq(integrationConnectionAssignments.providerKey, providerKey),
          eq(integrationConnectionAssignments.isDefault, true)
        )
      )
      .limit(1)
    return row ? { ...map(row.connection), squadId } : null
  }

  async getAssignedById(
    squadId: string,
    providerKey: string,
    connectionId: string
  ): Promise<AssignedIntegrationConnectionRecord | null> {
    // A malformed ID is simply not assigned (and must never reach Postgres as a uuid cast error).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) return null
    await reconcileSquadIntegration(squadId, providerKey)
    const [row] = await db
      .select({ connection: { ...getTableColumns(integrationConnections), enabled: effectiveConnectionEnabled() } })
      .from(integrationConnectionAssignments)
      .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
      .where(
        and(
          eq(integrationConnectionAssignments.squadId, squadId),
          eq(integrationConnectionAssignments.providerKey, providerKey),
          eq(integrationConnectionAssignments.connectionId, connectionId)
        )
      )
      .limit(1)
    return row ? { ...map(row.connection), squadId } : null
  }

  async listAssigned(squadId: string, providerKey: string) {
    await reconcileSquadIntegration(squadId, providerKey)
    const rows = await db
      .select({
        connection: { ...getTableColumns(integrationConnections), enabled: effectiveConnectionEnabled() },
        isDefault: integrationConnectionAssignments.isDefault,
      })
      .from(integrationConnectionAssignments)
      .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
      .where(
        and(
          eq(integrationConnectionAssignments.squadId, squadId),
          eq(integrationConnectionAssignments.providerKey, providerKey)
        )
      )
      .orderBy(integrationConnections.displayName, integrationConnections.id)
    return rows.map((row) => ({ ...map(row.connection), squadId, isDefault: row.isDefault }))
  }

  async listPoolSummaries(providerKey: string): Promise<readonly IntegrationConnectionSummary[]> {
    return db
      .select({
        id: integrationConnections.id,
        providerKey: integrationConnections.providerKey,
        displayName: integrationConnections.displayName,
        enabled: effectiveConnectionEnabled(),
        healthState: integrationConnections.healthState,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.providerKey, providerKey))
  }

  async assign(
    squadId: string,
    providerKey: string,
    connectionId: string,
    actor?: IntegrationAssignmentActor,
    options: { retainPrevious?: boolean; makeDefault?: boolean } = {}
  ): Promise<AssignedIntegrationConnectionRecord> {
    const makeDefault = options.makeDefault !== false
    return db.transaction(async (tx) => {
      await lockSquad(tx, squadId)
      await this.hooks.afterSquadLock?.()
      const [connection] = await tx
        .select()
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.id, connectionId),
            eq(integrationConnections.providerKey, providerKey),
            eq(integrationConnections.enabled, true),
            integrationEnabledPredicate()
          )
        )
        .for('update')
      if (!connection) throw new Error('Assignment requires an enabled provider connection')

      const [previous] = await tx
        .select({ connectionId: integrationConnectionAssignments.connectionId })
        .from(integrationConnectionAssignments)
        .where(
          and(
            eq(integrationConnectionAssignments.squadId, squadId),
            eq(integrationConnectionAssignments.providerKey, providerKey),
            eq(integrationConnectionAssignments.isDefault, true)
          )
        )
        .for('update')
      if (makeDefault && previous && previous.connectionId !== connectionId) {
        const previousWhere = and(
          eq(integrationConnectionAssignments.squadId, squadId),
          eq(integrationConnectionAssignments.providerKey, providerKey),
          eq(integrationConnectionAssignments.connectionId, previous.connectionId)
        )
        if (options.retainPrevious) {
          await tx.update(integrationConnectionAssignments).set({ isDefault: false }).where(previousWhere)
        } else {
          await tx.delete(integrationConnectionAssignments).where(previousWhere)
        }
      }
      const insert = tx
        .insert(integrationConnectionAssignments)
        .values({ squadId, providerKey, connectionId, isDefault: makeDefault })
      const target = [
        integrationConnectionAssignments.squadId,
        integrationConnectionAssignments.providerKey,
        integrationConnectionAssignments.connectionId,
      ]
      if (makeDefault) await insert.onConflictDoUpdate({ target, set: { isDefault: true, updatedAt: new Date() } })
      else await insert.onConflictDoNothing({ target })
      await invalidateProjection(tx, squadId, providerKey)
      await insertIntegrationAuditEvent(tx, {
        connectionId,
        squadId,
        userId: actor?.userId,
        agentId: actor?.agentId,
        action: 'assignment_set',
        outcome: 'succeeded',
        at: new Date(),
      })
      await rememberSquadIntegrationChoice(tx, squadId, providerKey)
      return { ...map(connection), squadId }
    })
  }

  async unassign(
    squadId: string,
    providerKey: string,
    actor?: IntegrationAssignmentActor,
    connectionId?: string
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      await lockSquad(tx, squadId)
      await this.hooks.afterSquadLock?.()
      const assignmentWhere = and(
        eq(integrationConnectionAssignments.squadId, squadId),
        eq(integrationConnectionAssignments.providerKey, providerKey),
        connectionId
          ? eq(integrationConnectionAssignments.connectionId, connectionId)
          : eq(integrationConnectionAssignments.isDefault, true)
      )
      const [candidate] = await tx
        .select({ connectionId: integrationConnectionAssignments.connectionId })
        .from(integrationConnectionAssignments)
        .where(assignmentWhere)
      if (!candidate) return false

      // Connection-before-assignment is the same order used by confirmed deletion.
      // This prevents the audit FK and ON DELETE CASCADE from deadlocking each other.
      const [connection] = await tx
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, candidate.connectionId))
        .for('update')
      if (!connection) return false
      await this.hooks.afterAssignmentConnectionLock?.()
      const [previous] = await tx
        .select({ connectionId: integrationConnectionAssignments.connectionId })
        .from(integrationConnectionAssignments)
        .where(assignmentWhere)
        .for('update')
      if (!previous || previous.connectionId !== connection.id) return false

      await tx.delete(integrationConnectionAssignments).where(assignmentWhere)
      await invalidateProjection(tx, squadId, providerKey)
      await insertIntegrationAuditEvent(tx, {
        connectionId: previous.connectionId,
        squadId,
        userId: actor?.userId,
        agentId: actor?.agentId,
        action: 'assignment_unassign',
        outcome: 'succeeded',
        at: new Date(),
      })
      await rememberSquadIntegrationChoice(tx, squadId, providerKey)
      return true
    })
  }

  async usage(connectionId: string): Promise<IntegrationConnectionUsage> {
    const rows = await db
      .select({ id: squads.id, name: squads.name })
      .from(integrationConnectionAssignments)
      .innerJoin(squads, eq(squads.id, integrationConnectionAssignments.squadId))
      .where(eq(integrationConnectionAssignments.connectionId, connectionId))
      .orderBy(squads.name, squads.id)
    return { squadCount: rows.length, squads: rows }
  }

  async scheduleCredentialCleanup(credentialRef: string): Promise<void> {
    await enqueueCredentialCleanup(db, credentialRef)
  }

  async scheduleRevocation(input: {
    providerKey: string
    adapterVersion: number
    credentialRef: string
    clientAuthority: IntegrationConnectionRecord['clientAuthority']
  }): Promise<void> {
    await db
      .insert(integrationRevocationJobs)
      .values(input)
      .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
  }

  async ownsRevocation(input: {
    credentialRef: string
    providerKey: string
    adapterVersion: number
    clientAuthority: IntegrationConnectionRecord['clientAuthority']
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: integrationRevocationJobs.id })
      .from(integrationRevocationJobs)
      .where(
        and(
          eq(integrationRevocationJobs.credentialRef, input.credentialRef),
          eq(integrationRevocationJobs.providerKey, input.providerKey),
          eq(integrationRevocationJobs.adapterVersion, input.adapterVersion),
          eq(integrationRevocationJobs.clientAuthority, input.clientAuthority)
        )
      )
      .limit(1)
    return Boolean(row)
  }

  async hasRevocation(credentialRef: string): Promise<boolean> {
    const [row] = await db
      .select({ id: integrationRevocationJobs.id })
      .from(integrationRevocationJobs)
      .where(eq(integrationRevocationJobs.credentialRef, credentialRef))
      .limit(1)
    return Boolean(row)
  }

  async abandonPendingAuthorization(input: {
    id: string
    localFlowId: string
    code: string
  }): Promise<'updated' | 'changed' | 'not_found'> {
    return db.transaction(async (tx) => {
      const [receipt] = await tx
        .select()
        .from(integrationAuthorizationFlowReceipts)
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
        .for('update')
      if (!receipt) return 'not_found'
      if (receipt.installKind || receipt.terminalAt) return 'changed'
      const [connection] = await tx
        .select()
        .from(integrationConnections)
        .where(eq(integrationConnections.id, input.id))
        .for('update')
      if (!connection) return 'not_found'
      if (
        connection.authorizationFlowId !== input.localFlowId ||
        connection.enabled ||
        connection.credentialRef !== receipt.artifactCredentialRef
      ) {
        return 'changed'
      }
      await tx
        .update(integrationAuthorizationFlowReceipts)
        .set({
          terminalCode: input.code,
          terminalAt: sql`transaction_timestamp()`,
          revocationRequiredAt: sql`transaction_timestamp()`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.localFlowId))
      await tx
        .insert(integrationRevocationJobs)
        .values({
          providerKey: connection.providerKey,
          adapterVersion: connection.adapterVersion,
          clientAuthority: connection.clientAuthority,
          authorizationFlowId: input.localFlowId,
          credentialRef: connection.credentialRef,
        })
        .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
      await tx.delete(integrationConnections).where(eq(integrationConnections.id, input.id))
      return 'updated'
    })
  }

  async due(now: Date, limit: number): Promise<readonly { id: string }[]> {
    return db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.enabled, true),
          integrationEnabledPredicate(),
          or(isNull(integrationConnections.nextValidationAt), lte(integrationConnections.nextValidationAt, now))
        )
      )
      .limit(limit)
  }

  async recordValidation(input: Parameters<IntegrationConnectionRepository['recordValidation']>[0]): Promise<boolean> {
    const values = input.validation.ok
      ? {
          authState: 'authenticated' as const,
          healthState: 'healthy' as const,
          grantedScopes: [...input.validation.grantedScopes],
          ...(input.validation.configuration === undefined ? {} : { configuration: input.validation.configuration }),
          validatedRevision: input.materialRevision,
          validatedAt: input.now,
          validationExpiresAt: input.expiresAt,
          healthCheckedAt: input.now,
          lastHealthyAt: input.now,
          lastErrorCode: null,
          validationFailureCount: 0,
          nextValidationAt: nextHealthyValidationAt(input.now, input.expiresAt),
        }
      : {
          authState: input.validation.code === 'invalid_auth' ? ('invalid' as const) : ('authenticated' as const),
          healthState: input.validation.code === 'invalid_auth' ? ('unreachable' as const) : ('degraded' as const),
          ...(input.validation.code === 'invalid_auth' ? { grantedScopes: [] } : {}),
          validatedRevision: null,
          validatedAt: input.now,
          validationExpiresAt: input.now,
          healthCheckedAt: input.now,
          lastFailureAt: input.now,
          lastErrorCode: input.validation.code,
          validationFailureCount: sql`${integrationConnections.validationFailureCount} + 1`,
          nextValidationAt: input.expiresAt,
        }
    if (input.validation.ok) {
      return db.transaction(async (tx) => {
        const [connection] = await tx
          .select({
            id: integrationConnections.id,
            providerKey: integrationConnections.providerKey,
            enabled: integrationConnections.enabled,
            authState: integrationConnections.authState,
            validatedRevision: integrationConnections.validatedRevision,
            validationExpiresAt: integrationConnections.validationExpiresAt,
          })
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.id, input.id),
              eq(integrationConnections.materialRevision, input.materialRevision)
            )
          )
          .for('update')
        if (!connection || connection.authState === 'reauthorization_required') return false
        await tx
          .update(integrationConnections)
          .set({ ...values, updatedAt: input.now })
          .where(eq(integrationConnections.id, input.id))
        const wasProjectionEligible =
          connection.enabled &&
          connection.authState === 'authenticated' &&
          connection.validatedRevision === input.materialRevision &&
          connection.validationExpiresAt !== null &&
          connection.validationExpiresAt > input.now
        if (connection.enabled && !wasProjectionEligible) {
          const usage = await usageInTransaction(tx, input.id)
          for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
        }
        return true
      })
    }
    if (!input.validation.ok && input.validation.code === 'invalid_auth') {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(integrationConnections)
          .set({ ...values, updatedAt: input.now })
          .where(
            and(
              eq(integrationConnections.id, input.id),
              eq(integrationConnections.materialRevision, input.materialRevision),
              ne(integrationConnections.authState, 'reauthorization_required')
            )
          )
          .returning({ id: integrationConnections.id, providerKey: integrationConnections.providerKey })
        const connection = rows[0]
        if (!connection) return false
        const usage = await usageInTransaction(tx, input.id)
        for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
        return true
      })
    }
    const rows = await db
      .update(integrationConnections)
      .set({ ...values, updatedAt: input.now })
      .where(
        and(
          eq(integrationConnections.id, input.id),
          eq(integrationConnections.materialRevision, input.materialRevision),
          ne(integrationConnections.authState, 'reauthorization_required')
        )
      )
      .returning({ id: integrationConnections.id })
    return rows.length === 1
  }

  async enableValidated(input: Parameters<IntegrationConnectionRepository['enableValidated']>[0]): Promise<boolean> {
    const [hint] = await db
      .select({ authorizationFlowId: integrationConnections.authorizationFlowId })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, input.id))
    const receiptFlowId = input.authorizationFlowId ?? hint?.authorizationFlowId
    return db.transaction(async (tx) => {
      const [receipt] = receiptFlowId
        ? await tx
            .select()
            .from(integrationAuthorizationFlowReceipts)
            .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receiptFlowId))
            .for('update')
        : [null]
      const connectionIds = [
        input.id,
        ...(receipt?.intent === 'reconnect' && !receipt.installKind && receipt.sourceConnectionId
          ? [receipt.sourceConnectionId]
          : []),
      ].sort()
      const lockedConnections = await tx
        .select({
          id: integrationConnections.id,
          providerKey: integrationConnections.providerKey,
          adapterVersion: integrationConnections.adapterVersion,
          clientAuthority: integrationConnections.clientAuthority,
          authorizationFlowId: integrationConnections.authorizationFlowId,
          enabled: integrationConnections.enabled,
          authState: integrationConnections.authState,
          validatedRevision: integrationConnections.validatedRevision,
          validationExpiresAt: integrationConnections.validationExpiresAt,
          credentialRef: integrationConnections.credentialRef,
          materialRevision: integrationConnections.materialRevision,
        })
        .from(integrationConnections)
        .where(inArray(integrationConnections.id, connectionIds))
        .orderBy(integrationConnections.id)
        .for('update')
      const connection = lockedConnections.find((row) => row.id === input.id)
      if (
        !connection ||
        connection.materialRevision !== input.materialRevision ||
        connection.authState === 'reauthorization_required'
      )
        return false
      if (!input.authorizationFlowId) {
        if (connection.authorizationFlowId !== (hint?.authorizationFlowId ?? null)) return false
        if (receipt && !receipt.installKind) return false
      }
      if (!receiptFlowId && connection.clientAuthority === 'local') {
        const stagedJobs = await tx
          .select({ id: integrationRevocationJobs.id })
          .from(integrationRevocationJobs)
          .where(eq(integrationRevocationJobs.credentialRef, connection.credentialRef))
          .for('update')
        if (stagedJobs.length) {
          const adopted = await tx
            .delete(integrationRevocationJobs)
            .where(
              and(
                eq(integrationRevocationJobs.credentialRef, connection.credentialRef),
                eq(integrationRevocationJobs.providerKey, connection.providerKey),
                eq(integrationRevocationJobs.adapterVersion, connection.adapterVersion),
                eq(integrationRevocationJobs.clientAuthority, connection.clientAuthority),
                isNull(integrationRevocationJobs.leaseToken),
                isNull(integrationRevocationJobs.leaseExpiresAt),
                eq(integrationRevocationJobs.attempts, 0),
                isNull(integrationRevocationJobs.terminalAt)
              )
            )
            .returning({ id: integrationRevocationJobs.id })
          if (adopted.length !== 1) return false
        }
      }
      if (input.authorizationFlowId) {
        if (connection.authorizationFlowId !== input.authorizationFlowId) return false
        if (!receipt) throw new Error('Authorization flow receipt unavailable')
        if (receipt.installKind) {
          return (
            receipt.installedConnectionId === connection.id &&
            receipt.installedMaterialRevision === connection.materialRevision
          )
        }
        const installKind = receipt.intent === 'connect' ? 'connect' : 'reconnect_distinct'
        const source = receipt.sourceConnectionId
          ? lockedConnections.find((row) => row.id === receipt.sourceConnectionId)
          : null
        if (
          installKind === 'reconnect_distinct' &&
          (receipt.sourceConnectionId === connection.id ||
            !source ||
            source.materialRevision !== receipt.sourceMaterialRevision)
        ) {
          return false
        }
        if (
          !receipt.stagingStartedAt ||
          receipt.terminalAt ||
          receipt.authority !== connection.clientAuthority ||
          receipt.providerKey !== connection.providerKey ||
          receipt.adapterVersion !== connection.adapterVersion ||
          receipt.artifactCredentialRef !== connection.credentialRef
        ) {
          throw new Error('Authorization flow receipt cannot install connection')
        }
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            installKind,
            installedConnectionId: connection.id,
            installedMaterialRevision: connection.materialRevision,
            installedAt: sql`transaction_timestamp()`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, transaction_timestamp() + interval '24 hours')`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, input.authorizationFlowId))
      }
      const rows = await tx
        .update(integrationConnections)
        .set({
          enabled: true,
          authState: 'authenticated',
          healthState: 'healthy',
          grantedScopes: [...input.validation.grantedScopes],
          ...(input.validation.configuration === undefined ? {} : { configuration: input.validation.configuration }),
          validatedRevision: input.materialRevision,
          validatedAt: input.now,
          validationExpiresAt: input.expiresAt,
          healthCheckedAt: input.now,
          lastHealthyAt: input.now,
          nextValidationAt: nextHealthyValidationAt(input.now, input.expiresAt),
          lastErrorCode: null,
          validationFailureCount: 0,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(integrationConnections.id, input.id),
            eq(integrationConnections.materialRevision, input.materialRevision),
            ne(integrationConnections.authState, 'reauthorization_required')
          )
        )
        .returning({ id: integrationConnections.id })
      if (rows.length !== 1) return false
      const wasProjectionEligible =
        connection.enabled &&
        connection.authState === 'authenticated' &&
        connection.validatedRevision === input.materialRevision &&
        connection.validationExpiresAt !== null &&
        connection.validationExpiresAt > input.now
      if (!wasProjectionEligible) {
        const usage = await usageInTransaction(tx, input.id)
        for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      }
      return true
    })
  }

  async disable(
    id: string,
    confirmAssigned = false
  ): Promise<Awaited<ReturnType<IntegrationConnectionRepository['disable']>>> {
    return db.transaction(async (tx) => {
      const [connection] = await tx
        .select({ id: integrationConnections.id, providerKey: integrationConnections.providerKey })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id))
        .for('update')
      if (!connection) return { status: 'not_found' }
      const usage = await usageInTransaction(tx, id)
      if (usage.squadCount > 0 && !confirmAssigned) return { status: 'in_use', usage }
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      await tx
        .update(integrationConnections)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(integrationConnections.id, id))
      return { status: 'updated', value: undefined }
    })
  }

  async disableRuntimeAuthFailure(
    input: Parameters<IntegrationConnectionRepository['disableRuntimeAuthFailure']>[0]
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(integrationConnections)
        .set({
          enabled: false,
          authState: 'invalid',
          healthState: 'unreachable',
          validatedRevision: null,
          validationExpiresAt: null,
          lastErrorCode: 'invalid_auth',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationConnections.id, input.id),
            eq(integrationConnections.materialRevision, input.materialRevision),
            ne(integrationConnections.authState, 'reauthorization_required')
          )
        )
        .returning({ id: integrationConnections.id, providerKey: integrationConnections.providerKey })
      const connection = rows[0]
      if (!connection) return false
      const usage = await usageInTransaction(tx, input.id)
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      return true
    })
  }

  async markReauthorizationRequired(
    input: Parameters<IntegrationConnectionRepository['markReauthorizationRequired']>[0]
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [connection] = await tx
        .select({ id: integrationConnections.id, providerKey: integrationConnections.providerKey })
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.id, input.id),
            eq(integrationConnections.materialRevision, input.materialRevision),
            ne(integrationConnections.authState, 'reauthorization_required')
          )
        )
        .for('update')
      if (!connection) return false
      const now = new Date()
      await tx
        .update(integrationConnections)
        .set({
          authState: 'reauthorization_required',
          healthState: 'degraded',
          validatedRevision: null,
          validationExpiresAt: null,
          lastFailureAt: now,
          lastErrorCode: input.code,
          nextValidationAt: null,
          updatedAt: now,
        })
        .where(eq(integrationConnections.id, input.id))
      await this.hooks.afterTerminalAuthConnectionUpdate?.()
      const usage = await usageInTransaction(tx, input.id)
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      return true
    })
  }

  async recordRefreshFailure(
    input: Parameters<IntegrationConnectionRepository['recordRefreshFailure']>[0]
  ): Promise<boolean> {
    const now = new Date()
    if (input.invalidateAuthentication) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(integrationConnections)
          .set({
            authState: 'invalid',
            healthState: 'degraded',
            lastFailureAt: now,
            lastErrorCode: input.code,
            validationFailureCount: sql`${integrationConnections.validationFailureCount} + 1`,
            nextValidationAt: new Date(now.getTime() + 60_000),
            updatedAt: now,
          })
          .where(
            and(
              eq(integrationConnections.id, input.id),
              eq(integrationConnections.materialRevision, input.materialRevision),
              ne(integrationConnections.authState, 'reauthorization_required')
            )
          )
          .returning({ id: integrationConnections.id, providerKey: integrationConnections.providerKey })
        const connection = rows[0]
        if (!connection) return false
        const usage = await usageInTransaction(tx, input.id)
        for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
        return true
      })
    }
    const rows = await db
      .update(integrationConnections)
      .set({
        ...(input.invalidateAuthentication
          ? { authState: 'invalid' as const, healthState: 'degraded' as const }
          : { healthState: 'degraded' as const }),
        lastFailureAt: now,
        lastErrorCode: input.code,
        validationFailureCount: sql`${integrationConnections.validationFailureCount} + 1`,
        nextValidationAt: new Date(now.getTime() + 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(integrationConnections.id, input.id),
          eq(integrationConnections.materialRevision, input.materialRevision),
          ne(integrationConnections.authState, 'reauthorization_required')
        )
      )
      .returning({ id: integrationConnections.id })
    return rows.length === 1
  }

  async installAuthorizedMaterial(
    input: Parameters<NonNullable<IntegrationConnectionRepository['installAuthorizedMaterial']>>[0]
  ): Promise<{ status: 'updated' | 'changed' | 'not_found' }> {
    return db.transaction(async (tx) => {
      if (input.adoptStagedRevocationRef && input.adoptStagedRevocationRef !== input.credentialRef) {
        throw new Error('Staged revocation artifact reference mismatch')
      }
      const [hint] = await tx
        .select({ authorizationFlowId: integrationConnections.authorizationFlowId })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, input.id))
      if (!hint) return { status: 'not_found' }
      const receiptIds = [
        ...new Set([hint.authorizationFlowId, input.authorizationFlowId].filter(Boolean) as string[]),
      ].sort()
      const lockedReceipts = receiptIds.length
        ? await tx
            .select()
            .from(integrationAuthorizationFlowReceipts)
            .where(inArray(integrationAuthorizationFlowReceipts.localFlowId, receiptIds))
            .orderBy(integrationAuthorizationFlowReceipts.localFlowId)
            .for('update')
        : []
      const receipt = lockedReceipts.find((row) => row.localFlowId === input.authorizationFlowId) ?? null
      const priorReceipt = lockedReceipts.find((row) => row.localFlowId === hint.authorizationFlowId) ?? null
      const [connection] = await tx
        .select({
          providerKey: integrationConnections.providerKey,
          adapterVersion: integrationConnections.adapterVersion,
          configuration: integrationConnections.configuration,
          credentialRef: integrationConnections.credentialRef,
          materialRevision: integrationConnections.materialRevision,
          clientAuthority: integrationConnections.clientAuthority,
          authorizationFlowId: integrationConnections.authorizationFlowId,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, input.id))
        .for('update')
      if (!connection) return { status: 'not_found' }
      await this.hooks.afterReconnectMaterialLock?.()
      if (connection.authorizationFlowId !== hint.authorizationFlowId) return { status: 'changed' }
      const configuration = connection.configuration as Record<string, unknown>
      const identityKeys = Object.keys(input.expectedIdentity)
      if (
        connection.providerKey !== input.expectedProviderKey ||
        connection.adapterVersion !== input.expectedAdapterVersion ||
        connection.materialRevision !== input.expectedMaterialRevision ||
        !configuration ||
        identityKeys.length === 0 ||
        !identityKeys.every(
          (key) => Object.hasOwn(configuration, key) && configuration[key] === input.expectedIdentity[key]
        )
      ) {
        return { status: 'changed' }
      }
      if (input.authorizationFlowId) {
        if (
          !receipt ||
          receipt.installKind ||
          !receipt.stagingStartedAt ||
          receipt.terminalAt ||
          receipt.intent !== 'reconnect' ||
          receipt.sourceConnectionId !== input.id ||
          receipt.sourceMaterialRevision !== input.expectedMaterialRevision ||
          receipt.providerKey !== connection.providerKey ||
          receipt.adapterVersion !== connection.adapterVersion ||
          receipt.authority !== input.clientAuthority ||
          receipt.artifactCredentialRef !== input.credentialRef
        ) {
          throw new Error('Authorization flow receipt cannot install reconnect')
        }
      }
      const priorFlowOwnsArtifact = priorReceipt !== null && hint.authorizationFlowId !== input.authorizationFlowId
      if (
        priorFlowOwnsArtifact &&
        (!priorReceipt.installKind ||
          priorReceipt.installedConnectionId !== input.id ||
          priorReceipt.installedMaterialRevision !== connection.materialRevision ||
          priorReceipt.artifactCredentialRef !== connection.credentialRef)
      ) {
        throw new Error('Installed authorization receipt does not own retired material')
      }
      const usage = await usageInTransaction(tx, input.id)
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      const now = new Date()
      if (priorFlowOwnsArtifact) {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            revocationRequiredAt: sql`coalesce(${integrationAuthorizationFlowReceipts.revocationRequiredAt}, transaction_timestamp())`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, transaction_timestamp() + interval '24 hours')`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, hint.authorizationFlowId!))
      }
      await tx
        .insert(integrationRevocationJobs)
        .values({
          providerKey: connection.providerKey,
          adapterVersion: connection.adapterVersion,
          credentialRef: connection.credentialRef,
          clientAuthority: connection.clientAuthority,
          authorizationFlowId: priorFlowOwnsArtifact ? hint.authorizationFlowId : null,
        })
        .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
      await tx
        .update(integrationConnections)
        .set({
          displayName: input.displayName,
          configuration: input.configuration,
          credentialRef: input.credentialRef,
          materialRevision: input.materialRevision,
          validatedRevision: input.materialRevision,
          authState: 'authenticated',
          healthState: 'healthy',
          grantedScopes: [],
          validatedAt: now,
          validationExpiresAt: new Date(now.getTime() + 15 * 60_000),
          healthCheckedAt: now,
          lastHealthyAt: now,
          lastErrorCode: null,
          validationFailureCount: 0,
          nextValidationAt: nextHealthyValidationAt(now, new Date(now.getTime() + 15 * 60_000)),
          updatedByUserId: input.updatedByUserId,
          clientAuthority: input.clientAuthority,
          authorizationFlowId:
            input.authorizationFlowId ?? (priorFlowOwnsArtifact ? null : connection.authorizationFlowId),
          updatedAt: now,
        })
        .where(eq(integrationConnections.id, input.id))
      if (input.adoptStagedRevocationRef) {
        const adopted = await tx
          .delete(integrationRevocationJobs)
          .where(
            and(
              eq(integrationRevocationJobs.credentialRef, input.adoptStagedRevocationRef),
              eq(integrationRevocationJobs.providerKey, connection.providerKey),
              eq(integrationRevocationJobs.adapterVersion, connection.adapterVersion),
              eq(integrationRevocationJobs.clientAuthority, input.clientAuthority),
              isNull(integrationRevocationJobs.leaseToken),
              isNull(integrationRevocationJobs.leaseExpiresAt),
              eq(integrationRevocationJobs.attempts, 0),
              isNull(integrationRevocationJobs.terminalAt)
            )
          )
          .returning({ id: integrationRevocationJobs.id })
        if (adopted.length !== 1) throw new Error('Staged revocation artifact is not adoptable')
      }
      if (receipt) {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            installKind: 'reconnect_same',
            installedConnectionId: input.id,
            installedMaterialRevision: input.materialRevision,
            installedAt: sql`transaction_timestamp()`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, transaction_timestamp() + interval '24 hours')`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
      }
      return { status: 'updated' }
    })
  }

  async rotateMaterial(
    input: Parameters<IntegrationConnectionRepository['rotateMaterial']>[0]
  ): Promise<Awaited<ReturnType<IntegrationConnectionRepository['rotateMaterial']>>> {
    return db.transaction(async (tx) => {
      const [hint] = await tx
        .select({ authorizationFlowId: integrationConnections.authorizationFlowId })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, input.id))
      if (!hint) return { status: 'not_found' }
      const [receipt] = hint.authorizationFlowId
        ? await tx
            .select()
            .from(integrationAuthorizationFlowReceipts)
            .where(eq(integrationAuthorizationFlowReceipts.localFlowId, hint.authorizationFlowId))
            .for('update')
        : [null]
      const [connection] = await tx
        .select({
          id: integrationConnections.id,
          providerKey: integrationConnections.providerKey,
          credentialRef: integrationConnections.credentialRef,
          materialRevision: integrationConnections.materialRevision,
          authorizationFlowId: integrationConnections.authorizationFlowId,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, input.id))
        .for('update')
      if (!connection) return { status: 'not_found' }
      if (connection.authorizationFlowId !== hint.authorizationFlowId) return { status: 'not_found' }
      const retiredCredentialRef =
        input.credentialRef !== undefined && input.credentialRef !== connection.credentialRef
          ? connection.credentialRef
          : null
      if (
        retiredCredentialRef &&
        receipt &&
        (!receipt.installKind ||
          receipt.installedConnectionId !== connection.id ||
          receipt.installedMaterialRevision !== connection.materialRevision ||
          receipt.artifactCredentialRef !== connection.credentialRef)
      ) {
        throw new Error('Installed authorization receipt does not own rotated material')
      }
      const usage = await usageInTransaction(tx, input.id)
      if (usage.squadCount > 0 && !input.confirmAssigned) return { status: 'in_use', usage }
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      if (retiredCredentialRef && receipt) {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            cleanupRequiredAt: sql`coalesce(${integrationAuthorizationFlowReceipts.cleanupRequiredAt}, transaction_timestamp())`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, transaction_timestamp() + interval '24 hours')`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
        await tx
          .insert(integrationCredentialCleanupJobs)
          .values({ authorizationFlowId: receipt.localFlowId, credentialRef: retiredCredentialRef })
          .onConflictDoNothing({ target: integrationCredentialCleanupJobs.credentialRef })
      } else if (retiredCredentialRef) {
        await enqueueCredentialCleanup(tx, retiredCredentialRef)
      }
      const [row] = await tx
        .update(integrationConnections)
        .set({
          ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
          ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
          ...(input.updatedByUserId === undefined ? {} : { updatedByUserId: input.updatedByUserId }),
          ...(retiredCredentialRef && receipt ? { authorizationFlowId: null } : {}),
          materialRevision: input.materialRevision,
          validatedRevision: null,
          enabled: false,
          authState: 'pending',
          healthState: 'unknown',
          grantedScopes: [],
          validatedAt: null,
          validationExpiresAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, input.id))
        .returning()
      return { status: 'updated', value: { connection: map(row!), retiredCredentialRef } }
    })
  }

  async rollbackPendingLocal(input: { id: string; credentialRef: string }): Promise<boolean> {
    const rows = await db
      .delete(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, input.id),
          eq(integrationConnections.credentialRef, input.credentialRef),
          eq(integrationConnections.enabled, false),
          eq(integrationConnections.clientAuthority, 'local'),
          or(
            eq(integrationConnections.authState, 'pending'),
            and(
              eq(integrationConnections.authState, 'authenticated'),
              eq(integrationConnections.validatedRevision, integrationConnections.materialRevision)
            )
          ),
          isNull(integrationConnections.authorizationFlowId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${integrationConnectionAssignments}
            WHERE ${integrationConnectionAssignments.connectionId} = ${integrationConnections.id}
          )`,
          sql`EXISTS (
            SELECT 1 FROM ${integrationRevocationJobs}
            WHERE ${integrationRevocationJobs.credentialRef} = ${integrationConnections.credentialRef}
              AND ${integrationRevocationJobs.providerKey} = ${integrationConnections.providerKey}
              AND ${integrationRevocationJobs.adapterVersion} = ${integrationConnections.adapterVersion}
              AND ${integrationRevocationJobs.clientAuthority} = 'local'
              AND ${integrationRevocationJobs.authorizationFlowId} IS NULL
              AND ${integrationRevocationJobs.leaseToken} IS NULL
              AND ${integrationRevocationJobs.leaseExpiresAt} IS NULL
              AND ${integrationRevocationJobs.attempts} = 0
              AND ${integrationRevocationJobs.terminalAt} IS NULL
          )`
        )
      )
      .returning({ id: integrationConnections.id })
    return rows.length === 1
  }

  async deleteWithRevocation(
    id: string,
    confirmAssigned = false
  ): Promise<Awaited<ReturnType<NonNullable<IntegrationConnectionRepository['deleteWithRevocation']>>>> {
    return db.transaction(async (tx) => {
      const [hint] = await tx
        .select({ authorizationFlowId: integrationConnections.authorizationFlowId })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id))
      if (!hint) return { status: 'not_found' }
      const [receipt] = hint.authorizationFlowId
        ? await tx
            .select()
            .from(integrationAuthorizationFlowReceipts)
            .where(eq(integrationAuthorizationFlowReceipts.localFlowId, hint.authorizationFlowId))
            .for('update')
        : [null]
      const [connection] = await tx
        .select({
          id: integrationConnections.id,
          providerKey: integrationConnections.providerKey,
          adapterVersion: integrationConnections.adapterVersion,
          credentialRef: integrationConnections.credentialRef,
          materialRevision: integrationConnections.materialRevision,
          clientAuthority: integrationConnections.clientAuthority,
          authorizationFlowId: integrationConnections.authorizationFlowId,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id))
        .for('update')
      if (!connection) return { status: 'not_found' }
      if (connection.authorizationFlowId !== hint.authorizationFlowId) return { status: 'not_found' }
      if (
        receipt &&
        (!receipt.installKind ||
          receipt.installedConnectionId !== connection.id ||
          receipt.installedMaterialRevision !== connection.materialRevision ||
          receipt.artifactCredentialRef !== connection.credentialRef)
      ) {
        throw new Error('Installed authorization receipt does not own deleted material')
      }
      await this.hooks.afterLifecycleConnectionLock?.()
      const usage = await usageInTransaction(tx, id)
      if (usage.squadCount > 0 && !confirmAssigned) return { status: 'in_use', usage }
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      if (receipt) {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            revocationRequiredAt: sql`coalesce(${integrationAuthorizationFlowReceipts.revocationRequiredAt}, transaction_timestamp())`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, transaction_timestamp() + interval '24 hours')`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
      }
      await tx
        .insert(integrationRevocationJobs)
        .values({
          providerKey: connection.providerKey,
          adapterVersion: connection.adapterVersion,
          credentialRef: connection.credentialRef,
          clientAuthority: connection.clientAuthority,
          authorizationFlowId: receipt?.localFlowId ?? null,
        })
        .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
      await tx.delete(integrationConnections).where(eq(integrationConnections.id, id))
      return { status: 'updated', value: { retiredCredentialRef: connection.credentialRef } }
    })
  }

  async delete(
    id: string,
    confirmAssigned = false
  ): Promise<Awaited<ReturnType<IntegrationConnectionRepository['delete']>>> {
    return db.transaction(async (tx) => {
      const [hint] = await tx
        .select({ authorizationFlowId: integrationConnections.authorizationFlowId })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id))
      if (!hint) return { status: 'not_found' }
      const [receipt] = hint.authorizationFlowId
        ? await tx
            .select()
            .from(integrationAuthorizationFlowReceipts)
            .where(eq(integrationAuthorizationFlowReceipts.localFlowId, hint.authorizationFlowId))
            .for('update')
        : [null]
      const [connection] = await tx
        .select({
          id: integrationConnections.id,
          providerKey: integrationConnections.providerKey,
          credentialRef: integrationConnections.credentialRef,
          materialRevision: integrationConnections.materialRevision,
          authorizationFlowId: integrationConnections.authorizationFlowId,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id))
        .for('update')
      if (!connection) return { status: 'not_found' }
      if (connection.authorizationFlowId !== hint.authorizationFlowId) return { status: 'not_found' }
      if (
        receipt &&
        (!receipt.installKind ||
          receipt.installedConnectionId !== connection.id ||
          receipt.installedMaterialRevision !== connection.materialRevision ||
          receipt.artifactCredentialRef !== connection.credentialRef)
      ) {
        throw new Error('Installed authorization receipt does not own deleted material')
      }
      await this.hooks.afterLifecycleConnectionLock?.()
      const usage = await usageInTransaction(tx, id)
      if (usage.squadCount > 0 && !confirmAssigned) return { status: 'in_use', usage }
      for (const squad of usage.squads) await invalidateProjection(tx, squad.id, connection.providerKey)
      if (receipt) {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            cleanupRequiredAt: sql`coalesce(${integrationAuthorizationFlowReceipts.cleanupRequiredAt}, transaction_timestamp())`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, transaction_timestamp() + interval '24 hours')`,
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, receipt.localFlowId))
        await tx
          .insert(integrationCredentialCleanupJobs)
          .values({ authorizationFlowId: receipt.localFlowId, credentialRef: connection.credentialRef })
          .onConflictDoNothing({ target: integrationCredentialCleanupJobs.credentialRef })
      } else {
        await enqueueCredentialCleanup(tx, connection.credentialRef)
      }
      await tx.delete(integrationConnections).where(eq(integrationConnections.id, id))
      return { status: 'updated', value: { retiredCredentialRef: connection.credentialRef } }
    })
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function enqueueCredentialCleanup(executor: Pick<typeof db, 'execute'>, credentialRef: string): Promise<void> {
  await executor.execute(sql`
    INSERT INTO ${integrationCredentialCleanupJobs} (credential_ref)
    SELECT ${credentialRef}
    WHERE EXISTS (SELECT 1 FROM secrets WHERE key = ${credentialRef})
    ON CONFLICT (credential_ref) DO NOTHING
  `)
}

async function lockSquad(tx: Transaction, squadId: string): Promise<void> {
  const [squad] = await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId)).for('update')
  if (!squad) throw new Error('Squad not found')
}

async function usageInTransaction(tx: Transaction, connectionId: string): Promise<IntegrationConnectionUsage> {
  const rows = await tx
    .select({ id: squads.id, name: squads.name })
    .from(integrationConnectionAssignments)
    .innerJoin(squads, eq(squads.id, integrationConnectionAssignments.squadId))
    .where(eq(integrationConnectionAssignments.connectionId, connectionId))
    .orderBy(squads.name, squads.id)
  return { squadCount: rows.length, squads: rows }
}

function map(row: typeof integrationConnections.$inferSelect): IntegrationConnectionRecord {
  return {
    id: row.id,
    providerKey: row.providerKey,
    adapterVersion: row.adapterVersion,
    clientAuthority: row.clientAuthority as IntegrationConnectionRecord['clientAuthority'],
    authorizationFlowId: row.authorizationFlowId,
    displayName: row.displayName,
    configuration: row.configuration,
    credentialRef: row.credentialRef,
    materialRevision: row.materialRevision,
    validatedRevision: row.validatedRevision,
    enabled: row.enabled,
    authState: row.authState,
    healthState: row.healthState,
    grantedScopes: row.grantedScopes,
    validatedAt: row.validatedAt,
    validationExpiresAt: row.validationExpiresAt,
    lastErrorCode: row.lastErrorCode,
    updatedAt: row.updatedAt,
  }
}
