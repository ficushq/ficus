/**
 * Human lifecycle for managed shared BigBrain vaults: create, list, rename, retry, owner device
 * link, read-access revoke/reconnect and delete. Every operation checks literal human authority
 * BEFORE any effect. Core is the vault authority: an operation is recorded here (generation
 * fence, replay ledger, Core-side intent applied at once) and the worker reconciler executes it
 * on this host through the local root helper. Access fences (revoke, delete) disable Core's read
 * connection first.
 *
 * The owner link is the one synchronous host call: a secret transient result, never stored,
 * cached, logged or audited here, and returned only after the owner is re-checked.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_MAX_VAULTS,
  managedBigbrainOwnerInviteResultSchema,
  managedBigbrainOwnerSchema,
  type ManagedBigbrainErrorCode,
  type ManagedBigbrainInstalledHost,
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
import { currentManagedBigbrainHost, managedBigbrainAvailability } from './availability'
import { ManagedHostError, type ManagedHostClient } from './host-client'
import { managedVaultOrigin } from './host-identity'
import { managedVaultOperations } from './operations'
import { ManagedBigbrainPlatformError } from './platform-client'
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

const label = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => v === v.trim() && !/\p{Cc}/u.test(v))
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
  pendingAction: string | null
  upstreamVaultId: string | null
  origin: string | null
  connectionId: string | null
  lastErrorCode: string | null
  retryable: boolean
  backup: string
  /** Squads that lose read access if this vault is deleted (management view only). */
  assignedSquads: { id: string; name: string }[]
  updatedAt: string
}

export interface ManagedVaultServiceDeps {
  store?: typeof managedVaultStore
  operations?: typeof managedVaultOperations
  hostClient: Pick<ManagedHostClient, 'call'>
  /** The eligible installed host (envelope, zone, limits, pin); null when unavailable. */
  host?: () => ManagedBigbrainInstalledHost | null
  /** Immediate Core access fence for a vault's read connection (disable; never delete). */
  disableConnection: (connectionId: string, actor: string) => Promise<void>
  /** Squads attached to a connection. */
  usage: (connectionId: string) => Promise<{ squads: readonly { id: string; name: string }[] }>
  isEnabled?: () => Promise<boolean>
  available?: () => { available: boolean }
  now?: () => Date
}

export function createManagedVaultService(deps: ManagedVaultServiceDeps) {
  const store = deps.store ?? managedVaultStore
  const operations = deps.operations ?? managedVaultOperations
  const isEnabled = deps.isEnabled ?? (() => isIntegrationEnabled('bigbrain'))
  const available = deps.available ?? (() => managedBigbrainAvailability())
  const currentHost = deps.host ?? (() => currentManagedBigbrainHost())

  async function view(row: ManagedVault, userId: string): Promise<ManagedVaultView> {
    return {
      vaultId: row.id,
      displayName: row.displayName,
      ownerUserId: row.ownerUserId,
      isOwner: row.ownerUserId === userId,
      state: row.state,
      readAccess: row.readAccess,
      desiredGeneration: row.desiredGeneration,
      appliedGeneration: row.appliedGeneration,
      pendingAction: row.desiredAction,
      upstreamVaultId: row.upstreamVaultId,
      origin: row.origin,
      connectionId: row.connectionId,
      lastErrorCode: row.lastErrorCode,
      retryable: row.retryable,
      backup: row.backup,
      assignedSquads: row.connectionId ? [...(await deps.usage(row.connectionId)).squads].slice(0, 100) : [],
      updatedAt: row.updatedAt.toISOString(),
    }
  }
  async function live(vaultId: string): Promise<ManagedVault> {
    const row = await store.get(vaultId)
    if (!row || row.state === 'deleted') throw new ManagedVaultServiceError('not_found', 404)
    return row
  }
  function requireHost(): ManagedBigbrainInstalledHost {
    const host = available().available ? currentHost() : null
    if (!host) throw new ManagedVaultServiceError('unavailable', 503)
    return host
  }
  async function ownerDisplay(userId: string, handle: string): Promise<string> {
    const [user] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
    const candidate = (user?.displayName ?? user?.email.split('@')[0] ?? handle).replace(/\p{Cc}/gu, ' ').trim()
    return (candidate || handle).slice(0, 120).trim()
  }
  async function fence(row: ManagedVault, actor: string): Promise<void> {
    if (row.connectionId) await deps.disableConnection(row.connectionId, actor)
    await store.clearReadMaterial(row.id)
  }

  return {
    async list(identity: Identity | undefined): Promise<ManagedVaultView[]> {
      if (!(await canEnumerateManagedVaults(identity))) throw new ManagedVaultServiceError('forbidden', 403)
      const userId = (identity as { userId: string }).userId
      return Promise.all((await store.list()).map((row) => view(row, userId)))
    },

    async get(identity: Identity | undefined, vaultId: string): Promise<ManagedVaultView> {
      if (!(await canEnumerateManagedVaults(identity))) throw new ManagedVaultServiceError('not_found', 404)
      return view(await live(vaultId), (identity as { userId: string }).userId)
    },

    async create(identity: Identity | undefined, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(createManagedVaultInputSchema, input)
      if (!(await isEnabled())) throw new ManagedVaultServiceError('integration_disabled', 409)
      const host = requireHost()
      const existing = await store.list()
      // A replay of an existing request is answered even at capacity.
      const replay = existing.find((row) => row.createRequestId === body.requestId)
      if (!replay && existing.length >= Math.min(MANAGED_BIGBRAIN_MAX_VAULTS, host.limits.maxVaults))
        throw new ManagedVaultServiceError('capacity', 429)
      const vaultId = replay?.id ?? crypto.randomUUID()
      const row = await store.request({
        vaultId,
        requestId: body.requestId,
        displayName: body.displayName,
        ownerUserId: userId,
        ownerHandle: body.ownerHandle,
        ownerDisplay: await ownerDisplay(userId, body.ownerHandle),
        actorUserId: userId,
        recipe: {
          origin: managedVaultOrigin(vaultId, host.zone),
          limits: host.limits,
          upstreamCommit: host.upstreamCommit,
          artifactDigest: host.artifactDigest,
        },
      })
      return view(row, userId)
    },

    async rename(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(renameManagedVaultInputSchema, input)
      await live(vaultId)
      const row = await store.requestOperation(vaultId, { action: 'rename', ...body })
      return view(row, userId)
    },

    async retry(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultFenceInputSchema, input)
      await live(vaultId)
      return view(await store.retry(vaultId, body), userId)
    },

    async setReadAccess(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(managedVaultReadAccessInputSchema, input)
      const row = await live(vaultId)
      // Revoke fences Core first: no read can start once the human asked to revoke.
      if (body.action === 'revoke' && row.desiredGeneration === body.expectedGeneration)
        await fence(row, `user:${userId}`)
      const updated = await store.requestOperation(vaultId, {
        action: body.action === 'revoke' ? 'read-revoke' : 'read-reconnect',
        requestId: body.requestId,
        expectedGeneration: body.expectedGeneration,
      })
      return view(updated, userId)
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
      if (row.desiredGeneration !== body.expectedGeneration || row.desiredAction !== null)
        throw new ManagedVaultServiceError('generation_conflict', 409, row.desiredGeneration)
      if (row.state !== 'ready' && row.state !== 'degraded')
        throw new ManagedVaultServiceError('generation_conflict', 409)
      const host = requireHost()
      const window = await operations.openInviteWindow(
        body.requestId,
        vaultId,
        body.expectedGeneration,
        (deps.now ?? (() => new Date()))()
      )
      if (window.status === 'expired') throw new ManagedVaultServiceError('invite_expired', 409)
      if (window.status === 'conflict') throw new ManagedVaultServiceError('request_conflict', 409)
      const reply = await deps.hostClient.call(host, body.requestId, {
        action: 'owner-invite',
        vaultId,
        expectedGeneration: body.expectedGeneration,
        actorUserId: userId,
        issuedAt: window.issuedAt,
        expiresAt: window.expiresAt,
      })
      const invite = 'invite' in reply ? managedBigbrainOwnerInviteResultSchema.safeParse(reply.invite) : null
      if (!invite?.success || !invite.data.inviteUrl.startsWith(`${row.origin}/invite#`))
        throw new ManagedVaultServiceError('invalid_response', 502)
      // Authority may have been lost while the host call was in flight: verify again.
      await requireManagedVaultOwner(identity, await live(vaultId))
      return invite.data
    },

    async delete(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(deleteManagedVaultInputSchema, input)
      const row = await live(vaultId)
      if (body.confirmedVaultId !== row.id || body.confirmedName !== row.displayName)
        throw new ManagedVaultServiceError('confirmation_mismatch', 409)
      if (row.desiredGeneration !== body.expectedGeneration)
        throw new ManagedVaultServiceError('generation_conflict', 409, row.desiredGeneration)
      await fence(row, `user:${userId}`)
      const updated = await store.requestOperation(vaultId, {
        action: 'delete',
        requestId: body.requestId,
        expectedGeneration: body.expectedGeneration,
      })
      return view(updated, userId)
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
      body: {
        code: error.code,
        ...(error.currentGeneration === undefined ? {} : { currentGeneration: error.currentGeneration }),
      },
    }
  if (error instanceof ManagedHostError || error instanceof ManagedBigbrainPlatformError) {
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
