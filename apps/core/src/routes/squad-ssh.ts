import { publicErrorMessage } from '../db/errors'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as squadSsh from '../services/squad/ssh'
import { Squad } from '../entities/Squad'
import { requireSquadPermission } from '../middleware'

const addKeySchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Key name must be alphanumeric with _ or -'),
  privateKey: z.string().min(1, 'Private key is required'),
  publicKey: z.string().optional(),
})

const setConfigSchema = z.object({
  config: z.string(),
})

const addKnownHostSchema = z.object({
  host: z.string().min(1, 'Host entry is required'),
})

const setKnownHostsSchema = z.object({
  knownHosts: z.string(),
})

/**
 * Helper to resolve and validate squad ID from param.
 */
async function getValidSquadId(squadIdParam: string): Promise<string | null> {
  const squad = await Squad.find(squadIdParam)
  return squad ? squad.id : null
}

export const squadSshRouter = new Hono()
  .onError((error, c) => {
    if (error instanceof squadSsh.SshDirectoryPermissionError) return c.json({ error: error.message }, 500)
    throw error
  })

  // List SSH keys for a squad
  .get('/:squadId/keys', requireSquadPermission('ssh:read', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const keys = await squadSsh.listSshKeys(squadId)
    return c.json(keys)
  })

  // Add an SSH key
  .post(
    '/:squadId/keys',
    requireSquadPermission('ssh:write', 'squadId'),
    zValidator('json', addKeySchema),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)

      const { name, privateKey, publicKey } = c.req.valid('json')

      try {
        await squadSsh.addSshKey(squadId, name, privateKey, publicKey)
        return c.json({ success: true, keyName: name }, 201)
      } catch (error) {
        if (error instanceof squadSsh.SshDirectoryPermissionError) throw error
        const message = error instanceof Error ? publicErrorMessage(error) : 'Failed to add key'
        return c.json({ error: message }, 400)
      }
    }
  )

  // Get public key
  .get('/:squadId/keys/:keyName/public', requireSquadPermission('ssh:read', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const keyName = c.req.param('keyName')
    const publicKey = squadSsh.getPublicKey(squadId, keyName)
    if (!publicKey) {
      return c.json({ error: 'Public key not found' }, 404)
    }
    return c.json({ publicKey })
  })

  // Remove an SSH key
  .delete('/:squadId/keys/:keyName', requireSquadPermission('ssh:write', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const keyName = c.req.param('keyName')

    try {
      await squadSsh.removeSshKey(squadId, keyName)
      return c.json({ success: true })
    } catch (error) {
      if (error instanceof squadSsh.SshDirectoryPermissionError) throw error
      const message = error instanceof Error ? publicErrorMessage(error) : 'Failed to remove key'
      return c.json({ error: message }, 400)
    }
  })

  // Get SSH config
  .get('/:squadId/config', requireSquadPermission('ssh:read', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const config = squadSsh.getSshConfig(squadId)
    return c.json({ config })
  })

  // Set SSH config
  .put(
    '/:squadId/config',
    requireSquadPermission('ssh:write', 'squadId'),
    zValidator('json', setConfigSchema),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)

      const { config } = c.req.valid('json')
      await squadSsh.setSshConfig(squadId, config)
      return c.json({ success: true })
    }
  )

  // Get known_hosts
  .get('/:squadId/known-hosts', requireSquadPermission('ssh:read', 'squadId'), async (c) => {
    const squadId = await getValidSquadId(c.req.param('squadId'))
    if (!squadId) return c.json({ error: 'Squad not found' }, 404)

    const knownHosts = squadSsh.getKnownHosts(squadId)
    return c.json({ knownHosts })
  })

  // Add a single known host entry
  .post(
    '/:squadId/known-hosts',
    requireSquadPermission('ssh:write', 'squadId'),
    zValidator('json', addKnownHostSchema),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)

      const { host } = c.req.valid('json')
      await squadSsh.addKnownHost(squadId, host)
      return c.json({ success: true })
    }
  )

  // Set known hosts (full replacement)
  .put(
    '/:squadId/known-hosts',
    requireSquadPermission('ssh:write', 'squadId'),
    zValidator('json', setKnownHostsSchema),
    async (c) => {
      const squadId = await getValidSquadId(c.req.param('squadId'))
      if (!squadId) return c.json({ error: 'Squad not found' }, 404)

      const { knownHosts } = c.req.valid('json')
      await squadSsh.setKnownHosts(squadId, knownHosts)
      return c.json({ success: true })
    }
  )
