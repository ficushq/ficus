import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { createSquadRelationshipSchema } from '@ficus/shared'
import type { SquadRelationshipType } from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { Squad } from '../entities/Squad'
import { db, squadRelationships } from '../db'
import { eventEmitter } from '../lib/infra/event-emitter'
import { requirePermission } from '../middleware/require-permission'
import { hasPermission } from '../services/rbac'
import type { Identity } from '../services/rbac'

export const squadRelationshipsRouter = new Hono()
  .get('/', async (c) => {
    const squadId = c.req.query('squadId')
    const type = c.req.query('type') as SquadRelationshipType | undefined

    if (!squadId) {
      return c.json({ error: 'squadId query parameter is required' }, 400)
    }

    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    if (!(await hasPermission(identity, 'squad-relationships:read', squadId))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const squad = await Squad.find(squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    const relationships = await squad.getRelationships(type)
    return c.json(relationships)
  })
  .post('/', zValidator('json', createSquadRelationshipSchema), async (c) => {
    const input = c.req.valid('json')
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)
    // A relationship enables cross-squad manager messaging, so require
    // squad-relationships:write on BOTH ends. A caller must not connect a squad
    // it does not control; Admin '*' continues to match both squads.
    const okSource = await hasPermission(identity, 'squad-relationships:write', input.sourceSquadId)
    const okTarget = await hasPermission(identity, 'squad-relationships:write', input.targetSquadId)
    if (!okSource || !okTarget) return c.json({ error: 'Forbidden' }, 403)

    try {
      const squad = await Squad.find(input.sourceSquadId)
      if (!squad) {
        return c.json({ error: 'Source squad not found' }, 400)
      }
      const relationship = await squad.addRelationship(input.targetSquadId, input.relationshipType, input.metadata)
      return c.json(relationship, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  .delete('/:id', requirePermission('squad-relationships:write'), async (c) => {
    const id = c.req.param('id')
    await db.delete(squadRelationships).where(eq(squadRelationships.id, id))
    eventEmitter.emit('squadRelationship.deleted', { relationshipId: id })
    return c.body(null, 204)
  })
