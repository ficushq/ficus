import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  parseTrackedResourceReference,
  parseTrackedResourceUrl,
  readDeliveryState,
  resolveTrackedResources,
  trackedResourceKey,
  trackedResourceLabel,
  trackedResourceObjectSchema,
  trackedResourceSchema,
  type IntegrationOutputFact,
  type ResolvedTrackedResource,
  type TrackedResource,
  type TrackedResourceKind,
  type TrackedResourcesView,
} from '@ficus/shared'
import { db, squads, workStreams, workStreamFlowRuns, integrationOutputEvents, type DbTx } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { codeHostingRegistry } from '../integrations/code-hosting'
import { subscriptionTargetsResource, trackedResourceRegistry } from '../integrations/tracked-resources'
import { isOutputEventAuthorizedForSquad, reconcileOutputDeliveries } from '../integrations/outputs/runtime'
import { integrationOutputRegistry } from '../integrations/outputs/registry'
import { eventTrackedResource, type TrackedTarget } from '../integrations/outputs/tracked-match'
import { deliveryView } from './delivery-pull-requests'
import { TrackedResourceError } from './tracked-resource-error'

export { TrackedResourceError } from './tracked-resource-error'

const trackedResourceInputSchema = trackedResourceObjectSchema.pick({
  integration: true,
  repository: true,
  kind: true,
  number: true,
  connectionId: true,
  url: true,
})
/**
 * Identity may arrive as an observed event, a resource URL, a written reference
 * (`owner/repo#12`, `ENG-12`), or an explicit resource.
 */
export const trackedResourceRequestSchema = z.union([
  z.object({ event: z.string().uuid() }).strict(),
  z.object({ url: z.string().url(), delivery: z.literal(true).optional() }).strict(),
  z
    .object({
      reference: z.string().trim().min(1).max(500),
      // GitHub references name no kind of their own, so the caller picks; Linear has only issues.
      kind: trackedResourceObjectSchema.shape.kind.optional(),
      // The account the reference belongs to, when the caller names one. Authorization checks it
      // against the squad's own assignment, exactly as it does for an explicit resource.
      connectionId: trackedResourceObjectSchema.shape.connectionId,
      delivery: z.literal(true).optional(),
    })
    .strict(),
  z.object({ resource: trackedResourceInputSchema, delivery: z.literal(true).optional() }).strict(),
])
export type TrackedResourceRequest = z.infer<typeof trackedResourceRequestSchema>

export interface TrackedResourceTarget {
  integration: string
  repository: string
  kind: TrackedResourceKind
  number: number
}

/**
 * Complete a fact that carries only a provider-native identity. A Linear comment names just the
 * issue UUID, so `repository`/`number` come from the provider — read through the squad's own
 * connection, which is identity resolution and never a grant. Null when the event names no such
 * identity; it throws when the squad named one it cannot read (404) or cannot read anything (409).
 */
export async function describeEventTrackedIdentity(
  event: { integration: string; fact: IntegrationOutputFact },
  squadId: string
): Promise<TrackedTarget | null> {
  const identity = integrationOutputRegistry.adapter(event.integration)?.trackedIdentity?.(event.fact)
  if (!identity) return null
  const adapter = trackedResourceRegistry.adapterFor(identity.integration)
  if (!adapter?.describe) return null
  // Only an issue is ever named this way: a pull request identity always carries repository/number.
  const described = await adapter.describe(
    { integration: identity.integration, kind: 'issue', externalId: identity.externalId },
    squadId
  )
  if (!described?.repository || described.number === undefined)
    throw new TrackedResourceError(
      `The ${identity.integration} issue this event names was not found on this squad's ${identity.integration} connection`,
      404
    )
  // The provider's answer is still an identity this instance has to be able to follow.
  if (!adapter.validateRepository(described.repository))
    throw new TrackedResourceError(`Invalid ${identity.integration} repository: ${described.repository}`, 400)
  return {
    integration: identity.integration,
    repository: described.repository,
    kind: 'issue',
    number: described.number,
    externalId: described.externalId ?? identity.externalId,
    ...(described.url ? { url: described.url } : {}),
  }
}

/** Correlation is not access: the squad must own the connection that observed the event. */
export async function resolveEventTrackedResource(eventId: string, squadId: string): Promise<TrackedResource> {
  const [event] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, eventId))
  if (!event) throw new TrackedResourceError('Integration event not found', 404)
  if (event.authority.kind !== 'connection' || event.authority.squadId !== squadId)
    throw new TrackedResourceError('Event is not accessible from this squad', 403)
  if (!(await isOutputEventAuthorizedForSquad(event, squadId)))
    throw new TrackedResourceError('Event connection is not authorized for this squad', 403)
  // A fact without repository/number still identifies its resource, just natively; completing it
  // is a read on the squad's own connection, which the checks above have already established.
  const target = eventTrackedResource(event) ?? (await describeEventTrackedIdentity(event, squadId))
  if (!target) throw new TrackedResourceError('Event does not reference a trackable issue or pull request', 400)
  const parsed = trackedResourceSchema.safeParse({
    ...target,
    connectionId: event.authority.connectionId,
    origin: {
      eventId: event.id,
      resourceKey: event.fact.resourceKey,
      output: event.fact.output,
      ...(event.fact.occurredAt ? { occurredAt: event.fact.occurredAt } : {}),
    },
  })
  if (!parsed.success) throw new TrackedResourceError('Event does not reference a trackable issue or pull request', 400)
  return parsed.data
}

/** A request that names an identity directly, rather than through an observed event. */
export type TrackedResourceIdentityRequest = Exclude<TrackedResourceRequest, { event: string }>

/**
 * The identity a request names: no access check, no provider read. Untracking uses this on its
 * own, because a squad may always unlink a resource even after losing the connection.
 */
export function trackedResourceRequestIdentity(request: TrackedResourceIdentityRequest): TrackedResource | null {
  if ('url' in request) {
    const parsed = parseTrackedResourceUrl(request.url)
    return parsed ? { ...parsed, url: request.url.trim() } : null
  }
  if ('reference' in request) {
    const parsed = parseTrackedResourceReference(request.reference)
    if (!parsed) return null
    // A GitHub reference names no kind of its own, so the caller picks. A caller who names a kind
    // the provider does not have is told so by authorization, never quietly given another resource.
    return {
      ...parsed,
      kind: request.kind ?? parsed.kind ?? 'issue',
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    }
  }
  return request.resource
}

/** Identity resolution first, then the squad's own authorization. */
export async function resolveTrackedResourceRequest(
  squadId: string,
  request: TrackedResourceRequest
): Promise<TrackedResource> {
  if ('event' in request) return resolveEventTrackedResource(request.event, squadId)
  let resource = trackedResourceRequestIdentity(request)
  if (!resource)
    throw new TrackedResourceError(
      'Not a supported issue or pull request link or reference (use a resource URL, owner/repo#12, or KEY-12)',
      400
    )
  if (request.delivery) {
    if (resource.kind !== 'pull_request')
      throw new TrackedResourceError('delivery is only valid for pull requests', 400)
    resource = { ...resource, delivery: true }
  }
  await authorizeTrackedResource(squadId, resource)
  // Only now, with the squad's own access established, ask the provider what the resource is.
  // An event-sourced identity skips this: the observed fact already carried it.
  const adapter = trackedResourceRegistry.adapterFor(resource.integration)
  if (adapter?.describe && (!resource.externalId || !resource.url)) {
    const described = await adapter.describe(resource, squadId)
    if (!described)
      throw new TrackedResourceError(
        `${trackedResourceLabel(resource)} was not found on this squad's ${resource.integration} connection`,
        404
      )
    resource = { ...resource, ...described }
    // The provider's answer is still an identity this instance has to be able to follow.
    if (!adapter.validateRepository(resource.repository))
      throw new TrackedResourceError(`Invalid ${resource.integration} repository: ${resource.repository}`, 400)
  }
  return resource
}

/** Access comes from the squad's connection assignment, never from the link itself. */
export async function authorizeTrackedResource(squadId: string, resource: TrackedResource): Promise<void> {
  const adapter = trackedResourceRegistry.adapterFor(resource.integration)
  if (!adapter) throw new TrackedResourceError(`Unknown tracked resource integration: ${resource.integration}`, 400)
  if (!adapter.validateRepository(resource.repository))
    throw new TrackedResourceError(`Invalid ${resource.integration} repository: ${resource.repository}`, 400)
  // Only a code host has pull requests; without one, `delivery` could never be satisfied either.
  if (resource.kind === 'pull_request' && !codeHostingRegistry.adapterFor(resource.integration))
    throw new TrackedResourceError(`Pull requests are not supported for ${resource.integration}`, 400)
  if (!(await adapter.authorizeSquad(squadId, resource.connectionId)))
    throw new TrackedResourceError(
      `No authorized ${resource.integration} connection is assigned to this squad${
        resource.connectionId ? ' for the requested account' : ''
      }`,
      403
    )
}

/**
 * Shape-only validation: rewrites `metadata.tracked` with parsed entries and returns them
 * (null when the key is absent). Reads nothing, so it is safe to call while holding a row lock.
 */
export function parseTrackedMetadata(metadata: Record<string, unknown>): TrackedResource[] | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, 'tracked')) return null
  const raw = metadata.tracked
  if (!Array.isArray(raw)) throw new TrackedResourceError('metadata.tracked must be an array', 400)
  const parsed: TrackedResource[] = []
  for (const [index, entry] of raw.entries()) {
    const result = trackedResourceSchema.safeParse(entry)
    if (!result.success)
      throw new TrackedResourceError(
        `metadata.tracked[${index}] is invalid: ${result.error.issues[0]?.message ?? 'unrecognized shape'}`,
        400
      )
    parsed.push(result.data)
  }
  metadata.tracked = parsed
  return parsed
}

/** The `tracked` entries already stored, by identity. First entry wins, like `mergeTracked`. */
function storedTrackedEntries(previous: unknown): Map<string, TrackedResource> {
  const stored = new Map<string, TrackedResource>()
  const raw = previous && typeof previous === 'object' ? (previous as Record<string, unknown>).tracked : undefined
  if (!Array.isArray(raw)) return stored
  for (const entry of raw) {
    const parsed = trackedResourceSchema.safeParse(entry)
    if (!parsed.success) continue
    const key = trackedResourceKey(parsed.data)
    if (!stored.has(key)) stored.set(key, parsed.data)
  }
  return stored
}

/**
 * Validate every `metadata.tracked` entry and authorize the ones this write introduces.
 * Entries already present in `previous` keep their access: they were authorized when added.
 * Authorization reads the squad's connections, so callers must run this BEFORE opening a
 * transaction: the provider lookup locks the squad row on its own connection.
 */
export async function validateTrackedMetadata(
  squadId: string,
  metadata: Record<string, unknown>,
  previous?: unknown,
  options?: { allowOriginEventId?: string }
): Promise<void> {
  const parsed = parseTrackedMetadata(metadata)
  if (!parsed) return
  // Access carries over from anything already resolvable, including the delivery PR and legacy issue.
  const previousKeys = new Set(resolveTrackedResources(previous).map((resource) => resource.key))
  // `origin` carries over only from a stored `tracked` entry: the delivery PR and legacy issue
  // resolve without one, so re-submitting them counts as introducing an origin.
  const stored = storedTrackedEntries(previous)
  for (const [index, resource] of parsed.entries()) {
    const key = trackedResourceKey(resource)
    // `origin` is the server's record of the event it observed. A client may keep one exactly as
    // stored; it can never add, rewrite, or drop one, whether or not the identity already exists.
    const storedEntry = stored.get(key)
    const forged = storedEntry
      ? !isDeepStrictEqual(resource.origin, storedEntry.origin)
      : !!resource.origin && resource.origin.eventId !== options?.allowOriginEventId
    if (forged) throw new TrackedResourceError(`metadata.tracked[${index}].origin is server-managed`, 400)
    if (previousKeys.has(key)) continue
    await authorizeTrackedResource(squadId, resource)
  }
}

/**
 * Pure: dedupe by identity, keep order, stamp `addedAt` only on entries that lack it.
 * The FIRST list wins a collision, so callers put the entry they trust first.
 */
export function mergeTracked(existing: unknown, additions: unknown): TrackedResource[] {
  const addedAt = new Date().toISOString()
  const merged: TrackedResource[] = []
  const seen = new Set<string>()
  for (const list of [existing, additions]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const parsed = trackedResourceSchema.safeParse(entry)
      if (!parsed.success) continue
      const key = trackedResourceKey(parsed.data)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(parsed.data.addedAt ? parsed.data : { ...parsed.data, addedAt })
    }
  }
  return merged
}

type LockedStream = typeof workStreams.$inferSelect
/** Squad row first, then the stream row: the same lock order every other writer uses. */
async function withLockedStream<T>(
  streamId: string,
  fn: (locked: LockedStream, tx: DbTx) => Promise<{ value: T; changed: boolean }>
): Promise<T> {
  let squadId = ''
  const { value, changed } = await db.transaction(async (tx) => {
    const [reference] = await tx
      .select({ squadId: workStreams.squadId })
      .from(workStreams)
      .where(eq(workStreams.id, streamId))
    if (!reference) throw new TrackedResourceError('Work stream not found', 404)
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, reference.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, streamId)).for('update')
    if (!locked) throw new TrackedResourceError('Work stream not found', 404)
    squadId = locked.squadId
    return fn(locked, tx)
  })
  if (changed) {
    eventEmitter.emit('workStream.updated', { workStreamId: streamId, squadId })
    await reconcileOutputDeliveries(streamId)
  }
  return value
}

export async function addTrackedResources(
  streamId: string,
  resources: TrackedResource[]
): Promise<{ added: ResolvedTrackedResource[]; changed: boolean; view: TrackedResourcesView }> {
  const result = await withLockedStream(streamId, async (locked, tx) => {
    const metadata = (locked.metadata as Record<string, unknown> | null) ?? {}
    const current = new Map(resolveTrackedResources(metadata).map((resource) => [resource.key, resource]))
    const additions = resources.filter((resource) => !current.has(trackedResourceKey(resource)))
    // The primary delivery pull request is already designated, so re-adding it with the flag is a no-op.
    const designate = new Set(
      resources
        .filter((resource) => resource.delivery)
        .map((resource) => trackedResourceKey(resource))
        .filter((key) => current.get(key)?.source === 'tracked' && !current.get(key)!.delivery)
    )
    if (!additions.length && !designate.size)
      return { value: { addedKeys: [] as string[], changed: false }, changed: false }
    // `delivery` is only ever valid on a pull request, so the kind is re-checked at the write
    // itself rather than trusted from the caller's request.
    const tracked = mergeTracked(metadata.tracked, additions).map((entry) =>
      entry.kind === 'pull_request' && designate.has(trackedResourceKey(entry))
        ? { ...entry, delivery: true as const }
        : entry
    )
    await tx
      .update(workStreams)
      .set({ metadata: { ...metadata, tracked }, updatedAt: new Date() })
      .where(eq(workStreams.id, streamId))
    return {
      value: { addedKeys: additions.map((resource) => trackedResourceKey(resource)), changed: true },
      changed: true,
    }
  })
  const view = await listTrackedResources(streamId)
  return {
    added: view.resources.filter((resource) => result.addedKeys.includes(resource.key)),
    changed: result.changed,
    view,
  }
}

export async function removeTrackedResource(
  streamId: string,
  target: TrackedResourceTarget
): Promise<{ removed: boolean; view: TrackedResourcesView }> {
  const key = trackedResourceKey(target)
  const removed = await withLockedStream(streamId, async (locked, tx) => {
    const metadata = (locked.metadata as Record<string, unknown> | null) ?? {}
    const resource = resolveTrackedResources(metadata).find((entry) => entry.key === key)
    if (!resource) return { value: false, changed: false }
    if (resource.source === 'delivery')
      throw new TrackedResourceError(
        'This pull request is the designated delivery change request; edit codeHost.changeRequest instead of untracking it',
        409
      )
    const next: Record<string, unknown> = { ...metadata }
    if (Array.isArray(next.tracked))
      next.tracked = next.tracked.filter((entry) => {
        const parsed = trackedResourceSchema.safeParse(entry)
        return !parsed.success || trackedResourceKey(parsed.data) !== key
      })
    // Observed delivery state is keyed by the resource that is going away, so it goes with it —
    // otherwise an orphaned entry lingers and re-tracking the PR would resurrect a stale state.
    if (resource.kind === 'pull_request') {
      const { [key]: orphaned, ...remaining } = readDeliveryState(metadata).pullRequests
      if (orphaned) {
        if (Object.keys(remaining).length) next.delivery = { pullRequests: remaining }
        else delete next.delivery
      }
    }
    await tx.update(workStreams).set({ metadata: next, updatedAt: new Date() }).where(eq(workStreams.id, streamId))
    return { value: true, changed: true }
  })
  return { removed, view: await listTrackedResources(streamId) }
}

export async function listTrackedResources(streamId: string): Promise<TrackedResourcesView> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  if (!stream) throw new TrackedResourceError('Work stream not found', 404)
  const [run] = await db
    .select({ state: workStreamFlowRuns.state })
    .from(workStreamFlowRuns)
    .where(eq(workStreamFlowRuns.workStreamId, streamId))
  const subscriptions: TrackedResourcesView['subscriptions'] = !['active', 'queued'].includes(stream.status)
    ? 'ended'
    : !run
      ? 'no-flow'
      : !run.state.definition.completion.followChanges
        ? 'not-following'
        : 'active'
  const active =
    subscriptions === 'active' ? codeHostingRegistry.subscriptions(run!.state.definition, stream.metadata) : []
  const observed = readDeliveryState(stream.metadata).pullRequests
  return {
    subscriptions,
    resources: resolveTrackedResources(stream.metadata).map((resource) => {
      const subscriptionIds = active
        .filter((subscription) => subscriptionTargetsResource(subscription, resource))
        .map((subscription) => subscription.id)
      return {
        ...resource,
        subscriptionIds,
        subscribed: subscriptionIds.length > 0,
        ...(observed[resource.key] ? { mergeState: observed[resource.key]!.state } : {}),
      }
    }),
    delivery: deliveryView(stream.metadata),
  }
}
