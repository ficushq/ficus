/**
 * Squad `.ficus/.env` content and Secret Store exposure (per squad and global). Names only: no
 * request or response carries a secret value.
 *
 * Exposing a Secret Store key renders its value into squad shells, so every key a change ADDS
 * (to one squad's exposure or the global one) also requires permission to READ that key in the
 * Secret Store (`secrets:read` or its group's `secrets:read:<group>`, the same check as
 * `GET /api/secrets/:key`). Otherwise `env:write` / `settings:write` alone would let a caller
 * expose a key they may not read and read it from a squad shell. Removing a key, and keeping a
 * key that is already exposed, never needs it.
 */

import { Hono, type Context } from 'hono'
import { zValidator } from '../lib/zod-validator'
import { z } from 'zod'
import * as squadEnv from '../services/squad/env'
import { getSecretStore } from '../services/secrets'
import { requirePermission, requireSquadPermission } from '../middleware'
import { secretReader } from '../middleware/require-secret-permission'
// The full squad id the guard already resolved AND authorized: re-deriving it from the route param
// would repeat the lookup and could let a handler act on a different squad than the guard checked.
import { resolvedSquadId } from '../middleware/require-permission'

const setEnvSchema = z.object({
  content: z.string(),
})

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Secret key must be a valid environment variable name')

const setEnvSecretsSchema = z.object({
  keys: z.array(envNameSchema).max(100),
})

/**
 * Refuse an exposure change that would add a key the caller may not read. The verdict depends on
 * the key NAME and the caller's permissions only, never on whether the key exists in the store, so
 * the 403 reveals nothing about which secrets exist. Returns null when the change may proceed.
 */
async function refuseUnreadableAdditions(c: Context, currentKeys: string[], nextKeys: string[]) {
  const current = new Set(currentKeys)
  // Normalize first: keys exposure never stores (platform-managed, reserved) are dropped, not checked.
  const added = squadEnv.normalizeSecretKeys(nextKeys).filter((key) => !current.has(key))
  if (added.length === 0) return null
  const mayRead = await secretReader(c)
  const unreadable = added.filter((key) => !mayRead(key))
  if (unreadable.length === 0) return null
  return c.json(
    {
      error: `You can only expose secrets you are allowed to read in the Secret Store. Not allowed: ${unreadable.join(', ')}.`,
    },
    403
  )
}

export const squadEnvRouter = new Hono()
  // Get .ficus/.env content
  .get('/:squadId/env', requireSquadPermission('env:read', 'squadId'), async (c) => {
    const squadId = resolvedSquadId(c)

    const content = squadEnv.getEnvFile(squadId)
    return c.json({ content: content ?? '', exposedSecretKeys: await squadEnv.getExposedSecretKeys(squadId) })
  })

  // Set .ficus/.env content
  .put('/:squadId/env', requireSquadPermission('env:write', 'squadId'), zValidator('json', setEnvSchema), async (c) => {
    const squadId = resolvedSquadId(c)

    const { content } = c.req.valid('json')
    const reserved = squadEnv.findReservedSquadEnvKeys(content)
    if (reserved.length > 0) return c.json({ error: squadEnv.describeReservedSquadEnvKeys(reserved) }, 400)
    await squadEnv.setEnvFile(squadId, content)
    return c.json({ success: true })
  })

  // List the Secret Store keys the caller may read, plus those already exposed to this squad (no values)
  .get('/:squadId/env/secrets', requireSquadPermission('env:read', 'squadId'), async (c) => {
    const squadId = resolvedSquadId(c)

    const [exposedKeys, globallyExposedKeys, secrets, mayRead] = await Promise.all([
      squadEnv.getExposedSecretKeys(squadId),
      squadEnv.getGloballyExposedSecretKeys(),
      getSecretStore().list(),
      secretReader(c),
    ])
    const squadExposed = new Set(exposedKeys)
    const globallyExposed = new Set(globallyExposedKeys)
    return c.json({
      // Hide the names of keys the caller may not read, so the listing does not reveal which secrets
      // exist. Keys already exposed to this squad (directly or globally) stay listed: they are already
      // in the squad's env, and a directly exposed one must stay visible so it can be removed.
      secrets: secrets
        .filter((secret) => mayRead(secret.key) || squadExposed.has(secret.key) || globallyExposed.has(secret.key))
        .map((secret) => {
          const isSquadExposed = squadExposed.has(secret.key)
          const isGloballyExposed = globallyExposed.has(secret.key)
          return {
            key: secret.key,
            isSet: secret.isSet,
            exposed: isSquadExposed || isGloballyExposed,
            squadExposed: isSquadExposed,
            globallyExposed: isGloballyExposed,
            // Whether this caller may add the key (read access in the Secret Store); removal never needs it.
            canExpose: mayRead(secret.key),
            updatedAt: secret.updatedAt,
            updatedBy: secret.updatedBy,
          }
        }),
    })
  })

  // List globally exposed Secret Store keys (no values)
  .get('/env/global-secrets', requirePermission('settings:read'), async (c) => {
    return c.json({ globallyExposedSecretKeys: await squadEnv.getGloballyExposedSecretKeys() })
  })

  // Replace globally exposed Secret Store keys and regenerate all squad env files (no values)
  .post(
    '/env/global-secrets',
    requirePermission('settings:write'),
    zValidator('json', setEnvSecretsSchema),
    async (c) => {
      const { keys } = c.req.valid('json')
      const refused = await refuseUnreadableAdditions(c, await squadEnv.getGloballyExposedSecretKeys(), keys)
      if (refused) return refused
      await squadEnv.setGloballyExposedSecretKeys(keys)
      return c.json({ success: true, globallyExposedSecretKeys: await squadEnv.getGloballyExposedSecretKeys() })
    }
  )

  // Append globally exposed Secret Store keys and regenerate all squad env files (no values)
  .put(
    '/env/global-secrets',
    requirePermission('settings:write'),
    zValidator('json', setEnvSecretsSchema),
    async (c) => {
      const { keys } = c.req.valid('json')
      const existingKeys = await squadEnv.getGloballyExposedSecretKeys()
      const refused = await refuseUnreadableAdditions(c, existingKeys, keys)
      if (refused) return refused
      await squadEnv.setGloballyExposedSecretKeys(Array.from(new Set([...existingKeys, ...keys])))
      return c.json({ success: true, globallyExposedSecretKeys: await squadEnv.getGloballyExposedSecretKeys() })
    }
  )

  // Remove globally exposed Secret Store keys and regenerate all squad env files (no values)
  .delete(
    '/env/global-secrets',
    requirePermission('settings:write'),
    zValidator('json', setEnvSecretsSchema),
    async (c) => {
      const { keys } = c.req.valid('json')
      const keysToRemove = new Set(keys)
      const exposedSecretKeys = (await squadEnv.getGloballyExposedSecretKeys()).filter((key) => !keysToRemove.has(key))
      await squadEnv.setGloballyExposedSecretKeys(exposedSecretKeys)
      return c.json({ success: true, globallyExposedSecretKeys: await squadEnv.getGloballyExposedSecretKeys() })
    }
  )

  // Replace the explicit Secret Store allowlist for this squad (no values in request or response)
  .post(
    '/:squadId/env/secrets',
    requireSquadPermission('env:write', 'squadId'),
    zValidator('json', setEnvSecretsSchema),
    async (c) => {
      const squadId = resolvedSquadId(c)

      const { keys } = c.req.valid('json')
      const refused = await refuseUnreadableAdditions(c, await squadEnv.getExposedSecretKeys(squadId), keys)
      if (refused) return refused
      await squadEnv.setExposedSecretKeys(squadId, keys)
      return c.json({ success: true, exposedSecretKeys: await squadEnv.getExposedSecretKeys(squadId) })
    }
  )

  // Append to the explicit Secret Store allowlist for this squad.
  .put(
    '/:squadId/env/secrets',
    requireSquadPermission('env:write', 'squadId'),
    zValidator('json', setEnvSecretsSchema),
    async (c) => {
      const squadId = resolvedSquadId(c)

      const { keys } = c.req.valid('json')
      const existingKeys = await squadEnv.getExposedSecretKeys(squadId)
      const refused = await refuseUnreadableAdditions(c, existingKeys, keys)
      if (refused) return refused
      const exposedSecretKeys = Array.from(new Set([...existingKeys, ...keys]))
      await squadEnv.setExposedSecretKeys(squadId, exposedSecretKeys)
      return c.json({ success: true, exposedSecretKeys })
    }
  )

  // Remove from the explicit Secret Store allowlist for this squad.
  .delete(
    '/:squadId/env/secrets',
    requireSquadPermission('env:write', 'squadId'),
    zValidator('json', setEnvSecretsSchema),
    async (c) => {
      const squadId = resolvedSquadId(c)

      const { keys } = c.req.valid('json')
      const keysToRemove = new Set(keys)
      const exposedSecretKeys = (await squadEnv.getExposedSecretKeys(squadId)).filter((key) => !keysToRemove.has(key))
      await squadEnv.setExposedSecretKeys(squadId, exposedSecretKeys)
      return c.json({ success: true, exposedSecretKeys })
    }
  )
