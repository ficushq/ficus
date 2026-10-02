import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { Role, RoleProtectedError, isUserAssignable } from '../entities/Role'
import { requirePermission } from '../middleware/require-permission'
import { wsManager } from '../services/ws/manager'
import { isGrantablePermission } from '../services/rbac/grantable'
import { db } from '../db'
import { roleAssignments } from '../db/schema'
import { withGitHubTrustMutation } from '../services/integrations/github/trust-mutation-guard'
import { GitHubFeedbackError } from '../services/integrations/github/feedback-trust'
import type { Identity } from '../services/rbac/permissions'
import { eventEmitter } from '../lib/infra/event-emitter'

const permissionArraySchema = z.array(z.string()).refine((perms) => perms.every(isGrantablePermission), {
  message: 'permissions contains an invalid or non-grantable value (global "*" and unknown permissions are rejected)',
})

const createRoleSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  permissions: permissionArraySchema,
})

const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  permissions: permissionArraySchema.optional(),
})

export const rolesRouter = new Hono()

function listAssignedHumanUsers(roleId: string) {
  return db
    .selectDistinct({ userId: roleAssignments.subjectId })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.roleId, roleId), eq(roleAssignments.subjectType, 'user')))
}

rolesRouter.get('/', requirePermission('roles:read'), async (c) => {
  const allRoles = await Role.findAll()
  // ?assignableTo=user narrows to the roles a person can actually hold, so human
  // role pickers don't have to know which slugs are agent-derived.
  const assignableTo = c.req.query('assignableTo')
  const visible = assignableTo === 'user' ? allRoles.filter(isUserAssignable) : allRoles
  return c.json(visible.map((r) => r.toJSON()))
})

rolesRouter.get('/:id', requirePermission('roles:read'), async (c) => {
  const role = await Role.findById(c.req.param('id'))
  if (!role) return c.json({ error: 'Role not found' }, 404)
  return c.json(role.toJSON())
})

rolesRouter.post('/', requirePermission('roles:create'), async (c) => {
  const body = await c.req.json()
  const parsed = createRoleSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const { name, slug, permissions } = parsed.data

  const existing = await Role.findBySlug(slug)
  if (existing) return c.json({ error: 'Role with this slug already exists' }, 409)

  const role = await Role.create({ name, slug, permissions, isSystem: false })
  wsManager.invalidateAccessCache()
  return c.json(role.toJSON(), 201)
})

rolesRouter.put('/:id', requirePermission('roles:update'), async (c) => {
  const role = await Role.findById(c.req.param('id'))
  if (!role) return c.json({ error: 'Role not found' }, 404)

  const body = await c.req.json()
  const parsed = updateRoleSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const affectedUsers = parsed.data.permissions === undefined ? [] : await listAssignedHumanUsers(role.id)

  try {
    await withGitHubTrustMutation(c.get('identity') as Identity, role.id, (tx) => role.update(parsed.data, tx))
  } catch (err) {
    if (err instanceof GitHubFeedbackError) return c.json({ error: err.code }, err.status)
    if (err instanceof RoleProtectedError) return c.json({ error: err.message }, 403)
    throw err
  }
  wsManager.invalidateAccessCache()
  for (const { userId } of affectedUsers) eventEmitter.emit('liveActivity.interestChanged', { userId })
  return c.json(role.toJSON())
})

rolesRouter.delete('/:id', requirePermission('roles:delete'), async (c) => {
  const role = await Role.findById(c.req.param('id'))
  if (!role) return c.json({ error: 'Role not found' }, 404)

  // Capture affected users before the FK cascade removes assignment rows.
  const affectedUsers = await listAssignedHumanUsers(role.id)
  try {
    await withGitHubTrustMutation(c.get('identity') as Identity, role.id, (tx) => role.delete(tx))
  } catch (err) {
    if (err instanceof GitHubFeedbackError) return c.json({ error: err.code }, err.status)
    if (err instanceof RoleProtectedError) return c.json({ error: err.message }, 403)
    throw err
  }
  wsManager.invalidateAccessCache()
  for (const { userId } of affectedUsers) eventEmitter.emit('liveActivity.interestChanged', { userId })
  return c.body(null, 204)
})
