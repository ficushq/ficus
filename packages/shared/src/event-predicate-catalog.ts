import type { IntegrationOutputDescriptor, IntegrationOutputField } from './integration-outputs'

const fields: IntegrationOutputDescriptor['fields'] = {
  repository: { type: 'string', normalize: 'lowercase', description: 'Repository owner/name.' },
  'pullRequest.number': { type: 'number', description: 'Pull request number.' },
  'pullRequest.author': {
    type: 'string',
    normalize: 'lowercase',
    description: 'Pull request author login, when supplied by GitHub (not the event actor).',
  },
  'pullRequest.authorType': {
    type: 'string',
    description: 'Pull request author account type: User or Bot, when supplied.',
  },
  'pullRequest.headSha': { type: 'string', description: 'Pull request head commit, when supplied.' },
  'issue.number': { type: 'number', description: 'Issue number.' },
  'issue.title': { type: 'string', description: 'Issue title.' },
  assignee: { type: 'string', normalize: 'lowercase', description: 'Assigned or unassigned GitHub login.' },
  action: { type: 'string', description: 'Native event action.' },
  actor: { type: 'string', normalize: 'lowercase', description: 'Actor login.' },
  state: { type: 'string', description: 'Review state or CI conclusion.' },
  requestedReviewer: { type: 'string', normalize: 'lowercase', description: 'Requested reviewer login.' },
  requestedTeam: { type: 'string', description: 'Requested reviewer team.' },
  workflow: { type: 'string', description: 'CI workflow name.' },
}
const dependabotFields: IntegrationOutputDescriptor['fields'] = {
  repository: fields.repository!,
  repositoryId: { type: 'number', description: 'Immutable GitHub repository ID.' },
  action: fields.action!,
  state: { type: 'string', description: 'Alert state: open, fixed, dismissed, auto_dismissed.' },
  severity: { type: 'string', description: 'Severity: low, medium, high, critical.' },
  'alert.number': { type: 'number', description: 'Dependabot alert number.' },
  'alert.externalId': { type: 'string', description: 'Immutable repository ID and alert number.' },
  'alert.advisoryId': { type: 'string', description: 'GitHub advisory ID (GHSA).' },
  'alert.package': { type: 'string', description: 'Dependency package name.' },
  'alert.ecosystem': { type: 'string', description: 'Dependency ecosystem.' },
  'alert.manifest': { type: 'string', description: 'Dependency manifest path.' },
  'alert.affectedRange': { type: 'string', description: 'Vulnerable version range.' },
  'alert.patchedVersion': { type: 'string', description: 'First patched version, empty if unavailable.' },
  'alert.groupKey': { type: 'string', description: 'Same repository, advisory and package across manifests.' },
}
const outputs = {
  'issue.assigned': 'Issue assigned',
  'issue.unassigned': 'Issue unassigned',
  'issue.updated': 'Issue updated',
  'issue.comment': 'Issue comment',
  'pull_request.updated': 'Pull request updated',
  'pull_request.merged': 'Pull request merged',
  'pull_request.closed': 'Pull request closed',
  'pull_request.review_requested': 'Review requested',
  'pull_request.reviewed': 'Review submitted',
  'pull_request.comment': 'Pull request comment',
  'pull_request.review_comment': 'Review line comment',
  'pull_request.ci_completed': 'CI completed',
  'dependabot_alert.updated': 'Dependabot alert',
}

export type EventPredicateField = Omit<IntegrationOutputField, 'type'> & {
  type: IntegrationOutputField['type'] | 'string[]'
}
const collectionFields: Record<string, EventPredicateField> = {
  labels: { type: 'string[]', normalize: 'lowercase', description: 'Issue or pull request labels.' },
  assignees: { type: 'string[]', normalize: 'lowercase', description: 'Assigned GitHub logins.' },
  actorType: { type: 'string', description: 'Actor account type, e.g. User or Bot.' },
  mergeConflict: { type: 'boolean', description: 'True when GitHub reports a merge conflict; otherwise absent.' },
  path: { type: 'string', description: 'Reviewed file path.' },
  line: { type: 'number', description: 'Reviewed line; absent or null for an outdated comment.' },
}
function githubPredicateFields(output: string): Record<string, EventPredicateField> {
  const paths = ['repository', 'action', 'actor', 'actorType']
  if (output.startsWith('issue.')) paths.push('issue.number', 'issue.title')
  else paths.push('pullRequest.number', 'pullRequest.headSha', 'pullRequest.author', 'pullRequest.authorType')
  if (output !== 'pull_request.ci_completed') paths.push('labels', 'assignees')
  if (['issue.assigned', 'issue.unassigned'].includes(output)) paths.push('assignee')
  if (output === 'pull_request.review_requested') paths.push('requestedReviewer', 'requestedTeam')
  if (output === 'pull_request.reviewed' || output === 'pull_request.ci_completed') paths.push('state')
  if (output === 'pull_request.ci_completed') paths.push('workflow')
  if (output === 'pull_request.updated') paths.push('mergeConflict')
  if (output === 'pull_request.review_comment') paths.push('path', 'line')
  return Object.fromEntries(paths.map((path) => [path, fields[path] ?? collectionFields[path]!]))
}

/** Subscription fields remain backward compatible; predicates use a narrower event-specific allowlist. */
export const githubOutputCatalog: IntegrationOutputDescriptor[] = Object.entries(outputs).map(([output, title]) => ({
  integration: 'github',
  output,
  version: 1,
  title,
  description: title + ' from GitHub webhooks or polling.',
  fields: output === 'dependabot_alert.updated' ? dependabotFields : fields,
  predicateFields: output === 'dependabot_alert.updated' ? dependabotFields : githubPredicateFields(output),
}))
const linearFields: Record<string, IntegrationOutputField> = {
  'issue.id': { type: 'string', description: 'Linear issue ID.' },
  'issue.number': { type: 'number', description: 'Linear issue number, scoped to its team.' },
  'issue.identifier': { type: 'string', description: 'Linear issue identifier, e.g. ENG-123.' },
  'issue.title': { type: 'string', description: 'Issue title.' },
  teamId: { type: 'string', description: 'Linear team ID.' },
  teamKey: { type: 'string', normalize: 'lowercase', description: 'Linear team key, e.g. ENG.' },
  assignee: { type: 'string', description: 'Assigned Linear user ID.' },
  action: { type: 'string', description: 'Native Linear event action.' },
  actor: { type: 'string', description: 'Acting Linear user ID.' },
  state: { type: 'string', description: 'Linear workflow state type (e.g. completed, canceled, started).' },
  delegate: { type: 'string', description: 'Linear user ID of the agent the issue is delegated to.' },
  actorType: {
    type: 'string',
    description: 'Acting Linear account type, from a live lookup: user, guest, app or unknown.',
  },
}
/** Fields only some Linear outputs carry; see `linearOutputExtras`. */
const linearExtraFields: Record<string, IntegrationOutputField> = {
  previousDelegate: { type: 'string', description: 'Linear user ID of the previous delegate, when there was one.' },
  'session.id': { type: 'string', description: 'Linear agent session ID.' },
  'session.url': { type: 'string', description: 'Linear agent session URL.' },
  'session.trigger': {
    type: 'string',
    description:
      'What opened the agent session: delegation, mention, or unknown when no person can be attributed and the issue is not delegated to the app.',
  },
  'session.creator': { type: 'string', description: 'Linear user ID of the person who opened the session.' },
  'session.appUserId': { type: 'string', description: 'Linear user ID of the agent app the session belongs to.' },
  'comment.id': { type: 'string', description: 'Linear comment ID.' },
  'comment.parentId': { type: 'string', description: 'Linear ID of the comment this one replies to.' },
  'comment.author': { type: 'string', description: 'Linear user ID of the comment author.' },
  'comment.inSession': {
    type: 'boolean',
    absent: false,
    description:
      'Whether the comment is in a thread of one of this app\u2019s agent sessions; such comments also arrive as agent_session.prompted.',
  },
  'activity.id': { type: 'string', description: 'Linear agent activity ID of the prompt.' },
  'prompt.signal': { type: 'string', description: 'Signal sent with the prompt: stop, or empty.' },
}
const linearOutputs: Record<string, string> = {
  'issue.assigned': 'Issue assigned',
  'issue.unassigned': 'Issue unassigned',
  'issue.updated': 'Issue updated',
  'issue.comment': 'Issue comment',
  'issue.delegated': 'Issue delegated',
  'issue.undelegated': 'Issue undelegated',
  'issue.mentioned': 'Agent mentioned',
  'issue.created': 'Issue created',
  'agent_session.created': 'Agent session created',
  'agent_session.prompted': 'Agent session prompted',
}
const linearOutputExtras: Record<string, string[]> = {
  'issue.comment': ['comment.id', 'comment.parentId', 'comment.author', 'comment.inSession', 'session.id'],
  'issue.delegated': ['previousDelegate', 'session.id'],
  'issue.mentioned': ['comment.id', 'session.id'],
  'agent_session.created': [
    'session.id',
    'session.url',
    'session.trigger',
    'session.creator',
    'session.appUserId',
    'comment.id',
  ],
  'agent_session.prompted': ['session.id', 'session.appUserId', 'activity.id', 'prompt.signal', 'comment.id'],
}
/** Outputs only the Linear agent app's session webhooks produce (an `issue.delegated` can also come from an issue update). */
const linearSessionOutputs = new Set(['issue.mentioned', 'agent_session.created', 'agent_session.prompted'])
/**
 * The agent app's polling fallback recovers sessions and prompts (and the delegation or mention a
 * session reports) and the app's own undelegation. Issue and comment changes, and every API-key
 * connection, depend on webhook delivery alone.
 */
function linearOutputDescription(output: string, title: string) {
  if (linearSessionOutputs.has(output))
    return `${title} from Linear agent app webhooks, or from polling when a webhook is missed.`
  if (output === 'issue.delegated')
    return `${title} from Linear webhooks. Delegations to the Ficus app are also recovered by polling.`
  if (output === 'issue.undelegated')
    return `${title} from Linear webhooks. The Ficus app's own undelegations are also recovered by polling.`
  return `${title} from Linear webhooks only; polling does not recover it.`
}
export const linearOutputCatalog: IntegrationOutputDescriptor[] = Object.entries(linearOutputs).map(
  ([output, title]) => {
    const fields = {
      ...linearFields,
      ...Object.fromEntries((linearOutputExtras[output] ?? []).map((path) => [path, linearExtraFields[path]!])),
    }
    return {
      integration: 'linear',
      output,
      version: 1,
      title,
      description: linearOutputDescription(output, title),
      fields,
      predicateFields: {
        ...fields,
        labels: { type: 'string[]', normalize: 'lowercase', description: 'Issue labels.' },
      },
    }
  }
)
export function eventPredicateFields(source: { integration: string; output: string; version: number }) {
  return [...githubOutputCatalog, ...linearOutputCatalog].find(
    (event) =>
      event.integration === source.integration && event.output === source.output && event.version === source.version
  )?.predicateFields
}

/** Only own allowlist entries count; Object.prototype names are never event fields. */
export function eventPredicateField(source: { integration: string; output: string; version: number }, path: string) {
  const fields = eventPredicateFields(source)
  return fields && Object.hasOwn(fields, path) ? fields[path] : undefined
}

/**
 * Decision conditions (`kind: 'decision'` predicates) send the event's subject and text plus these fields,
 * where the event has them, unless the condition names its own `input.fields` from the same allowlist.
 */
export const EVENT_DECISION_DEFAULT_FIELDS = ['issue.title', 'actor', 'actorType', 'labels'] as const
export function eventDecisionDefaultFields(source: { integration: string; output: string; version: number }) {
  return EVENT_DECISION_DEFAULT_FIELDS.filter((path) => !!eventPredicateField(source, path))
}
