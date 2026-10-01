import { publicErrorMessage } from '../db/errors'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, skills } from '../db'
import { Skill } from '../entities/Skill'
import { assertConfigId, assertNonEmptyString } from '../lib/validation/config-ids'
import { parseSkillMarkdown, validateSkillSupportFiles } from '../services/config-sync/skill-sync'
import { skillSync } from '../services/config-sync'
import { requirePermission } from '../middleware'

const skillsRoutes = new Hono()

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  assertConfigId(slug, 'skill id')
  return slug
}

function validateBody(body: any, id: string) {
  assertConfigId(id, 'skill id')
  assertNonEmptyString(body.name, 'name')
  assertNonEmptyString(body.content, 'content')
  return {
    id,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    content: body.content,
    supportFiles: validateSkillSupportFiles(body.supportFiles),
  }
}

skillsRoutes.get('/', requirePermission('skills:read'), async (c) => {
  const list = await Skill.list({ includeDisabled: true })
  return c.json(list.map((s) => s.toJson()).sort((a, b) => a.name.localeCompare(b.name)))
})

skillsRoutes.get('/:id', requirePermission('skills:read'), async (c) => {
  const skill = await Skill.find(c.req.param('id'))
  if (!skill) return c.json({ error: 'Skill not found' }, 404)
  return c.json(skill.toJson())
})

skillsRoutes.post('/', requirePermission('skills:write'), async (c) => {
  try {
    const body = await c.req.json()
    const input = validateBody(body, body.id)
    if (await Skill.find(input.id)) return c.json({ error: `Skill "${input.id}" already exists` }, 409)
    await Skill.upsert(input)
    return c.json((await Skill.mustFind(input.id)).toJson(), 201)
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

skillsRoutes.post('/import', requirePermission('skills:write'), async (c) => {
  try {
    const body = await c.req.json()
    assertNonEmptyString(body.content, 'content')
    const heading = body.content
      .split(/\r?\n/)
      .find((line: string) => line.startsWith('# '))
      ?.replace(/^#\s+/, '')
      .trim()
    const id = body.id ? body.id : slugify(heading || 'imported-skill')
    const parsed = parseSkillMarkdown(body.content, id, validateSkillSupportFiles(body.supportFiles))
    if (await Skill.find(parsed.id)) return c.json({ error: `Skill "${parsed.id}" already exists` }, 409)
    await Skill.upsert(parsed)
    return c.json((await Skill.mustFind(parsed.id)).toJson(), 201)
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

skillsRoutes.put('/:id', requirePermission('skills:write'), async (c) => {
  try {
    const id = c.req.param('id')
    if (!(await Skill.find(id))) return c.json({ error: 'Skill not found' }, 404)
    const input = validateBody(await c.req.json(), id)
    await Skill.upsert(input)
    await skillSync.recomputeFieldOverrides(id)
    Skill.invalidateCache()
    return c.json((await Skill.mustFind(id)).toJson())
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

skillsRoutes.delete('/:id', requirePermission('skills:write'), async (c) => {
  const skill = await Skill.find(c.req.param('id'))
  if (!skill) return c.json({ error: 'Skill not found' }, 404)
  if (skill.yamlTemplate != null)
    return c.json({ error: 'Cannot delete a template-based config — use disable instead' }, 400)
  await db.delete(skills).where(eq(skills.id, skill.id))
  Skill.invalidateCache()
  return c.json({ ok: true })
})

skillsRoutes.get('/:id/template-diff', requirePermission('skills:read'), async (c) => {
  try {
    return c.json(await skillSync.getTemplateDiff(c.req.param('id')))
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 404)
  }
})
skillsRoutes.post('/:id/revert-to-template', requirePermission('skills:write'), async (c) => {
  try {
    await skillSync.revertToTemplate(c.req.param('id'))
    Skill.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})
skillsRoutes.post('/:id/revert-template-fields', requirePermission('skills:write'), async (c) => {
  try {
    const body = await c.req.json()
    await skillSync.revertTemplateFields(c.req.param('id'), body.fields ?? [])
    Skill.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})
skillsRoutes.post('/:id/disable', requirePermission('skills:write'), async (c) => {
  const id = c.req.param('id')
  if (!(await Skill.find(id))) return c.json({ error: 'Skill not found' }, 404)
  await skillSync.setDisabled(id, true)
  Skill.invalidateCache()
  return c.json({ ok: true })
})
skillsRoutes.post('/:id/enable', requirePermission('skills:write'), async (c) => {
  const id = c.req.param('id')
  if (!(await Skill.find(id))) return c.json({ error: 'Skill not found' }, 404)
  await skillSync.setDisabled(id, false)
  Skill.invalidateCache()
  return c.json({ ok: true })
})
skillsRoutes.put('/:id/support-file', requirePermission('skills:write'), async (c) => {
  try {
    const id = c.req.param('id')
    const skill = await Skill.find(id)
    if (!skill) return c.json({ error: 'Skill not found' }, 404)
    const body = await c.req.json()
    assertNonEmptyString(body.path, 'path')
    assertNonEmptyString(body.content, 'content')
    const supportFiles = validateSkillSupportFiles({ ...skill.supportFiles, [body.path]: body.content })
    await Skill.upsert({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      supportFiles,
    })
    await skillSync.recomputeFieldOverrides(id)
    Skill.invalidateCache()
    return c.json((await Skill.mustFind(id)).toJson())
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

skillsRoutes.delete('/:id/support-file', requirePermission('skills:write'), async (c) => {
  try {
    const id = c.req.param('id')
    const skill = await Skill.find(id)
    if (!skill) return c.json({ error: 'Skill not found' }, 404)
    const body = await c.req.json()
    assertNonEmptyString(body.path, 'path')
    const supportFiles = validateSkillSupportFiles(skill.supportFiles)
    delete supportFiles[body.path]
    await Skill.upsert({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      supportFiles,
    })
    await skillSync.recomputeFieldOverrides(id)
    Skill.invalidateCache()
    return c.json((await Skill.mustFind(id)).toJson())
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

skillsRoutes.get('/:id/export', requirePermission('skills:read'), async (c) => {
  const skill = await Skill.find(c.req.param('id'))
  if (!skill) return c.json({ error: 'Not found' }, 404)
  return c.text(skill.content, 200, { 'Content-Type': 'text/markdown' })
})

export { skillsRoutes }
