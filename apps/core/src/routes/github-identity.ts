import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type {
  GitHubPersonalIdentityStatus,
  IntegrationAuthorizationStart,
  IntegrationDeviceAuthorizationStatus,
} from '@ficus/shared'
import { db, integrationAuditEvents } from '../db'
import { eventEmitter } from '../lib/infra/event-emitter'
import type { Identity } from '../services/rbac'
import {
  GitHubFeedbackError,
  githubAuthorityActor,
  requireGitHubHuman,
} from '../services/integrations/github/feedback-trust'
import { AuthorizationFlowError } from '../services/integrations/authorization/service'
import { GitHubOAuthError } from '@ficus/shared/oauth-providers/github/client'
import { describeGitHubAuthorizationError } from '../services/integrations/authorization/github-errors'

export interface GitHubIdentityRoutesService {
  get(identity: Identity | undefined): Promise<GitHubPersonalIdentityStatus>
  start(identity: Identity | undefined, returnTo: string): Promise<IntegrationAuthorizationStart>
  poll(identity: Identity | undefined, id: string): Promise<IntegrationDeviceAuthorizationStatus>
  cancel(identity: Identity | undefined, id: string): Promise<void>
  confirm(identity: Identity | undefined, proofId: string): Promise<unknown>
  unlink(identity: Identity | undefined): Promise<unknown>
}

function failure(c: Context, error: unknown) {
  if (error instanceof GitHubFeedbackError)
    return c.json({ error: 'GitHub identity request refused', code: error.code }, error.status)
  if (error instanceof AuthorizationFlowError)
    return c.json(
      { error: 'GitHub authorization unavailable', code: error.code },
      error.code === 'broker_unconfigured' ? 503 : 400
    )
  if (error instanceof GitHubOAuthError) {
    const failure = describeGitHubAuthorizationError(error)
    if (failure.retryAfterSeconds !== undefined) c.header('Retry-After', String(failure.retryAfterSeconds))
    return c.json({ error: failure.message, code: failure.code }, failure.status)
  }
  return c.json({ error: 'GitHub identity unavailable', code: 'identity_unavailable' }, 503)
}
const empty = z.object({}).strict()
const id = z.object({ id: z.string().uuid() })

/** Mount behind normal identity, CSRF and authz-sentinel middleware; no public callback bypass. */
export function createGitHubIdentityRouter(service: GitHubIdentityRoutesService): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const identity = c.get('identity') as Identity | undefined
    try {
      // Never resolve an agent's associated/acting user. This is a self-only human account operation.
      await requireGitHubHuman(db, identity)
      c.set('authzChecked', true)
      c.header('Cache-Control', 'no-store')
    } catch (error) {
      // Refused before any service runs: audit the attempt like the services audit theirs.
      if (error instanceof GitHubFeedbackError)
        await db
          .insert(integrationAuditEvents)
          .values({
            actorKey: githubAuthorityActor(identity),
            targetKind: 'github_identity',
            targetId: githubAuthorityActor(identity),
            action: 'github.identity.access',
            outcome: 'denied',
            code: error.code,
          })
          .catch(() => undefined)
      return failure(c, error)
    }
    await next()
  })
  app.get('/', async (c) => {
    try {
      return c.json(await service.get(c.get('identity') as Identity))
    } catch (error) {
      return failure(c, error)
    }
  })
  app.post(
    '/authorization/start',
    zValidator('json', z.object({ returnTo: z.string().min(1).max(1_024) }).strict()),
    async (c) => {
      try {
        return c.json(await service.start(c.get('identity') as Identity, c.req.valid('json').returnTo))
      } catch (error) {
        return failure(c, error)
      }
    }
  )
  app.post('/authorization/device/:id/poll', zValidator('param', id), zValidator('json', empty), async (c) => {
    try {
      return c.json(await service.poll(c.get('identity') as Identity, c.req.valid('param').id))
    } catch (error) {
      return failure(c, error)
    }
  })
  app.post('/authorization/device/:id/cancel', zValidator('param', id), zValidator('json', empty), async (c) => {
    try {
      await service.cancel(c.get('identity') as Identity, c.req.valid('param').id)
      return c.json({ canceled: true })
    } catch (error) {
      return failure(c, error)
    }
  })
  app.post('/:id/confirm', zValidator('param', id), zValidator('json', empty), async (c) => {
    try {
      const identity = c.get('identity') as Identity
      const result = await service.confirm(identity, c.req.valid('param').id)
      // Content-free, post-commit, private to this user's own sockets.
      if (identity.type === 'user') eventEmitter.emit('githubIdentity.updated', { userId: identity.userId })
      return c.json(result)
    } catch (error) {
      return failure(c, error)
    }
  })
  app.delete('/', zValidator('json', empty), async (c) => {
    try {
      const identity = c.get('identity') as Identity
      await service.unlink(identity)
      if (identity.type === 'user') eventEmitter.emit('githubIdentity.updated', { userId: identity.userId })
      return c.json({ unlinked: true })
    } catch (error) {
      return failure(c, error)
    }
  })
  return app
}
