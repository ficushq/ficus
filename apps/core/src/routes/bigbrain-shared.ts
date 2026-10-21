/**
 * Human lifecycle routes for managed shared BigBrain vaults, mounted under
 * `/api/integrations/providers/bigbrain/shared-vaults`. Authority is enforced in the service
 * (literal enabled human + instance permission, including owner device links). Bodies are exact
 * schemas; errors are codes only. Owner device link and member invite responses carry a secret
 * link and are never cacheable (no response here is).
 */
import { Hono, type Context } from 'hono'
import type { Identity } from '../services/rbac'
import {
  managedVaultErrorResponse,
  type createManagedVaultService,
} from '../services/integrations/bigbrain/managed/service'

export type ManagedVaultRouteService = ReturnType<typeof createManagedVaultService>

export function createBigbrainSharedRouter(service: ManagedVaultRouteService): Hono {
  const handle = async (c: Context, action: (identity: Identity) => Promise<unknown>, status: 200 | 201 = 200) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    // The service performs the literal-human/permission authorization itself, before any effect.
    c.set('authzChecked', true)
    c.header('Cache-Control', 'no-store')
    try {
      return c.json((await action(identity)) as object, status)
    } catch (error) {
      const response = managedVaultErrorResponse(error)
      if (!response) throw error
      return c.json(response.body, response.status as 400)
    }
  }
  // Malformed JSON propagates to the root JSON-body handler (stable 400), never swallowed here.
  const body = (c: Context): Promise<unknown> => c.req.json()

  return (
    new Hono()
      .get('/', (c) => handle(c, async (identity) => ({ vaults: await service.list(identity) })))
      .post('/', (c) => handle(c, async (identity) => service.create(identity, await body(c)), 201))
      .get('/:vaultId', (c) => handle(c, (identity) => service.get(identity, c.req.param('vaultId'))))
      .patch('/:vaultId', (c) =>
        handle(c, async (identity) => service.rename(identity, c.req.param('vaultId'), await body(c)))
      )
      .post('/:vaultId/retry', (c) =>
        handle(c, async (identity) => service.retry(identity, c.req.param('vaultId'), await body(c)))
      )
      .post('/:vaultId/read-access', (c) =>
        handle(c, async (identity) => service.setReadAccess(identity, c.req.param('vaultId'), await body(c)))
      )
      .post('/:vaultId/owner-invite', (c) => {
        // Secret, single-use device link: never cached, never sent as a Referer.
        c.header('Referrer-Policy', 'no-referrer')
        return handle(c, async (identity) => service.ownerInvite(identity, c.req.param('vaultId'), await body(c)))
      })
      // Members: every route (the list too) needs a BigBrain manager; enforced in the service.
      .get('/:vaultId/members', (c) => handle(c, (identity) => service.members(identity, c.req.param('vaultId'))))
      .post('/:vaultId/invites', (c) => {
        // Secret, single-use member invite link: never cached, never sent as a Referer.
        c.header('Referrer-Policy', 'no-referrer')
        return handle(c, async (identity) => service.inviteMember(identity, c.req.param('vaultId'), await body(c)), 201)
      })
      .post('/:vaultId/invites/:inviteId/cancel', (c) =>
        handle(c, async (identity) =>
          service.cancelInvite(identity, c.req.param('vaultId'), c.req.param('inviteId'), await body(c))
        )
      )
      .post('/:vaultId/members/:handle/access', (c) =>
        handle(c, async (identity) =>
          service.setMemberAccess(identity, c.req.param('vaultId'), c.req.param('handle'), await body(c))
        )
      )
      .post('/:vaultId/members/:handle/remove', (c) =>
        handle(c, async (identity) =>
          service.removeMember(identity, c.req.param('vaultId'), c.req.param('handle'), await body(c))
        )
      )
      .delete('/:vaultId', (c) =>
        handle(c, async (identity) => service.delete(identity, c.req.param('vaultId'), await body(c)))
      )
  )
}
