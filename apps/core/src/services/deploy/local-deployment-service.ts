import { timingSafeEqual } from 'crypto'
import { and, desc, eq, gt, gte, inArray, isNull, lt, ne } from 'drizzle-orm'
import type { CreateLocalDeploymentInput, LocalDeployment, LocalDeploymentStatus } from '@ficus/shared'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { db, localDeploymentAliasReleases, localDeployments } from '../../db'
import { getPostgresError } from '../../db/errors'
import { AmbiguousPrefixError, uuidPrefixCondition } from '../../db/prefix-match'
import { Squad } from '../../entities/Squad'
import { normalizeLocalDeploymentInput } from './local-deployment-validation'
import { resolveLocalDeploymentPort } from './local-deployment-ports'
import { resolveLocalDeploymentPortScope } from './local-deployment-port-scope'
import { createLogger } from '../../lib/infra/logger'
import {
  LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS,
  LocalDeploymentAliasError,
  isWellFormedLocalDeploymentAlias,
  normalizeLocalDeploymentAlias,
} from './local-deployment-alias'
import { resolvePublicAppUrl } from '../../lib/public-app-url'

type LocalDeploymentRow = typeof localDeployments.$inferSelect
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const ALIAS_UNIQUE_INDEX = 'local_deployments_alias_uniq'

const ACTIVE_LOCAL_APP_STATUSES: LocalDeploymentRow['status'][] = ['starting', 'running', 'restarting']
const log = createLogger('local-deployment')
const warnedHostedConfigErrors = new Set<string>()

class HostedAppsConfigError extends Error {}

function generateLocalDeploymentBrowserToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

function buildLocalDeploymentProxyPath(id: string): string {
  return `/api/app/${id}/`
}

const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TENANT_LABEL_MIN_LENGTH = 3
const TENANT_APP_LABEL_MAX_LENGTH = 49

/** Returns the validated app-host apex, or null when hosted app URLs are disabled. */
export function getHostedAppsDomain(): string | null {
  const rawAppsDomain = process.env.FICUS_APPS_DOMAIN
  if (rawAppsDomain === undefined || rawAppsDomain === '') return null
  const appsDomain = rawAppsDomain.trim()
  if (!appsDomain || appsDomain !== rawAppsDomain || !DNS_NAME_PATTERN.test(appsDomain)) {
    throw new HostedAppsConfigError('FICUS_APPS_DOMAIN must be a lowercase DNS name without a scheme, port, or path')
  }
  return appsDomain
}

function getHostedTenantLabel(): string {
  const appUrl = resolvePublicAppUrl()
  if (!appUrl) throw new HostedAppsConfigError('APP_URL is required when FICUS_APPS_DOMAIN is configured')

  let hostname: string
  try {
    const parsed = new URL(appUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
    hostname = parsed.hostname
  } catch {
    throw new HostedAppsConfigError('APP_URL must be a valid HTTP(S) URL when FICUS_APPS_DOMAIN is configured')
  }

  const labels = hostname.split('.')
  const tenantLabel = labels[0]
  if (labels.length < 2 || !tenantLabel || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenantLabel)) {
    throw new HostedAppsConfigError('APP_URL must contain a valid tenant label')
  }
  if (tenantLabel.length < TENANT_LABEL_MIN_LENGTH) {
    throw new HostedAppsConfigError(`APP_URL tenant label must be at least ${TENANT_LABEL_MIN_LENGTH} characters`)
  }
  if (tenantLabel.length > TENANT_APP_LABEL_MAX_LENGTH) {
    throw new HostedAppsConfigError(`APP_URL tenant label must be at most ${TENANT_APP_LABEL_MAX_LENGTH} characters`)
  }
  return tenantLabel
}

function validateHostedAppsConfig(): void {
  if (getHostedAppsDomain()) getHostedTenantLabel()
}

/**
 * The app's own public host on a hosted instance, `<tenant>--<first 12 hex of
 * the id>.<apps domain>` (lowercase, no port), or null when hosted app URLs are
 * off or misconfigured (the app is then reachable only on the path mount).
 */
export function getLocalDeploymentPublicHost(localDeploymentId: string): string | null {
  return hostedAppHost(localDeploymentId.replaceAll('-', '').slice(0, 12).toLowerCase())
}

/**
 * The app's alias host, `<tenant>--<alias>.<apps domain>`, or null when it has
 * no alias or hosted app URLs are off or misconfigured. The hosted Platform
 * bridge routes it to Core as `/api/app/~<alias>/` (docs/wiki/integration-contracts.md).
 */
export function getLocalDeploymentAliasHost(alias: string | null | undefined): string | null {
  if (!alias || !isWellFormedLocalDeploymentAlias(alias)) return null
  return hostedAppHost(alias)
}

/** The host the app is linked by: its alias host when it has one, else its id host. */
export function getLocalDeploymentPreferredHost(row: { id: string; alias?: string | null }): string | null {
  return getLocalDeploymentAliasHost(row.alias) ?? getLocalDeploymentPublicHost(row.id)
}

function hostedAppHost(appLabel: string): string | null {
  try {
    const appsDomain = getHostedAppsDomain()
    if (!appsDomain) return null
    return `${getHostedTenantLabel()}--${appLabel}.${appsDomain}`
  } catch (error) {
    if (!(error instanceof HostedAppsConfigError)) throw error
    if (!warnedHostedConfigErrors.has(error.message)) {
      warnedHostedConfigErrors.add(error.message)
      log.warn('Hosted app URL config is invalid; using path fallback for existing deployments', error.message)
    }
    return null
  }
}

function buildBrowserLocalDeploymentUrl(row: Pick<LocalDeploymentRow, 'id' | 'alias' | 'browserAccessToken'>): string {
  const publicHost = getLocalDeploymentPreferredHost(row)
  const base = publicHost ? `https://${publicHost}/` : buildLocalDeploymentProxyPath(row.id)
  if (!row.browserAccessToken) return base
  return `${base}?_ficus_token=${encodeURIComponent(row.browserAccessToken)}`
}

export function toLocalDeployment(row: LocalDeploymentRow): LocalDeployment {
  return {
    id: row.id,
    squadId: row.squadId,
    sandboxId: row.sandboxId,
    name: row.name,
    alias: row.alias ?? null,
    port: row.port,
    targetHost: row.targetHost,
    urlPathOrHost: buildBrowserLocalDeploymentUrl(row),
    visibility: row.visibility,
    mode: row.mode,
    status: row.status,
    keepSandboxAlive: row.keepSandboxAlive,
    command: row.command,
    cwd: row.cwd,
    logPath: row.logPath,
    envSecretRefs: row.envSecretRefs,
    processId: row.processId,
    restartPolicy: row.restartPolicy,
    restartCount: row.restartCount,
    createdByAgentId: row.createdByAgentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}

export async function createLocalDeployment(squad: Squad, input: CreateLocalDeploymentInput): Promise<LocalDeployment> {
  // Validate deployment-wide URL config before reserving a port or inserting a
  // live row. A bad operator value must not leave an unreachable orphan behind.
  validateHostedAppsConfig()
  const normalized = normalizeLocalDeploymentInput(input, { squadId: squad.id })
  // Before the port, like the config: a refused alias must leave nothing behind.
  const alias =
    input.alias === undefined || input.alias === null ? null : normalizeRequestedLocalDeploymentAlias(input.alias)
  // Absent port => Ficus assigns one (the default, and the only way to guarantee
  // it is free); explicit port => rejected if another live deployment in the
  // same network scope holds it.
  const sandboxId = Squad.getSandboxId(squad.id)
  const portScope = await resolveLocalDeploymentPortScope(sandboxId)
  const port = await resolveLocalDeploymentPort(portScope, normalized.port)
  const localDeploymentId = crypto.randomUUID()
  const browserAccessToken = generateLocalDeploymentBrowserToken()
  const row = await withAliasConflicts(() =>
    db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(localDeployments)
        .values({
          id: localDeploymentId,
          squadId: squad.id,
          sandboxId,
          portScope,
          name: normalized.name,
          alias,
          port,
          targetHost: '127.0.0.1',
          browserAccessToken,
          visibility: normalized.visibility,
          mode: normalized.mode,
          status: 'starting',
          keepSandboxAlive: true,
          command: normalized.command ?? null,
          cwd: normalized.cwd ?? null,
          logPath: normalized.logPath ?? null,
          envSecretRefs: normalized.envSecretRefs ?? null,
          restartPolicy: normalized.restartPolicy,
        })
        .returning()
      if (alias) await claimReleasedAlias(tx, alias, localDeploymentId)
      return inserted
    })
  )

  return toLocalDeployment(row)
}

/** A requested alias in stored form, or the reason it cannot be used on this instance. */
export function normalizeRequestedLocalDeploymentAlias(raw: unknown): string {
  let tenantLabel: string | null = null
  try {
    if (getHostedAppsDomain()) tenantLabel = getHostedTenantLabel()
  } catch (error) {
    if (!(error instanceof HostedAppsConfigError)) throw error
  }
  if (!tenantLabel) {
    throw new LocalDeploymentAliasError(
      'App aliases need per-app hosts, which this instance does not have (FICUS_APPS_DOMAIN is not set, or it or APP_URL is invalid); the app is served at its /api/app/<id>/ path',
      'unavailable'
    )
  }
  return normalizeLocalDeploymentAlias(raw, tenantLabel)
}

/** Turn the alias unique index firing into the caller-facing conflict. */
async function withAliasConflicts<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const postgres = getPostgresError(error)
    if (postgres?.code === '23505' && postgres.constraint === ALIAS_UNIQUE_INDEX) {
      throw new LocalDeploymentAliasError('That alias is already used by another app', 'conflict')
    }
    throw error
  }
}

/**
 * Within the transaction that just wrote `alias` to this app: refuse it while
 * another app freed it less than the cooldown ago, else forget the release.
 *
 * Called AFTER the write, not before. A concurrent release of the same alias
 * holds its row's index entry until it commits, so the write waits for it;
 * this read then runs in a fresh READ COMMITTED snapshot and sees the release.
 * Read first, and a claim racing a release would miss it.
 */
async function claimReleasedAlias(tx: DatabaseTransaction, alias: string, localDeploymentId: string): Promise<void> {
  const cutoff = new Date(Date.now() - LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS)
  const [release] = await tx
    .select()
    .from(localDeploymentAliasReleases)
    .where(and(eq(localDeploymentAliasReleases.alias, alias), gt(localDeploymentAliasReleases.releasedAt, cutoff)))
    .limit(1)
  if (release && release.localDeploymentId !== localDeploymentId) {
    const availableAt = new Date(release.releasedAt.getTime() + LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS)
    throw new LocalDeploymentAliasError(
      `That alias was released by another app recently; it can be claimed after ${availableAt.toISOString()}`,
      'conflict'
    )
  }
  await tx.delete(localDeploymentAliasReleases).where(eq(localDeploymentAliasReleases.alias, alias))
}

/** Start the cooldown on an alias this app just gave up. */
async function recordAliasRelease(tx: DatabaseTransaction, alias: string, localDeploymentId: string): Promise<void> {
  const releasedAt = new Date()
  await tx
    .insert(localDeploymentAliasReleases)
    .values({ alias, localDeploymentId, releasedAt })
    .onConflictDoUpdate({ target: localDeploymentAliasReleases.alias, set: { localDeploymentId, releasedAt } })
}

/**
 * Set (a string) or clear (null) a live app's alias. Setting needs per-app
 * hosts (FICUS_APPS_DOMAIN); clearing always works. The old alias, if any,
 * enters the cooldown. Throws {@link LocalDeploymentAliasError} for a refused
 * alias, and `Sandbox localDeployment not found` for a missing or archived app.
 */
export async function setLocalDeploymentAlias(id: string, rawAlias: string | null): Promise<LocalDeployment> {
  const alias = rawAlias === null ? null : normalizeRequestedLocalDeploymentAlias(rawAlias)
  const result = await withAliasConflicts(() =>
    db.transaction(async (tx) => {
      // Lock the row: two concurrent changes to one app must not both read the
      // same old alias (one of them would then never record its release).
      const [current] = await tx
        .select()
        .from(localDeployments)
        .where(and(eq(localDeployments.id, id), isNull(localDeployments.archivedAt)))
        .for('update')
        .limit(1)
      if (!current) throw new Error('Sandbox localDeployment not found')
      if (current.alias === alias) return { row: current, changed: false }
      const [row] = await tx
        .update(localDeployments)
        .set({ alias, updatedAt: new Date() })
        .where(eq(localDeployments.id, id))
        .returning()
      if (alias) await claimReleasedAlias(tx, alias, id)
      if (current.alias) await recordAliasRelease(tx, current.alias, id)
      return { row: row!, changed: true }
    })
  )
  const localDeployment = toLocalDeployment(result.row)
  if (result.changed) emitLocalDeploymentUpdated(localDeployment)
  return localDeployment
}

/**
 * The live app holding `alias`, or null. Only for a request that arrived on
 * that alias's own host (local-deployment-auth.ts checks the host first).
 */
export async function getLocalDeploymentByAlias(alias: string): Promise<LocalDeployment | null> {
  if (!isWellFormedLocalDeploymentAlias(alias)) return null
  const [row] = await db
    .select()
    .from(localDeployments)
    .where(and(eq(localDeployments.alias, alias), isNull(localDeployments.archivedAt)))
    .limit(1)
  return row ? toLocalDeployment(row) : null
}

export async function listLocalDeployments(
  squadId: string,
  options: { includeArchived?: boolean } = {}
): Promise<LocalDeployment[]> {
  const conditions = [eq(localDeployments.squadId, squadId)]
  if (!options.includeArchived) conditions.push(isNull(localDeployments.archivedAt))

  const rows = await db
    .select()
    .from(localDeployments)
    .where(and(...conditions))
    .orderBy(desc(localDeployments.createdAt))
  return rows.map(toLocalDeployment)
}

export async function getLocalDeployment(id: string): Promise<LocalDeployment | null> {
  const rows = await db.select().from(localDeployments).where(uuidPrefixCondition(localDeployments.id, id)).limit(2)
  if (rows.length === 0) return null
  if (rows.length > 1) throw new AmbiguousPrefixError('local deployment', id)
  return toLocalDeployment(rows[0])
}

export async function isValidLocalDeploymentBrowserToken(
  id: string,
  token: string | null | undefined
): Promise<boolean> {
  if (!token) return false
  const [row] = await db
    .select({ browserAccessToken: localDeployments.browserAccessToken })
    .from(localDeployments)
    .where(eq(localDeployments.id, id))
    .limit(1)
  if (!row?.browserAccessToken) return false
  // Constant-time compare to avoid leaking the secret token byte-by-byte.
  const expected = Buffer.from(row.browserAccessToken)
  const received = Buffer.from(token)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

/**
 * Whether `token` is any deployment's browser access token. The local-app proxy
 * asks so it never hands one app another app's credential.
 */
export async function isAnyLocalDeploymentBrowserToken(token: string): Promise<boolean> {
  if (!token) return false
  const [row] = await db
    .select({ id: localDeployments.id })
    .from(localDeployments)
    .where(eq(localDeployments.browserAccessToken, token))
    .limit(1)
  return !!row
}

function emitLocalDeploymentUpdated(localDeployment: LocalDeployment): void {
  eventEmitter.emit('sandboxLocalDeployment.updated', {
    localDeploymentId: localDeployment.id,
    squadId: localDeployment.squadId,
    status: localDeployment.status,
  })
}

export async function archiveLocalDeploymentRecord(id: string): Promise<LocalDeployment> {
  const now = new Date()
  // An archived app gives up its alias (into the cooldown), so its host stops
  // resolving and the name can later serve another app.
  const row = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ alias: localDeployments.alias })
      .from(localDeployments)
      .where(eq(localDeployments.id, id))
      .for('update')
      .limit(1)
    const [archived] = await tx
      .update(localDeployments)
      .set({
        status: 'stopped',
        keepSandboxAlive: false,
        processId: null,
        alias: null,
        archivedAt: now,
        updatedAt: now,
      })
      .where(eq(localDeployments.id, id))
      .returning()
    if (current?.alias) await recordAliasRelease(tx, current.alias, id)
    return archived
  })

  if (!row) {
    throw new Error('Sandbox localDeployment not found')
  }

  const localDeployment = toLocalDeployment(row)
  emitLocalDeploymentUpdated(localDeployment)
  return localDeployment
}

export async function stopLocalDeploymentRecord(id: string): Promise<LocalDeployment> {
  const [row] = await db
    .update(localDeployments)
    .set({ status: 'stopped', keepSandboxAlive: false, updatedAt: new Date() })
    .where(eq(localDeployments.id, id))
    .returning()

  if (!row) {
    throw new Error('Sandbox localDeployment not found')
  }

  const localDeployment = toLocalDeployment(row)
  emitLocalDeploymentUpdated(localDeployment)
  return localDeployment
}

export async function hasActiveLocalDeployments(sandboxId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: localDeployments.id })
    .from(localDeployments)
    .where(
      and(
        eq(localDeployments.sandboxId, sandboxId),
        isNull(localDeployments.archivedAt),
        eq(localDeployments.keepSandboxAlive, true),
        inArray(localDeployments.status, ACTIVE_LOCAL_APP_STATUSES)
      )
    )
    .limit(1)

  return Boolean(row)
}

export async function markLocalDeploymentsStoppedForSandbox(sandboxId: string): Promise<void> {
  const now = new Date()
  const stoppedRows = await db
    .update(localDeployments)
    .set({ status: 'stopped', keepSandboxAlive: false, processId: null, updatedAt: now })
    .where(
      and(
        eq(localDeployments.sandboxId, sandboxId),
        isNull(localDeployments.archivedAt),
        ne(localDeployments.mode, 'managed')
      )
    )
    .returning()
  // Announced like every other stop: it is also what closes the app's open WebSockets.
  for (const row of stoppedRows) emitLocalDeploymentUpdated(toLocalDeployment(row))

  const managedRows = await db
    .update(localDeployments)
    .set({ status: 'crashed', keepSandboxAlive: false, processId: null, updatedAt: now })
    .where(
      and(
        eq(localDeployments.sandboxId, sandboxId),
        isNull(localDeployments.archivedAt),
        eq(localDeployments.mode, 'managed'),
        eq(localDeployments.restartPolicy, 'always'),
        ne(localDeployments.status, 'stopped')
      )
    )
    .returning()

  for (const row of managedRows) emitLocalDeploymentUpdated(toLocalDeployment(row))
}

export interface UpdateLocalDeploymentRecordInput {
  status?: LocalDeploymentStatus
  keepSandboxAlive?: boolean
  processId?: string | null
  restartCount?: number
}

export async function updateLocalDeploymentRecord(
  id: string,
  input: UpdateLocalDeploymentRecordInput,
  guard: {
    expectedRecord?: Pick<LocalDeployment, 'updatedAt' | 'status' | 'processId' | 'restartCount'>
    onlyLive?: boolean
  } = {}
): Promise<LocalDeployment> {
  const conditions = [eq(localDeployments.id, id)]
  if (guard.expectedRecord) {
    const expected = guard.expectedRecord
    // Null or omitted identity means no session, never a wildcard. Normalize
    // before building SQL so an optional processId cannot reach eq as undefined.
    const expectedProcessId = expected.processId ?? null
    const timestamp = new Date(expected.updatedAt)
    // PostgreSQL defaults retain microseconds, while the API Date retains only
    // milliseconds. Match that millisecond plus lifecycle fields, rather than
    // an exact timestamp that can never match a newly inserted row.
    conditions.push(
      gte(localDeployments.updatedAt, timestamp),
      lt(localDeployments.updatedAt, new Date(timestamp.getTime() + 1)),
      eq(localDeployments.status, expected.status),
      expectedProcessId === null
        ? isNull(localDeployments.processId)
        : eq(localDeployments.processId, expectedProcessId),
      eq(localDeployments.restartCount, expected.restartCount)
    )
  }
  if (guard.onlyLive) conditions.push(ne(localDeployments.status, 'stopped'), isNull(localDeployments.archivedAt))
  const [row] = await db
    .update(localDeployments)
    .set({ ...input, updatedAt: new Date() })
    .where(and(...conditions))
    .returning()

  if (!row) {
    const current = await getLocalDeployment(id)
    if (current) return current // A newer write won; do not emit a stale event.
    throw new Error('Sandbox localDeployment not found')
  }

  const localDeployment = toLocalDeployment(row)
  emitLocalDeploymentUpdated(localDeployment)
  return localDeployment
}

export async function listLiveLocalDeployments(): Promise<LocalDeployment[]> {
  const rows = await db
    .select()
    .from(localDeployments)
    .where(and(ne(localDeployments.status, 'stopped'), isNull(localDeployments.archivedAt)))
    .orderBy(desc(localDeployments.updatedAt))
  return rows.map(toLocalDeployment)
}

export async function listSandboxIdsWithLiveManagedLocalDeployments(): Promise<string[]> {
  const rows = await db
    .select({ sandboxId: localDeployments.sandboxId })
    .from(localDeployments)
    .where(
      and(
        eq(localDeployments.mode, 'managed'),
        eq(localDeployments.restartPolicy, 'always'),
        ne(localDeployments.status, 'stopped'),
        isNull(localDeployments.archivedAt)
      )
    )
  return [...new Set(rows.map((row) => row.sandboxId))]
}

export async function listRestartableManagedLocalDeploymentsForSandbox(sandboxId: string): Promise<LocalDeployment[]> {
  const rows = await db
    .select()
    .from(localDeployments)
    .where(
      and(
        eq(localDeployments.sandboxId, sandboxId),
        eq(localDeployments.mode, 'managed'),
        eq(localDeployments.restartPolicy, 'always'),
        ne(localDeployments.status, 'stopped'),
        isNull(localDeployments.archivedAt)
      )
    )
  return rows.map(toLocalDeployment)
}
