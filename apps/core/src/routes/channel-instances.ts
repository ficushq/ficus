import { publicErrorMessage } from '../db/errors'
import { parseTrustedChannelIds, parseChannelIds } from '../services/channel-access'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ChannelInstance } from '../entities/ChannelInstance'
import { db, channelInstances } from '../db'
import { channelSync } from '../services/config-sync'
import { requirePermission } from '../middleware/require-permission'

function missingDefaultResponse() {
  return { error: 'Channel instances require a default squad for unmapped channels' }
}

export const channelInstancesRouter = new Hono()
  .get('/', requirePermission('channels:read'), async (c) => {
    const instances = await ChannelInstance.list()
    return c.json(
      instances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        provider: inst.provider,
        providerConfig: inst.providerConfig,
        trustedChannelIds: inst.trustedChannelIds,
        allowedChannelIds: inst.allowedChannelIds,
        deniedChannelIds: inst.deniedChannelIds,
        allowPrivateChats: inst.allowPrivateChats,
        channelSquadMap: inst.channelSquadMap,
        defaultSquadId: inst.defaultSquadId,
        yamlFieldOverrides: inst.yamlFieldOverrides ?? [],
        hasTemplate: inst.yamlTemplate != null,
        disabled: inst.disabled,
      }))
    )
  })
  .get('/:id/export', requirePermission('channels:read'), async (c) => {
    const id = c.req.param('id')
    const rows = await db.select().from(channelInstances).where(eq(channelInstances.id, id)).limit(1)
    const row = rows[0]
    if (!row) return c.json({ error: 'Channel instance not found' }, 404)

    return c.text(channelSync.toYaml(row), 200, { 'Content-Type': 'text/yaml; charset=utf-8' })
  })
  .get('/:id', requirePermission('channels:read'), async (c) => {
    const inst = await ChannelInstance.find(c.req.param('id'))
    if (!inst) return c.json({ error: 'Channel instance not found' }, 404)
    return c.json({
      id: inst.id,
      name: inst.name,
      provider: inst.provider,
      providerConfig: inst.providerConfig,
      trustedChannelIds: inst.trustedChannelIds,
      allowedChannelIds: inst.allowedChannelIds,
      deniedChannelIds: inst.deniedChannelIds,
      allowPrivateChats: inst.allowPrivateChats,
      channelSquadMap: inst.channelSquadMap,
      defaultSquadId: inst.defaultSquadId,
      yamlFieldOverrides: inst.yamlFieldOverrides ?? [],
      hasTemplate: inst.yamlTemplate != null,
      disabled: inst.disabled,
    })
  })
  .post('/', requirePermission('channels:create'), async (c) => {
    const body = await c.req.json()
    if (body.allowPrivateChats !== undefined && typeof body.allowPrivateChats !== 'boolean')
      return c.json({ error: 'allowPrivateChats must be a boolean' }, 400)
    const { id, name, provider, providerConfig, channelSquadMap, defaultSquadId } = body
    if (!id || !name || !provider) {
      return c.json({ error: 'id, name, and provider are required' }, 400)
    }
    if (!defaultSquadId) {
      return c.json(missingDefaultResponse(), 400)
    }
    const existing = await ChannelInstance.find(id)
    if (existing) return c.json({ error: `Channel "${id}" already exists` }, 409)
    const inst = await ChannelInstance.create({
      id,
      name,
      provider,
      providerConfig: providerConfig || {},
      trustedChannelIds: parseTrustedChannelIds(body.trustedChannelIds ?? []),
      allowedChannelIds: parseChannelIds(body.allowedChannelIds ?? []),
      deniedChannelIds: parseChannelIds(body.deniedChannelIds ?? []),
      allowPrivateChats: body.allowPrivateChats ?? true,
      channelSquadMap: channelSquadMap || {},
      defaultSquadId,
    })
    return c.json(
      {
        id: inst.id,
        name: inst.name,
        provider: inst.provider,
        yamlFieldOverrides: [],
        hasTemplate: false,
        disabled: false,
      },
      201
    )
  })
  .put('/:id', requirePermission('channels:update'), async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json()
    if (body.allowPrivateChats !== undefined && typeof body.allowPrivateChats !== 'boolean')
      return c.json({ error: 'allowPrivateChats must be a boolean' }, 400)
    const existing = await ChannelInstance.find(id)
    if (!existing) return c.json({ error: 'Channel instance not found' }, 404)
    const nextDefaultSquadId = body.defaultSquadId !== undefined ? body.defaultSquadId : existing.defaultSquadId
    if (!nextDefaultSquadId) {
      return c.json(missingDefaultResponse(), 400)
    }
    if (body.trustedChannelIds !== undefined) body.trustedChannelIds = parseTrustedChannelIds(body.trustedChannelIds)
    if (body.allowedChannelIds !== undefined) body.allowedChannelIds = parseChannelIds(body.allowedChannelIds)
    if (body.deniedChannelIds !== undefined) body.deniedChannelIds = parseChannelIds(body.deniedChannelIds)
    await existing.update(body)
    await channelSync.recomputeFieldOverrides(id)
    const updated = await ChannelInstance.find(id)
    return c.json({
      id: updated!.id,
      name: updated!.name,
      provider: updated!.provider,
      yamlFieldOverrides: updated!.yamlFieldOverrides ?? [],
    })
  })
  .delete('/:id', requirePermission('channels:delete'), async (c) => {
    const id = c.req.param('id')
    const rows = await db.select().from(channelInstances).where(eq(channelInstances.id, id))
    if (!rows[0]) return c.json({ error: 'Channel not found' }, 404)
    if (rows[0].yamlTemplate != null) {
      return c.json({ error: 'Cannot delete a template-based config — use disable instead' }, 400)
    }
    await db.delete(channelInstances).where(eq(channelInstances.id, id))
    return c.json({ ok: true })
  })
  .get('/:id/template-diff', requirePermission('channels:read'), async (c) => {
    try {
      const diff = await channelSync.getTemplateDiff(c.req.param('id'))
      return c.json(diff)
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 404)
    }
  })
  .post('/:id/revert-to-template', requirePermission('channels:update'), async (c) => {
    try {
      await channelSync.revertToTemplate(c.req.param('id'))
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 400)
    }
  })
  .post('/:id/revert-template-fields', requirePermission('channels:update'), async (c) => {
    try {
      const body = await c.req.json()
      await channelSync.revertTemplateFields(c.req.param('id'), body.fields ?? [])
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 400)
    }
  })
  .post('/:id/disable', requirePermission('channels:update'), async (c) => {
    await channelSync.setDisabled(c.req.param('id'), true)
    return c.json({ ok: true })
  })
  .post('/:id/enable', requirePermission('channels:update'), async (c) => {
    await channelSync.setDisabled(c.req.param('id'), false)
    return c.json({ ok: true })
  })
