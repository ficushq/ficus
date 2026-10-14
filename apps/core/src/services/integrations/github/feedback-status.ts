import { z } from 'zod'
import type { IntegrationOutputFact } from '@ficus/shared'
import { DEPENDABOT_ACTIONS } from './dependabot-output'

const id = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)))
const nativeId = z.number().int().positive().safe()
const repository = z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/)
const sha = z.string().regex(/^[0-9a-f]{40,64}$/)
const pr = z.object({ number: nativeId, headSha: sha.optional() }).strict()
const base = { repository, repositoryId: nativeId, projection: z.literal('status') }
const lifecycle = z
  .object({
    ...base,
    action: z.enum(['closed', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft']),
    state: z.enum(['open', 'closed', 'merged', 'unknown']),
    pullRequest: pr,
    pullRequestState: z.enum(['open', 'closed', 'merged', 'unknown']),
    draft: z.boolean().optional(),
    mergeConflict: z.literal(true).optional(),
  })
  .strict()
const ci = z
  .object({
    ...base,
    action: z.literal('completed'),
    state: z.enum([
      'success',
      'failure',
      'neutral',
      'cancelled',
      'skipped',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
    ]),
    pullRequest: pr,
    ci: z
      .object({
        workflowId: id,
        runId: id,
        runNumber: z.union([id, z.literal('')]),
        runAttempt: z.union([id, z.literal('')]),
      })
      .strict(),
  })
  .strict()
const security = z
  .object({
    ...base,
    action: z.string().refine((value) => DEPENDABOT_ACTIONS.includes(value)),
    state: z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    alert: z
      .object({
        number: nativeId,
        externalId: z.string(),
        advisoryId: z
          .string()
          .regex(/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i)
          .optional(),
      })
      .strict(),
  })
  .strict()

/** One allowlisted factual renderer shared by normalization and stored-proof validation. */
export function buildGitHubStatus(
  input: Pick<IntegrationOutputFact, 'output' | 'version' | 'eventKey' | 'occurredAt' | 'data' | 'ordering'>
): IntegrationOutputFact | null {
  if (input.version !== 1 || !Number.isFinite(Date.parse(input.occurredAt))) return null
  const identity = {
    output: input.output,
    version: input.version,
    eventKey: input.eventKey,
    occurredAt: input.occurredAt,
  }
  if (input.output === 'dependabot_alert.updated') {
    const parsed = security.safeParse(input.data)
    if (!parsed.success) return null
    const data = parsed.data,
      alert = data.alert
    if (alert.externalId !== `${data.repositoryId}:${alert.number}`) return null
    const url = `https://github.com/${data.repository}/security/dependabot/${alert.number}`
    return {
      ...identity,
      resourceKey: `dependabot:${alert.externalId}`,
      data,
      subject: `Dependabot ${data.severity}: ${data.repository} alert ${alert.number}`,
      body: [
        `Dependabot alert ${alert.number}: ${data.severity} (${data.state}; ${data.action}).`,
        alert.advisoryId ? `Advisory: ${alert.advisoryId}.` : '',
        url,
        'Provider state is not remediation acceptance or work completion.',
      ]
        .filter(Boolean)
        .join('\n'),
      url,
      ...(input.ordering ? { ordering: { key: alert.externalId, position: [Date.parse(input.occurredAt)] } } : {}),
    }
  }
  const isCI = input.output === 'pull_request.ci_completed'
  if (!isCI && !['pull_request.updated', 'pull_request.closed', 'pull_request.merged'].includes(input.output))
    return null
  const parsed = isCI ? ci.safeParse(input.data) : lifecycle.safeParse(input.data)
  if (!parsed.success) return null
  const data = parsed.data
  if (
    'pullRequestState' in data &&
    (data.pullRequestState !== data.state ||
      (input.output === 'pull_request.merged' && data.state !== 'merged') ||
      (input.output === 'pull_request.closed' && data.state !== 'closed'))
  )
    return null
  const workflow = 'ci' in data ? data.ci : null
  const resourceUrl = `https://github.com/${data.repository}/pull/${data.pullRequest.number}`
  const url = workflow ? `https://github.com/${data.repository}/actions/runs/${workflow.runId}` : resourceUrl
  const headSha = data.pullRequest.headSha
  if (
    input.ordering &&
    (!workflow ||
      input.ordering.position.length !== 2 ||
      input.ordering.position.some((value) => !Number.isSafeInteger(value) || value < 0))
  )
    return null
  return {
    ...identity,
    resourceKey: `${data.repository}#${data.pullRequest.number}`,
    data,
    subject: workflow
      ? `CI ${data.state}: ${data.repository} · Workflow ${workflow.workflowId}`
      : `Pull request ${data.state}: ${data.repository} ${data.pullRequest.number}`,
    body: [
      workflow
        ? `Workflow ${workflow.workflowId}: ${data.state}.`
        : `Pull request ${data.pullRequest.number}: ${data.state} (${data.action}).`,
      headSha ? `Head: ${headSha}` : '',
      url,
    ]
      .filter(Boolean)
      .join('\n'),
    url,
    ...(workflow && input.ordering
      ? { ordering: { key: workflow.workflowId, position: input.ordering.position } }
      : {}),
  }
}
