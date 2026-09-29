import { readFile } from 'fs/promises'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { parse } from 'yaml'
import { db } from '../../db'
import { roles, type RoleAppliesTo } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import { CONFIG_DIR } from '../../lib/paths'
import { backfillUserIds, DEFAULT_USER_ROLE_SLUGS, grantDefaultRoles } from '../rbac/default-roles'
import { invalidatePermissionCache } from '../rbac/permissions'

const log = createLogger('config-sync:roles')

interface RoleYaml {
  name: string
  slug: string
  permissions: string[]
  readOnly?: boolean
  /**
   * Which subject the role is for. Omitted means 'user' — every role that isn't
   * explicitly agent-derived is one a person can hold.
   */
  appliesTo?: RoleAppliesTo
}

const VALID_APPLIES_TO: RoleAppliesTo[] = ['user', 'agent', 'both']

/** Fail soft on a typo in the yaml rather than writing a value nothing understands. */
function appliesToOf(roleDef: RoleYaml): RoleAppliesTo {
  const declared = roleDef.appliesTo
  if (declared && VALID_APPLIES_TO.includes(declared)) return declared
  if (declared) log.warn(`Role ${roleDef.slug}: unknown appliesTo "${declared}" — defaulting to 'user'`)
  return 'user'
}

interface RolesFile {
  roles: RoleYaml[]
}

export class RoleSync {
  readonly name = 'roles'
  readonly directory: string

  constructor(directory: string = join(CONFIG_DIR, 'roles')) {
    this.directory = directory
  }

  async sync(): Promise<{ synced: number; skipped: number }> {
    const filePath = join(this.directory, 'defaults.yaml')
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (_err) {
      log.warn(`No role defaults found at ${filePath}`)
      return { synced: 0, skipped: 0 }
    }

    let parsed: RolesFile
    try {
      parsed = parse(content) as RolesFile
    } catch (err) {
      // Fail soft: a malformed roles file must not abort the rest of config sync.
      log.error(`Failed to parse role defaults at ${filePath}: ${(err as Error).message}`)
      return { synced: 0, skipped: 0 }
    }
    if (!parsed?.roles?.length) {
      log.warn('No roles defined in defaults.yaml')
      return { synced: 0, skipped: 0 }
    }

    let synced = 0
    let skipped = 0

    for (const roleDef of parsed.roles) {
      const existing = await db.select().from(roles).where(eq(roles.slug, roleDef.slug))

      if (existing.length > 0) {
        const current = existing[0]

        // Respect admin modifications — but only for roles the yaml does NOT
        // mark readOnly. readOnly roles are security-critical defaults and must
        // always reconcile from yaml so a later tightening of defaults.yaml
        // propagates even after an admin edit.
        const yamlReadOnly = roleDef.readOnly ?? false
        if (!yamlReadOnly && current.updatedBy === 'admin') {
          skipped++
          log.info(`Skipping role ${roleDef.slug}: modified by admin`)
          continue
        }

        const permsChanged = JSON.stringify(current.permissions) !== JSON.stringify(roleDef.permissions)
        const readOnlyChanged = current.readOnly !== (roleDef.readOnly ?? false)
        const appliesTo = appliesToOf(roleDef)
        const appliesToChanged = current.appliesTo !== appliesTo
        if (permsChanged || readOnlyChanged || appliesToChanged) {
          await db
            .update(roles)
            .set({
              permissions: roleDef.permissions,
              readOnly: roleDef.readOnly ?? false,
              appliesTo,
              updatedBy: 'yaml',
              updatedAt: new Date(),
            })
            .where(eq(roles.slug, roleDef.slug))
          synced++
          log.info(`Updated role: ${roleDef.slug}`)
        } else {
          skipped++
        }
      } else {
        // Creating a default role and granting it to the people already here happen together: if the
        // grant fails, the role isn't there either, so the next start tries both again. Only the first
        // creation grants, so an assignment an admin removes later stays removed.
        const isDefault = (DEFAULT_USER_ROLE_SLUGS as readonly string[]).includes(roleDef.slug)
        await db.transaction(async (tx) => {
          await tx.insert(roles).values({
            name: roleDef.name,
            slug: roleDef.slug,
            permissions: roleDef.permissions,
            appliesTo: appliesToOf(roleDef),
            isSystem: true,
            readOnly: roleDef.readOnly ?? false,
            updatedBy: 'yaml',
          })
          if (isDefault) await grantDefaultRoles(await backfillUserIds(tx), [roleDef.slug], tx)
        })
        synced++
        log.info(`Created role: ${roleDef.slug}`)
        if (isDefault) {
          invalidatePermissionCache()
          log.info(`Granted ${roleDef.slug} to everyone with a role`)
        }
      }
    }

    log.info(`Role sync complete: ${synced} synced, ${skipped} unchanged`)
    return { synced, skipped }
  }
}
