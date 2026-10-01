import { publicErrorMessage } from '../db/errors'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { SquadPreset } from '../entities/SquadPreset'
import { db, squadPresets } from '../db'
import { squadPresetSync } from '../services/config-sync'
import { validateSquadPresetConfig } from '../services/config/validate-config'
import { requirePermission } from '../middleware/require-permission'

export const squadPresetsRouter = new Hono()
  .get('/', requirePermission('squad-presets:read'), async (c) => {
    const types = await SquadPreset.list()
    return c.json(types.map((t) => t.toJson()))
  })
  .get('/:id', requirePermission('squad-presets:read'), async (c) => {
    const type = await SquadPreset.find(c.req.param('id'))
    if (!type) {
      return c.json({ error: 'Squad preset not found' }, 404)
    }
    return c.json(type.toJson())
  })
  .post('/', requirePermission('squad-presets:create'), async (c) => {
    const body = await c.req.json()
    const { id } = body
    if (!id) return c.json({ error: 'id is required' }, 400)
    try {
      await validateSquadPresetConfig({ ...body, id })
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 400)
    }
    const existing = await SquadPreset.find(id)
    if (existing) return c.json({ error: `Squad preset "${id}" already exists` }, 409)
    await SquadPreset.upsert({ ...body, id })
    const created = await SquadPreset.mustFind(id)
    return c.json(created.toJson(), 201)
  })
  .put('/:id', requirePermission('squad-presets:update'), async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json()
    const existing = await SquadPreset.find(id)
    if (!existing) return c.json({ error: 'Squad preset not found' }, 404)
    try {
      await validateSquadPresetConfig({ ...body, id })
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 400)
    }
    await SquadPreset.upsert({ ...body, id })
    await squadPresetSync.recomputeFieldOverrides(id)
    SquadPreset.invalidateCache()
    const updated = await SquadPreset.mustFind(id)
    return c.json(updated.toJson())
  })
  .delete('/:id', requirePermission('squad-presets:delete'), async (c) => {
    const id = c.req.param('id')
    const existing = await SquadPreset.find(id)
    if (!existing) return c.json({ error: 'Squad preset not found' }, 404)
    if (existing.yamlTemplate != null) {
      return c.json({ error: 'Cannot delete a template-based config — use disable instead' }, 400)
    }
    await db.delete(squadPresets).where(eq(squadPresets.id, id))
    SquadPreset.invalidateCache()
    return c.json({ ok: true })
  })
  .get('/:id/template-diff', requirePermission('squad-presets:read'), async (c) => {
    try {
      const diff = await squadPresetSync.getTemplateDiff(c.req.param('id'))
      return c.json(diff)
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 404)
    }
  })
  .post('/:id/revert-to-template', requirePermission('squad-presets:update'), async (c) => {
    try {
      await squadPresetSync.revertToTemplate(c.req.param('id'))
      SquadPreset.invalidateCache()
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 400)
    }
  })
  .post('/:id/revert-template-fields', requirePermission('squad-presets:update'), async (c) => {
    try {
      const body = await c.req.json()
      await squadPresetSync.revertTemplateFields(c.req.param('id'), body.fields ?? [])
      SquadPreset.invalidateCache()
      return c.json({ ok: true })
    } catch (e: any) {
      return c.json({ error: publicErrorMessage(e) }, 400)
    }
  })
  .post('/:id/disable', requirePermission('squad-presets:update'), async (c) => {
    const id = c.req.param('id')
    if (!(await SquadPreset.find(id))) return c.json({ error: 'Squad preset not found' }, 404)
    await squadPresetSync.setDisabled(id, true)
    SquadPreset.invalidateCache()
    return c.json({ ok: true })
  })
  .post('/:id/enable', requirePermission('squad-presets:update'), async (c) => {
    const id = c.req.param('id')
    if (!(await SquadPreset.find(id))) return c.json({ error: 'Squad preset not found' }, 404)
    await squadPresetSync.setDisabled(id, false)
    SquadPreset.invalidateCache()
    return c.json({ ok: true })
  })
  .get('/:id/export', requirePermission('squad-presets:read'), async (c) => {
    const rows = await db
      .select()
      .from(squadPresets)
      .where(eq(squadPresets.id, c.req.param('id')))
    if (!rows[0]) return c.json({ error: 'Not found' }, 404)
    const yamlStr = squadPresetSync.toYaml(rows[0] as any)
    return c.text(yamlStr, 200, { 'Content-Type': 'text/yaml' })
  })
