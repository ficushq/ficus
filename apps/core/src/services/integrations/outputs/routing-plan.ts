import { createHash } from 'node:crypto'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import {
  ADDRESSABLE_AGENT_STATUSES,
  integrationSubscriptionMatches,
  type IntegrationSubscription,
  type WorkflowEventTrigger,
  type IntegrationOutputFact,
  type GitHubFeedbackRoute,
  integrationValueAt,
} from '@ficus/shared'
import {
  db,
  agents,
  squads,
  workStreams,
  workStreamFlowRuns,
  integrationConnections,
  integrationOutputEvents,
  integrationOutputDeliveries,
  integrationOutputTriggerRuns,
  type DbTx,
} from '../../../db'
import { codeHostingRegistry } from '../code-hosting'
import { integrationOutputRegistry } from './registry'
import { eventRuleTrigger, selectOutputRule } from './default-routing'
import { defaultStreamMatches, preFlowRecipient } from './tracked-match'
import { planChangeRequestBinding } from './delivery-binding'
import { githubContentHash } from '../github/feedback-envelope'
import { outputRecipients } from './routing-audience'
import { consultantAgentId } from '../../chat/consultant-idempotency'
import { changeRequestBindingMetadata } from '../../work-streams/change-request-binding'

type Event = typeof integrationOutputEvents.$inferSelect
export type OutputRoutingRoute = GitHubFeedbackRoute
export interface OutputRoutingPlan {
  relevant: boolean
  routes: OutputRoutingRoute[]
  fingerprint: string
}
export function outputSourceMatches(subscription: IntegrationSubscription, event: Event): boolean {
  return (
    subscription.source.integration === event.integration &&
    subscription.source.output === event.fact.output &&
    subscription.source.version === event.fact.version &&
    (!subscription.source.connectionId ||
      (event.authority.kind === 'connection' && event.authority.connectionId === subscription.source.connectionId))
  )
}
/** Query the existing resource receipt without claiming it; delivery uses the identical query. */
export function outputTriggerSourceKey(event: Event, trigger: WorkflowEventTrigger) {
  return `${event.integration}:${trigger.source.connectionId ?? 'any-account'}`
}
export async function findOutputTriggerRun(
  store: typeof db | DbTx,
  squadId: string,
  trigger: WorkflowEventTrigger,
  event: Event
) {
  const [prior] = await store
    .select()
    .from(integrationOutputTriggerRuns)
    .where(
      and(
        eq(integrationOutputTriggerRuns.squadId, squadId),
        eq(integrationOutputTriggerRuns.triggerId, trigger.id),
        or(
          eq(integrationOutputTriggerRuns.sourceKey, outputTriggerSourceKey(event, trigger)),
          sql`${integrationOutputTriggerRuns.sourceKey} LIKE ${`${event.integration}:${trigger.source.connectionId ? `connection:${trigger.source.connectionId}:` : ''}%`}`
        ),
        eq(integrationOutputTriggerRuns.resourceKey, event.fact.resourceKey)
      )
    )
    .limit(1)
  return prior
}
function result(input: OutputRoutingRoute[]): OutputRoutingPlan {
  const routes = [...input].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  // Only IDs/provenance, never raw titles, bodies, binding values, or external text.
  return {
    relevant: routes.length > 0,
    routes,
    fingerprint: createHash('sha256').update(JSON.stringify(routes)).digest('hex'),
  }
}

/**
 * Query-only relevance. `authorize` must check exact-resource visibility and live connection authority.
 * Paused/parked/inactive consumers remain relevant; this function does NOT resume or create them.
 * Routing rechecks this plan at release: it is provenance, never an authorization grant.
 */
export async function planOutputRouting(
  event: Event,
  authorize: (squadId: string) => Promise<boolean>,
  options: {
    login?: string
    bindingFact?: IntegrationOutputFact
    store?: typeof db | DbTx
    includeSettled?: boolean
  } = {}
): Promise<OutputRoutingPlan> {
  const store = options.store ?? db
  if (event.authority.kind !== 'connection' || !(await authorize(event.authority.squadId))) return result([])
  const squadId = event.authority.squadId
  const [squad] = await store
    .select()
    .from(squads)
    .where(and(eq(squads.id, squadId), eq(squads.status, 'active')))
  if (!squad) return result([])
  const [connection] = await store
    .select({ configuration: integrationConnections.configuration })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, event.authority.connectionId))
  const configuration = options.login === undefined ? connection?.configuration : { login: options.login }
  const login = String((configuration as { login?: string } | undefined)?.login ?? '')
  if (integrationOutputRegistry.adapter(event.integration)?.shouldNotify?.(event.fact, configuration) === false)
    return result([])
  const rows = await store
    .select({ stream: workStreams, run: workStreamFlowRuns })
    .from(workStreams)
    .leftJoin(workStreamFlowRuns, eq(workStreamFlowRuns.workStreamId, workStreams.id))
    .where(and(eq(workStreams.squadId, squadId), inArray(workStreams.status, ['active', 'queued'])))
  const available = await store
    .select()
    .from(agents)
    .where(and(eq(agents.squadId, squadId), inArray(agents.status, [...ADDRESSABLE_AGENT_STATUSES])))
  const routes: OutputRoutingRoute[] = []
  let defaultAudienceOwned = false
  for (const { stream, run } of rows) {
    if (defaultStreamMatches(stream.metadata, event)) {
      defaultAudienceOwned = true
      if (!run) {
        const recipient = preFlowRecipient(stream, available, squad.managerAgentId)
        // Bot relevance follows the existing audience/rule predicates, not a blanket bot discard.
        if (recipient)
          routes.push({
            kind: 'pre-flow',
            id: stream.id,
            workStreamId: stream.id,
            recipientId: recipient.id,
            fingerprint: routeHash(['pre-flow', stream.id, recipient.id]),
          })
      }
    }
    if (!run || run.createdAt > event.createdAt) continue
    for (const subscription of codeHostingRegistry.subscriptions(run.state.definition, stream.metadata)) {
      const descriptor = integrationOutputRegistry.descriptor(subscription.source)
      if (
        descriptor &&
        outputSourceMatches(subscription, event) &&
        integrationSubscriptionMatches(subscription, event.fact, stream.metadata, descriptor)
      ) {
        routes.push(flowRoute('subscription', subscription, stream, run, squad.managerAgentId))
        defaultAudienceOwned = true
      }
    }
  }
  const branch = await planChangeRequestBinding(event.integration, options.bindingFact ?? event.fact, authorize)
  if (branch) {
    const target = rows.find((row) => row.stream.id === branch.workStreamId)
    if (target?.run && target.run.createdAt <= event.createdAt) {
      const metadata = changeRequestBindingMetadata(target.stream.metadata, branch.reference, branch.candidate)
      if (defaultStreamMatches(metadata, event)) defaultAudienceOwned = true
      for (const subscription of codeHostingRegistry.subscriptions(target.run.state.definition, metadata)) {
        const descriptor = integrationOutputRegistry.descriptor(subscription.source)
        if (
          descriptor &&
          outputSourceMatches(subscription, event) &&
          integrationSubscriptionMatches(subscription, event.fact, metadata, descriptor)
        ) {
          routes.push(
            flowRoute('delivery-branch', subscription, { ...target.stream, metadata }, target.run, squad.managerAgentId)
          )
          defaultAudienceOwned = true
        }
      }
    }
  }
  const trigger = eventRuleTrigger(squad.metadata, event, login)
  if (trigger) {
    const descriptor = integrationOutputRegistry.descriptor(trigger.source)
    const subscription = { ...trigger, deliver: { to: 'active' as const, whenInactive: 'retain' as const } }
    if (
      descriptor &&
      outputSourceMatches(subscription, event) &&
      integrationSubscriptionMatches(subscription, event.fact, {}, descriptor) &&
      (options.includeSettled || !(await findOutputTriggerRun(store, squadId, trigger, event)))
    )
      routes.push({
        kind: 'start-workstream',
        id: trigger.id,
        recipientId: squad.managerAgentId ?? undefined,
        fingerprint: routeHash([trigger, selectOutputRule(squad.metadata, event, login)]),
      })
  }
  const [delivery] = await store
    .select({ id: integrationOutputDeliveries.id })
    .from(integrationOutputDeliveries)
    .innerJoin(workStreams, eq(workStreams.id, integrationOutputDeliveries.workStreamId))
    .where(and(eq(integrationOutputDeliveries.eventId, event.id), eq(workStreams.squadId, squadId)))
    .limit(1)
  if (!defaultAudienceOwned && (options.includeSettled || (!delivery && !event.triggerSquadIds.includes(squadId)))) {
    const rule = selectOutputRule(squad.metadata, event, login)
    if (rule?.action.type === 'notify-manager' && available.some((agent) => agent.id === squad.managerAgentId))
      routes.push({
        kind: 'notify-manager',
        id: rule.id,
        recipientId: squad.managerAgentId!,
        fingerprint: routeHash(rule),
      })
    if (rule?.action.type === 'notify-consultant')
      routes.push({
        kind: 'notify-consultant',
        id: rule.id,
        fingerprint: routeHash(rule),
        recipientId: consultantAgentId({
          actorUserId: 'integration-event',
          squadId,
          clientId: outputLogicalEventKey(event, rule.id),
        }),
      })
  }
  return result(routes.map((route) => ({ ...route, authorityHash: githubContentHash(event.authority) })))
}

export const routeHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function outputLogicalEventKey(event: Event, suffix: string) {
  return routeHash([event.integration, event.fact.eventKey, suffix])
}
function flowRoute(
  kind: string,
  subscription: IntegrationSubscription,
  stream: typeof workStreams.$inferSelect,
  run: typeof workStreamFlowRuns.$inferSelect,
  managerId: string | null
): OutputRoutingRoute {
  const bindings = Object.values(subscription.match).flatMap((match) =>
    'streamMetadata' in match ? [[match.streamMetadata, integrationValueAt(stream.metadata, match.streamMetadata)]] : []
  )
  const targets = outputRecipients(run, stream, subscription, managerId)
  const to = subscription.deliver.to
  const slots = run.state.attempts
    .filter((attempt) => ['ready', 'running'].includes(attempt.status))
    .flatMap((attempt) => {
      const step = attempt.step ?? run.state.definition.steps.find((step) => step.id === attempt.stepId)
      return step?.kind === 'agent' &&
        (to === 'active' ||
          to === 'delivery-owner' ||
          ('participant' in to ? step.participant === to.participant : step.id === to.step))
        ? [
            {
              attemptId: attempt.id,
              stepId: step.id,
              participant: step.participant,
              stepHash: routeHash([
                step,
                run.state.definition.participants[step.participant],
                run.participantSnapshots[step.participant],
              ]),
              ...(run.attemptAgents[String(attempt.id)] ? { agentId: run.attemptAgents[String(attempt.id)] } : {}),
            },
          ]
        : []
    })
  return {
    kind,
    id: subscription.id,
    workStreamId: stream.id,
    runId: run.createRequestId,
    ownerId: stream.ownerAgentId,
    fingerprint: routeHash([subscription, bindings]),
    consumers: targets.length
      ? targets.map((target) => ({ ...target, ...slots.find((slot) => slot.attemptId === target.attemptId) }))
      : slots,
  }
}
