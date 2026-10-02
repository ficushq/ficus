import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  resolveBranchChangeRequest,
  resolveCodeHostReference,
  type CodeHostReference,
  type IntegrationOutputFact,
} from '@ficus/shared'
import { db, workStreams, workStreamFlowRuns } from '../../../db'
import { recordChangeRequestBinding } from '../../work-streams/change-request-binding'
import { createLogger } from '../../../lib/infra/logger'
import { integrationOutputRegistry } from './registry'

const log = createLogger('delivery-pr-binding')

/** Only these completion modes deliver through a change request that finish verifies. */
const PR_COMPLETION_MODES = ['pr-merge', 'pr-auto-merge']

/** The head identity a pull-request event reports about the pull request it names. */
export interface ChangeRequestHead {
  integration: string
  repository: string
  number: number
  url?: string
  headBranch: string
  headRepository: string
  baseBranch?: string
  merged: boolean
  state: string
}

/**
 * Head identity from one normalized fact, or null when the fact cannot identify a delivery pull
 * request by branch. Only facts that carry the head branch and the head repository qualify (pull
 * request updates, reviews, and review comments); issue comments and CI facts carry neither and
 * are routed once one of those events has bound the pull request.
 */
export function changeRequestHeadFromFact(integration: string, fact: IntegrationOutputFact): ChangeRequestHead | null {
  if (!fact.output.startsWith('pull_request.')) return null
  const resource = integrationOutputRegistry.adapter(integration)?.trackedResource?.(fact)
  if (!resource || resource.kind !== 'pull_request') return null
  const data = fact.data as Record<string, unknown>
  const headBranch = typeof data.headBranch === 'string' ? data.headBranch.trim() : ''
  const headRepository = typeof data.headRepository === 'string' ? data.headRepository.trim().toLowerCase() : ''
  if (!headBranch || !headRepository) return null
  const baseBranch = typeof data.baseBranch === 'string' && data.baseBranch.trim() ? data.baseBranch.trim() : undefined
  const state = typeof data.pullRequestState === 'string' ? data.pullRequestState : ''
  return {
    integration,
    repository: resource.repository.trim().toLowerCase(),
    number: resource.number,
    ...(resource.url ? { url: resource.url } : {}),
    headBranch,
    headRepository,
    ...(baseBranch ? { baseBranch } : {}),
    merged: state === 'merged',
    state: state === 'merged' ? 'closed' : state,
  }
}

export type StreamBranchMatch =
  | { kind: 'none' }
  | { kind: 'bound'; number: number }
  | { kind: 'unbound'; reference: CodeHostReference }

/**
 * Whether a stream's own branch identifies this pull request: same integration and repository
 * (canonical `codeHost` or the legacy `github` shape, never a filesystem path), head branch equal
 * to `metadata.git.branch`, and base equal to `metadata.git.baseBranch` when both are known.
 */
export function matchStreamBranch(metadata: unknown, head: ChangeRequestHead): StreamBranchMatch {
  const reference = resolveCodeHostReference(metadata)
  if (!reference || reference.integration !== head.integration) return { kind: 'none' }
  if (reference.repository.trim().toLowerCase() !== head.repository) return { kind: 'none' }
  const git = (metadata as { git?: { branch?: unknown; baseBranch?: unknown } } | null)?.git
  const branch = typeof git?.branch === 'string' ? git.branch.trim() : ''
  if (!branch || branch !== head.headBranch) return { kind: 'none' }
  const baseBranch = typeof git?.baseBranch === 'string' ? git.baseBranch.trim() : ''
  if (baseBranch && head.baseBranch && baseBranch !== head.baseBranch) return { kind: 'none' }
  return reference.changeRequest
    ? { kind: 'bound', number: reference.changeRequest.number }
    : { kind: 'unbound', reference }
}

/**
 * Bind a delivery pull request to the one work stream whose branch it was opened from, as soon as
 * a code-host event for it is observed (webhook or polling alike), so its feedback routes to the
 * stream during review rather than only after finish resolves it.
 *
 * Conservative by construction, because a wrong binding is worse than no binding: the shared
 * `resolveBranchChangeRequest` policy rejects fork heads, wrong bases, and closed-unmerged pull
 * requests; an existing binding is never overwritten; and when more than one authorized stream
 * claims the branch, nothing binds (finish-time resolution remains the fallback). Nothing is
 * recorded for ambiguity. Only streams the event is authorized for are considered, so a squad's
 * connection never binds another squad's stream. Returns the stream this call bound (empty when
 * nothing bound, including when a stream already carried this pull request).
 */
export async function planChangeRequestBinding(
  integration: string,
  fact: IntegrationOutputFact,
  authorize: (squadId: string) => Promise<boolean>
) {
  const head = changeRequestHeadFromFact(integration, fact)
  if (!head) return null
  const rows = await db
    .select({ id: workStreams.id, squadId: workStreams.squadId, metadata: workStreams.metadata })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .where(
      and(
        inArray(workStreams.status, ['active', 'queued']),
        sql`${workStreams.metadata}->'git'->>'branch' = ${head.headBranch}`,
        sql`${workStreamFlowRuns.state}->'definition'->'completion'->>'mode' in (${sql.join(
          PR_COMPLETION_MODES.map((mode) => sql`${mode}`),
          sql`, `
        )})`
      )
    )
  const matches: Array<{ id: string; match: Exclude<StreamBranchMatch, { kind: 'none' }> }> = []
  for (const row of rows) {
    const match = matchStreamBranch(row.metadata, head)
    if (match.kind !== 'none' && (await authorize(row.squadId))) matches.push({ id: row.id, match })
  }
  const alreadyBound = matches.filter(({ match }) => match.kind === 'bound' && match.number === head.number)
  if (alreadyBound.length) return null
  if (matches.length !== 1) return null
  const [{ id, match }] = matches as [(typeof matches)[number]]
  if (match.kind !== 'unbound') return null
  const resolution = resolveBranchChangeRequest({
    branch: head.headBranch,
    baseBranch: head.baseBranch,
    repository: match.reference.repository,
    candidates: [{ ...head, baseBranch: head.baseBranch ?? '' }],
  })
  if (resolution.status !== 'chosen') return null
  return { workStreamId: id, reference: match.reference, candidate: resolution.candidate, head }
}

/** Query-only discovery above is also used by relevance planning before any admission effects. */
export async function bindChangeRequestFromEvent(
  integration: string,
  fact: IntegrationOutputFact,
  authorize: (squadId: string) => Promise<boolean>
): Promise<string[]> {
  const plan = await planChangeRequestBinding(integration, fact, authorize)
  if (!plan) return []
  const bound = await recordChangeRequestBinding(
    plan.workStreamId,
    plan.reference,
    plan.candidate,
    (metadata) => matchStreamBranch(metadata, plan.head).kind === 'unbound'
  )
  if (bound)
    log.info(
      `Bound ${plan.head.repository}#${plan.head.number} to work stream ${plan.workStreamId} from branch '${plan.head.headBranch}'`
    )
  return bound ? [plan.workStreamId] : []
}
