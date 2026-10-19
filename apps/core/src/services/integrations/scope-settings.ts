import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  db,
  settings,
  squads,
  integrationConnections as connections,
  integrationConnectionAssignments as assignments,
  type DbTx,
} from '../../db'
import { resolveOAuthAuthority } from './authorization/authority'
import { invalidateProjection } from './provider-state'

export const INTEGRATION_DEFAULT_PREFIX = '__integration-default:'
export const INTEGRATION_SQUAD_PREFIX = '__integration-squad:'
type AccountChoice = { connectionId: string; isDefault: boolean }
export interface SquadIntegrationPreference {
  enabled: boolean
  inheritDefault: boolean
  accounts: AccountChoice[]
}
const scopeKey = (squadId: string, provider: string) => `${INTEGRATION_SQUAD_PREFIX}${provider}:${squadId}`

export async function globalIntegrationDefault(provider: string, store: typeof db | DbTx = db): Promise<string | null> {
  const [row] = await store
    .select()
    .from(settings)
    .where(eq(settings.key, INTEGRATION_DEFAULT_PREFIX + provider))
  return row?.value || null
}

/** Pin the first successfully connected GitHub account; deletion never silently promotes another identity. */
export async function initializeGitHubDefault(): Promise<void> {
  const [first] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.providerKey, 'github'),
        eq(connections.authState, 'authenticated'),
        eq(connections.enabled, true),
        eq(connections.clientAuthority, resolveOAuthAuthority())
      )
    )
    .orderBy(asc(connections.createdAt), asc(connections.id))
    .limit(1)
  if (first)
    await db
      .insert(settings)
      .values({ key: INTEGRATION_DEFAULT_PREFIX + 'github', value: first.id })
      .onConflictDoNothing()
}

async function readPreference(tx: DbTx, squadId: string, provider: string): Promise<SquadIntegrationPreference | null> {
  const [row] = await tx
    .select()
    .from(settings)
    .where(eq(settings.key, scopeKey(squadId, provider)))
  return row ? (JSON.parse(row.value) as SquadIntegrationPreference) : null
}
async function writePreference(tx: DbTx, squadId: string, provider: string, value: SquadIntegrationPreference) {
  await tx
    .insert(settings)
    .values({ key: scopeKey(squadId, provider), value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: new Date() } })
}

/** Called inside manual assignment transactions while the squad row is locked. */
export async function rememberSquadIntegrationChoice(tx: DbTx, squadId: string, provider: string) {
  const accounts = await tx
    .select({ connectionId: assignments.connectionId, isDefault: assignments.isDefault })
    .from(assignments)
    .where(and(eq(assignments.squadId, squadId), eq(assignments.providerKey, provider)))
  await writePreference(tx, squadId, provider, { enabled: accounts.length > 0, inheritDefault: false, accounts })
}

/** Materialized assignments keep credential, event, refresh, and projection consumers on the same authority. */
export async function reconcileSquadIntegration(
  squadId: string,
  provider: string,
  patch?: { enabled?: boolean; inheritDefault?: boolean }
) {
  if (!patch) {
    const [row] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, scopeKey(squadId, provider)))
    const saved = row ? (JSON.parse(row.value) as SquadIntegrationPreference) : null
    const globalDefaultId = await globalIntegrationDefault(provider)
    if (saved && (!saved.enabled || !saved.inheritDefault))
      return { enabled: saved.enabled, inheritDefault: saved.inheritDefault, globalDefaultId, changed: false }
    if (!saved && !globalDefaultId) {
      const [existing] = await db
        .select({ id: assignments.connectionId })
        .from(assignments)
        .where(and(eq(assignments.squadId, squadId), eq(assignments.providerKey, provider)))
        .limit(1)
      return {
        enabled: provider === 'github' || !!existing,
        inheritDefault: provider === 'github' && !existing,
        globalDefaultId,
        changed: false,
      }
    }
    if (saved?.inheritDefault && globalDefaultId) {
      const current = await db
        .select({ id: assignments.connectionId, isDefault: assignments.isDefault })
        .from(assignments)
        .innerJoin(connections, eq(connections.id, assignments.connectionId))
        .where(and(eq(assignments.squadId, squadId), eq(assignments.providerKey, provider)))
      if (current.length === 1 && current[0]!.id === globalDefaultId && current[0]!.isDefault)
        return { enabled: saved.enabled, inheritDefault: true, globalDefaultId, changed: false }
    }
  }
  return db.transaction(async (tx) => {
    const [squad] = await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId)).for('update')
    if (!squad) return { enabled: false, inheritDefault: false, globalDefaultId: null, changed: false }
    const existing = await tx
      .select({ connectionId: assignments.connectionId, isDefault: assignments.isDefault })
      .from(assignments)
      .where(and(eq(assignments.squadId, squadId), eq(assignments.providerKey, provider)))
    const saved = await readPreference(tx, squadId, provider)
    const preference: SquadIntegrationPreference = {
      ...(saved ?? {
        enabled: provider === 'github' || existing.length > 0,
        inheritDefault: provider === 'github' && existing.length === 0,
        accounts: existing,
      }),
      ...patch,
    }
    const globalDefaultId = await globalIntegrationDefault(provider, tx)
    let desired = preference.enabled
      ? preference.inheritDefault
        ? globalDefaultId
          ? [{ connectionId: globalDefaultId, isDefault: true }]
          : []
        : preference.accounts
      : []
    // Lock connection rows before touching assignments, matching the repository's lifecycle lock order.
    const ids = [...new Set([...existing, ...desired].map((item) => item.connectionId))].sort()
    const available = ids.length
      ? await tx
          .select({ id: connections.id })
          .from(connections)
          .where(and(inArray(connections.id, ids), eq(connections.providerKey, provider)))
          .orderBy(connections.id)
          .for('update')
      : []
    desired = desired.filter((item) => available.some((row) => row.id === item.connectionId))
    const signature = (items: AccountChoice[]) =>
      items
        .map((item) => `${item.connectionId}:${item.isDefault}`)
        .sort()
        .join(',')
    const changed = signature(existing) !== signature(desired)
    if (changed) {
      await tx.delete(assignments).where(and(eq(assignments.squadId, squadId), eq(assignments.providerKey, provider)))
      if (desired.length)
        await tx.insert(assignments).values(desired.map((item) => ({ squadId, providerKey: provider, ...item })))
      await invalidateProjection(tx, squadId, provider)
    }
    // Don't persist an empty pre-login inheritance choice just because a read occurred.
    if ((saved || patch || existing.length || globalDefaultId) && JSON.stringify(saved) !== JSON.stringify(preference))
      await writePreference(tx, squadId, provider, preference)
    return { enabled: preference.enabled, inheritDefault: preference.inheritDefault, globalDefaultId, changed }
  })
}

export async function setGlobalIntegrationDefault(provider: string, connectionId: string) {
  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.providerKey, provider),
        eq(connections.enabled, true),
        eq(connections.authState, 'authenticated')
      )
    )
  if (!connection) throw new Error('Choose an enabled, connected account as the global default.')
  await db
    .insert(settings)
    .values({ key: INTEGRATION_DEFAULT_PREFIX + provider, value: connectionId })
    .onConflictDoUpdate({ target: settings.key, set: { value: connectionId, updatedAt: new Date() } })
}

export async function reconcileIntegrationSquads(provider: string): Promise<string[]> {
  const rows = await db.select({ id: squads.id }).from(squads).orderBy(squads.id)
  const changed: string[] = []
  for (const row of rows) if ((await reconcileSquadIntegration(row.id, provider)).changed) changed.push(row.id)
  return changed
}
