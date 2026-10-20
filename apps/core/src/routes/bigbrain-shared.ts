/**
 * Human lifecycle routes for managed shared BigBrain vaults, mounted under
 * `/api/integrations/providers/bigbrain/shared-vaults`. Authority is enforced in the service
 * (literal enabled human + instance permission; owner for device links). Bodies are exact
 * schemas; errors are codes only. The owner device link response is never cacheable.
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
    // The service performs the literal-human/owner authorization itself, before any effect.
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
  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined)

  return new Hono()
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
    .delete('/:vaultId', (c) =>
      handle(c, async (identity) => service.delete(identity, c.req.param('vaultId'), await body(c)))
    )
}
