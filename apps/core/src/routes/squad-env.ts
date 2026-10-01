import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as squadEnv from '../services/squad/env'
import { getSecretStore } from '../services/secrets'
import { requirePermission, requireSquadPermission } from '../middleware'
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
  keys: z.array(envNameSchema),
})

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

  // List Secret Store keys and which are explicitly exposed to this squad (no values)
  .get('/:squadId/env/secrets', requireSquadPermission('env:read', 'squadId'), async (c) => {
    const squadId = resolvedSquadId(c)

    const [exposedKeys, globallyExposedKeys, secrets] = await Promise.all([
      squadEnv.getExposedSecretKeys(squadId),
      squadEnv.getGloballyExposedSecretKeys(),
      getSecretStore().list(),
    ])
    const squadExposed = new Set(exposedKeys)
    const globallyExposed = new Set(globallyExposedKeys)
    return c.json({
      secrets: secrets.map((secret) => {
        const isSquadExposed = squadExposed.has(secret.key)
        const isGloballyExposed = globallyExposed.has(secret.key)
        return {
          key: secret.key,
          isSet: secret.isSet,
          exposed: isSquadExposed || isGloballyExposed,
          squadExposed: isSquadExposed,
          globallyExposed: isGloballyExposed,
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
