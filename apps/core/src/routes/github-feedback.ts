import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import {
  githubAccountIdSchema,
  githubAuthorFilterUpdateSchema,
  githubFeedbackPageQuerySchema,
  githubTrustedAuthorAddSchema,
  githubTrustedAuthorResolveSchema,
  moderateGitHubFeedbackSchema,
} from '@ficus/shared'
import { db, integrationAuditEvents } from '../db'
import { eventEmitter } from '../lib/infra/event-emitter'
import type { Identity } from '../services/rbac'
import {
  addManualGitHubTrust,
  GitHubFeedbackError,
  githubAuthorityActor,
  lookupGitHubAccount,
  removeManualGitHubTrust,
  requireGitHubHuman,
  requireGitHubHumanSquadUpdate,
  resolveGitHubAccount,
} from '../services/integrations/github/feedback-trust'
import { moderateGitHubFeedback } from '../services/integrations/github/feedback-moderation'
import { setGitHubAuthorFilter } from '../services/integrations/github/author-filter-setting'
import {
  getGitHubFeedbackDetail,
  getGitHubFeedbackSummary,
  listGitHubFeedback,
  listGitHubTrustedAuthors,
  retryGitHubFeedbackRelease,
} from '../services/integrations/github/feedback-review'

export interface GitHubFeedbackRouterOptions {
  /** Fixed-origin public account lookup; injectable so tests never reach the network. */
  lookupAccount?: (login: string) => Promise<unknown>
  /** Per-user provider lookups (resolve + add) allowed per window. */
  lookupLimit?: { max: number; windowMs: number }
}

const squadParam = z.object({ squadId: z.string().uuid() })
const revisionParam = squadParam.extend({ revisionId: z.string().uuid() })
const accountParam = squadParam.extend({ accountId: githubAccountIdSchema })
const empty = z.object({}).strict()

function failure(c: Context, error: unknown) {
  if (error instanceof GitHubFeedbackError)
    return c.json({ error: 'GitHub feedback request refused', code: error.code }, error.status)
  console.error('[github-feedback] request failed:', error instanceof Error ? error.name : 'unknown')
  return c.json({ error: 'GitHub feedback unavailable', code: 'github_feedback_unavailable' }, 503)
}

/** Strict validation failures never echo caller input. */
const strict = <T extends z.ZodTypeAny>(target: 'json' | 'param' | 'query', schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid request', code: 'invalid_request' }, 400)
  })

/** Content-free, emitted only after the service's transaction committed. */
const invalidate = (squadId: string) => eventEmitter.emit('githubFeedback.updated', { squadId })

/**
 * Thin human-only HTTP surface over the checked moderation/trust services. Mounted at `/api/squads`
 * behind the global identity, CSRF and authz-sentinel middleware. Every handler re-checks authority in
 * its service (human principal + fresh squad permission); this router adds a cheap early refusal of
 * non-human principals so agents (including delegated user credentials) never reach a read.
 */
export function createGitHubFeedbackRouter(options: GitHubFeedbackRouterOptions = {}): Hono {
  const app = new Hono()
  const lookup = options.lookupAccount ?? lookupGitHubAccount
  const limit = options.lookupLimit ?? { max: 30, windowMs: 10 * 60_000 }
  const lookups = new Map<string, number[]>()
  const allowLookup = (userId: string) => {
    const now = Date.now()
    const recent = (lookups.get(userId) ?? []).filter((at) => now - at < limit.windowMs)
    if (recent.length >= limit.max) {
      lookups.set(userId, recent)
      return false
    }
    recent.push(now)
    lookups.set(userId, recent)
    return true
  }
  const identityOf = (c: Context) => c.get('identity') as Identity | undefined

  // Path-scoped (NOT '*'): this router shares the /api/squads mount with other routers.
  app.use('/:squadId/github-feedback/*', async (c, next) => {
    const identity = identityOf(c)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    c.header('Cache-Control', 'no-store')
    try {
      await requireGitHubHuman(db, identity)
    } catch (error) {
      // A non-human principal is refused here, before any service runs; record the attempt the
      // same way the services audit their own refusals.
      if (error instanceof GitHubFeedbackError)
        await db
          .insert(integrationAuditEvents)
          .values({
            actorKey: githubAuthorityActor(identity),
            targetKind: 'squad',
            targetId: c.req.param('squadId') ?? 'unknown',
            action: 'github.feedback.access',
            outcome: 'denied',
            code: error.code,
          })
          .catch(() => undefined)
      return failure(c, error)
    }
    if (!squadParam.safeParse({ squadId: c.req.param('squadId') }).success)
      return c.json({ error: 'Invalid request', code: 'invalid_request' }, 400)
    await next()
  })

  app.get('/:squadId/github-feedback/summary', strict('param', squadParam), async (c) => {
    try {
      return c.json(await getGitHubFeedbackSummary(identityOf(c), c.req.valid('param').squadId))
    } catch (error) {
      return failure(c, error)
    }
  })

  app.get(
    '/:squadId/github-feedback/revisions',
    strict('param', squadParam),
    strict('query', githubFeedbackPageQuerySchema),
    async (c) => {
      try {
        return c.json(await listGitHubFeedback(identityOf(c), c.req.valid('param').squadId, c.req.valid('query')))
      } catch (error) {
        return failure(c, error)
      }
    }
  )

  app.get('/:squadId/github-feedback/revisions/:revisionId', strict('param', revisionParam), async (c) => {
    const { squadId, revisionId } = c.req.valid('param')
    try {
      return c.json(await getGitHubFeedbackDetail(identityOf(c), squadId, revisionId))
    } catch (error) {
      return failure(c, error)
    }
  })

  // 202: decisions are persisted and release is queued; it does NOT mean delivered.
  app.post(
    '/:squadId/github-feedback/decisions',
    strict('param', squadParam),
    strict('json', moderateGitHubFeedbackSchema),
    async (c) => {
      const { squadId } = c.req.valid('param')
      try {
        const decisions = await moderateGitHubFeedback(identityOf(c), squadId, c.req.valid('json'))
        invalidate(squadId)
        return c.json(
          {
            decisions: decisions.map((decision) => ({
              revisionId: decision.revisionId,
              action: decision.action,
              decisionVersion: decision.decisionVersion,
            })),
          },
          202
        )
      } catch (error) {
        return failure(c, error)
      }
    }
  )

  app.post(
    '/:squadId/github-feedback/revisions/:revisionId/retry',
    strict('param', revisionParam),
    strict('json', empty),
    async (c) => {
      const { squadId, revisionId } = c.req.valid('param')
      try {
        await retryGitHubFeedbackRelease(identityOf(c), squadId, revisionId)
        invalidate(squadId)
        return c.json({ queued: true }, 202)
      } catch (error) {
        return failure(c, error)
      }
    }
  )

  app.put(
    '/:squadId/github-feedback/author-filter',
    strict('param', squadParam),
    strict('json', githubAuthorFilterUpdateSchema),
    async (c) => {
      const { squadId } = c.req.valid('param')
      try {
        const result = await setGitHubAuthorFilter(identityOf(c), squadId, c.req.valid('json').enabled)
        invalidate(squadId)
        return c.json(result)
      } catch (error) {
        return failure(c, error)
      }
    }
  )

  app.get('/:squadId/github-feedback/trusted-authors', strict('param', squadParam), async (c) => {
    try {
      return c.json(await listGitHubTrustedAuthors(identityOf(c), c.req.valid('param').squadId))
    } catch (error) {
      return failure(c, error)
    }
  })

  // Preview only: resolves a login to a provider-verified identity. Persists nothing.
  app.post(
    '/:squadId/github-feedback/trusted-authors/resolve',
    strict('param', squadParam),
    strict('json', githubTrustedAuthorResolveSchema),
    async (c) => {
      const identity = identityOf(c)
      try {
        const userId = await requireGitHubHumanSquadUpdate(db, identity, c.req.valid('param').squadId)
        if (!allowLookup(userId)) return c.json({ error: 'Too many lookups', code: 'lookup_rate_limited' }, 429)
        return c.json(await resolveGitHubAccount(c.req.valid('json').login, lookup))
      } catch (error) {
        return failure(c, error)
      }
    }
  )

  app.post(
    '/:squadId/github-feedback/trusted-authors',
    strict('param', squadParam),
    strict('json', githubTrustedAuthorAddSchema),
    async (c) => {
      const identity = identityOf(c)
      const { squadId } = c.req.valid('param')
      const { login, accountId } = c.req.valid('json')
      try {
        const userId = await requireGitHubHumanSquadUpdate(db, identity, squadId)
        if (!allowLookup(userId)) return c.json({ error: 'Too many lookups', code: 'lookup_rate_limited' }, 429)
        const account = await addManualGitHubTrust(identity, squadId, login, lookup, accountId)
        invalidate(squadId)
        return c.json(account, 201)
      } catch (error) {
        return failure(c, error)
      }
    }
  )

  // Removes ONLY the manual grant; the response reports any independent dynamic trust that remains.
  app.delete('/:squadId/github-feedback/trusted-authors/:accountId', strict('param', accountParam), async (c) => {
    const { squadId, accountId } = c.req.valid('param')
    try {
      const remainingOrigins = await removeManualGitHubTrust(identityOf(c), squadId, accountId)
      invalidate(squadId)
      return c.json({ removed: true, remainingOrigins })
    } catch (error) {
      return failure(c, error)
    }
  })

  return app
}
