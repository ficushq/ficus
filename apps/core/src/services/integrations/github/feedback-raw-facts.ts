import type { IntegrationOutputFact } from '@ficus/shared'
import { and, eq, sql, type SQLWrapper } from 'drizzle-orm'
import {
  db,
  type DbTx,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
  githubOutputProofs,
  inbox,
  integrationOutputDeliveries,
  integrationOutputEvents,
  integrationOutputTriggerRuns,
  workStreams,
} from '../../../db'
import { creationNotificationContent, defaultNotificationContent } from '../outputs/default-routing'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { githubOutputPass, GITHUB_PASS_READ_LIMIT } from './feedback-pass'
import { githubContentHash, hasGitHubParentText } from './feedback-envelope'
import {
  hasGitHubFreshnessBinding,
  rawGitHubFactsSourceId,
  rawGitHubFactsSourceIdSQL,
} from './feedback-freshness-binding'
import { isCurrentGitHubFeedbackRevision } from './feedback-obsolescence'
import {
  readOutputEvent,
  inboxIntegrationEventId,
  inboxRecipientAgentId,
  reserveOutputBody,
} from './feedback-pass-read'

type Event = typeof integrationOutputEvents.$inferSelect
type Store = typeof db | DbTx
export const GITHUB_FEEDBACK_OBSOLETE = 'github_feedback_obsolete'
export const GITHUB_FACTUAL_PARENT_OBSOLETE = 'github_factual_parent_obsolete'
export const GITHUB_FACTUAL_RECOVERY_PENDING = 'github_factual_parent_obsolete_pending'

/** Deterministic immutable OFF variant. No current parent text, trust, decision or approval is copied. */
function factualFact(source: Event): IntegrationOutputFact | null {
  const content = source.fact.github?.content
  if (
    source.integration !== 'github' ||
    source.sourceKey.startsWith('github-') ||
    !hasGitHubFreshnessBinding(source) ||
    content?.objectKind !== 'action' ||
    !content.delivery ||
    !source.fact.github?.rawParent ||
    hasGitHubParentText(content.delivery)
  )
    return null
  const { parentText: _parentText, ...factual } = content
  return { ...content.delivery, eventKey: source.fact.eventKey, github: { content: factual, status: null } }
}

/** Local exact-source proof; the namespace/shape alone never confers admission. */
export async function rawGitHubFactsOrigin(store: Store, event: Event): Promise<Event | undefined> {
  const id = rawGitHubFactsSourceId(event)
  const source = id ? await readOutputEvent(store, id) : undefined
  const expected = source && factualFact(source)
  return source &&
    expected &&
    event.eventKey === source.eventKey &&
    githubContentHash(expected) === githubContentHash(event.fact) &&
    githubContentHash(source.authority) === githubContentHash(event.authority)
    ? source
    : undefined
}

/** Read-only SQL equivalent of the immutable source proof, for paginated inbox reads. */
export function rawGitHubFactsProofSQL(eventId: SQLWrapper, fact: SQLWrapper, sourceKey: SQLWrapper) {
  return sql`EXISTS (SELECT 1 FROM integration_output_events raw_facts_origin
    INNER JOIN integration_output_events raw_facts_variant ON raw_facts_variant.id = ${eventId}
    WHERE raw_facts_origin.id = ${rawGitHubFactsSourceIdSQL(sourceKey)}
      AND raw_facts_origin.integration = 'github' AND raw_facts_origin.source_key NOT LIKE 'github-%'
      AND raw_facts_origin.authority = raw_facts_variant.authority
      AND raw_facts_origin.event_key = raw_facts_variant.event_key
      AND raw_facts_origin.fact #>> '{github,content,objectKind}' = 'action'
      AND raw_facts_origin.fact #>> '{github,rawParent,objectKind}' IN ('issue', 'pull_request')
      AND raw_facts_origin.fact #>> '{github,rawParent,repositoryId}' ~ '^[1-9][0-9]*$'
      AND raw_facts_origin.fact #>> '{github,rawParent,nativeId}' ~ '^[1-9][0-9]*$'
      AND raw_facts_origin.fact #> '{github,content,delivery,data,parentContent}' IS NULL
      AND ${fact} = ((raw_facts_origin.fact #> '{github,content,delivery}') || jsonb_build_object(
        'eventKey', raw_facts_origin.fact->>'eventKey', 'github', jsonb_build_object(
          'content', (raw_facts_origin.fact #> '{github,content}') - 'parentText', 'status', null))))`
}

/** Accepted message proof, not a caller-selected client ID. Also covers acceptance-before-ack. */
export function rawGitHubFactsRecipientAcceptedSQL(
  originId: SQLWrapper,
  agentId: SQLWrapper,
  exceptInboxId: SQLWrapper = sql`null`
) {
  return sql<boolean>`EXISTS (SELECT 1 FROM inbox raw_fact_mail
    INNER JOIN integration_output_events raw_fact_origin ON raw_fact_origin.id = ${originId}::uuid
    INNER JOIN integration_output_events raw_fact_event ON raw_fact_event.id = ${inboxIntegrationEventId(sql`raw_fact_mail.metadata`)}
    WHERE raw_fact_mail.recipient_type = 'agent' AND raw_fact_mail.sender_type = 'system'
      AND raw_fact_mail.recipient_id = ${agentId}::text AND raw_fact_mail.id IS DISTINCT FROM ${exceptInboxId}::uuid
      AND raw_fact_event.integration = 'github'
      AND raw_fact_event.authority->>'squadId' = raw_fact_origin.authority->>'squadId'
      AND (raw_fact_event.id = ${originId}::uuid OR raw_fact_event.source_key = 'github-raw-facts:' || ${originId}::text
        OR (raw_fact_event.fact->>'eventKey' = raw_fact_origin.fact->>'eventKey'
          AND raw_fact_event.fact #>> '{github,content,objectKind}' = 'action'
          AND raw_fact_event.fact #>> '{github,content,repositoryId}' = raw_fact_origin.fact #>> '{github,content,repositoryId}'
          AND raw_fact_event.fact #>> '{github,content,nativeId}' = raw_fact_origin.fact #>> '{github,content,nativeId}')
        OR EXISTS (SELECT 1 FROM github_feedback_sources raw_fact_association
          INNER JOIN github_feedback_revisions raw_fact_revision ON raw_fact_revision.id = raw_fact_association.revision_id
          INNER JOIN github_feedback_objects raw_fact_object ON raw_fact_object.id = raw_fact_revision.object_id
          WHERE raw_fact_association.event_id = raw_fact_origin.id AND raw_fact_object.object_kind = 'action'
            AND raw_fact_event.source_key = 'github-feedback:' || raw_fact_object.squad_id::text || ':' || raw_fact_revision.id::text
            AND raw_fact_event.event_key = raw_fact_revision.id::text))
      AND (raw_fact_mail.delivered_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM chat_send_receipts raw_fact_receipt
        INNER JOIN messages raw_fact_message ON raw_fact_message.id = raw_fact_receipt.message_id
          AND raw_fact_message.agent_id = raw_fact_receipt.agent_id
        WHERE raw_fact_receipt.agent_id = ${inboxRecipientAgentId(sql`raw_fact_mail.recipient_id`)} AND raw_fact_receipt.state = 'accepted'
          AND raw_fact_receipt.execution_id IS NOT NULL AND raw_fact_receipt.accepted_at IS NOT NULL
          AND raw_fact_message.role = 'human' AND raw_fact_message.metadata->>'source' = 'inbox'
          AND raw_fact_message.metadata->>'clientId' = raw_fact_receipt.client_id
          AND raw_fact_message.metadata->>'executionId' = raw_fact_receipt.execution_id::text
          AND raw_fact_message.metadata->'inboxMessageIds' @> jsonb_build_array(raw_fact_mail.id::text)
          AND (raw_fact_receipt.client_id = 'github-feedback:' || raw_fact_event.id::text || ':' || raw_fact_mail.id::text
            OR raw_fact_receipt.client_id = 'integration-output:' || (raw_fact_mail.metadata->>'integrationDeliveryId') || ':' || raw_fact_mail.id::text)
      )))`
}

export async function mayReceiveRawGitHubFacts(store: Store, event: Event, agentId: string, inboxId?: string) {
  const originId = rawGitHubFactsSourceId(event)
  if (!originId) return true
  const [row] = await store
    .select({
      accepted: rawGitHubFactsRecipientAcceptedSQL(sql`${originId}`, sql`${agentId}`, sql`${inboxId ?? null}`),
    })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, event.id))
  return row?.accepted === false
}

/** Runs under the shared authority lock. Pure persistence: never sends, triggers, fetches, or approves.
 * Reuses original effect scopes; already-routed sources are not replayed to newly matching routes.
 * Pending sources retain ordinary routing with the original logical event key / trigger receipts.
 */
export async function preserveRawGitHubActionFacts(
  tx: DbTx,
  sourceId: string,
  afterCommit: Array<() => void> = []
): Promise<Event | undefined> {
  const source = await readOutputEvent(tx, sourceId)
  if (!source && (githubOutputPass()?.bodyRows ?? 0) >= GITHUB_PASS_READ_LIMIT)
    throw new Error('feedback_capacity_deferred')
  const fact = source && factualFact(source)
  if (!source || !fact || source.authority.kind !== 'connection') return
  const squadId = source.authority.squadId
  const observations = await tx
    .select({
      association: githubFeedbackSources,
      revision: {
        id: githubFeedbackRevisions.id,
        squadId: githubFeedbackRevisions.squadId,
        decision: githubFeedbackRevisions.decision,
        releaseState: githubFeedbackRevisions.releaseState,
      },
      object: githubFeedbackObjects,
    })
    .from(githubFeedbackSources)
    .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
    .innerJoin(githubFeedbackObjects, eq(githubFeedbackObjects.id, githubFeedbackRevisions.objectId))
    .where(eq(githubFeedbackSources.eventId, source.id))
  const own = observations.find(
    ({ object }) =>
      object.objectKind === 'action' &&
      object.nativeId === source.fact.github!.content!.nativeId &&
      object.repositoryId === source.fact.github!.content!.repositoryId
  )
  const parent = observations.find(
    ({ object }) =>
      object.objectKind === source.fact.github!.rawParent!.objectKind &&
      object.nativeId === source.fact.github!.rawParent!.nativeId &&
      object.repositoryId === source.fact.github!.rawParent!.repositoryId
  )
  if (
    observations.length !== 2 ||
    !own ||
    !parent ||
    observations.some(
      ({ association, revision }) =>
        !association.unfiltered ||
        association.squadId !== squadId ||
        revision.squadId !== squadId ||
        githubContentHash(association.authority) !== githubContentHash(source.authority)
    ) ||
    own.revision.decision === 'deny' ||
    !(await isCurrentGitHubFeedbackRevision(tx, own.revision.id)) ||
    own.revision.releaseState === 'obsolete' ||
    (await isCurrentGitHubFeedbackRevision(tx, parent.revision.id))
  )
    return
  const [projected] = await tx
    .select({ id: githubOutputProofs.eventId })
    .from(githubOutputProofs)
    .where(eq(githubOutputProofs.sourceEventId, source.id))
    .limit(1)
  if (projected) return // Never turn a filtered human/model effect into an OFF replay.
  const sourceKey = `github-raw-facts:${source.id}`
  const [identity] = await tx
    .select({ id: integrationOutputEvents.id })
    .from(integrationOutputEvents)
    .where(and(eq(integrationOutputEvents.sourceKey, sourceKey), eq(integrationOutputEvents.eventKey, source.eventKey)))
  const pass = githubOutputPass()
  let variant: Event | undefined
  if (identity && pass?.bodies.has(`event:${identity.id}`)) variant = await readOutputEvent(tx, identity.id)
  else {
    if (!reserveOutputBody()) throw new Error('feedback_capacity_deferred')
    await tx
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey,
        eventKey: source.eventKey,
        fact,
        authority: source.authority,
        createdAt: source.createdAt,
        matchedAt: source.matchedAt,
        lastErrorCode: GITHUB_FACTUAL_PARENT_OBSOLETE,
        triggerSquadIds: source.triggerSquadIds,
      })
      .onConflictDoNothing()
    ;[variant] = await tx
      .select()
      .from(integrationOutputEvents)
      .where(
        and(eq(integrationOutputEvents.sourceKey, sourceKey), eq(integrationOutputEvents.eventKey, source.eventKey))
      )
    if (variant && pass) pass.bodies.set(`event:${variant.id}`, structuredClone(variant))
  }
  if (!variant || !(await rawGitHubFactsOrigin(tx, variant))) return
  await tx
    .insert(githubFeedbackSources)
    .values({
      revisionId: own.revision.id,
      eventId: variant.id,
      squadId: own.association.squadId,
      authority: source.authority,
      unfiltered: true,
    })
    .onConflictDoNothing()
  const deliveries = await tx
    .select()
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.eventId, source.id))
  for (const delivery of deliveries.filter((row) => !['delivered', 'superseded'].includes(row.status))) {
    await tx
      .insert(integrationOutputDeliveries)
      .values({
        eventId: variant.id,
        workStreamId: delivery.workStreamId,
        subscriptionId: delivery.subscriptionId,
        subscription: delivery.subscription,
        reason: GITHUB_FACTUAL_PARENT_OBSOLETE,
      })
      .onConflictDoNothing()
  }
  const notices = await tx
    .select({
      id: inbox.id,
      recipientId: inbox.recipientId,
      idempotencyKey: inbox.idempotencyKey,
      metadata: inbox.metadata,
    })
    .from(inbox)
    .where(
      and(
        eq(inbox.senderType, 'system'),
        eq(inbox.recipientType, 'agent'),
        sql`${inbox.metadata}->>'source' = 'integration-notification'`,
        sql`${inbox.metadata}->>'integrationEventId' = ${source.id}`
      )
    )
  for (const notice of notices) {
    await persistFactualNotification(
      tx,
      variant,
      notice.recipientId,
      `${notice.idempotencyKey ?? notice.id}:raw-facts`,
      notice.metadata ?? {},
      afterCommit
    )
  }
  // Creation committed before its owner intake persisted: preserve that SAME creation, never
  // execute the trigger again or drop the owner's paused-workflow setup instructions.
  const created = await tx
    .select({ trigger: integrationOutputTriggerRuns, stream: workStreams })
    .from(integrationOutputTriggerRuns)
    .innerJoin(workStreams, eq(workStreams.id, integrationOutputTriggerRuns.workStreamId))
    .where(eq(integrationOutputTriggerRuns.eventId, source.id))
  for (const { trigger, stream } of created) {
    if (!stream.ownerAgentId) continue
    await persistFactualNotification(
      tx,
      variant,
      stream.ownerAgentId,
      `github-feedback-creation:${source.id}:${stream.id}:${stream.ownerAgentId}:raw-facts`,
      {
        source: 'integration-notification',
        integrationCreationNotice: true,
        workStreamId: stream.id,
        integrationRuleId: trigger.triggerId,
      },
      afterCommit
    )
  }
  await tx
    .update(integrationOutputDeliveries)
    .set({ status: 'superseded', reason: GITHUB_FEEDBACK_OBSOLETE, updatedAt: new Date() })
    .where(
      and(
        eq(integrationOutputDeliveries.eventId, source.id),
        sql`${integrationOutputDeliveries.status} NOT IN ('delivered', 'superseded')`
      )
    )
  await tx
    .update(integrationOutputEvents)
    .set({ matchedAt: new Date(), lastErrorCode: GITHUB_FEEDBACK_OBSOLETE })
    .where(eq(integrationOutputEvents.id, source.id))
  return variant
}

async function persistFactualNotification(
  tx: DbTx,
  variant: Event,
  recipientId: string,
  key: string,
  metadata: Record<string, unknown>,
  afterCommit: Array<() => void>
) {
  if (!(await mayReceiveRawGitHubFacts(tx, variant, recipientId))) return
  const workStreamId = typeof metadata.workStreamId === 'string' ? metadata.workStreamId : undefined
  const [stream] = workStreamId ? await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)) : []
  const creation = metadata.integrationCreationNotice === true
  if (creation && (!stream || stream.ownerAgentId !== recipientId || !['active', 'queued'].includes(stream.status)))
    return
  const subject = creation ? `New work stream you own: ${variant.fact.subject}` : variant.fact.subject
  const content =
    creation && stream
      ? creationNotificationContent(variant, stream)
      : defaultNotificationContent(
          variant,
          workStreamId,
          undefined,
          variant.authority.kind === 'connection' ? variant.authority.squadId : undefined
        )
  const idempotencyKey = key.length <= 200 ? key : `github-raw-facts:${githubContentHash(key)}`
  const [inserted] = await tx
    .insert(inbox)
    .values({
      recipientType: 'agent',
      recipientId,
      senderType: 'system',
      subject,
      content,
      metadata: {
        ...metadata,
        integrationEventId: variant.id,
        integrationFactualReason: GITHUB_FACTUAL_PARENT_OBSOLETE,
        wakeEligible: true,
      },
      idempotencyKey,
    })
    .onConflictDoNothing({ target: inbox.idempotencyKey })
    .returning({ id: inbox.id })
  // Verify an idempotent winner by equality, without materializing an unbounded mailbox body.
  const [winner] = inserted
    ? [inserted]
    : await tx
        .select({ id: inbox.id })
        .from(inbox)
        .where(
          and(
            eq(inbox.idempotencyKey, idempotencyKey),
            eq(inbox.recipientId, recipientId),
            eq(inbox.senderType, 'system'),
            eq(inbox.recipientType, 'agent'),
            sql`${inbox.subject} IS NOT DISTINCT FROM ${subject ?? null}`,
            eq(inbox.content, content),
            sql`${inbox.metadata}->>'integrationEventId' = ${variant.id}`
          )
        )
  if (!winner) throw new Error('Factual notification idempotency payload mismatch')
  if (inserted)
    afterCommit.push(() =>
      eventEmitter.emit('inbox.messageReceived', {
        messageId: inserted.id,
        recipientType: 'agent',
        recipientId,
        senderAgentId: null,
      })
    )
}
