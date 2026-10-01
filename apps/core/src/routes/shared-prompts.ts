import { publicErrorMessage } from '../db/errors'
import { Hono } from 'hono'
import { AgentType } from '../entities/AgentType'
import { SharedPrompt } from '../entities/SharedPrompt'
import { assertConfigId, assertNonEmptyString } from '../lib/validation/config-ids'
import { sharedPromptSync } from '../services/config-sync'
import { requirePermission } from '../middleware'

const sharedPromptsRoutes = new Hono()

// `fallbackName` is only used when the caller omits `name` entirely — on create that's
// the id, on update it's the existing record's name, so a content-only PUT can't
// silently rename an include. An explicitly empty/whitespace `name` is always rejected.
function validateBody(body: any, id: string, fallbackName: string) {
  assertConfigId(id, 'shared prompt id')
  assertNonEmptyString(body.content, 'content')
  let name: string
  if (Object.hasOwn(body, 'name')) {
    assertNonEmptyString(body.name, 'name')
    name = body.name.trim()
  } else {
    name = fallbackName
  }
  return {
    id,
    name,
    // `description` is only included when the caller sent it, so SharedPrompt.upsert
    // (which special-cases an absent key) leaves an existing description untouched.
    ...(Object.hasOwn(body, 'description') ? { description: body.description?.trim() || null } : {}),
    content: body.content,
  }
}

sharedPromptsRoutes.get('/', requirePermission('agent-types:read'), async (c) => {
  const list = await SharedPrompt.list({ includeDisabled: true })
  return c.json(list.map((i) => i.toJson()).sort((a, b) => a.name.localeCompare(b.name)))
})

sharedPromptsRoutes.get('/:id', requirePermission('agent-types:read'), async (c) => {
  const include = await SharedPrompt.find(c.req.param('id'))
  if (!include) return c.json({ error: 'Shared prompt not found' }, 404)
  return c.json(include.toJson())
})

sharedPromptsRoutes.post('/', requirePermission('agent-types:update'), async (c) => {
  try {
    const body = await c.req.json()
    const input = validateBody(body, body.id, body.id)
    if (await SharedPrompt.find(input.id)) return c.json({ error: `Shared prompt "${input.id}" already exists` }, 409)
    await SharedPrompt.upsert(input)
    return c.json((await SharedPrompt.mustFind(input.id)).toJson(), 201)
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

sharedPromptsRoutes.put('/:id', requirePermission('agent-types:update'), async (c) => {
  try {
    const id = c.req.param('id')
    const existing = await SharedPrompt.find(id)
    if (!existing) return c.json({ error: 'Shared prompt not found' }, 404)
    const input = validateBody(await c.req.json(), id, existing.name)
    await SharedPrompt.upsert(input)
    await sharedPromptSync.recomputeFieldOverrides(id)
    SharedPrompt.invalidateCache()
    return c.json((await SharedPrompt.mustFind(id)).toJson())
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

sharedPromptsRoutes.delete('/:id', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  const include = await SharedPrompt.find(id)
  if (!include) return c.json({ error: 'Shared prompt not found' }, 404)
  if (include.yamlTemplate != null)
    return c.json({ error: 'Cannot delete a template-based include — disable it instead' }, 400)
  const referencedBy = (await AgentType.list()).filter((t) => (t.includes ?? []).includes(id)).map((t) => t.id)
  if (referencedBy.length) return c.json({ error: `Shared prompt "${id}" is used by agent types`, referencedBy }, 409)
  await SharedPrompt.delete(id)
  return c.json({ ok: true })
})

sharedPromptsRoutes.get('/:id/template-diff', requirePermission('agent-types:read'), async (c) => {
  try {
    return c.json(await sharedPromptSync.getTemplateDiff(c.req.param('id')))
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 404)
  }
})

sharedPromptsRoutes.post('/:id/revert-to-template', requirePermission('agent-types:update'), async (c) => {
  try {
    await sharedPromptSync.revertToTemplate(c.req.param('id'))
    SharedPrompt.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

sharedPromptsRoutes.post('/:id/revert-template-fields', requirePermission('agent-types:update'), async (c) => {
  try {
    const body = await c.req.json()
    await sharedPromptSync.revertTemplateFields(c.req.param('id'), body.fields ?? [])
    SharedPrompt.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: publicErrorMessage(e) }, 400)
  }
})

sharedPromptsRoutes.post('/:id/disable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await SharedPrompt.find(id))) return c.json({ error: 'Shared prompt not found' }, 404)
  await sharedPromptSync.setDisabled(id, true)
  SharedPrompt.invalidateCache()
  return c.json({ ok: true })
})

sharedPromptsRoutes.post('/:id/enable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await SharedPrompt.find(id))) return c.json({ error: 'Shared prompt not found' }, 404)
  await sharedPromptSync.setDisabled(id, false)
  SharedPrompt.invalidateCache()
  return c.json({ ok: true })
})

export { sharedPromptsRoutes }
