import { and, eq } from 'drizzle-orm'
import type { SandboxToolchainConfig, SandboxToolchainStatus } from '@ficus/shared'
import { db } from '../../../db'
import { createPostgresConnection, getConnectionString, withDedicatedConnectionSlot } from '../../../db/connection'
import { sandboxToolchainActivations, sandboxToolchainProvisions, squads } from '../../../db/schema'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { loadEffectiveToolchain } from '../../integrations/projection/load-effective-toolchain'
import type { ManagedToolchainConfig } from './config'

export type ToolchainErrorCode =
  | 'devbox_unavailable'
  | 'install_failed'
  | 'setup_failed'
  | 'activation_failed'
  | 'readiness_failed'
  | 'timeout'
  | 'unknown'

const SAFE_REASONS: Record<ToolchainErrorCode, string> = {
  devbox_unavailable: 'Devbox is unavailable in this sandbox',
  install_failed: 'Package installation failed',
  setup_failed: 'Toolchain setup failed',
  activation_failed: 'Toolchain activation failed',
  readiness_failed: 'Toolchain readiness check failed',
  timeout: 'Toolchain provisioning timed out; the sandbox may be overloaded',
  unknown: 'Toolchain provisioning failed',
}

interface ProvisionKey {
  sandboxId: string
  squadId: string
  desiredFingerprint: string
}

export interface ToolchainActivationState {
  sandboxId: string
  squadId: string
  appliedFingerprint?: string
  updatedAt: Date
}

export interface ToolchainReconcileSnapshot {
  config?: ManagedToolchainConfig
  provision?: ProvisionState
  activation?: ToolchainActivationState
}

export interface ProvisionState {
  sandboxId: string
  squadId: string
  desiredFingerprint: string
  appliedFingerprint?: string
  status: SandboxToolchainStatus
  errorCode?: ToolchainErrorCode
  exitCode?: number
  reason?: string
  updatedAt: Date
}

function emit(sandboxId: string): void {
  eventEmitter.emit('sandbox.status', { sandboxId })
}

interface ProvisionLeaseSession {
  query(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  release(): void
}

interface ProvisionLeasePool {
  reserve(): Promise<ProvisionLeaseSession>
  end(): Promise<void>
}

export async function withPinnedProvisionLease<T>(
  sandboxId: string,
  reconcile: () => Promise<T>,
  pool: ProvisionLeasePool
): Promise<T> {
  const key = `toolchain:${sandboxId}`
  try {
    const session = await pool.reserve()
    try {
      await session.query`select pg_advisory_lock(hashtextextended(${key}, 0))`
      try {
        return await reconcile()
      } finally {
        await session.query`select pg_advisory_unlock(hashtextextended(${key}, 0))`
      }
    } finally {
      session.release()
    }
  } finally {
    await pool.end()
  }
}

/** Serialize physical toolchain reconciliation across Core processes. */
export async function withProvisionLease<T>(sandboxId: string, reconcile: () => Promise<T>): Promise<T> {
  return withDedicatedConnectionSlot(async () => {
    const connection = createPostgresConnection(getConnectionString(), { max: 1, idle_timeout: 0 })
    return withPinnedProvisionLease(sandboxId, reconcile, {
      reserve: async () => {
        const session = await connection.reserve()
        return {
          query: (strings, ...values) => session(strings, ...(values as never[])),
          release: () => session.release(),
        }
      },
      end: () => connection.end({ timeout: 5 }),
    })
  })
}

export async function markDesired(input: ProvisionKey): Promise<void> {
  const now = new Date()
  await db
    .insert(sandboxToolchainProvisions)
    .values({ ...input, status: 'pending', updatedAt: now })
    .onConflictDoUpdate({
      target: sandboxToolchainProvisions.sandboxId,
      set: {
        squadId: input.squadId,
        desiredFingerprint: input.desiredFingerprint,
        status: 'pending',
        errorCode: null,
        exitCode: null,
        completedAt: null,
        updatedAt: now,
      },
    })
  emit(input.sandboxId)
}

async function updateCurrentDesired(
  input: ProvisionKey,
  values: Partial<typeof sandboxToolchainProvisions.$inferInsert>
): Promise<boolean> {
  const rows = await db
    .update(sandboxToolchainProvisions)
    .set(values)
    .where(
      and(
        eq(sandboxToolchainProvisions.sandboxId, input.sandboxId),
        eq(sandboxToolchainProvisions.desiredFingerprint, input.desiredFingerprint)
      )
    )
    .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
  if (rows.length > 0) emit(input.sandboxId)
  return rows.length > 0
}

export async function markStage(input: ProvisionKey & { status: 'installing' | 'running_setup' }): Promise<void> {
  const now = new Date()
  const inserted = await db
    .insert(sandboxToolchainProvisions)
    .values({ ...input, status: input.status, startedAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
  if (inserted.length > 0) emit(input.sandboxId)
  else
    await updateCurrentDesired(input, {
      status: input.status,
      errorCode: null,
      exitCode: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    })
}

export async function markActivationRequired(input: ProvisionKey): Promise<void> {
  await db
    .insert(sandboxToolchainActivations)
    .values({ sandboxId: input.sandboxId, squadId: input.squadId })
    .onConflictDoUpdate({
      target: sandboxToolchainActivations.sandboxId,
      set: { squadId: input.squadId, updatedAt: new Date() },
    })
}

export async function markReady(input: ProvisionKey): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    const now = new Date()
    const inserted = await tx
      .insert(sandboxToolchainProvisions)
      .values({
        ...input,
        appliedFingerprint: input.desiredFingerprint,
        status: 'ready',
        updatedAt: now,
        completedAt: now,
      })
      .onConflictDoNothing()
      .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
    const rows =
      inserted.length > 0
        ? inserted
        : await tx
            .update(sandboxToolchainProvisions)
            .set({
              appliedFingerprint: input.desiredFingerprint,
              status: 'ready',
              errorCode: null,
              exitCode: null,
              updatedAt: now,
              completedAt: now,
            })
            .where(
              and(
                eq(sandboxToolchainProvisions.sandboxId, input.sandboxId),
                eq(sandboxToolchainProvisions.desiredFingerprint, input.desiredFingerprint)
              )
            )
            .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
    if (rows.length === 0) return false
    await tx
      .insert(sandboxToolchainActivations)
      .values({
        sandboxId: input.sandboxId,
        squadId: input.squadId,
        appliedFingerprint: input.desiredFingerprint,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sandboxToolchainActivations.sandboxId,
        set: {
          squadId: input.squadId,
          appliedFingerprint: input.desiredFingerprint,
          updatedAt: now,
        },
      })
    return true
  })
  if (changed) emit(input.sandboxId)
}

export async function markFailed(
  input: ProvisionKey & { errorCode: ToolchainErrorCode; exitCode?: number }
): Promise<void> {
  const now = new Date()
  const inserted = await db
    .insert(sandboxToolchainProvisions)
    .values({
      ...input,
      status: 'failed',
      errorCode: input.errorCode,
      exitCode: input.exitCode ?? null,
      updatedAt: now,
      completedAt: now,
    })
    .onConflictDoNothing()
    .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
  if (inserted.length > 0) emit(input.sandboxId)
  else
    await updateCurrentDesired(input, {
      status: 'failed',
      errorCode: input.errorCode,
      exitCode: input.exitCode ?? null,
      updatedAt: now,
      completedAt: now,
    })
}

function mapProvisionState(row: typeof sandboxToolchainProvisions.$inferSelect): ProvisionState {
  const errorCode = row.errorCode as ToolchainErrorCode | null
  return {
    ...row,
    appliedFingerprint: row.appliedFingerprint ?? undefined,
    errorCode: errorCode ?? undefined,
    exitCode: row.exitCode ?? undefined,
    reason: errorCode ? SAFE_REASONS[errorCode] : undefined,
  }
}

/**
 * The toolchain the provisioner actually realizes for a squad: the squad's own
 * declaration merged with what its enabled, validated integrations contribute
 * (packages, init hooks, readiness probes) plus the projection fingerprint.
 *
 * EVERY fingerprint that is compared against `sandbox_toolchain_provisions`
 * must be computed from THIS config. Fingerprinting the bare squad config
 * instead (which the status route once did) never matches the row the
 * provisioner wrote once an integration contributes anything, so the UI
 * reported `pending` — and offered "Retry provisioning" — for a toolchain the
 * database said was `ready`.
 */
export async function loadDesiredToolchain(
  squadId: string,
  config: SandboxToolchainConfig | undefined
): Promise<ManagedToolchainConfig> {
  const effective = await loadEffectiveToolchain(squadId, config)
  return {
    ...effective.config,
    initHooks: effective.initHooks,
    readiness: effective.readiness,
    integrationFingerprint: effective.integrationFingerprint,
  }
}

export async function readToolchainReconcileSnapshot(
  squadId: string,
  sandboxId: string
): Promise<ToolchainReconcileSnapshot> {
  const [row] = await db
    .select({
      metadata: squads.metadata,
      provision: sandboxToolchainProvisions,
      activation: sandboxToolchainActivations,
    })
    .from(squads)
    .leftJoin(
      sandboxToolchainProvisions,
      and(eq(sandboxToolchainProvisions.sandboxId, sandboxId), eq(sandboxToolchainProvisions.squadId, squads.id))
    )
    .leftJoin(
      sandboxToolchainActivations,
      and(eq(sandboxToolchainActivations.sandboxId, sandboxId), eq(sandboxToolchainActivations.squadId, squads.id))
    )
    .where(eq(squads.id, squadId))
    .limit(1)
  if (!row) return { config: undefined, provision: undefined, activation: undefined }
  const sandbox = (row.metadata as Record<string, unknown> | null)?.sandbox
  const config =
    typeof sandbox === 'object' &&
    sandbox !== null &&
    'toolchain' in sandbox &&
    typeof sandbox.toolchain === 'object' &&
    sandbox.toolchain !== null
      ? (sandbox.toolchain as SandboxToolchainConfig)
      : undefined
  return {
    config: await loadDesiredToolchain(squadId, config),
    provision: row.provision ? mapProvisionState(row.provision) : undefined,
    activation: row.activation
      ? { ...row.activation, appliedFingerprint: row.activation.appliedFingerprint ?? undefined }
      : undefined,
  }
}

export async function getProvisionState(
  sandboxId: string,
  desiredFingerprint?: string
): Promise<ProvisionState | undefined> {
  const [row] = await db
    .select()
    .from(sandboxToolchainProvisions)
    .where(eq(sandboxToolchainProvisions.sandboxId, sandboxId))
    .limit(1)
  if (!row) return undefined
  if (desiredFingerprint && row.desiredFingerprint !== desiredFingerprint) {
    return {
      sandboxId: row.sandboxId,
      squadId: row.squadId,
      desiredFingerprint,
      appliedFingerprint: row.appliedFingerprint ?? undefined,
      status: 'pending',
      updatedAt: row.updatedAt,
    }
  }
  return mapProvisionState(row)
}

export async function clearCurrentToolchainState(sandboxId: string, squadId: string): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    const provisions = await tx
      .delete(sandboxToolchainProvisions)
      .where(and(eq(sandboxToolchainProvisions.sandboxId, sandboxId), eq(sandboxToolchainProvisions.squadId, squadId)))
      .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
    const activations = await tx
      .delete(sandboxToolchainActivations)
      .where(
        and(eq(sandboxToolchainActivations.sandboxId, sandboxId), eq(sandboxToolchainActivations.squadId, squadId))
      )
      .returning({ sandboxId: sandboxToolchainActivations.sandboxId })
    return provisions.length + activations.length > 0
  })
  if (changed) emit(sandboxId)
}

export async function clearSandboxProvisionState(sandboxId: string): Promise<void> {
  const rows = await db
    .delete(sandboxToolchainProvisions)
    .where(eq(sandboxToolchainProvisions.sandboxId, sandboxId))
    .returning({ sandboxId: sandboxToolchainProvisions.sandboxId })
  rows.forEach(({ sandboxId: changedId }) => emit(changedId))
}
