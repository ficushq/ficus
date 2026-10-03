import type { integrationOutputEvents, githubFeedbackRevisions, inbox } from '../../../db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { githubContentHash } from './feedback-envelope'
import { readCurrentGitHubFeedback } from './feedback-provider'
import type { GitHubFeedbackContent } from '@ficus/shared'
import { verifyGitHubOutputResource } from './feedback-resource'

/** One budget is inherited by every await/queue/release nested in a root reconcile pass. */
export interface GitHubOutputPass {
  /** Candidate attempts, including repeats/cache hits, independently of preparation dedupe. */
  work: number
  lookaheadRows: number
  lookaheadQueries: number
  events: Set<string>
  bodyRows: number
  bodies: Map<string, typeof integrationOutputEvents.$inferSelect>
  inboxBodies: Map<string, typeof inbox.$inferSelect>
  ordinary?: Map<string, string[]>
  revisions: Map<string, typeof githubFeedbackRevisions.$inferSelect>
  current: Map<string, Promise<{ contentHash: string } | null>>
  resources: number
  deliveries?: Map<string, Array<{ eventId: string; deliveryId: string }>>
  native: Map<string, Promise<{ repositoryAuthorized: boolean; nativeAuthorized: boolean; checkedAt: Date }>>
}
const passes = new AsyncLocalStorage<GitHubOutputPass>()
export const githubOutputPass = () => passes.getStore()
export async function withGitHubOutputPass<T>(work: () => Promise<T>): Promise<T> {
  return passes.getStore()
    ? work()
    : passes.run(
        {
          work: 0,
          lookaheadRows: 0,
          lookaheadQueries: 0,
          events: new Set(),
          bodyRows: 0,
          bodies: new Map(),
          revisions: new Map(),
          inboxBodies: new Map(),
          resources: 0,
          native: new Map(),
          current: new Map(),
        },
        work
      )
}

export const GITHUB_PASS_READ_LIMIT = 25
export const GITHUB_PASS_RESOURCE_LIMIT = 8
export const GITHUB_PASS_PROVIDER_CALL_LIMIT = 24

/** Reserve before reading/preparing; exhausted work waits for the next pass, never stale proof. */
export function reserveGitHubEvent(id: string): boolean {
  const pass = githubOutputPass()
  if (!pass) throw new Error('github_pass_required')
  if (pass.events.has(id)) return true
  if (pass.events.size >= GITHUB_PASS_READ_LIMIT) return false
  pass.events.add(id)
  return true
}

/** Dedupe exact source/material snapshots (including negative results). Three fixed endpoints max. */
export async function readGitHubResource(source: Parameters<typeof verifyGitHubOutputResource>[0]) {
  const pass = githubOutputPass()
  if (!pass) throw new Error('github_pass_required')
  const key = githubContentHash([source.authority, source.fact])
  const existing = pass.native.get(key)
  if (existing) return existing
  if (pass.resources >= GITHUB_PASS_RESOURCE_LIMIT) return null
  pass.resources++
  const read = verifyGitHubOutputResource(source).then((result) => ({ ...result, checkedAt: new Date() }))
  pass.native.set(key, read)
  return read
}

/** Conflict/current-version witnesses are provider work too, never a hidden extra read budget. */
export async function readGitHubCurrent(
  source: Parameters<typeof readCurrentGitHubFeedback>[0],
  content: GitHubFeedbackContent
) {
  const pass = githubOutputPass()
  if (!pass) throw new Error('github_pass_required')
  const key = githubContentHash([source.authority, content])
  const known = pass.current.get(key)
  if (known) return known
  if (pass.resources >= GITHUB_PASS_RESOURCE_LIMIT) return null
  pass.resources++ // two fixed assigned endpoints, conservatively reserve the three-call unit
  const read = readCurrentGitHubFeedback(source, content)
  pass.current.set(key, read)
  return read
}

/** Scope only payload/predicate/preparation work for ONE candidate. A separate effect attempt
 * (even nested, even the same cached event) must use withGitHubCandidate again. Never cache access.
 */
const candidateScopes = new AsyncLocalStorage<GitHubOutputPass>()
export async function withGitHubCandidate<T>(work: () => Promise<T>, withheld: T): Promise<T> {
  const pass = githubOutputPass()
  if (!pass) throw new Error('github_pass_required')
  if (pass.work >= GITHUB_PASS_READ_LIMIT) return withheld
  pass.work++ // BEFORE predicates, cache lookups, source reads, or effects
  return candidateScopes.run(pass, work)
}

/** Nested source/payload/authority checks are part of the already charged candidate, not new
 * candidates. Standalone entry points still charge every call; distinct-ID sets are not WORK.
 */
export async function inGitHubCandidate<T>(work: () => Promise<T>, withheld: T): Promise<T> {
  return candidateScopes.getStore() === githubOutputPass() && githubOutputPass()
    ? work()
    : withGitHubCandidate(work, withheld)
}

/** Bounded ID-only lookahead: <=100 requested rows, <=12 selection queries per pass. Charging
 * requested LIMIT (not merely returned rows) also bounds empty/blocked per-stream probes. No
 * selection runs after work exhaustion. Point equality/authority reads are not lookahead.
 */
export function reserveGitHubLookahead(maximum: number): number {
  const pass = githubOutputPass()
  if (!pass) throw new Error('github_pass_required')
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('invalid_github_lookahead')
  if (pass.work >= GITHUB_PASS_READ_LIMIT || pass.lookaheadQueries >= 12) return 0
  const limit = Math.min(maximum, 100 - pass.lookaheadRows, GITHUB_PASS_READ_LIMIT - pass.work)
  if (!limit) return 0
  pass.lookaheadQueries++
  pass.lookaheadRows += limit
  return limit
}
