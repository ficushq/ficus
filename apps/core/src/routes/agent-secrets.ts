/**
 * Per-agent secrets: which Secret Store keys are exposed to ONE agent's own
 * sandbox (services/agent/secrets.ts). Names only — no request or response
 * ever carries a value; values are set through the Secret Store routes.
 *
 * Authorization mirrors squad exposures (routes/squad-env.ts): `env:read` /
 * `env:write` on the agent's squad, or at system scope for a squad-less agent.
 * Exposing a key additionally requires permission to READ that key in the
 * Secret Store (`secrets:read` or its group's `secrets:read:<group>`, as for
 * `GET /api/secrets/:key`): otherwise someone could expose a secret they may
 * not read to an agent they can talk to, and read it through that agent.
 * Removing a key never needs it.
 * Changing an exposure is additionally refused for agent identities: a person
 * decides which agent holds a credential, so no agent (not even a squad
 * manager holding `env:write`) can grant itself or another agent a secret.
 */

import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createMiddleware } from 'hono/factory'
import { Agent } from '../entities/Agent'
import { AmbiguousPrefixError } from '../db/prefix-match'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import { resolvePermissions, type Identity } from '../services/rbac'
import { secretAccessible } from '../services/secrets/groups'
import { getSecretStore } from '../services/secrets'
import { normalizeSecretKeys } from '../services/squad/env'
import {
  AgentSecretsError,
  changeAgentExposedSecretKeys,
  getAgentSecretsStatus,
  type AgentSecretsChange,
} from '../services/agent/secrets'

declare module 'hono' {
  interface ContextVariableMap {
    /** The agent id the per-agent secrets guard resolved and authorized (null: no such agent). */
    agentSecretsTargetId?: string | null
  }
}

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Secret key must be a valid environment variable name')

const keysSchema = z.object({ keys: z.array(envNameSchema).max(200) })

/** Resolve the route param (full id or unique prefix) once; the handler acts on exactly this agent. */
async function resolveTarget(c: Context): Promise<string | null> {
  const cached = c.get('agentSecretsTargetId')
  if (cached !== undefined) return cached
  let agentId: string | null = null
  try {
    agentId = (await Agent.find(c.req.param('id')!))?.id ?? null
  } catch (error) {
    if (!(error instanceof AmbiguousPrefixError)) throw error
  }
  c.set('agentSecretsTargetId', agentId)
  return agentId
}

async function targetSquadId(c: Context): Promise<string | null> {
  const agentId = await resolveTarget(c)
  return agentId ? ((await Agent.find(agentId))?.squadId ?? null) : null
}

const requirePerson = createMiddleware(async (c, next) => {
  const identity = c.get('identity') as Identity | undefined
  if (identity?.type === 'agent') {
    return c.json({ error: 'Only a person can change which secrets an agent holds.' }, 403)
  }
  return next()
})

function errorResponse(c: Context, error: unknown) {
  if (error instanceof AgentSecretsError) return c.json({ error: error.message }, error.status)
  throw error
}

/** Which Secret Store keys the caller may read (system-scoped, exactly as the Secret Store routes check). */
async function secretReader(c: Context): Promise<(key: string) => boolean> {
  const held = await resolvePermissions(c.get('identity') as Identity)
  return (key) => secretAccessible(held, key, 'read')
}

async function applyChange(c: Context, mode: AgentSecretsChange['mode'], keys: string[]) {
  const agentId = await resolveTarget(c)
  if (!agentId) return c.json({ error: 'Agent not found' }, 404)
  try {
    const result = await changeAgentExposedSecretKeys(agentId, { mode, keys }, { mayReadSecret: await secretReader(c) })
    return c.json({ success: true, ...result })
  } catch (error) {
    return errorResponse(c, error)
  }
}

export const agentSecretsRouter = new Hono()
  // Names-only status plus the selectable Secret Store keys (no values).
  .get('/:id/secrets', requireEntityPermission('env:read', targetSquadId), async (c) => {
    const agentId = await resolveTarget(c)
    if (!agentId) return c.json({ error: 'Agent not found' }, 404)
    try {
      const status = await getAgentSecretsStatus(agentId)
      const exposed = new Set(status.exposedSecretKeys)
      const listed = await getSecretStore().list()
      const mayRead = await secretReader(c)
      // Offer only keys the caller could expose; keys already exposed stay listed so they can be removed.
      const exposable = new Set(normalizeSecretKeys(listed.map((secret) => secret.key)).filter(mayRead))
      return c.json({
        agentId,
        ...status,
        secrets: listed
          .filter((secret) => exposable.has(secret.key) || exposed.has(secret.key))
          .map((secret) => ({
            key: secret.key,
            isSet: secret.isSet,
            exposed: exposed.has(secret.key),
            canExpose: exposable.has(secret.key),
            updatedAt: secret.updatedAt,
          })),
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  // Replace the agent's exposed keys (the UI's checkbox list).
  .post(
    '/:id/secrets',
    requireEntityPermission('env:write', targetSquadId),
    requirePerson,
    zValidator('json', keysSchema),
    async (c) => applyChange(c, 'replace', c.req.valid('json').keys)
  )

  // Append keys (ficus agent expose-secrets).
  .put(
    '/:id/secrets',
    requireEntityPermission('env:write', targetSquadId),
    requirePerson,
    zValidator('json', keysSchema),
    async (c) => applyChange(c, 'add', c.req.valid('json').keys)
  )

  // Remove keys (ficus agent unexpose-secrets). Always allowed, whatever the agent's state.
  .delete(
    '/:id/secrets',
    requireEntityPermission('env:write', targetSquadId),
    requirePerson,
    zValidator('json', keysSchema),
    async (c) => applyChange(c, 'remove', c.req.valid('json').keys)
  )
