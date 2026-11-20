import {
  eventRulePredicateSchema,
  validateEventPredicates,
  eventPredicateMatches,
  eventDecisionPredicateMatches,
  isEventDecisionPredicate,
  type EventDecisionOutcome,
  type EventDecisionPredicate,
  type EventPredicate,
} from './event-predicates'
import { eventPredicateField } from './event-predicate-catalog'
import { z } from 'zod'
import { boundedRecord, keyedRecord } from './zod-helpers'
import { integrationSubscriptionSchema, integrationValueAt, type IntegrationOutputFact } from './integration-outputs'
import { workflowEventTriggerSchema, workflowSourceSchema, type WorkflowSource } from './workflows'

export const squadEventRuleSchema = z
  .strictObject({
    id: workflowEventTriggerSchema.shape.id,
    enabled: z.boolean().default(true),
    source: integrationSubscriptionSchema.shape.source,
    match: workflowEventTriggerSchema.shape.match.optional(),
    predicates: z.array(eventRulePredicateSchema).max(16).optional(),
    filters: z.strictObject({
      squadRouting: z.boolean().default(false),
      repository: z.string().trim().max(200).optional(),
      labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      teamId: z.string().trim().max(200).optional(),
      audience: z.enum(['connected-account', 'assigned-or-mentioned', 'any']).default('connected-account'),
    }),
    action: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('notify-manager'), additionalContext: z.string().trim().max(10000).optional() }),
      z.strictObject({
        type: z.literal('notify-consultant'),
        additionalContext: z.string().trim().max(10000).optional(),
      }),
      z.strictObject({ type: z.literal('ignore') }),
      z.strictObject({
        type: z.literal('start-workstream'),
        workflow: workflowSourceSchema.optional(),
        titlePrefix: z.string().max(100).optional(),
        additionalContext: z.string().trim().max(10000).optional(),
        metadata: workflowEventTriggerSchema.shape.create.shape.metadata.optional(),
      }),
    ]),
  })
  .superRefine((rule, ctx) => {
    if (rule.predicates?.length) validateEventPredicates(rule.source, rule.predicates, ctx)
  })
export type SquadEventRule = z.infer<typeof squadEventRuleSchema>
export const squadEventRulesSchema = boundedRecord(
  keyedRecord(
    z.string().regex(/^[a-z][a-z0-9-]*$/),
    z
      .array(squadEventRuleSchema)
      .max(32)
      .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Duplicate event rule ID')
  ),
  256
).superRefine((providers, ctx) => {
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
/** GitHub label names are unique regardless of case, so label filters, like label conditions, ignore case. */
function labelsOverlap(wanted: string[], labels: unknown): boolean {
  const present = new Set(strings(labels).map((label) => label.toLowerCase()))
  return wanted.some((label) => present.has(label.toLowerCase()))
}
export function matchesGitHubRouting(metadata: unknown, repository: unknown, labels?: unknown): boolean {
  return (
    typeof repository === 'string' &&
    Array.isArray(record(metadata).github) &&
    record(metadata).github.some(
      (route: any) =>
        typeof route?.repo === 'string' &&
        eventRepositoryMatches(route.repo, repository) &&
        (labels === undefined || !strings(route.labels).length || labelsOverlap(strings(route.labels), labels))
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
        ? LINEAR_DEFAULT_RULES
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

/**
 * Linear defaults mirror GitHub's: account-bound changes and mentions notify the manager. `issue.created`,
 * `issue.updated` and `agent_session.created` have no default (`agent_session.created` always pairs with a
 * delegated or mentioned fact).
 */
const LINEAR_DEFAULT_RULES: string[][] = [
  ['issue.assigned', 'notify-manager', 'connected-account'],
  ['issue.unassigned', 'notify-manager', 'connected-account'],
  ['issue.delegated', 'notify-manager', 'connected-account'],
  ['issue.undelegated', 'notify-manager', 'connected-account'],
  ['issue.mentioned', 'notify-manager', 'assigned-or-mentioned'],
  ['issue.comment', 'notify-manager', 'assigned-or-mentioned'],
  ['agent_session.prompted', 'notify-manager', 'connected-account'],
]
/** IDs of the default Linear rules, for offering them to squads whose stored rules predate them. */
export const LINEAR_DEFAULT_RULE_IDS = LINEAR_DEFAULT_RULES.map(
  ([output]) => `linear-${output!.replaceAll('_', '-').replaceAll('.', '-')}`
)

/**
 * Linear turns the app's own `response`, `elicitation` and `error` activities into comments, and agents comment
 * through the CLI, so a comment authored by the connected account must never start another turn.
 */
export function isLinearSelfComment(fact: IntegrationOutputFact, account: string): boolean {
  if (!account || fact.output !== 'issue.comment') return false
  // The author (who wrote it) or the actor (who triggered this delivery, e.g. an edit) being the account.
  return fact.data.actor === account || record(fact.data.comment).author === account
}

/** Delivery reason for a comment GitHub attributes to Ficus's GitHub App acting as the connected account. */
export const GITHUB_SELF_COMMENT_APP_REASON = 'Skipped: written by Ficus through its GitHub App'
/**
 * Delivery reason for a comment GitHub attributes to another GitHub App acting as the connected account.
 * Ficus cannot rule out its own write through an app it no longer recognizes (for example a connection
 * still bound to an earlier custom app), so it keeps the echo guard.
 */
export const GITHUB_SELF_COMMENT_OTHER_APP_REASON =
  'Skipped: written by the connected GitHub account through another GitHub App'
/**
 * Delivery reason for a review or review comment by the connected account. GitHub does not say which app
 * wrote these, so Ficus cannot tell its own from the person's and treats them as its own.
 */
export const GITHUB_SELF_COMMENT_ACCOUNT_REASON =
  'Skipped: written by the connected GitHub account, and GitHub does not say whether Ficus wrote it'

/** Which GitHub App wrote a comment, as normalization records it in `viaApp`. */
export type GitHubCommentApp = 'none' | 'ficus' | 'other'

/**
 * Why a comment or review is an echo of Ficus's own write, or undefined when it is not one.
 *
 * Ficus writes as the connected account through its GitHub App, but the person who owns that account
 * can also comment as themselves. Issue and pull request comments carry the app that wrote them, which
 * normalization records as `viaApp`: `none` (a person typing as themselves) is delivered, `ficus` and
 * `other` are skipped, the latter because it may be Ficus's own write through an app it no longer knows.
 * Reviews and review comments carry no such attribution (and facts stored before it existed lack the
 * field), so for those the login alone still decides: loop protection outranks delivery.
 */
export function githubSelfCommentReason(fact: IntegrationOutputFact, login: string): string | undefined {
  if (
    !login ||
    !['issue.comment', 'pull_request.comment', 'pull_request.reviewed', 'pull_request.review_comment'].includes(
      fact.output
    ) ||
    typeof fact.data.actor !== 'string' ||
    fact.data.actor.toLowerCase() !== login.toLowerCase()
  )
    return undefined
  const viaApp = record(fact.data).viaApp
  if (viaApp === 'none') return undefined
  if (viaApp === 'ficus') return GITHUB_SELF_COMMENT_APP_REASON
  if (viaApp === 'other') return GITHUB_SELF_COMMENT_OTHER_APP_REASON
  return GITHUB_SELF_COMMENT_ACCOUNT_REASON
}

/** Comment/review echoes of Ficus's own writes must not start another agent turn. */
export function isGitHubSelfComment(fact: IntegrationOutputFact, login: string): boolean {
  return githubSelfCommentReason(fact, login) !== undefined
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
    | 'decision'
  description: string
  passed: boolean
}
export interface SquadEventRulePreview {
  selectedRuleId: string | null
  action: SquadEventRule['action']['type'] | null
  suppression: 'self-comment' | null
  /** A rule whose other checks passed but whose decision conditions have no outcome yet. */
  awaitingDecisionRuleId: string | null
  rules: Array<{
    id: string
    position: number
    status:
      | 'disabled'
      | 'not-matched'
      | 'selected'
      | 'shadowed'
      | 'suppressed'
      | 'awaiting-decision'
      /** After a rule awaiting a decision: whether it is reached depends on that answer. */
      | 'not-evaluated'
    checks: EventRuleCheck[]
  }>
}

/**
 * Supplies the outcomes of a rule's decision conditions (aligned with `predicates`), or undefined when they
 * have not been asked. Asked only for a rule whose every other check passed, in rule order.
 */
export type EventRuleDecisions = (
  rule: SquadEventRule,
  predicates: EventDecisionPredicate[]
) => EventDecisionOutcome[] | undefined

/** Preview helper: answer every decision condition with the same assumption instead of asking a model. */
export const assumeEventRuleDecisions =
  (matches: boolean): EventRuleDecisions =>
  (_rule, predicates) =>
    predicates.map(() => ({ assumed: matches }))

/** Read-only rule selection, NOT a promise of delivery: runtime authorization, subscriptions and receipts still apply.
 * Reports contain no event values, bodies, configured operands, workflow metadata or additional instructions.
 */
export function previewSquadEventRules(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string,
  decisions?: EventRuleDecisions
): SquadEventRulePreview {
  return evaluateSquadEventRules(metadata, integration, fact, login, connectionId, decisions).preview
}
/** Undefined when no rule matches, or when a rule's decision conditions are still unanswered. */
export function selectSquadEventRule(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string,
  decisions?: EventRuleDecisions
) {
  return evaluateSquadEventRules(metadata, integration, fact, login, connectionId, decisions).selected
}

/**
 * Stored array order is authoritative. Both preview and live dispatch use this single evaluation path.
 * Synchronous: a rule whose decision conditions `decisions` cannot answer stops selection and is returned
 * as `pending`, so an async caller can ask the model and evaluate again (see Core's event-rule decisions).
 */
export function evaluateSquadEventRules(
  metadata: unknown,
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  connectionId?: string,
  decisions?: EventRuleDecisions
): {
  selected: SquadEventRule | undefined
  preview: SquadEventRulePreview
  pending?: { rule: SquadEventRule; predicates: EventDecisionPredicate[] }
} {
  const suppression =
    (integration === 'github' && isGitHubSelfComment(fact, login)) ||
    (integration === 'linear' && isLinearSelfComment(fact, login))
      ? 'self-comment'
      : null
  const preview: SquadEventRulePreview = {
    selectedRuleId: null,
    action: null,
    suppression,
    awaitingDecisionRuleId: null,
    rules: [],
  }
  let selected: SquadEventRule | undefined
  let pending: { rule: SquadEventRule; predicates: EventDecisionPredicate[] } | undefined
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
    if (pending) {
      result.status = 'not-evaluated'
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
        labelsOverlap(filters.labels, data.labels),
        'At least one per-rule label must be present (case-insensitive).'
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
      if (isEventDecisionPredicate(predicate)) continue
      const field = eventPredicateField(rule.source, predicate.field)
      check(
        'predicate',
        !!field && eventPredicateMatches(predicate, field, fact.data),
        `${predicate.field} ${predicate.op}: ${predicateCheckDescription(predicate.op)}`
      )
    }
    check(
      'audience',
      matchesAudience(integration, fact, login, filters.audience),
      integration === 'linear' && filters.audience !== 'any'
        ? linearAudienceDescription(fact.output, filters.audience, login)
        : integration !== 'github' || filters.audience === 'any'
          ? 'No account-involvement restriction.'
          : filters.audience === 'connected-account' && fact.output === 'pull_request.review_requested'
            ? 'Review requested from this account or a team delivered to this connection.'
            : filters.audience === 'connected-account' && ['issue.assigned', 'issue.unassigned'].includes(fact.output)
              ? 'Assigned or unassigned login must be the connected account.'
              : 'Connected account must be assigned or @mentioned; self and bot authors do not match.'
    )
    // Decision conditions cost a model call: asked last, only once every other check has passed.
    const decisionPredicates = (rule.predicates ?? []).filter(isEventDecisionPredicate)
    if (decisionPredicates.length && checks.every((check) => check.passed)) {
      const outcomes = decisions?.(rule, decisionPredicates)
      if (!outcomes) {
        pending = { rule, predicates: decisionPredicates }
        result.status = 'awaiting-decision'
        preview.awaitingDecisionRuleId = rule.id
        continue
      }
      decisionPredicates.forEach((predicate, index) => {
        const outcome: EventDecisionOutcome = outcomes[index] ?? { unavailable: 'unavailable' }
        check(
          'decision',
          eventDecisionPredicateMatches(predicate, outcome),
          decisionCheckDescription(predicate, outcome)
        )
      })
    }
    if (checks.every((check) => check.passed)) {
      selected = rule
      result.status = 'selected'
      preview.selectedRuleId = rule.id
      preview.action = rule.action.type
    }
  }
  return { selected, preview, ...(pending ? { pending } : {}) }
}

/** Explains a field condition's semantics without disclosing its operand or the event's value. */
function predicateCheckDescription(op: EventPredicate['op']) {
  if (op === 'exists') return 'missing and null are absent.'
  if (op === 'contains') return 'requires a present collection with an exact member; empty collections do not match.'
  if (op === 'not-contains')
    return 'requires a present collection without that member; empty collections match, missing and null do not.'
  return 'requires a present, correctly typed value.'
}

/** Says how the outcome was reached, never the event's content or the answer's numbers. */
function decisionCheckDescription(predicate: EventDecisionPredicate, outcome: EventDecisionOutcome) {
  const asked = `Decision model (${predicate.question.type})`
  if ('assumed' in outcome) return `${asked}: assumed ${outcome.assumed ? 'to match' : 'not to match'} in this preview.`
  if ('unavailable' in outcome)
    return `${asked}: ${outcome.unavailable === 'unconfigured' ? 'no provider configured' : 'no answer in time'}; on unavailable, ${predicate.onUnavailable}.`
  return outcome.answer.type === 'refusal'
    ? `${asked}: the model declined to answer.`
    : `${asked}: answer must satisfy the condition.`
}

function matchesAudience(
  integration: string,
  fact: IntegrationOutputFact,
  login: string,
  audience: SquadEventRule['filters']['audience']
) {
  const data = record(fact.data)
  if (audience === 'any') return true
  if (integration === 'linear') return matchesLinearAudience(fact, login, audience)
  if (integration !== 'github') return true
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

const LINEAR_SESSION_OUTPUTS = ['agent_session.created', 'agent_session.prompted']
const LINEAR_DELEGATION_OUTPUTS = ['issue.delegated', 'issue.undelegated']
const LINEAR_ASSIGNMENT_OUTPUTS = ['issue.assigned', 'issue.unassigned']

/**
 * `account` is the connection's Linear user ID: the app user for an app connection, or the API key's viewer
 * recorded on the event's authority. An event recorded without one (before account binding existed) keeps the
 * old Linear behavior of no account restriction; ingress already bound the account for those.
 */
/** Outputs that existed before account binding; events of these without an account keep the old behavior. */
const LINEAR_LEGACY_OUTPUTS = ['issue.assigned', 'issue.unassigned', 'issue.updated', 'issue.comment']

function matchesLinearAudience(
  fact: IntegrationOutputFact,
  account: string,
  audience: 'connected-account' | 'assigned-or-mentioned'
) {
  // Fail closed for the newer outputs: an ingress that forgot the account must not match everything.
  if (!account) return LINEAR_LEGACY_OUTPUTS.includes(fact.output)
  const data = record(fact.data)
  if (audience === 'connected-account') {
    if (LINEAR_ASSIGNMENT_OUTPUTS.includes(fact.output)) return data.assignee === account
    if (LINEAR_DELEGATION_OUTPUTS.includes(fact.output)) return data.delegate === account
    if (LINEAR_SESSION_OUTPUTS.includes(fact.output)) return record(data.session).appUserId === account
  }
  if (data.actor === account || data.actorType === 'app') return false
  // A comment in one of the account's agent session threads is already routed as a mention or a prompt.
  if (fact.output === 'issue.comment' && record(data.session).id) return false
  return fact.output === 'issue.mentioned' || data.assignee === account || data.delegate === account
}

function linearAudienceDescription(output: string, audience: string, account: string) {
  if (!account)
    return LINEAR_LEGACY_OUTPUTS.includes(output)
      ? 'No connected account recorded for this event: no account-involvement restriction.'
      : 'No connected account recorded for this event, so account involvement cannot match.'
  if (audience === 'connected-account') {
    if (LINEAR_ASSIGNMENT_OUTPUTS.includes(output)) return 'Assigned or unassigned user must be the connected account.'
    if (LINEAR_DELEGATION_OUTPUTS.includes(output))
      return 'Delegated or undelegated agent must be the connected account.'
    if (LINEAR_SESSION_OUTPUTS.includes(output)) return 'Agent session must belong to the connected account.'
  }
  return 'Connected account must be @mentioned, or the issue’s assignee or delegate; self and app authors do not match.'
}

export function eventRuleWorkflow(rule: SquadEventRule, metadata: unknown): WorkflowSource {
  return (
    (rule.action.type === 'start-workstream' && rule.action.workflow) ||
    record(metadata).workflow || { kind: 'preset', id: 'solo', customizations: [] }
  )
}
