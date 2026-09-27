import { createHash, randomBytes } from 'crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  db,
  instanceMaintenanceAudit,
  instanceMaintenanceState,
  systemTokens,
  withDedicatedDbTransaction,
} from '../../db'
import { getSecretStore } from '../secrets'
import { createLogger } from '../../lib/infra/logger'
import type { Identity } from '../rbac'
import {
  type LegacyUpgradePolicy,
  type PlatformMaintenanceCompatibilityDecision,
} from './platform-maintenance-compatibility'

const log = createLogger('system-tokens')

/** Every system token carries this prefix; resolveSystemToken rejects anything else before any lookup. */
export const SYSTEM_TOKEN_PREFIX = 'ficus_sys_'
// The auto-provisioned webhook token's raw value, kept encrypted in the secret store so the webhook
// processors can present it. The `__` prefix marks it internal (hidden from the secrets UI list).
const WEBHOOK_TOKEN_SECRET_KEY = '__SYSTEM_WEBHOOK_TOKEN'
const WEBHOOK_TOKEN_NAME = 'Webhook automation'
// Serializes webhook-token replacement across calls and processes (hashed with
// hashtextextended(key, 0), like the other string-keyed advisory locks).
const WEBHOOK_TOKEN_LOCK_KEY = 'system-tokens:webhook-automation-replace'

/** Scopes the bundled webhook scripts need (inbox send-system, squad/agent get/list, workstream CRUD). */
export const DEFAULT_WEBHOOK_SCOPES = [
  'inbox:system',
  'squads:read',
  'agents:read',
  'workstreams:read',
  'workstreams:create',
  'workstreams:update',
]

/**
 * Auth env for spawned webhook scripts: the long-lived webhook system token as FICUS_TOKEN (the CLI
 * prefers it), falling back to the legacy FICUS_PASSWORD during bootstrap (before any admin user exists,
 * where the secret store can't persist a token).
 */
export async function webhookScriptAuthEnv(): Promise<Record<string, string>> {
  const token = await ensureWebhookToken()
  return {
    // Scripts execute beside Core, so use its listener, not a CLI login or a
    // public reverse-proxy base path. Explicit context also bypasses Bun's
    // dotenv heuristic when the injected URL happens to match the .env file.
    FICUS_WEBHOOK_CONTEXT: '1',
    FICUS_API_URL: `http://127.0.0.1:${process.env.PORT || '3000'}`,
    FICUS_TOKEN: token ?? '',
    FICUS_PASSWORD: token ? '' : (getSecretStore().get('FICUS_PASSWORD') ?? ''),
  }
}

export interface SystemTokenRecord {
  id: string
  name: string
  scopes: string[]
  kind: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

type Row = typeof systemTokens.$inferSelect

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toJson(row: Row): SystemTokenRecord {
  return {
    id: row.id,
    name: row.name,
    scopes: (row.scopes as string[]) ?? [],
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  }
}

function scopesMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((scope) => set.has(scope))
}

/** Create a system token. Returns the raw token (shown once) and the stored record. */
export async function createSystemToken(input: {
  name: string
  scopes: string[]
  kind?: 'manual' | 'webhook'
}): Promise<{ token: string; record: SystemTokenRecord }> {
  const token = `${SYSTEM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const [row] = await db
    .insert(systemTokens)
    .values({ name: input.name, tokenHash: hashToken(token), scopes: input.scopes, kind: input.kind ?? 'manual' })
    .returning()
  return { token, record: toJson(row) }
}

export async function listSystemTokens(opts: { includeWebhook?: boolean } = {}): Promise<SystemTokenRecord[]> {
  const rows = await db.select().from(systemTokens).orderBy(desc(systemTokens.createdAt))
  const visible = opts.includeWebhook ? rows : rows.filter((r) => r.kind !== 'webhook')
  return visible.map(toJson)
}

export type PlatformMaintenanceUpgradeResult =
  | { ok: true; scopes: string[]; outcome: 'upgraded' | 'already_explicit' }
  | { ok: false; status: 400 | 403 | 410 | 426; reasonCode: string }

type AuditInsert = typeof instanceMaintenanceAudit.$inferInsert
type UpgradeDependencies = {
  writeAudit?: (values: AuditInsert) => Promise<void>
}

function deniedStatus(reasonCode: string): 400 | 403 | 410 | 426 {
  if (reasonCode === 'invalid_context') return 400
  if (reasonCode === 'compatibility_disabled') return 410
  if (reasonCode === 'compatibility_floor') return 426
  return 403
}

/** Atomically inspect/elevate a legacy platform token and audit every reached decision. */
export async function upgradePlatformMaintenanceToken(
  input: {
    identity: Identity
    actor: string
    principalClass: Identity['type']
    policy: LegacyUpgradePolicy
    compatibility: PlatformMaintenanceCompatibilityDecision
  },
  dependencies: UpgradeDependencies = {}
): Promise<PlatformMaintenanceUpgradeResult> {
  return db.transaction(async (tx) => {
    await tx.insert(instanceMaintenanceState).values({ id: 'global' }).onConflictDoNothing()
    let observation: { state: typeof instanceMaintenanceState.$inferSelect; databaseNow: Date | string } | undefined
    const observeMaintenance = async () => {
      if (observation) return observation
      const [observed] = await tx
        .select({ state: instanceMaintenanceState, databaseNow: sql<Date>`clock_timestamp()` })
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      if (!observed) throw new Error('Instance maintenance singleton is not initialized')
      observation = observed
      return observed
    }

    const audit = async (outcome: 'upgraded' | 'already_explicit' | 'denied', reasonCode: string) => {
      const observed = await observeMaintenance()
      const databaseNow = new Date(observed.databaseNow)
      const context =
        input.compatibility.context ??
        ({ protocolVersion: null, callerVersion: null, instanceId: null, correlationId: null } as const)
      const activeLease =
        observed.state.platformLeaseExpiresAt !== null && observed.state.platformLeaseExpiresAt > databaseNow
      const values: AuditInsert = {
        generation: observed.state.generation,
        action: 'platform_token_upgrade_attempt',
        actor: input.actor,
        leaseId: activeLease ? observed.state.platformLeaseId : null,
        leaseExpiresAt: activeLease ? observed.state.platformLeaseExpiresAt : null,
        adminHold: observed.state.adminHold,
        effective: observed.state.adminHold || activeLease,
        metadata: {
          principalClass: input.principalClass,
          endpoint: '/api/system-tokens/self/platform-maintenance-upgrade',
          ...context,
          policy: input.policy,
          outcome,
          reasonCode,
        },
        createdAt: databaseNow,
      }
      if (dependencies.writeAudit) await dependencies.writeAudit(values)
      else await tx.insert(instanceMaintenanceAudit).values(values)
    }

    if (!input.compatibility.allowed) {
      await audit('denied', input.compatibility.reasonCode)
      return {
        ok: false,
        status: deniedStatus(input.compatibility.reasonCode),
        reasonCode: input.compatibility.reasonCode,
      }
    }
    if (input.identity.type !== 'system') {
      await audit('denied', 'wrong_principal')
      return { ok: false, status: 403, reasonCode: 'wrong_principal' }
    }

    await tx.execute(sql`SELECT id FROM system_tokens WHERE id = ${input.identity.systemTokenId} FOR UPDATE`)
    const [row] = await tx
      .select()
      .from(systemTokens)
      .where(and(eq(systemTokens.id, input.identity.systemTokenId), isNull(systemTokens.revokedAt)))
      .limit(1)
    if (!row || row.name !== 'platform-orchestrator') {
      await audit('denied', 'wrong_name')
      return { ok: false, status: 403, reasonCode: 'wrong_name' }
    }
    const scopes = (row.scopes as string[]) ?? []
    if (!scopes.includes('machines:read') || !scopes.includes('machines:write')) {
      await audit('denied', 'missing_machine_scope')
      return { ok: false, status: 403, reasonCode: 'missing_machine_scope' }
    }
    const alreadyExplicit = scopes.includes('system:pause')
    const upgraded = alreadyExplicit ? scopes : [...scopes, 'system:pause']
    if (!alreadyExplicit) {
      await tx.update(systemTokens).set({ scopes: upgraded }).where(eq(systemTokens.id, row.id))
    }
    const outcome = alreadyExplicit ? 'already_explicit' : 'upgraded'
    await audit(outcome, 'eligible')
    if (input.policy === 'observe' && input.compatibility.legacyUnknown) {
      log.warn('Legacy platform maintenance compatibility request', {
        tokenId: row.id,
        callerVersion: null,
        instanceId: null,
        correlationId: null,
        outcome,
      })
    }
    return { ok: true, scopes: upgraded, outcome }
  })
}

export async function revokeSystemToken(id: string): Promise<boolean> {
  const [row] = await db
    .update(systemTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(systemTokens.id, id), isNull(systemTokens.revokedAt)))
    .returning()
  return !!row
}

/** Resolve a raw token to its stable identity and scopes (or null if unknown/revoked). Touches lastUsedAt. */
export async function resolveSystemToken(
  token: string
): Promise<{ id: string; name: string; scopes: string[] } | null> {
  if (!token.startsWith(SYSTEM_TOKEN_PREFIX)) return null
  const [row] = await db
    .select()
    .from(systemTokens)
    .where(and(eq(systemTokens.tokenHash, hashToken(token)), isNull(systemTokens.revokedAt)))
    .limit(1)
  if (!row) return null
  void db.update(systemTokens).set({ lastUsedAt: new Date() }).where(eq(systemTokens.id, row.id))
  return { id: row.id, name: row.name, scopes: (row.scopes as string[]) ?? [] }
}

/**
 * Ensure the long-lived webhook automation token exists and return its raw value. Self-heals: if the
 * stored secret is missing/stale/revoked, a fresh token is minted and persisted. Returns null if the
 * secret store can't persist it (e.g. no FICUS_ENCRYPTION_KEY) — callers fall back to legacy auth.
 *
 * A stored value without the current prefix (minted before a prefix change) can never authenticate,
 * so it is replaced by a fresh token and its row is revoked. The function takes no input: only
 * verified webhook handlers reach it, and it never returns the token to an HTTP caller.
 */
export async function ensureWebhookToken(): Promise<string | null> {
  const store = getSecretStore()
  const existing = store.get(WEBHOOK_TOKEN_SECRET_KEY)
  if (existing?.startsWith(SYSTEM_TOKEN_PREFIX)) {
    const [row] = await db
      .select()
      .from(systemTokens)
      .where(and(eq(systemTokens.tokenHash, hashToken(existing)), isNull(systemTokens.revokedAt)))
      .limit(1)

    if (row) {
      const scopes = (row.scopes as string[]) ?? []
      if (!scopesMatch(scopes, DEFAULT_WEBHOOK_SCOPES)) {
        await db
          .update(systemTokens)
          .set({ scopes: DEFAULT_WEBHOOK_SCOPES, lastUsedAt: new Date() })
          .where(eq(systemTokens.id, row.id))
        log.info('Updated webhook automation system token scopes')
      } else {
        void db.update(systemTokens).set({ lastUsedAt: new Date() }).where(eq(systemTokens.id, row.id))
      }
      return existing
    }
  }

  return replaceWebhookToken()
}

/**
 * Replace the stored webhook token under an advisory lock, so a burst of concurrent webhook runs
 * (in one process or several) mints exactly one token. Inside the lock the stored value is re-read
 * from the database: if another caller already replaced it, that token is returned unchanged.
 * Otherwise a fresh token is minted, the stale value's row is revoked, and the secret is written,
 * all before the lock is released. The lock runs on a dedicated connection so waiters never hold
 * pool slots the lock holder needs.
 */
async function replaceWebhookToken(): Promise<string | null> {
  const store = getSecretStore()
  try {
    return await withDedicatedDbTransaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${WEBHOOK_TOKEN_LOCK_KEY}, 0))`)
      await store.refreshKey(WEBHOOK_TOKEN_SECRET_KEY)
      const current = store.get(WEBHOOK_TOKEN_SECRET_KEY)
      if (current?.startsWith(SYSTEM_TOKEN_PREFIX)) {
        const [live] = await tx
          .select({ id: systemTokens.id })
          .from(systemTokens)
          .where(and(eq(systemTokens.tokenHash, hashToken(current)), isNull(systemTokens.revokedAt)))
          .limit(1)
        if (live) return current
      }

      const token = `${SYSTEM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      await tx.insert(systemTokens).values({
        name: WEBHOOK_TOKEN_NAME,
        tokenHash: hashToken(token),
        scopes: DEFAULT_WEBHOOK_SCOPES,
        kind: 'webhook',
      })
      if (current) {
        await tx
          .update(systemTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(systemTokens.tokenHash, hashToken(current)), isNull(systemTokens.revokedAt)))
      }
      // Written last: if it throws, the transaction rolls back and nothing is minted or revoked.
      // The secret store writes on the main pool, not this transaction, so the new value can
      // be visible just before this commit, and a failed commit after it leaves the store
      // naming a token with no row. Both self-heal: the next call finds no live row and mints.
      await store.set(WEBHOOK_TOKEN_SECRET_KEY, token, 'system')
      log.info(
        current && !current.startsWith(SYSTEM_TOKEN_PREFIX)
          ? 'Replaced a webhook automation system token that lacked the current prefix'
          : 'Provisioned webhook automation system token'
      )
      return token
    })
  } catch (err) {
    log.warn('Could not provision webhook system token (secret store unavailable):', err)
    return null
  }
}
