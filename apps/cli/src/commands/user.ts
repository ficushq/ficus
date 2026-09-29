import { Command } from 'commander'
import { permissionMatches } from '@ficus/shared'
import { apiGet } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

type AssignmentScope = 'system' | 'squad_default' | 'squad'

interface UserRow {
  id: string
  email: string
  displayName: string | null
  disabledAt: string | null
  createdAt: string
  hasPasskey: boolean
  isAdmin: boolean
  inviteExpiresAt: string | null
}

interface RoleAssignment {
  id: string
  roleId: string
  roleSlug: string
  roleName: string
  scope: AssignmentScope
  squadId: string | null
  createdAt: string
}

interface Role {
  id: string
  name: string
  slug: string
  permissions: string[]
  appliesTo: string
  isSystem: boolean
  readOnly: boolean
}

interface EffectivePermissions {
  userId: string
  email: string
  disabled: boolean
  squad: { id: string; name: string } | null
  roles: Array<{ slug: string; name: string; scope: AssignmentScope; squadId: string | null; permissions: string[] }>
  permissions: string[]
}

function userState(user: UserRow): string {
  if (user.disabledAt) return 'disabled'
  return user.hasPasskey ? 'active' : 'invited'
}

/** A user named by full id, unique id prefix, or email (case-insensitive). */
export function findUser(users: UserRow[], ref: string): UserRow {
  const needle = ref.trim().toLowerCase()
  const exact = users.find((user) => user.id === needle || user.email.toLowerCase() === needle)
  if (exact) return exact
  const byPrefix = users.filter((user) => user.id.startsWith(needle))
  if (byPrefix.length === 1) return byPrefix[0]
  if (byPrefix.length > 1) throw new Error(`User id prefix "${ref}" is ambiguous; use more characters or the email`)
  throw new Error(`User not found: ${ref}. Run "ficus user list" to see every user.`)
}

/** A role named by slug or id. */
export function findRole(roles: Role[], ref: string): Role {
  const role = roles.find((candidate) => candidate.slug === ref || candidate.id === ref)
  if (!role) throw new Error(`Role not found: ${ref}. Run "ficus role list" to see every role.`)
  return role
}

/** Where an assignment applies, in words: squad_default is "every squad without its own role". */
export function describeScope(assignment: Pick<RoleAssignment, 'scope' | 'squadId'>, squadNames: Map<string, string>) {
  if (assignment.scope === 'system') return 'instance-wide'
  if (assignment.scope === 'squad_default') return 'default for squads'
  const id = assignment.squadId ?? ''
  return `squad ${squadNames.get(id) ?? id.slice(0, 8)}`
}

async function resolveUser(ref: string): Promise<UserRow> {
  return findUser(await apiGet<UserRow[]>('/api/users'), ref)
}

async function squadNameMap(): Promise<Map<string, string>> {
  const squads = await apiGet<Array<{ id: string; name: string }>>('/api/squads')
  return new Map(squads.map((squad) => [squad.id, squad.name]))
}

export function registerUserCommands(program: Command) {
  const user = program
    .command('user')
    .description('Read user accounts, their role assignments, and effective permissions (requires users:read)')

  user
    .command('list')
    .description('List users with their state (active, invited, disabled)')
    .action(async () => {
      try {
        const users = await apiGet<UserRow[]>('/api/users')
        if (isJsonMode()) return output(users)
        if (users.length === 0) return console.log('No users found')
        outputTable(
          users.map((row) => ({
            ID: row.id.slice(0, 8),
            Email: row.email,
            Name: row.displayName ?? '',
            State: userState(row),
            Admin: row.isAdmin ? 'yes' : '',
          })),
          ['ID', 'Email', 'Name', 'State', 'Admin']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  user
    .command('get <user>')
    .description('Show one user (by id, id prefix, or email) and every role assignment with where it applies')
    .action(async (ref) => {
      try {
        const found = await resolveUser(ref)
        const [assignments, squadNames] = await Promise.all([
          apiGet<RoleAssignment[]>(`/api/users/${found.id}/roles`),
          squadNameMap(),
        ])
        const roles = assignments.map((assignment) => ({
          ...assignment,
          squadName: assignment.squadId ? (squadNames.get(assignment.squadId) ?? null) : null,
        }))
        if (isJsonMode()) return output({ ...found, state: userState(found), roles })
        console.log(`${found.email}${found.displayName ? ` (${found.displayName})` : ''}`)
        console.log(`ID:      ${found.id}`)
        console.log(`State:   ${userState(found)}${found.isAdmin ? ', system admin' : ''}`)
        console.log(`Created: ${found.createdAt}`)
        if (roles.length === 0) return console.log('Roles:   none (this user can sign in but see nothing)')
        console.log('Roles:')
        outputTable(
          roles.map((assignment) => ({
            Role: assignment.roleSlug,
            Applies: describeScope(assignment, squadNames),
            Assignment: assignment.id.slice(0, 8),
          })),
          ['Role', 'Applies', 'Assignment']
        )
        console.log(
          'A role on a squad replaces the default-for-squads roles there. Use "ficus user permissions" to resolve it.'
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  user
    .command('permissions <user>')
    .description("Resolve a user's effective permissions, instance-wide or in one squad, exactly as the server does")
    .option('-q, --squad <squadId>', 'Include that squad’s role tier (id or 8-character short id)')
    .option('--check <permission>', 'Only report whether the user holds this permission (e.g. deployments:read)')
    .action(async (ref, options: { squad?: string; check?: string }) => {
      try {
        const found = await resolveUser(ref)
        const query = options.squad ? `?squadId=${encodeURIComponent(options.squad)}` : ''
        const result = await apiGet<EffectivePermissions>(`/api/users/${found.id}/permissions${query}`)
        const where = result.squad ? `in squad ${result.squad.name}` : 'instance-wide'
        if (options.check) {
          const grantedBy = result.permissions.filter((held) => permissionMatches(held, options.check!))
          const allowed = grantedBy.length > 0 && !result.disabled
          if (isJsonMode()) return output({ ...result, check: options.check, allowed, grantedBy })
          console.log(
            `${result.email} ${allowed ? 'HAS' : 'does NOT have'} ${options.check} ${where}` +
              (grantedBy.length ? ` (granted by ${grantedBy.join(', ')})` : '') +
              (result.disabled ? ' — account is disabled' : '')
          )
          return
        }
        if (isJsonMode()) return output(result)
        console.log(`${result.email} ${where}${result.disabled ? ' (account disabled)' : ''}`)
        console.log(`Roles: ${result.roles.map((role) => `${role.slug} (${role.scope})`).join(', ') || 'none'}`)
        console.log('Permissions:')
        for (const permission of [...result.permissions].sort()) console.log(`  ${permission}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}

export function registerRoleCommands(program: Command) {
  const role = program.command('role').description('Read role definitions and their permissions (requires roles:read)')

  role
    .command('list')
    .description('List roles')
    .option('--user-assignable', 'Only roles a person can hold (hides agent-derived roles)')
    .action(async (options: { userAssignable?: boolean }) => {
      try {
        const roles = await apiGet<Role[]>(`/api/roles${options.userAssignable ? '?assignableTo=user' : ''}`)
        if (isJsonMode()) return output(roles)
        if (roles.length === 0) return console.log('No roles found')
        outputTable(
          roles.map((row) => ({
            Slug: row.slug,
            Name: row.name,
            'Applies To': row.appliesTo,
            System: row.isSystem ? 'yes' : '',
            Permissions: row.permissions.length,
          })),
          ['Slug', 'Name', 'Applies To', 'System', 'Permissions']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  role
    .command('get <role>')
    .description('Show one role (by slug or id) and every permission it grants')
    .action(async (ref) => {
      try {
        const found = findRole(await apiGet<Role[]>('/api/roles'), ref)
        if (isJsonMode()) return output(found)
        console.log(`${found.name} (${found.slug})${found.isSystem ? ', system role' : ''}`)
        console.log(`ID:         ${found.id}`)
        console.log(`Applies to: ${found.appliesTo}`)
        console.log('Permissions:')
        for (const permission of found.permissions) console.log(`  ${permission}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
