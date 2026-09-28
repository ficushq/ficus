import { integrationOutputRegistry } from '../integrations/outputs/registry'
import { createHash } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import {
  isWorkerAgentType,
  resolveWorkflow,
  workflowPresetSchema,
  workflowSourceSchema,
  type WorkflowDefinition,
  type WorkflowPreset,
  type ResolvedWorkflow,
} from '@ficus/shared'
import { agentTypes, db, modelTiers, workflows, type DbTx } from '../../db'

type Store = typeof db | DbTx
export type WorkflowRow = typeof workflows.$inferSelect

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400
  ) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/** Stable across JSONB key ordering and Date serialization. Catalog revisions select only semantic fields. */
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  // Keep existing catalog revisions and request fingerprints stable across the
  // participant field rename. This legacy hash spelling is never serialized to the API.
  if (
    value !== null &&
    typeof value === 'object' &&
    'agentTypeId' in value &&
    'session' in value &&
    Object.keys(value).every((key) => ['agentTypeId', 'tier', 'session'].includes(key))
  ) {
    const { agentTypeId, ...settings } = value as Record<string, unknown>
    value = { ...settings, profile: agentTypeId }
  }
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function workflowFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function workflowRevision(row: WorkflowRow): string {
  return workflowFingerprint({
    id: row.id,
    description: row.description,
    ...(row.scope?.kind !== 'instance' ? { scope: row.scope } : {}),
    definition: row.definition,
    disabled: row.disabled,
  })
}

export function serializeWorkflow(row: WorkflowRow) {
  return {
    id: row.id,
    description: row.description,
    ...(row.scope?.kind !== 'instance' ? { scope: row.scope } : {}),
    definition: row.definition,
    revision: workflowRevision(row),
    disabled: row.disabled,
    hasTemplate: row.yamlTemplate !== null,
    yamlFieldOverrides: row.yamlFieldOverrides,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function validateWorkflowParticipants(definition: WorkflowDefinition, store: Store = db): Promise<void> {
  try {
    for (const subscription of definition.subscriptions ?? []) integrationOutputRegistry.validate(subscription)
  } catch (error) {
    throw new WorkflowError(error instanceof Error ? error.message : 'Invalid integration subscription')
  }
  const ids = [...new Set(Object.values(definition.participants).map((participant) => participant.agentTypeId))]
  if (!ids.length) return
  const rows = await store
    .select({ id: agentTypes.id, disabled: agentTypes.disabled, systemOnly: agentTypes.systemOnly })
    .from(agentTypes)
    .where(inArray(agentTypes.id, ids))
  const available = new Set(rows.filter(isWorkerAgentType).map((row) => row.id))
  for (const id of ids)
    if (!available.has(id))
      throw new WorkflowError(
        `Agent type '${id}' does not exist, is disabled, or is system-only; choose an enabled worker agent type`
      )
  for (const participant of Object.values(definition.participants)) {
    if (participant.tier) {
      const [tier] = await store.select().from(modelTiers).where(eq(modelTiers.slug, participant.tier))
      if (!tier || tier.disabled)
        throw new WorkflowError(`Model tier '${participant.tier}' does not exist or is disabled`)
    }
  }
}

export async function resolveStoredWorkflow(input: unknown, store: Store = db): Promise<ResolvedWorkflow> {
  const source = workflowSourceSchema.parse(input)
  let resolved: ResolvedWorkflow
  if (source.kind === 'inline') resolved = resolveWorkflow(source)
  else {
    const [row] = await store.select().from(workflows).where(eq(workflows.id, source.id))
    if (!row) throw new WorkflowError('Workflow not found', 404)
    if (source.revision !== undefined && source.revision !== workflowRevision(row))
      throw new WorkflowError('Workflow changed; reload it before customizing', 409)
    if (row.disabled) throw new WorkflowError('Workflow is disabled')
    try {
      resolved = resolveWorkflow(source, { ...row, revision: workflowRevision(row) })
    } catch (error) {
      throw new WorkflowError(error instanceof Error ? error.message : 'Invalid workflow customization')
    }
  }
  await validateWorkflowParticipants(resolved.definition, store)
  return resolved
}

function overrides(row: WorkflowRow, value: WorkflowPreset): string[] {
  if (row.yamlTemplate === null) return []
  const template = row.yamlTemplate as Record<string, unknown>
  return (['description', 'definition'] as const).filter(
    (key) => workflowFingerprint(value[key] ?? null) !== workflowFingerprint(template[key] ?? null)
  )
}

export async function createWorkflow(input: unknown): Promise<WorkflowRow> {
  const value = workflowPresetSchema.parse(input)
  await validateWorkflowParticipants(value.definition)
  const [row] = await db
    .insert(workflows)
    .values({ ...value, description: value.description ?? null })
    .onConflictDoNothing()
    .returning()
  if (!row) throw new WorkflowError('Workflow already exists', 409)
  return row
}

/** Replaces an effective definition atomically and preserves config override ownership. */
export async function replaceWorkflow(id: string, revision: string, input: unknown): Promise<WorkflowRow> {
  const value = workflowPresetSchema.parse(input)
  if (value.id !== id) throw new WorkflowError('Workflow ID cannot change')
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(workflows).where(eq(workflows.id, id)).for('update')
    if (!row) throw new WorkflowError('Workflow not found', 404)
    if (workflowRevision(row) !== revision) throw new WorkflowError('Workflow changed; reload it before editing', 409)
    if (workflowFingerprint(value.scope ?? { kind: 'instance' }) !== workflowFingerprint(row.scope))
      throw new WorkflowError('Preset scope cannot change; save a separate copy instead')
    await validateWorkflowParticipants(value.definition, tx)
    const [updated] = await tx
      .update(workflows)
      .set({
        description: value.description ?? null,
        definition: value.definition,
        yamlFieldOverrides: overrides(row, value),
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id))
      .returning()
    return updated!
  })
}

export async function setWorkflowDisabled(id: string, revision: string, disabled: boolean): Promise<WorkflowRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(workflows).where(eq(workflows.id, id)).for('update')
    if (!row) throw new WorkflowError('Workflow not found', 404)
    if (workflowRevision(row) !== revision) throw new WorkflowError('Workflow changed; reload it before editing', 409)
    if (!disabled) await validateWorkflowParticipants(row.definition, tx)
    const [updated] = await tx
      .update(workflows)
      .set({ disabled, updatedAt: new Date() })
      .where(eq(workflows.id, id))
      .returning()
    return updated!
  })
}

export async function deleteWorkflow(id: string, revision: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(workflows).where(eq(workflows.id, id)).for('update')
    if (!row) throw new WorkflowError('Workflow not found', 404)
    if (workflowRevision(row) !== revision) throw new WorkflowError('Workflow changed; reload it before deleting', 409)
    if (row.yamlTemplate !== null) throw new WorkflowError('Disable a template-based workflow instead of deleting it')
    await tx.delete(workflows).where(eq(workflows.id, id))
  })
}

/** Reset the whole graph together; partial graph resets could leave dangling edges. */
export async function revertWorkflow(id: string, revision: string): Promise<WorkflowRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(workflows).where(eq(workflows.id, id)).for('update')
    if (!row) throw new WorkflowError('Workflow not found', 404)
    if (workflowRevision(row) !== revision) throw new WorkflowError('Workflow changed; reload it before reverting', 409)
    if (!row.yamlTemplate) throw new WorkflowError('Workflow has no YAML template')
    const template = row.yamlTemplate as Record<string, unknown>
    const value = workflowPresetSchema.parse({ ...template, description: template.description ?? undefined })
    await validateWorkflowParticipants(value.definition, tx)
    const [updated] = await tx
      .update(workflows)
      .set({
        description: value.description ?? null,
        definition: value.definition,
        yamlFieldOverrides: [],
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id))
      .returning()
    return updated!
  })
}
