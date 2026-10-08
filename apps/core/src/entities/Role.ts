import { eq } from 'drizzle-orm'
import { db, type DbTx } from '../db'
import { roles, type RoleAppliesTo } from '../db/schema'
import type { InferSelectModel } from 'drizzle-orm'

export class RoleProtectedError extends Error {}

export type { RoleAppliesTo }

/**
 * Whether a role may be granted to a person. Agent roles are derived from an
 * agent's type (services/rbac/permissions.ts) and never live in role_assignments,
 * so offering or accepting one for a user is always a mistake.
 */
export function isUserAssignable(role: { appliesTo: RoleAppliesTo }): boolean {
  return role.appliesTo === 'user' || role.appliesTo === 'both'
}

export type RoleRow = InferSelectModel<typeof roles>

export interface CreateRoleInput {
  name: string
  slug: string
  permissions: string[]
  isSystem?: boolean
  readOnly?: boolean
  appliesTo?: RoleAppliesTo
}

export interface UpdateRoleInput {
  name?: string
  permissions?: string[]
}

export class Role {
  constructor(private row: RoleRow) {}

  get id() {
    return this.row.id
  }
  get name() {
    return this.row.name
  }
  get slug() {
    return this.row.slug
  }
  get permissions() {
    return this.row.permissions as string[]
  }
  get appliesTo(): RoleAppliesTo {
    return this.row.appliesTo
  }
  get isSystem() {
    return this.row.isSystem
  }
  get readOnly() {
    return this.row.readOnly
  }
  get createdAt() {
    return this.row.createdAt
  }
  get updatedAt() {
    return this.row.updatedAt
  }
  get updatedBy() {
    return this.row.updatedBy
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      permissions: this.permissions,
      appliesTo: this.appliesTo,
      isSystem: this.isSystem,
      readOnly: this.readOnly,
      updatedBy: this.updatedBy,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    }
  }

  static async create(input: CreateRoleInput): Promise<Role> {
    const [row] = await db
      .insert(roles)
      .values({
        name: input.name,
        slug: input.slug,
        permissions: input.permissions,
        // Custom roles are user roles: every assignment path writes subject_type
        // 'user', and agent roles are declared in config/roles/defaults.yaml only.
        appliesTo: input.appliesTo ?? 'user',
        isSystem: input.isSystem ?? false,
        readOnly: input.readOnly ?? false,
      })
      .returning()
    return new Role(row)
  }

  static async findById(id: string): Promise<Role | null> {
    const [row] = await db.select().from(roles).where(eq(roles.id, id))
    return row ? new Role(row) : null
  }

  static async findBySlug(slug: string): Promise<Role | null> {
    const [row] = await db.select().from(roles).where(eq(roles.slug, slug))
    return row ? new Role(row) : null
  }

  static async findAll(): Promise<Role[]> {
    const rows = await db.select().from(roles)
    return rows.map((r) => new Role(r))
  }

  async update(input: UpdateRoleInput, executor: typeof db | DbTx = db): Promise<Role> {
    if (this.readOnly) {
      throw new RoleProtectedError('Cannot modify read-only roles')
    }
    if (this.isSystem && input.permissions !== undefined) {
      throw new RoleProtectedError('Cannot modify permissions of system roles')
    }
    const updateValues = { ...input }
    if (this.isSystem && updateValues.name !== undefined) {
      delete updateValues.name
    }
    const [row] = await executor
      .update(roles)
      .set({ ...updateValues, updatedAt: new Date(), updatedBy: 'admin' })
      .where(eq(roles.id, this.id))
      .returning()
    this.row = row
    return this
  }

  async delete(executor: typeof db | DbTx = db): Promise<void> {
    if (this.readOnly) {
      throw new RoleProtectedError('Cannot delete read-only roles')
    }
    if (this.isSystem) {
      throw new RoleProtectedError('Cannot delete system roles')
    }
    await executor.delete(roles).where(eq(roles.id, this.id))
  }
}
