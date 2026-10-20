/**
 * Human lifecycle for managed shared BigBrain vaults: create, list, rename, retry, owner device
 * link, read-access revoke/reconnect and delete. Every operation checks literal human authority
 * BEFORE any Platform call. Platform is the generation authority: Core only verifies the caller's
 * expected generation against its synchronized view, sends the mutation, then applies Platform's
 * fresh summary. Access fences (revoke, delete) disable Core's read connection first.
 *
 * The owner link is a secret transient result: never stored, cached, logged or audited here.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  managedBigbrainOwnerSchema,
  managedBigbrainVaultSummarySchema,
  type ManagedBigbrainErrorCode,
  type ManagedBigbrainOwnerInviteResult,
} from '@ficus/shared/managed-bigbrain'
import { db, users } from '../../../../db'
import type { Identity } from '../../../rbac/permissions'
import { isIntegrationEnabled } from '../../provider-state'
import {
  canEnumerateManagedVaults,
  requireManagedVaultManager,
  requireManagedVaultOwner,
  ManagedVaultAuthorizationError,
} from './authorization'
import { managedBigbrainAvailability } from './availability'
import { ManagedBigbrainPlatformError, managedBigbrainPlatform } from './platform-client'
import { ManagedVaultStoreError, managedVaultStore, type ManagedVault } from './store'

export type ManagedVaultServiceCode =
  | ManagedBigbrainErrorCode
  | 'unavailable'
  | 'integration_disabled'
  | 'name_conflict'
  | 'confirmation_mismatch'

export class ManagedVaultServiceError extends Error {
  constructor(
    readonly code: ManagedVaultServiceCode,
    readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 503,
    /** The vault's current generation on races, so a client can re-read and retry deliberately. */
    readonly currentGeneration?: number
  ) {
    super(code)
    this.name = 'ManagedVaultServiceError'
  }
}

const label = managedBigbrainVaultSummarySchema.innerType().shape.displayName
const requestId = z.string().uuid()
const generation = z.number().int().safe().min(1)
export const createManagedVaultInputSchema = z
  .object({ requestId, displayName: label, ownerHandle: managedBigbrainOwnerSchema.shape.handle })
  .strict()
export const renameManagedVaultInputSchema = z
  .object({ requestId, expectedGeneration: generation, displayName: label })
  .strict()
export const managedVaultFenceInputSchema = z.object({ requestId, expectedGeneration: generation }).strict()
export const managedVaultReadAccessInputSchema = managedVaultFenceInputSchema
  .extend({ action: z.enum(['revoke', 'reconnect']) })
  .strict()
export const deleteManagedVaultInputSchema = managedVaultFenceInputSchema
  .extend({ confirmedVaultId: z.string().uuid(), confirmedName: label })
  .strict()

/** Management DTO: never credentials, read material, host paths or another vault's data. */
export interface ManagedVaultView {
  vaultId: string
  displayName: string
  ownerUserId: string
  isOwner: boolean
  state: string
  readAccess: string
  desiredGeneration: number
  appliedGeneration: number
  upstreamVaultId: string | null
  origin: string | null
  connectionId: string | null
  lastErrorCode: string | null
  retryable: boolean
  updatedAt: string
}

export interface ManagedVaultServiceDeps {
  platform?: Omit<typeof managedBigbrainPlatform, 'capabilities'>
  store?: typeof managedVaultStore
  /** Immediate Core access fence for a vault's read connection (disable; never delete). */
  disableConnection: (connectionId: string, actor: string) => Promise<void>
  isEnabled?: () => Promise<boolean>
  available?: () => { available: boolean }
}

export function createManagedVaultService(deps: ManagedVaultServiceDeps) {
  const platform = deps.platform ?? managedBigbrainPlatform
  const store = deps.store ?? managedVaultStore
  const isEnabled = deps.isEnabled ?? (() => isIntegrationEnabled('bigbrain'))
  const available = deps.available ?? (() => managedBigbrainAvailability())

  function view(row: ManagedVault, userId: string): ManagedVaultView {
    return {
      vaultId: row.id,
      displayName: row.displayName,
      ownerUserId: row.ownerUserId,
      isOwner: row.ownerUserId === userId,
      state: row.state,
      readAccess: row.readAccess,
      desiredGeneration: row.desiredGeneration,
      appliedGeneration: row.appliedGeneration,
      upstreamVaultId: row.upstreamVaultId,
      origin: row.origin,
      connectionId: row.connectionId,
      lastErrorCode: row.lastErrorCode,
      retryable: row.retryable,
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  async function live(vaultId: string): Promise<ManagedVault> {
    const row = await store.get(vaultId)
    if (!row || row.state === 'deleted') throw new ManagedVaultServiceError('not_found', 404)
    return row
  }
  function fenceGeneration(row: ManagedVault, expected: number): void {
    if (row.desiredGeneration !== expected)
      throw new ManagedVaultServiceError('generation_conflict', 409, row.desiredGeneration)
  }
  /** The owner exactly as recorded at create: Platform refuses any change on later updates. */
  function owner(row: ManagedVault) {
    return { userId: row.ownerUserId, handle: row.ownerHandle, display: row.ownerDisplay }
  }
  /** Display label for a new owner, from their profile at create time (then frozen). */
  async function ownerDisplay(userId: string, handle: string): Promise<string> {
    const [user] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
    const candidate = (user?.displayName ?? user?.email.split('@')[0] ?? handle).replace(/\p{Cc}/gu, ' ').trim()
    return (candidate || handle).slice(0, 120).trim()
  }
  /** Apply Platform's fresh summary after a mutation (best effort: sync converges regardless). */
  async function refresh(vaultId: string): Promise<ManagedVault> {
    try {
      return await store.applySummary(await platform.getVault(vaultId))
    } catch {
      return (await store.get(vaultId))!
    }
  }
  async function fence(row: ManagedVault, actor: string): Promise<void> {
    if (row.connectionId) await deps.disableConnection(row.connectionId, actor)
    await store.clearReadMaterial(row.id)
  }

  return {
    async list(identity: Identity | undefined): Promise<ManagedVaultView[]> {
      if (!(await canEnumerateManagedVaults(identity))) throw new ManagedVaultServiceError('forbidden', 403)
      const userId = (identity as { userId: string }).userId
      return (await store.list()).map((row) => view(row, userId))
    },

    async get(identity: Identity | undefined, vaultId: string): Promise<ManagedVaultView> {
      if (!(await canEnumerateManagedVaults(identity))) throw new ManagedVaultServiceError('not_found', 404)
      return view(await live(vaultId), (identity as { userId: string }).userId)
    },

    async create(identity: Identity | undefined, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(createManagedVaultInputSchema, input)
      if (!(await isEnabled())) throw new ManagedVaultServiceError('integration_disabled', 409)
      if (!available().available) throw new ManagedVaultServiceError('unavailable', 503)
      const row = await store.request({
        requestId: body.requestId,
        displayName: body.displayName,
        ownerUserId: userId,
        ownerHandle: body.ownerHandle,
        ownerDisplay: await ownerDisplay(userId, body.ownerHandle),
        actorUserId: userId,
      })
      await platform.putVault(row.id, {
        requestId: body.requestId,
        expectedGeneration: 0,
        displayName: row.displayName,
        owner: owner(row),
      })
      return view(await refresh(row.id), userId)
    },

    async rename(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(renameManagedVaultInputSchema, input)
      const row = await live(vaultId)
      fenceGeneration(row, body.expectedGeneration)
      // The owner never changes through a rename.
      await platform.putVault(vaultId, {
        requestId: body.requestId,
        expectedGeneration: body.expectedGeneration,
        displayName: body.displayName,
        owner: owner(row),
      })
      return view(await refresh(vaultId), userId)
    },

    async retry(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultFenceInputSchema, input)
      fenceGeneration(await live(vaultId), body.expectedGeneration)
      await platform.retryVault(vaultId, body)
      return view(await refresh(vaultId), userId)
    },

    async setReadAccess(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultReadAccessInputSchema, input)
      const row = await live(vaultId)
      fenceGeneration(row, body.expectedGeneration)
      // Revoke fences Core first: no read can start once the human asked to revoke.
      if (body.action === 'revoke') await fence(row, `user:${userId}`)
      await platform.setReadAccess(vaultId, body)
      return view(await refresh(vaultId), userId)
    },

    /** Returns the SECRET owner device link once; callers must send it with no-store headers. */
    async ownerInvite(
      identity: Identity | undefined,
      vaultId: string,
      input: unknown
    ): Promise<ManagedBigbrainOwnerInviteResult> {
      const row = await live(vaultId)
      const userId = await requireManagedVaultOwner(identity, row)
      const body = parse(managedVaultFenceInputSchema, input)
      fenceGeneration(row, body.expectedGeneration)
      const result = await platform.createOwnerInvite(vaultId, { ...body, actorUserId: userId })
      // Authority may have been lost while the host call was in flight: verify again.
      await requireManagedVaultOwner(identity, await live(vaultId))
      return result
    },

    async delete(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(deleteManagedVaultInputSchema, input)
      const row = await live(vaultId)
      if (body.confirmedVaultId !== row.id || body.confirmedName !== row.displayName)
        throw new ManagedVaultServiceError('confirmation_mismatch', 409)
      fenceGeneration(row, body.expectedGeneration)
      await fence(row, `user:${userId}`)
      await platform.deleteVault(vaultId, body)
      return view(await refresh(vaultId), userId)
    },
  }
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ManagedVaultServiceError('invalid_request', 400)
  return parsed.data
}

/** HTTP status for any error a managed vault route can see; codes only, never messages. */
export function managedVaultErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (error instanceof ManagedVaultServiceError)
    return {
      status: error.status,
      body: {
        code: error.code,
        ...(error.currentGeneration === undefined ? {} : { currentGeneration: error.currentGeneration }),
      },
    }
  if (error instanceof ManagedVaultAuthorizationError) return { status: 403, body: { code: error.code } }
  if (error instanceof ManagedVaultStoreError)
    return {
      status: error.code === 'not_found' ? 404 : error.code === 'invalid_request' ? 400 : 409,
      body: { code: error.code },
    }
  if (error instanceof ManagedBigbrainPlatformError) {
    const status =
      error.code === 'invalid_request'
        ? 400
        : error.code === 'forbidden' || error.code === 'capability_stale' || error.code === 'scope_mismatch'
          ? 403
          : error.code === 'not_found'
            ? 404
            : ['generation_conflict', 'request_conflict', 'identity_mismatch', 'invite_expired'].includes(error.code)
              ? 409
              : error.code === 'capacity'
                ? 429
                : error.retryable || error.code === 'not_installed' || error.code === 'unauthorized'
                  ? 503
                  : 502
    return { status, body: { code: error.code, retryable: error.retryable } }
  }
  return null
}
