/**
 * Human lifecycle for managed shared BigBrain vaults: create, list, rename, retry, owner device
 * link, read-access revoke/reconnect and delete. Every operation checks literal human authority
 * BEFORE any effect. Core is the vault authority: an operation is recorded here (generation
 * fence, replay ledger, Core-side intent applied at once) and the worker reconciler executes it
 * on this host through the local root helper. Access fences (revoke, delete) disable Core's read
 * connection first.
 *
 * Vaults belong to the instance, not a person: every vault's upstream owner is `ficus`
 * (`MANAGED_BIGBRAIN_FICUS_OWNER`), and any BigBrain manager may connect a device as that owner.
 * The owner link is a synchronous host call: a secret transient result, never stored, cached or
 * logged here (only who requested it, for which vault), and returned only after the requester's
 * authority is re-checked. Member management (members.ts) is synchronous the same way.
 */
import { z } from 'zod'
import {
  MANAGED_BIGBRAIN_FICUS_OWNER,
  MANAGED_BIGBRAIN_MAX_VAULTS,
  managedBigbrainOwnerInviteResultSchema,
  type ManagedBigbrainErrorCode,
  type ManagedBigbrainInstalledHost,
  type ManagedBigbrainOwnerInviteResult,
} from '@ficus/shared/managed-bigbrain'
import { createLogger } from '../../../../lib/infra/logger'
import type { Identity } from '../../../rbac/permissions'
import type { IntegrationAuditRecorder } from '../../audit'
import { DbIntegrationAuditRecorder } from '../../db-audit'
import { isIntegrationEnabled } from '../../provider-state'
import {
  canEnumerateManagedVaults,
  managedVaultAttachableSquads,
  requireManagedVaultManager,
  ManagedVaultAuthorizationError,
} from './authorization'
import { currentManagedBigbrainHost, managedBigbrainAvailability } from './availability'
import { ManagedHostError, type ManagedHostClient } from './host-client'
import { managedVaultOrigin } from './host-identity'
import { managedVaultOperations } from './operations'
import { ManagedBigbrainPlatformError } from './platform-client'
import { managedVaultMemberMethods } from './members'
import { ManagedVaultStoreError, managedVaultStore, type ManagedVault } from './store'
import type { FixedWindowLimiter } from '../../../auth/device-auth-rate-limit'

export type ManagedVaultServiceCode =
  | ManagedBigbrainErrorCode
  | 'unavailable'
  | 'integration_disabled'
  | 'name_conflict'
  | 'confirmation_mismatch'
  /** A vault whose host owner anchor was lost (see `hostOwnerUserId`): no owner links. */
  | 'owner_unavailable'
  /** Too many member requests from one person in a short window. */
  | 'rate_limited'

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
export const createManagedVaultInputSchema = z.object({ requestId, displayName: label }).strict()
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
  /** The vault's owner identity inside BigBrain (`ficus` for vaults created by this rule). Not
   * a Ficus user: shared vaults belong to the instance. */
  ownerHandle: string
  /** Whether owner device links can be created at all (false only for a lost host anchor). */
  ownerLinksAvailable: boolean
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
  /** Ficus's own read connection for this vault (null until imported). `readAccess` is the host's
   * view of the credential; this is whether Ficus actually reads with it right now. */
  readConnection: ManagedVaultReadConnection | null
  /** Safe code of the last failed read-credential synchronization; null once it succeeds. Ficus
   * retries on its own with backoff. */
  readSyncError: string | null
  updatedAt: string
}

export interface ManagedVaultReadConnection {
  enabled: boolean
  /** Sanitized code of the last failed validation (never a provider message). */
  lastErrorCode: string | null
  /** A person turned it off (Ficus never turns it back on by itself). */
  disabledByPerson: boolean
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
  /** Live state of a vault's read connection (null when the row is gone). */
  readConnection: (connectionId: string) => Promise<ManagedVaultReadConnection | null>
  /** Squads this person may attach vaults to (`integrations:write` there), for the global card. */
  writableSquads?: (identity: Identity, userId: string) => Promise<{ id: string; name: string }[]>
  isEnabled?: () => Promise<boolean>
  available?: () => { available: boolean }
  now?: () => Date
  /** Records who requested each owner device link and member change (content-free; never a link). */
  audit?: IntegrationAuditRecorder
  /** Per-user member request budgets (default: the process-wide limiter). */
  memberLimiter?: FixedWindowLimiter
}

const log = createLogger('managed-bigbrain-vaults')

/** Fresh vault UUIDs tried when a short id collides (each collision has ~n/2^48 odds). */
const MAX_SHORT_ID_ATTEMPTS = 8

export function createManagedVaultService(deps: ManagedVaultServiceDeps) {
  const store = deps.store ?? managedVaultStore
  const operations = deps.operations ?? managedVaultOperations
  const isEnabled = deps.isEnabled ?? (() => isIntegrationEnabled('bigbrain'))
  const available = deps.available ?? (() => managedBigbrainAvailability())
  const currentHost = deps.host ?? (() => currentManagedBigbrainHost())
  const audit = deps.audit ?? new DbIntegrationAuditRecorder()

  async function view(row: ManagedVault): Promise<ManagedVaultView> {
    return {
      vaultId: row.id,
      displayName: row.displayName,
      ownerHandle: row.ownerHandle,
      ownerLinksAvailable: row.hostOwnerUserId !== null,
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
      readConnection: row.connectionId ? await deps.readConnection(row.connectionId) : null,
      readSyncError: row.readSyncErrorCode,
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
  async function fence(row: ManagedVault, actor: string): Promise<void> {
    if (row.connectionId) await deps.disableConnection(row.connectionId, actor)
    await store.clearReadMaterial(row.id)
  }

  const statusOf = {
    invalid_request: 400,
    forbidden: 403,
    generation_conflict: 409,
    rate_limited: 429,
    invalid_response: 502,
  } as const
  const members = managedVaultMemberMethods({
    hostClient: deps.hostClient,
    audit,
    now: deps.now ?? (() => new Date()),
    limiter: deps.memberLimiter,
    live,
    requireHost,
    fail: (code, currentGeneration) => new ManagedVaultServiceError(code, statusOf[code], currentGeneration),
  })

  return {
    ...members,
    async list(identity: Identity | undefined): Promise<ManagedVaultView[]> {
      if (!(await canEnumerateManagedVaults(identity))) throw new ManagedVaultServiceError('forbidden', 403)
      return Promise.all((await store.list()).map((row) => view(row)))
    },

    /** Squads this person may attach vaults to from the global card. Attach and detach themselves
     * use the squad assignment routes (and their authorization), never this list. */
    async attachableSquads(identity: Identity | undefined): Promise<{ id: string; name: string }[]> {
      const userId = await requireManagedVaultManager(identity)
      return (deps.writableSquads ?? managedVaultAttachableSquads)(identity!, userId)
    },

    async get(identity: Identity | undefined, vaultId: string): Promise<ManagedVaultView> {
      if (!(await canEnumerateManagedVaults(identity))) throw new ManagedVaultServiceError('not_found', 404)
      return view(await live(vaultId))
    },

    async create(identity: Identity | undefined, input: unknown): Promise<ManagedVaultView> {
      const userId = await requireManagedVaultManager(identity)
      const body = parse(createManagedVaultInputSchema, input)
      if (!(await isEnabled())) throw new ManagedVaultServiceError('integration_disabled', 409)
      const host = requireHost()
      // A replay of an existing request is answered even at capacity; a new one is counted under
      // a lock with its insert, so concurrent creates cannot exceed the limit.
      const replay = (await store.list()).find((row) => row.createRequestId === body.requestId)
      const request = {
        maxLive: Math.min(MANAGED_BIGBRAIN_MAX_VAULTS, host.limits.maxVaults),
        requestId: body.requestId,
        displayName: body.displayName,
        // Every new vault is the instance's: its upstream owner is always `ficus`.
        hostOwnerUserId: MANAGED_BIGBRAIN_FICUS_OWNER.userId,
        ownerHandle: MANAGED_BIGBRAIN_FICUS_OWNER.handle,
        ownerDisplay: MANAGED_BIGBRAIN_FICUS_OWNER.display,
        actorUserId: userId,
      }
      // The origin is chosen once here and persisted. A new UUID whose 12-hex short id is taken
      // by another vault of this tenant is discarded before anything is created.
      let row: ManagedVault | undefined
      for (let attempt = 0; !row; attempt++) {
        const vaultId = (attempt === 0 ? replay?.id : undefined) ?? crypto.randomUUID()
        try {
          row = await store.request({
            ...request,
            vaultId,
            recipe: {
              origin: managedVaultOrigin(vaultId, host),
              limits: host.limits,
              upstreamCommit: host.upstreamCommit,
              artifactDigest: host.artifactDigest,
            },
          })
        } catch (error) {
          if (!(error instanceof ManagedVaultStoreError && error.code === 'short_id_conflict')) throw error
          if (attempt >= MAX_SHORT_ID_ATTEMPTS - 1) throw new ManagedVaultServiceError('request_conflict', 409)
        }
      }
      return view(row)
    },

    async rename(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      await requireManagedVaultManager(identity)
      const body = parse(renameManagedVaultInputSchema, input)
      await live(vaultId)
      const row = await store.requestOperation(vaultId, { action: 'rename', ...body })
      return view(row)
    },

    async retry(identity: Identity | undefined, vaultId: string, input: unknown): Promise<ManagedVaultView> {
      await requireManagedVaultManager(identity)
      const body = parse(managedVaultFenceInputSchema, input)
      await live(vaultId)
      return view(await store.retry(vaultId, body))
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
      return view(updated)
    },

    /** Returns the SECRET owner device link once; callers must send it with no-store headers. */
    async ownerInvite(
      identity: Identity | undefined,
      vaultId: string,
      input: unknown
    ): Promise<ManagedBigbrainOwnerInviteResult> {
      const userId = await requireManagedVaultManager(identity)
      const row = await live(vaultId)
      const body = parse(managedVaultFenceInputSchema, input)
      // The host only issues a link for the anchor it recorded at create; a row that lost it
      // (its creator was deleted while this was a user reference) can never get one.
      const anchor = row.hostOwnerUserId
      if (anchor === null) throw new ManagedVaultServiceError('owner_unavailable', 409)
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
        // Core has authorized the requester; the host matches the vault's recorded owner anchor.
        actorUserId: anchor,
        issuedAt: window.issuedAt,
        expiresAt: window.expiresAt,
      })
      const invite = 'invite' in reply ? managedBigbrainOwnerInviteResultSchema.safeParse(reply.invite) : null
      if (!invite?.success || !invite.data.inviteUrl.startsWith(`${row.origin}/invite#`))
        throw new ManagedVaultServiceError('invalid_response', 502)
      // Authority may have been lost while the host call was in flight: verify again.
      await requireManagedVaultManager(identity)
      await live(vaultId)
      // Every BigBrain manager can connect as the vault's owner, so record who asked (never the
      // link). Fails closed: a link is only returned once its requester is on record.
      await audit.record({
        userId,
        actorKey: `user:${userId}`,
        targetKind: 'managed_bigbrain_vault',
        targetId: vaultId,
        connectionId: row.connectionId ?? undefined,
        action: 'managed_vault_owner_invite',
        outcome: 'succeeded',
        requestId: body.requestId,
        at: (deps.now ?? (() => new Date()))(),
      })
      log.info('Managed BigBrain owner device link issued', { vaultId, userId, requestId: body.requestId })
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
      return view(updated)
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
      status:
        error.code === 'not_found'
          ? 404
          : error.code === 'invalid_request'
            ? 400
            : error.code === 'capacity'
              ? 429
              : 409,
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
