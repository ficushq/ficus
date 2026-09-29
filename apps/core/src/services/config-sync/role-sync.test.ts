import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { db, roleAssignments, roles, users } from '../../db'
import { and, eq, inArray } from 'drizzle-orm'
import { createTestUser } from '../../test-utils'
import { DEMO_REVIEWER_EMAIL } from '../demo/reviewer'
import { RoleSync } from './role-sync'

describe('RoleSync', () => {
  const sync = new RoleSync()

  beforeEach(async () => {
    await db.delete(roles)
  })

  test('loads and syncs all default roles from config/roles/defaults.yaml', async () => {
    const result = await sync.sync()
    expect(result.synced).toBeGreaterThanOrEqual(5) // admin, operator, viewer, default-worker, default-manager
    expect(result.skipped).toBe(0)

    const rows = await db.select().from(roles)
    expect(rows.length).toBe(result.synced)
  })

  test('default-worker role exists and includes required agent permissions', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'default-worker'))
    expect(row).toBeTruthy()
    expect(row.readOnly).toBe(true)
    expect(row.isSystem).toBe(true)
    expect(row.permissions).toContain('chat:send')
    expect(row.permissions).toContain('workstreams:read')
    expect(row.permissions).toContain('skills:read')
    expect(row.permissions).toContain('skills:write')
    expect(row.permissions).toContain('monitors:read')
    expect(row.permissions).toContain('monitors:write')
    expect(row.permissions).toContain('deployments:read')
    expect(row.permissions).toContain('deployments:write')
    expect(row.permissions).toContain('deployments:delete')
    expect(row.permissions).toContain('artifacts:read')
    expect(row.permissions).toContain('artifacts:write')
    expect(row.permissions).toContain('routing:read')
    expect(row.permissions).toContain('slots:use')
    expect(row.permissions).not.toContain('slots:write')
    expect(row.permissions).not.toContain('inbox:read-squad')
  })

  test('default-manager role exists and includes all worker permissions plus manage-agents', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'default-manager'))
    expect(row).toBeTruthy()
    expect(row.readOnly).toBe(true)
    expect(row.isSystem).toBe(true)
    expect(row.permissions).toContain('chat:read')
    expect(row.permissions).toContain('workstreams:manage-agents')
    expect(row.permissions).toContain('integrations:read')
    expect(row.permissions).toContain('integrations:use')
    expect(row.permissions).not.toContain('integrations:write')
    expect(row.permissions).toContain('squads:update')
    expect(row.permissions).toContain('skills:read')
    expect(row.permissions).toContain('skills:write')
    expect(row.permissions).toContain('monitors:read')
    expect(row.permissions).toContain('monitors:write')
    expect(row.permissions).toContain('deployments:read')
    expect(row.permissions).toContain('deployments:write')
    expect(row.permissions).toContain('deployments:delete')
    expect(row.permissions).toContain('artifacts:read')
    expect(row.permissions).toContain('artifacts:write')
    expect(row.permissions).toContain('routing:read')
    expect(row.permissions).toContain('slots:write')
    expect(row.permissions).not.toContain('slots:use')
    expect(row.permissions).toContain('inbox:read-squad')
  })

  test('operator role includes new resource wildcard permissions', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'operator'))
    expect(row).toBeTruthy()
    expect(row.permissions).toContain('skills:*')
    expect(row.permissions).toContain('monitors:*')
    expect(row.permissions).toContain('deployments:*')
    expect(row.permissions).toContain('artifacts:*')
    expect(row.permissions).toContain('grants:*')
    expect(row.permissions).toContain('routing:*')
    expect(row.permissions).toContain('ai:voice')
  })

  test('viewer role includes new resource read permissions', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'viewer'))
    expect(row).toBeTruthy()
    expect(row.permissions).toContain('skills:read')
    expect(row.permissions).toContain('monitors:read')
    expect(row.permissions).toContain('deployments:read')
    expect(row.permissions).toContain('artifacts:read')
    expect(row.permissions).toContain('grants:read')
    expect(row.permissions).toContain('routing:read')
    expect(row.permissions).toContain('inbox:read-squad')
  })

  test('default roles grant operations recommendation permissions as intended', async () => {
    await sync.sync()
    const expectedPermissions = {
      viewer: ['recommendations:read'],
      operator: ['recommendations:read', 'recommendations:update'],
      'default-manager': ['recommendations:read', 'recommendations:update'],
      'default-worker': [],
    }

    for (const [slug, permissions] of Object.entries(expectedPermissions)) {
      const [row] = await db.select().from(roles).where(eq(roles.slug, slug))
      expect(row).toBeTruthy()
      for (const permission of permissions) expect(row.permissions).toContain(permission)
      if (permissions.length === 0) {
        expect(row.permissions).not.toContain('recommendations:read')
        expect(row.permissions).not.toContain('recommendations:update')
      }
    }
  })

  test('farmer role is the farm, and the people already here with a role get it when it first arrives (once)', async () => {
    // Someone already here holds a role; the default role arrives with the next sync.
    const [existing] = await db
      .insert(roles)
      .values({ name: 'Existing', slug: `existing-${crypto.randomUUID()}`, permissions: ['squads:read'] })
      .returning()
    const someone = await createTestUser({ prefix: `role-sync-${crypto.randomUUID()}` })
    await db
      .insert(roleAssignments)
      .values({ subjectType: 'user', subjectId: someone.id, roleId: existing!.id, scope: 'squad_default' })
    await sync.sync()
    const [farmer] = await db.select().from(roles).where(eq(roles.slug, 'farmer'))
    expect(farmer?.permissions).toEqual(['farm:read', 'farm:chat'])
    const held = await db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.subjectId, someone.id), eq(roleAssignments.roleId, farmer!.id)))
    expect(held).toHaveLength(1)
    expect(held[0]!.scope).toBe('system')
    // Removed by an admin, it stays removed: later syncs only update the role.
    await db.delete(roleAssignments).where(eq(roleAssignments.id, held[0]!.id))
    await sync.sync()
    expect(
      await db
        .select()
        .from(roleAssignments)
        .where(and(eq(roleAssignments.subjectId, someone.id), eq(roleAssignments.roleId, farmer!.id)))
    ).toHaveLength(0)
    await db.delete(users).where(eq(users.id, someone.id))
  })

  test('the farmer backfill skips people without a role, disabled people and the demo reviewer', async () => {
    const [existing] = await db
      .insert(roles)
      .values({ name: 'Existing', slug: `existing-${crypto.randomUUID()}`, permissions: ['squads:read'] })
      .returning()
    const roleless = await createTestUser({ prefix: `role-sync-${crypto.randomUUID()}` })
    const disabled = await createTestUser({ prefix: `role-sync-${crypto.randomUUID()}` })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id))
    await db.delete(users).where(eq(users.email, DEMO_REVIEWER_EMAIL))
    const reviewer = await createTestUser({ email: DEMO_REVIEWER_EMAIL })
    for (const person of [disabled, reviewer]) {
      await db
        .insert(roleAssignments)
        .values({ subjectType: 'user', subjectId: person.id, roleId: existing!.id, scope: 'system' })
    }
    await sync.sync()
    const [farmer] = await db.select().from(roles).where(eq(roles.slug, 'farmer'))
    for (const person of [roleless, disabled, reviewer]) {
      expect(
        await db
          .select()
          .from(roleAssignments)
          .where(and(eq(roleAssignments.subjectId, person.id), eq(roleAssignments.roleId, farmer!.id)))
      ).toHaveLength(0)
    }
    await db.delete(users).where(inArray(users.id, [roleless.id, disabled.id, reviewer.id]))
  })

  test('admin role has wildcard permission', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'admin'))
    expect(row).toBeTruthy()
    expect(row.readOnly).toBe(true)
    expect(row.isSystem).toBe(true)
    expect(row.permissions).toContain('*')
  })

  test('agent roles do not have grants:* permission', async () => {
    await sync.sync()
    for (const slug of ['default-worker', 'default-manager']) {
      const [row] = await db.select().from(roles).where(eq(roles.slug, slug))
      expect(row.permissions).not.toContain('grants:*')
    }
  })

  test('skips roles modified by admin (updatedBy=admin)', async () => {
    await sync.sync()
    // Simulate admin modification
    await db
      .update(roles)
      .set({ updatedBy: 'admin', permissions: ['custom:perm'] })
      .where(eq(roles.slug, 'viewer'))

    const result = await sync.sync()
    expect(result.skipped).toBeGreaterThanOrEqual(1)

    // Viewer should retain admin-set permissions
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'viewer'))
    expect(row.permissions).toContain('custom:perm')
    expect(row.updatedBy).toBe('admin')
  })

  test('updates yaml-owned roles when permissions change', async () => {
    await sync.sync()
    // Manually corrupt viewer permissions (yaml-owned)
    await db
      .update(roles)
      .set({ permissions: ['squads:read'] })
      .where(eq(roles.slug, 'viewer'))

    const result = await sync.sync()
    expect(result.synced).toBeGreaterThanOrEqual(1)

    // Should be restored from yaml
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'viewer'))
    expect(row.permissions).toContain('skills:read')
  })

  test('updatedBy is set to yaml on insert', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'admin'))
    expect(row.updatedBy).toBe('yaml')
  })

  test('does not delete existing roles not in yaml', async () => {
    // Insert a custom role not in yaml
    await db.insert(roles).values({
      name: 'Custom Role',
      slug: 'custom-role',
      permissions: ['custom:read'],
      isSystem: false,
      readOnly: false,
      updatedBy: 'admin',
    })

    await sync.sync()

    const [customRow] = await db.select().from(roles).where(eq(roles.slug, 'custom-role'))
    expect(customRow).toBeTruthy()
  })

  test('default-worker grants bare resource:action permissions (no dead :own grants)', async () => {
    await sync.sync()
    const [row] = await db.select().from(roles).where(eq(roles.slug, 'default-worker'))
    // :own grants matched nothing; replaced with the bare perms the guards request.
    expect(row.permissions).toContain('memory:read')
    expect(row.permissions).toContain('memory:write')
    expect(row.permissions).toContain('inbox:read')
    expect(row.permissions).toContain('inbox:write')
    expect(row.permissions).toContain('squads:read')
    expect(row.permissions).not.toContain('memory:own')
    expect(row.permissions).not.toContain('inbox:own')
    expect(row.permissions).not.toContain('squads:read:own')
  })

  test('re-applies yaml to admin-edited readOnly roles (security tightening propagates)', async () => {
    await sync.sync()
    // Admin over-broadens a readOnly system role and marks it admin-owned.
    await db
      .update(roles)
      .set({ updatedBy: 'admin', permissions: ['*'] })
      .where(eq(roles.slug, 'default-worker'))

    await sync.sync()

    const [row] = await db.select().from(roles).where(eq(roles.slug, 'default-worker'))
    // Must be restored from yaml, dropping the over-broad '*'.
    expect(row.permissions).not.toContain('*')
    expect(row.permissions).toContain('chat:send')
    expect(row.updatedBy).toBe('yaml')
  })

  test('malformed defaults.yaml fails soft (no throw, no abort of config sync)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rolesync-'))
    // Unterminated quoted scalar -> YAMLParseError from parse().
    writeFileSync(join(dir, 'defaults.yaml'), 'roles: "unterminated')
    const result = await new RoleSync(dir).sync()
    expect(result).toEqual({ synced: 0, skipped: 0 })
  })
})
