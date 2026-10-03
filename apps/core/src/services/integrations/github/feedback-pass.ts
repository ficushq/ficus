import type { integrationOutputEvents } from '../../../db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { githubContentHash } from './feedback-envelope'
import { readCurrentGitHubFeedback } from './feedback-provider'
import type { GitHubFeedbackContent } from '@ficus/shared'
import { verifyGitHubOutputResource } from './feedback-resource'

/** One budget is inherited by every await/queue/release nested in a root reconcile pass. */
export interface GitHubOutputPass {
  events: Set<string>
  current: Map<string, Promise<{ contentHash: string } | null>>
  resources: number
  deliveries?: Map<string, Array<{ event: typeof integrationOutputEvents.$inferSelect; deliveryId: string }>>
  native: Map<string, Promise<{ repositoryAuthorized: boolean; nativeAuthorized: boolean; checkedAt: Date }>>
}
const passes = new AsyncLocalStorage<GitHubOutputPass>()
export const githubOutputPass = () => passes.getStore()
export async function withGitHubOutputPass<T>(work: () => Promise<T>): Promise<T> {
  return passes.getStore()
    ? work()
    : passes.run({ events: new Set(), resources: 0, native: new Map(), current: new Map() }, work)
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
