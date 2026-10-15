import { eq, inArray } from 'drizzle-orm'
import type { WorkflowScope, WorkflowSource, WorkflowEventTrigger } from '@ficus/shared'
import { db, workflows, squads, users, type DbTx } from '../../db'
import { hasPermission, type Identity } from '../rbac'
import { WorkflowError } from './catalog'

type CatalogPermission = 'workflows:read' | 'workflows:create' | 'workflows:update' | 'workflows:delete'
export async function canAccessWorkflow(
  identity: Identity,
  permission: CatalogPermission,
  scope: WorkflowScope = { kind: 'instance' }
) {
  return decideScopeAccess(identity, permission, scope, async (squadId) => {
    const [squad] = await db.select({ id: squads.id }).from(squads).where(eq(squads.id, squadId))
    return !!squad
  })
}
/**
 * The rows the caller may access under `permission`, in their original order, with the same
 * answer {@link canAccessWorkflow} gives row by row. Each distinct scope is decided once and the
 * referenced squads are looked up in one query, so the cost scales with the number of scopes,
 * not the number of rows: agent permissions are uncached and cost several queries per check.
 */
export async function filterAccessibleWorkflows<Row extends { scope: WorkflowScope }>(
  identity: Identity,
  permission: CatalogPermission,
  rows: Row[]
): Promise<Row[]> {
  const squadIds = [...new Set(rows.flatMap((row) => (row.scope.kind === 'squad' ? [row.scope.squadId] : [])))]
  const existingSquads = new Set(
    squadIds.length
      ? (await db.select({ id: squads.id }).from(squads).where(inArray(squads.id, squadIds))).map((row) => row.id)
      : []
  )
  const decisions = new Map<string, Promise<boolean>>()
  for (const { scope } of rows)
    if (!decisions.has(scopeKey(scope)))
      decisions.set(
        scopeKey(scope),
        decideScopeAccess(identity, permission, scope, async (squadId) => existingSquads.has(squadId))
      )
  const keys = [...decisions.keys()]
  const allowed = new Set((await Promise.all(decisions.values())).flatMap((ok, index) => (ok ? [keys[index]!] : [])))
  return rows.filter((row) => allowed.has(scopeKey(row.scope)))
}
function scopeKey(scope: WorkflowScope) {
  return scope.kind === 'squad' ? `squad:${scope.squadId}` : scope.kind === 'user' ? `user:${scope.userId}` : 'instance'
}
async function decideScopeAccess(
  identity: Identity,
  permission: CatalogPermission,
  scope: WorkflowScope,
  squadExists: (squadId: string) => Promise<boolean>
) {
  if (scope.kind === 'squad')
    return (await squadExists(scope.squadId)) && (await hasPermission(identity, permission, scope.squadId))
  if (scope.kind === 'user') {
    if (identity.type !== 'user' || identity.userId !== scope.userId) return false
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, scope.userId))
    return !!user && (await hasPermission(identity, permission))
  }
  // A squad manager's catalog-write grant applies only inside its own squad.
  if (permission !== 'workflows:read' && identity.type === 'agent' && identity.squadId) return false
  return hasPermission(identity, permission)
}
export async function authorizeWorkflow(identity: Identity, permission: CatalogPermission, id: string) {
  const [row] = await db.select().from(workflows).where(eq(workflows.id, id))
  if (!row || !(await canAccessWorkflow(identity, permission, row.scope)))
    throw new WorkflowError('Workflow not found or not accessible', 404)
  return row
}
export async function authorizeWorkflowSource(identity: Identity, source: WorkflowSource, squadId: string) {
  if (source.kind === 'inline') return
  const row = await authorizeWorkflow(identity, 'workflows:read', source.id)
  if (row.scope.kind === 'squad' && row.scope.squadId !== squadId)
    throw new WorkflowError('This preset belongs to another squad', 403)
}
/** Trusted creation paths (schedules, entity calls) must not cross preset boundaries either. */
export async function checkWorkflowScope(
  source: WorkflowSource,
  squadId: string,
  requestingUserId: string | null,
  store: DbTx | typeof db = db
) {
  if (source.kind === 'inline') return
  const [row] = await store.select().from(workflows).where(eq(workflows.id, source.id))
  if (!row) throw new WorkflowError('Workflow not found', 404)
  if (row.scope.kind === 'squad' && row.scope.squadId !== squadId)
    throw new WorkflowError('This preset belongs to another squad', 403)
  if (row.scope.kind === 'user' && row.scope.userId !== requestingUserId)
    throw new WorkflowError('This preset belongs to another user', 403)
}

export async function validateSquadWorkflows(
  metadata: Record<string, unknown>,
  squadId: string,
  store: DbTx | typeof db = db
) {
  const { squadMetadataSchema } = await import('@ficus/shared')
  const { resolveStoredWorkflow } = await import('./catalog')
  squadMetadataSchema.parse(metadata)
  const { integrationOutputRegistry } = await import('../integrations/outputs/registry')
  for (const trigger of (metadata.integrationTriggers ?? []) as WorkflowEventTrigger[]) {
    integrationOutputRegistry.validate({ ...trigger, deliver: { to: 'active', whenInactive: 'retain' } })
    const descriptor = integrationOutputRegistry.descriptor(trigger.source)!
    for (const binding of Object.values(trigger.create.metadata))
      if (!descriptor.fields[binding.event]) throw new WorkflowError(`Unknown output field '${binding.event}'`)
  }
  const sources = squadWorkflowSources(metadata)
  for (const source of sources) {
    await checkWorkflowScope(source, squadId, null, store)
    await resolveStoredWorkflow(source, store)
  }
}
export function squadWorkflowSources(metadata: Record<string, unknown>): WorkflowSource[] {
  return [
    ...((metadata.integrationTriggers ?? []) as WorkflowEventTrigger[]).map((trigger) => trigger.create.workflow),
    ...(metadata.workflow ? [metadata.workflow as WorkflowSource] : []),
    ...((metadata.workflowSetup as { choices?: Array<{ source: WorkflowSource }> } | undefined)?.choices ?? []).map(
      (choice) => choice.source
    ),
  ]
}
