import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Squad } from '../entities/Squad'
import { SquadMemoryGrant } from '../entities/SquadMemoryGrant'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import { requireSquadPermission } from '../middleware/require-permission'
import { routeParam } from '../lib/route-param'

const sensitivitySchema = z.enum(['public', 'internal', 'restricted', 'confidential'])

const grantPolicyScopeSchema = z
  .object({
    sourceTypes: z.array(z.string().min(1)).optional(),
    paths: z.array(z.string().min(1)).optional(),
    sensitivity: sensitivitySchema.optional(),
  })
  .strict()

const grantPolicySchema = z
  .object({
    read: grantPolicyScopeSchema.optional(),
    write: grantPolicyScopeSchema.omit({ sensitivity: true }).optional(),
  })
  .strict()

const createGrantSchema = z.object({
  granteeSquadId: z.string().uuid(),
  policy: grantPolicySchema.default({}),
  expiresAt: z.string().datetime().nullable().optional(),
})

/**
 * Squad memory grant management endpoints.
 *
 * These endpoints are intentionally internal/admin-style for the current core API:
 * callers are trusted by the existing global API auth boundary and the route does
 * not yet receive an authenticated source-squad principal to authorize ownership
 * per request. Do not expose these routes as end-user/public grant management
 * without adding source-squad ownership checks for create/list/delete.
 */
export const grantsRouter = new Hono()
  .post(
    '/squads/:sourceSquadId/grants',
    requireSquadPermission('grants:write', 'sourceSquadId'),
    zValidator('json', createGrantSchema),
    async (c) => {
      const sourceSquadId = c.req.param('sourceSquadId')
      const input = c.req.valid('json')

      const sourceSquad = await Squad.find(sourceSquadId)
      if (!sourceSquad) return c.json({ error: 'Source squad not found' }, 404)

      const granteeSquad = await Squad.find(input.granteeSquadId)
      if (!granteeSquad) return c.json({ error: 'Grantee squad not found' }, 404)

      const grant = await SquadMemoryGrant.create({
        sourceSquadId,
        granteeSquadId: input.granteeSquadId,
        policy: input.policy,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })

      return c.json(grant, 201)
    }
  )
  .get('/squads/:sourceSquadId/grants', requireSquadPermission('grants:read', 'sourceSquadId'), async (c) => {
    const sourceSquadId = c.req.param('sourceSquadId')
    const sourceSquad = await Squad.find(sourceSquadId)
    if (!sourceSquad) return c.json({ error: 'Source squad not found' }, 404)

    const grants = await SquadMemoryGrant.listBySource(sourceSquadId)
    return c.json(grants)
  })
  .get('/squads/:granteeSquadId/granted', requireSquadPermission('grants:read', 'granteeSquadId'), async (c) => {
    const granteeSquadId = c.req.param('granteeSquadId')
    const granteeSquad = await Squad.find(granteeSquadId)
    if (!granteeSquad) return c.json({ error: 'Grantee squad not found' }, 404)

    const grants = await SquadMemoryGrant.listByGrantee(granteeSquadId)
    return c.json(grants)
  })
  .delete(
    '/grants/:id',
    requireEntityPermission('grants:write', async (c) => {
      const grant = await SquadMemoryGrant.find(routeParam(c, 'id'))
      return grant?.sourceSquadId ?? null
    }),
    async (c) => {
      const id = c.req.param('id')
      const grant = await SquadMemoryGrant.find(id)
      if (!grant) return c.json({ error: 'Grant not found' }, 404)

      await grant.delete()
      return c.body(null, 204)
    }
  )
