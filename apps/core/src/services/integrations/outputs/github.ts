import { normalizeDependabot, DEPENDABOT_OUTPUT } from '../github/dependabot-output'
import { createHash } from 'node:crypto'
import { githubOutputCatalog, isGitHubSelfComment, type IntegrationOutputFact } from '@ficus/shared'
import type { IntegrationOutputAdapter } from './types'

const outputTitles = Object.fromEntries(githubOutputCatalog.map((event) => [event.output, event.title]))

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The adapter describes GitHub facts. It knows nothing about Ficus agents or flow routing. */
export const githubOutputAdapter: IntegrationOutputAdapter = {
  integration: 'github',
  catalog: githubOutputCatalog,
  workStreamBindings(fact) {
    if (fact.output === DEPENDABOT_OUTPUT) return {}
    // Issues are linked through `metadata.tracked`, so only pull requests bind an identity here.
    return {
      'github.repo': { event: 'repository' },
      ...(fact.data.pullRequest ? { 'github.pr.number': { event: 'pullRequest.number' } } : {}),
    }
  },
  workStreamMatch(fact) {
    return fact.output === DEPENDABOT_OUTPUT
      ? { 'alert.externalId': { value: String(record(fact.data.alert)?.externalId ?? '') } }
      : undefined
  },
  trackedResource(fact) {
    const repository = typeof fact.data.repository === 'string' ? fact.data.repository : ''
    if (fact.output === DEPENDABOT_OUTPUT) {
      const alert = record(fact.data.alert)
      if (!alert || !Number.isSafeInteger(alert.number) || !Number.isSafeInteger(fact.data.repositoryId)) return null
      return {
        integration: 'github',
        repository,
        kind: 'dependabot_alert',
        number: alert.number,
        externalId: alert.externalId,
        url: fact.url,
      }
    }
    const pullRequest = record(fact.data.pullRequest)
    const issue = record(fact.data.issue)
    const number = pullRequest?.number ?? issue?.number
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number <= 0) return null
    const kind = pullRequest ? 'pull_request' : 'issue'
    return {
      integration: 'github',
      repository,
      kind,
      number,
      url: `https://github.com/${repository}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`,
    }
  },
  shouldNotify(fact, configuration) {
    return !isGitHubSelfComment(fact, String(record(configuration)?.login ?? ''))
  },
  notificationBody(fact) {
    // Feedback and CI already describe the event itself, not the parent resource.
    // Keep their text intact (including edited comments and review-thread links).
    if (
      ![
        'issue.assigned',
        'issue.unassigned',
        'issue.updated',
        'pull_request.review_requested',
        'pull_request.updated',
        'pull_request.closed',
        'pull_request.merged',
      ].includes(fact.output)
    )
      return fact.body
    const resource = githubOutputAdapter.trackedResource?.(fact)
    if (!resource?.url) return fact.body
    const data = fact.data
    // An initial assignment/request can start work without any earlier context.
    if (['issue.assigned', 'pull_request.review_requested'].includes(fact.output) || data.action === 'opened')
      return fact.body.includes(resource.url) ? fact.body : `${fact.body}\n${resource.url}`

    // Stateless presentation also compacts facts retained before this policy existed.
    // Never parse/truncate the canonical body: it remains evidence for rules/audit.
    const state = data.pullRequestState ?? data.state
    const detail = [...new Set([data.action, state].filter(Boolean))].join('; ')
    const head = record(data.pullRequest)?.headSha
    return [
      `${outputTitles[fact.output]}${data.actor ? ` by ${data.actor}` : ''}${detail ? ` (${detail})` : ''}.`,
      data.action === 'edited' ? 'Details edited; view the current title and description at the resource link.' : '',
      head ? `Head: ${head}` : '',
      data.mergeConflict ? 'Merge conflicts need resolution.' : '',
      resource.url,
    ]
      .filter(Boolean)
      .join('\n')
  },
  normalize(event) {
    if (event.type === 'dependabot_alert') return normalizeDependabot(event)
    const payload = record(event.payload)
    const repository = payload?.repository?.full_name
    if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) return []
    const repo = repository.toLowerCase()
    const native = record(payload!.pull_request) ?? record(payload!.issue)
    const nestedRepo = native?.base?.repo?.full_name
    if (nestedRepo && (typeof nestedRepo !== 'string' || nestedRepo.toLowerCase() !== repo)) return []
    if (payload!.number !== undefined && native?.number !== undefined && payload!.number !== native.number) return []
    const action = typeof payload!.action === 'string' ? payload!.action : ''
    let output: string
    let item = native
    let numbers = [native?.number]
    if (event.type === 'workflow_run') {
      item = record(payload!.workflow_run)
      if (!item || action !== 'completed') return []
      if (typeof item.conclusion !== 'string' || !/^[a-z0-9_-]+$/.test(item.conclusion)) return []
      output = 'pull_request.ci_completed'
      numbers = Array.isArray(item.pull_requests)
        ? item.pull_requests
            .filter(
              (pr: any) =>
                pr &&
                (!pr.base?.repo?.full_name ||
                  (typeof pr.base.repo.full_name === 'string' && pr.base.repo.full_name.toLowerCase() === repo))
            )
            .map((pr: any) => pr.number)
        : []
    } else if (event.type === 'issues' && native && !native.pull_request) {
      output = action === 'assigned' ? 'issue.assigned' : action === 'unassigned' ? 'issue.unassigned' : 'issue.updated'
    } else if (event.type === 'pull_request') {
      if (!native) return []
      output =
        action === 'review_requested'
          ? 'pull_request.review_requested'
          : action === 'closed'
            ? native.merged
              ? 'pull_request.merged'
              : 'pull_request.closed'
            : 'pull_request.updated'
    } else if (event.type === 'pull_request_review') {
      if (action !== 'submitted') return []
      output = 'pull_request.reviewed'
      item = record(payload!.review)
    } else if (event.type === 'pull_request_review_comment') {
      if (!['created', 'edited'].includes(action)) return []
      output = 'pull_request.review_comment'
      item = record(payload!.comment)
    } else if (event.type === 'issue_comment' && native) {
      if (!['created', 'edited'].includes(action)) return []
      output = native.pull_request ? 'pull_request.comment' : 'issue.comment'
      item = record(payload!.comment)
    } else return []
    if (!item) return []
    const timestamp =
      (output === 'pull_request.reviewed'
        ? item.submitted_at
        : output === 'pull_request.merged'
          ? native?.merged_at
          : output === 'pull_request.closed'
            ? native?.closed_at
            : undefined) ??
      item.updated_at ??
      item.submitted_at ??
      item.completed_at ??
      item.created_at
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return []
    const actor = payload!.sender?.login ?? item.user?.login ?? ''
    const url =
      typeof item.html_url === 'string' && item.html_url.startsWith('https://github.com/') ? item.html_url : undefined
    const body = typeof item.body === 'string' ? item.body.slice(0, 24000) : ''
    return [...new Set(numbers)].flatMap((number): IntegrationOutputFact[] => {
      if (!Number.isSafeInteger(number) || number <= 0) return []
      const data = {
        repository: repo,
        ...(output.startsWith('issue.')
          ? { issue: { number, title: String(native?.title ?? '') } }
          : {
              pullRequest: {
                number,
                ...(typeof (native?.head?.sha ?? item!.head_sha) === 'string'
                  ? { headSha: native?.head?.sha ?? item!.head_sha }
                  : {}),
              },
            }),
        assignee: String(payload!.assignee?.login ?? ''),
        action,
        actor: String(actor),
        state: String(item!.conclusion ?? item!.state ?? ''),
        ...(payload!.requested_reviewer?.type
          ? { requestedReviewerType: String(payload!.requested_reviewer.type) }
          : {}),
        ...(typeof native?.head?.ref === 'string' ? { headBranch: native.head.ref } : {}),
        ...(typeof native?.base?.ref === 'string' ? { baseBranch: native.base.ref } : {}),
        // Where the head ref lives: a fork reusing a stream's branch name reports its own repository.
        ...(typeof native?.head?.repo?.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(native.head.repo.full_name)
          ? { headRepository: native.head.repo.full_name.toLowerCase() }
          : {}),
        ...(Array.isArray(native?.requested_reviewers) || Array.isArray(native?.requested_teams)
          ? {
              pendingHumanReview:
                (Array.isArray(native?.requested_reviewers) &&
                  native.requested_reviewers.some((reviewer: any) => reviewer?.type === 'User')) ||
                (Array.isArray(native?.requested_teams) &&
                  native.requested_teams.some((team: any) => typeof team?.slug === 'string' && team.slug.length > 0)),
            }
          : {}),
        ...(typeof native?.updated_at === 'string' && Number.isFinite(Date.parse(native.updated_at))
          ? { snapshotAt: new Date(native.updated_at).toISOString() }
          : {}),
        ...(native && !output.startsWith('issue.')
          ? { pullRequestState: native.merged === true ? 'merged' : String(native.state ?? 'unknown') }
          : {}),
        ...(typeof native?.draft === 'boolean' ? { draft: native.draft } : {}),
        ...(output === 'pull_request.reviewed' && typeof item!.commit_id === 'string'
          ? { reviewedHeadSha: item!.commit_id }
          : {}),
        requestedReviewer: String(payload!.requested_reviewer?.login ?? ''),
        requestedTeam: String(payload!.requested_team?.slug ?? ''),
        actorType: String(payload!.sender?.type ?? item!.user?.type ?? ''),
        labels: Array.isArray(native?.labels)
          ? native.labels.map((label: any) => String(label?.name ?? label)).slice(0, 100)
          : [],
        assignees: Array.isArray(native?.assignees)
          ? native.assignees.map((user: any) => String(user?.login ?? '')).slice(0, 100)
          : [],
        ...(output === 'pull_request.ci_completed'
          ? {
              ci: {
                workflowId: String(item!.workflow_id ?? ''),
                runId: String(item!.id ?? ''),
                runNumber: String(item!.run_number ?? ''),
                runAttempt: String(item!.run_attempt ?? ''),
              },
            }
          : {}),
        ...(output === 'pull_request.review_comment'
          ? { path: String(item!.path ?? ''), line: item!.line ?? item!.original_line ?? null }
          : {}),
        ...(typeof native?.mergeable_state === 'string' ? { mergeState: native.mergeable_state } : {}),
        ...(native?.mergeable_state === 'dirty' ? { mergeConflict: true } : {}),
        workflow: String(item!.name ?? ''),
      }
      const ordering =
        output === 'pull_request.ci_completed' &&
        Number.isSafeInteger(item!.run_number) &&
        Number.isSafeInteger(item!.run_attempt)
          ? { key: String(item!.workflow_id ?? item!.name), position: [item!.run_number, item!.run_attempt] }
          : undefined
      const ci = output === 'pull_request.ci_completed'
      const workflow = data.workflow.trim() || 'Workflow'
      const ciDetails = ci
        ? [
            `${workflow}: ${data.state}`,
            [
              'pullRequest' in data && data.pullRequest.headSha ? `Head: ${data.pullRequest.headSha}` : '',
              // No `#`: in Ficus chat `#<n>` is a work stream.
              data.ci?.runNumber ? `Run ${data.ci.runNumber}` : '',
              data.ci?.runAttempt ? `Attempt ${data.ci.runAttempt}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
            url,
          ]
            .filter(Boolean)
            .join('\n')
        : ''
      return [
        {
          output,
          version: 1,
          resourceKey: `${repo}#${number}`,
          occurredAt: new Date(timestamp).toISOString(),
          eventKey: digest([
            output,
            repo,
            number,
            action,
            item!.id,
            output === 'pull_request.updated' && action === 'synchronize'
              ? (native?.head?.sha ?? timestamp)
              : timestamp,
            data.state,
            data.requestedReviewer,
            data.assignee,
            ordering,
            ...(data.requestedTeam ? [data.requestedTeam] : []),
          ]),
          data,
          subject: ci
            ? `CI ${data.state}: ${repo}#${number} · ${workflow}`
            : `${outputTitles[output]}: ${repo}#${number}`,
          body: ci
            ? ciDetails
            : `${outputTitles[output]}${actor ? ` by ${actor}` : ''}${data.state ? ` (${data.state})` : ''}.${data.mergeConflict ? '\nMerge conflicts need resolution.' : ''}${output === 'pull_request.review_comment' ? `\n${data.path}:${data.line ?? '?'} — reply in this review thread.` : ''}${url ? `\n${url}` : ''}${body ? `\n\n${body}` : ''}`,
          ...(url ? { url } : {}),
          ...(ordering ? { ordering } : {}),
        },
      ]
    })
  },
}
