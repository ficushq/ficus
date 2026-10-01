import { eventPredicateSchema, validateEventPredicates, eventPredicateMatches } from './event-predicates'
import { eventPredicateField } from './event-predicate-catalog'
import { z } from 'zod'
import { integrationSubscriptionSchema, integrationValueAt, type IntegrationOutputFact } from './integration-outputs'
import { workflowEventTriggerSchema, workflowSourceSchema, type WorkflowSource } from './workflows'

export const squadEventRuleSchema = z
  .object({
    id: workflowEventTriggerSchema.shape.id,
    enabled: z.boolean().default(true),
    source: integrationSubscriptionSchema.shape.source,
    match: workflowEventTriggerSchema.shape.match.optional(),
    predicates: z.array(eventPredicateSchema).max(16).optional(),
    filters: z
      .object({
        squadRouting: z.boolean().default(false),
        repository: z.string().trim().max(200).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        teamId: z.string().trim().max(200).optional(),
        audience: z.enum(['connected-account', 'assigned-or-mentioned', 'any']).default('connected-account'),
      })
      .strict(),
    action: z.discriminatedUnion('type', [
      z
        .object({ type: z.literal('notify-manager'), additionalContext: z.string().trim().max(10000).optional() })
        .strict(),
      z
        .object({ type: z.literal('notify-consultant'), additionalContext: z.string().trim().max(10000).optional() })
        .strict(),
      z.object({ type: z.literal('ignore') }).strict(),
      z
        .object({
          type: z.literal('start-workstream'),
          workflow: workflowSourceSchema.optional(),
          titlePrefix: z.string().max(100).optional(),
          additionalContext: z.string().trim().max(10000).optional(),
          metadata: workflowEventTriggerSchema.shape.create.shape.metadata.optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.predicates?.length) validateEventPredicates(rule.source, rule.predicates, ctx)
  })
export type SquadEventRule = z.infer<typeof squadEventRuleSchema>
export const squadEventRulesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]*$/),
    z
      .array(squadEventRuleSchema)
      .max(32)
      .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Duplicate event rule ID')
  )
  .superRefine((providers, ctx) => {
    for (const [provider, rules] of Object.entries(providers))
      rules.forEach((rule, index) => {
        if (rule.source.integration !== provider)
          ctx.addIssue({
            code: 'custom',
            path: [provider, index, 'source'],
            message: 'Rule provider must match its integration',
          })
      })
  })
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((value): value is string => typeof value === 'string') : []
export function eventRepositoryMatches(pattern: string, repository: string) {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i'
  ).test(repository)
}
export function matchesGitHubRouting(metadata: unknown, repository: unknown, labels?: unknown): boolean {
  return (
    typeof repository === 'string' &&
    Array.isArray(record(metadata).github) &&
    record(metadata).github.some(
      (route: any) =>
        typeof route?.repo === 'string' &&
        eventRepositoryMatches(route.repo, repository) &&
        (labels === undefined ||
          !strings(route.labels).length ||
          strings(route.labels).some((label) => strings(labels).includes(label)))
    )
  )
}

/** Missing config adopts the old behavior as visible editable rules. An explicit [] disables it. */
export function effectiveSquadEventRules(metadata: unknown, provider: string): SquadEventRule[] {
  const stored = record(metadata)
  if (Object.prototype.hasOwnProperty.call(record(stored.integrationRules), provider))
    return squadEventRulesSchema.parse({ [provider]: stored.integrationRules[provider] })[provider]!
  const existing: SquadEventRule[] = Array.isArray(stored.integrationTriggers)
    ? stored.integrationTriggers
        .map((value: unknown) => workflowEventTriggerSchema.parse(value))
        .filter((trigger: any) => trigger.source.integration === provider)
        .map((trigger: any) => ({
          id: trigger.id,
          enabled: true,
          source: trigger.source,
          match: trigger.match,
          filters: { squadRouting: false, audience: 'any' },
          action: { type: 'start-workstream', ...trigger.create },
        }))
    : []
  const defaults =
    provider === 'github'
      ? [
          ['dependabot_alert.updated', 'notify-manager', 'any'],
          ['issue.assigned', 'notify-manager', 'connected-account'],
          ['issue.unassigned', 'notify-manager', 'connected-account'],
          ['pull_request.review_requested', 'start-workstream', 'connected-account'],
          ...['issue.comment', 'pull_request.comment', 'pull_request.reviewed', 'pull_request.review_comment'].map(
            (output) => [output, 'notify-manager', 'assigned-or-mentioned']
          ),
        ]
      : provider === 'linear'
        ? [['issue.assigned', 'notify-manager', 'connected-account']]
        : []
  for (const [output, action, audience] of defaults) {
    const id = `${provider}-${output!.replaceAll('_', '-').replaceAll('.', '-')}`
    if (!existing.some((rule) => rule.id === id))
      existing.push(
        squadEventRuleSchema.parse({
          id,
          enabled: true,
          source: { integration: provider, output, version: 1 },
          filters: { squadRouting: true, audience },
          action: { type: action },
          ...(output === 'dependabot_alert.updated'
            ? {
                predicates: [
                  { field: 'severity', op: 'in', value: ['high', 'critical'] },
                  { field: 'state', op: 'eq', value: 'open' },
                  { field: 'action', op: 'neq', value: 'assignees_changed' },
                ],
              }
            : {}),
        })
      )
  }
  return existing
}

/** Comment/review echoes from the connected account must not start another agent turn. */
export function isGitHubSelfComment(fact: IntegrationOutputFact, login: string): boolean {
  return (
    !!login &&
    ['issue.comment', 'pull_request.comment', 'pull_request.reviewed', 'pull_request.review_comment'].includes(
      fact.output
    ) &&
    typeof fact.data.actor === 'string' &&
    fact.data.actor.toLowerCase() === login.toLowerCase()
  )
}

export interface EventRuleCheck {
  kind:
    | 'enabled'
    | 'source'
    | 'connection'
    | 'shared-scope'
    | 'repository'
    | 'labels'
    | 'team'
    | 'legacy-match'
    | 'predicate'
    | 'audience'
  description: string
  passed: boolean
}
export interface SquadEventRulePreview {
  selectedRuleId: string | null
  action: SquadEventRule['action']['type'] | null
  suppression: 'self-comment' | null
  rules: Array<{
    id: string
    position: number
    status: 'disabled' | 'not-matched' | 'selected' | 'shadowed' | 'suppressed'
    checks: EventRuleCheck[]
  }>
}

/** Read-only rule selection, NOT a promise of delivery: runtime authorization, subscriptions and receipts still apply.
 * Reports contain no event values, bodies, configured operands, workflow metadata or additional instructions.
 */
export function previewSquadEventRules(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string
): SquadEventRulePreview {
  return evaluateSquadEventRules(metadata, integration, fact, login, connectionId).preview
}
export function selectSquadEventRule(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string
) {
  return evaluateSquadEventRules(metadata, integration, fact, login, connectionId).selected
}

/** Stored array order is authoritative. Both preview and live dispatch use this single evaluation path. */
function evaluateSquadEventRules(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string
) {
  const suppression = integration === 'github' && isGitHubSelfComment(fact, login) ? 'self-comment' : null
  const preview: SquadEventRulePreview = { selectedRuleId: null, action: null, suppression, rules: [] }
  let selected: SquadEventRule | undefined
  const data = record(fact.data)
  for (const [index, rule] of effectiveSquadEventRules(metadata, integration).entries()) {
    const checks: EventRuleCheck[] = []
    const result: SquadEventRulePreview['rules'][number] = {
      id: rule.id,
      position: index + 1,
      status: 'not-matched',
      checks,
    }
    preview.rules.push(result)
    if (suppression) {
      result.status = 'suppressed'
      continue
    }
    if (selected) {
      result.status = 'shadowed'
      continue
    }
    const check = (kind: EventRuleCheck['kind'], passed: boolean, description: string) => {
      checks.push({ kind, passed, description })
      return passed
    }
    if (!check('enabled', rule.enabled, 'Rule is enabled.')) {
      result.status = 'disabled'
      continue
    }
    if (
      !check(
        'source',
        rule.source.integration === integration &&
          rule.source.output === fact.output &&
          rule.source.version === fact.version,
        'Provider, event and version must match.'
      )
    )
      continue
    if (
      !check(
        'connection',
        !rule.source.connectionId || rule.source.connectionId === connectionId,
        rule.source.connectionId ? 'Event must use the rule’s selected account.' : 'Any authorized account can match.'
      )
    )
      continue
    const filters = rule.filters
    let sharedScope = true
    if (filters.squadRouting) {
      if (integration === 'github')
        sharedScope = matchesGitHubRouting(
          metadata,
          data.repository,
          fact.output.startsWith('issue.') && fact.output !== 'issue.comment' ? data.labels : undefined
        )
      if (integration === 'linear') {
        const routes = record(metadata).linear
        sharedScope =
          typeof data.teamId === 'string' &&
          (Array.isArray(routes) ? routes : [routes]).some((route) => route?.teamId === data.teamId)
      }
    }
    check(
      'shared-scope',
      sharedScope,
      !filters.squadRouting
        ? 'Shared scope ignored for this rule.'
        : integration === 'github'
          ? fact.output.startsWith('issue.') && fact.output !== 'issue.comment'
            ? 'Shared repository AND any configured shared label must match; empty scope matches nothing.'
            : 'Shared repository must match; shared labels do not filter comments or pull requests. Empty scope matches nothing.'
          : 'Shared team must match; empty scope matches nothing.'
    )
    if (filters.repository)
      check(
        'repository',
        eventRepositoryMatches(filters.repository, String(data.repository ?? '')),
        'Per-rule repository pattern must match (case-insensitive; * is a wildcard).'
      )
    if (filters.labels?.length)
      check(
        'labels',
        filters.labels.some((label) => strings(data.labels).includes(label)),
        'At least one per-rule label must be present (case-sensitive).'
      )
    if (filters.teamId) check('team', filters.teamId === data.teamId, 'Per-rule team must match exactly.')
    if (rule.match)
      check(
        'legacy-match',
        Object.entries(rule.match).every(([path, binding]) => {
          const actual = integrationValueAt(fact.data, path)
          return typeof actual === 'string' && ['repository', 'assignee', 'actor', 'requestedReviewer'].includes(path)
            ? actual.toLowerCase() === String(binding.value).toLowerCase()
            : actual === binding.value
        }),
        'All saved legacy equality filters must match.'
      )
    for (const predicate of rule.predicates ?? []) {
      const field = eventPredicateField(rule.source, predicate.field)
      check(
        'predicate',
        !!field && eventPredicateMatches(predicate, field, fact.data),
        `${predicate.field} ${predicate.op}: ${predicate.op === 'exists' ? 'missing and null are absent.' : 'requires a present, correctly typed value.'}`
      )
    }
    check(
      'audience',
      matchesAudience(integration, fact, login, filters.audience),
      integration !== 'github' || filters.audience === 'any'
        ? 'No account-involvement restriction.'
        : filters.audience === 'connected-account' && fact.output === 'pull_request.review_requested'
          ? 'Review requested from this account or a team delivered to this connection.'
          : filters.audience === 'connected-account' && ['issue.assigned', 'issue.unassigned'].includes(fact.output)
            ? 'Assigned or unassigned login must be the connected account.'
            : 'Connected account must be assigned or @mentioned; self and bot authors do not match.'
    )
    if (checks.every((check) => check.passed)) {
      selected = rule
      result.status = 'selected'
      preview.selectedRuleId = rule.id
      preview.action = rule.action.type
    }
  }
  return { selected, preview }
}

function matchesAudience(
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  audience: SquadEventRule['filters']['audience']
) {
  const data = record(fact.data)
  if (integration !== 'github' || audience === 'any') return true
  if (!login) return false
  if (audience === 'connected-account') {
    if (fact.output === 'pull_request.review_requested')
      return !!data.requestedTeam || String(data.requestedReviewer).toLowerCase() === login.toLowerCase()
    if (['issue.assigned', 'issue.unassigned'].includes(fact.output))
      return String(data.assignee).toLowerCase() === login.toLowerCase()
  }
  if (String(data.actor).toLowerCase() === login.toLowerCase() || data.actorType === 'Bot') return false
  const mention = new RegExp(`(^|[^a-zA-Z0-9_])@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9_-])`, 'i')
  return (
    strings(data.assignees).some((assignee) => assignee.toLowerCase() === login.toLowerCase()) ||
    mention.test(fact.body)
  )
}

export function eventRuleWorkflow(rule: SquadEventRule, metadata: unknown): WorkflowSource {
  return (
    (rule.action.type === 'start-workstream' && rule.action.workflow) ||
    record(metadata).workflow || { kind: 'preset', id: 'solo', customizations: [] }
  )
}
