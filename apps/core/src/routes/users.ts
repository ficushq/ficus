import { getPostgresError } from '../db/errors'
import { Hono } from 'hono'
import { eq, and, ne, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import { roleAssignments, roles, sessions, squads, users } from '../db/schema'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { User } from '../entities/User'
import { Role, isUserAssignable } from '../entities/Role'
import { requirePermission } from '../middleware/require-permission'
import { wsManager } from '../services/ws/manager'
import {
  auditActor,
  resolvePermissions,
  resolveRoleSummaries,
  permissionMatches,
  type Identity,
} from '../services/rbac'
import { Squad } from '../entities/Squad'
import { AmbiguousPrefixError } from '../db/prefix-match'
import {
  sendInviteEmail,
  issueEmailChallenge,
  supersedeRegistrationChallenges,
  recentVerificationCount,
  INVITE_CHALLENGE_TTL_MS,
  VERIFICATION_RATE_LIMIT,
} from '../services/auth/email'
import { createLogger } from '../lib/infra/logger'
import { systemAdminUserIds } from '../services/auth/admin-users'
import { getSeatPricingConfig, summarizeSeatPricing } from '../services/platform/seat-pricing'
import { notifyOnboardingChanged } from '../services/onboarding/events'
import { eventEmitter } from '../lib/infra/event-emitter'
import { endLiveActivitiesForUser } from '../services/push/live-activity'

const log = createLogger('users-routes')

/**
 * Role every invitee gets when the caller names none. An account with no role at
 * all can sign in and see nothing, which reads as a broken invite; `operator` is
 * the ordinary "can actually use this instance" role (`viewer` and any other
 * user-assignable role remain freely selectable, and `admin` is only grantable by
 * a caller who already holds those permissions — see ungrantablePermissions).
 */
const DEFAULT_INVITE_ROLE_SLUG = 'operator'

export const usersRouter = new Hono()

/**
 * Privilege-escalation guard: a caller may only grant permissions they themselves
 * hold in the scope the assignment targets. '*' can only be granted by a holder
 * of '*'. Returns the missing permissions (empty when the grant is allowed).
 */
async function ungrantablePermissions(
  identity: Identity,
  role: Pick<Role, 'permissions'>,
  squadId?: string
): Promise<string[]> {
  const callerPermissions = await resolvePermissions(identity, squadId)
  return role.permissions.filter((granted) => !callerPermissions.some((held) => permissionMatches(held, granted)))
}

/**
 * Resolve the caller-supplied role identifiers (ids OR slugs) for a new user.
 * Every returned role is validated as user-assignable and within the caller's
 * own permissions before anything is written.
 */
async function resolveInviteRoles(
  identifiers: string[] | undefined,
  identity: Identity
): Promise<{ roles: Role[] } | { error: string }> {
  const explicit = !!identifiers?.length
  const wanted = explicit ? [...new Set(identifiers!)] : [DEFAULT_INVITE_ROLE_SLUG]

  // The role table is small (a handful of rows) — matching ids and slugs in
  // memory beats building a two-column IN query for the sake of one round trip.
  const found = await Role.findAll()

  const resolved: Role[] = []
  for (const identifier of wanted) {
    const role = found.find((r) => r.slug === identifier || r.id === identifier)
    if (!role) {
      // A role the caller explicitly named must exist. The implicit default is
      // soft: on an instance whose config sync has not seeded `operator` yet,
      // inviting someone role-less beats refusing to invite them at all.
      if (explicit) return { error: `Unknown role: ${identifier}` }
      log.warn(`Default invite role '${identifier}' not found — inviting with no roles`)
      continue
    }
    // Agent roles (default-worker/-manager/-consultant) are derived from an
    // agent's type, never assigned to a person — granting one to a user would
    // silently do nothing useful.
    if (!isUserAssignable(role)) return { error: `Role ${role.slug} cannot be assigned to a user` }
    resolved.push(role)
  }

  for (const role of resolved) {
    const lacking = await ungrantablePermissions(identity, role)
    if (lacking.length > 0) return { error: `Cannot grant permissions you do not hold: ${lacking.join(', ')}` }
  }

  return { roles: resolved }
}

type AssignmentScope = 'system' | 'squad_default' | 'squad'
const ASSIGNMENT_SCOPES: readonly AssignmentScope[] = ['system', 'squad_default', 'squad']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One role an invite gives, in a scope, as the per-user role editor would assign it. */
interface InviteAssignment {
  role: Role
  scope: AssignmentScope
  squadId: string | null
}

/**
 * Resolve an invite's role assignments: `assignments` (a role id or slug, a
 * scope, and a squad for squad scope), plus any `roleIds` (system-wide, the
 * older shape). Neither gives the default role system-wide. Each is validated
 * as POST /:id/roles validates one (user-assignable, a real squad for squad
 * scope, and within the caller's own permissions in that scope) before
 * anything is written.
 */
async function resolveInviteAssignments(
  assignments: unknown,
  roleIds: string[] | undefined,
  identity: Identity
): Promise<{ assignments: InviteAssignment[] } | { error: string; status: 400 | 403 }> {
  if (assignments !== undefined && !Array.isArray(assignments))
    return { error: 'assignments must be an array', status: 400 }
  const requested = (assignments ?? []) as Array<Record<string, unknown>>
  if (!requested.length) {
    const resolved = await resolveInviteRoles(roleIds, identity)
    if ('error' in resolved)
      return { error: resolved.error, status: resolved.error.startsWith('Cannot grant') ? 403 : 400 }
    return { assignments: resolved.roles.map((role) => ({ role, scope: 'system', squadId: null })) }
  }

  const found = await Role.findAll()
  const out: InviteAssignment[] = []
  const wanted = [
    ...(roleIds ?? []).map((roleId) => ({ roleId, scope: 'system' as unknown, squadId: undefined as unknown })),
    ...requested,
  ]
  for (const item of wanted) {
    const { roleId, scope, squadId } = item as { roleId?: unknown; scope?: unknown; squadId?: unknown }
    if (typeof roleId !== 'string') return { error: 'Each assignment needs a roleId', status: 400 }
    if (typeof scope !== 'string' || !ASSIGNMENT_SCOPES.includes(scope as AssignmentScope))
      return { error: `scope must be one of: ${ASSIGNMENT_SCOPES.join(', ')}`, status: 400 }
    if (scope === 'squad' && (typeof squadId !== 'string' || !UUID.test(squadId)))
      return { error: 'squadId is required for squad scope', status: 400 }
    if (scope !== 'squad' && squadId !== undefined && squadId !== null)
      return { error: 'squadId must not be set for system or squad_default scope', status: 400 }
    const role = found.find((r) => r.id === roleId || r.slug === roleId)
    if (!role) return { error: `Unknown role: ${roleId}`, status: 400 }
    if (!isUserAssignable(role)) return { error: `Role ${role.slug} cannot be assigned to a user`, status: 400 }
    if (scope === 'squad') {
      const [squad] = await db
        .select({ id: squads.id })
        .from(squads)
        .where(eq(squads.id, squadId as string))
      if (!squad) return { error: `Unknown squad: ${squadId}`, status: 400 }
    }
    const lacking = await ungrantablePermissions(identity, role, scope === 'squad' ? (squadId as string) : undefined)
    if (lacking.length > 0)
      return { error: `Cannot grant permissions you do not hold: ${lacking.join(', ')}`, status: 403 }
    const next = { role, scope: scope as AssignmentScope, squadId: scope === 'squad' ? (squadId as string) : null }
    if (!out.some((a) => a.role.id === role.id && a.scope === next.scope && a.squadId === next.squadId)) out.push(next)
  }
  return { assignments: out }
}

/**
 * What the caller learns about an invite that was just issued.
 *
 * With email configured the invitee gets the link by mail and neither the code
 * nor the link is echoed back to the admin. Without a provider there is no
 * delivery channel, so both come back for the admin to hand over.
 */
interface IssuedInvite {
  inviteCode?: string
  inviteUrl?: string
  inviteEmailFailed?: boolean
}

/**
 * Issue + deliver one invite, swallowing a mail failure into a flag.
 *
 * A mail failure must never 500: at the creation call site the account and its
 * roles are already committed, and at the resend call site the previous link has
 * already been retired — throwing would leave the caller with a broken invite and
 * no way to see it. Delivery is the LAST step of sendInviteEmail, so in practice
 * `inviteEmailFailed` means "issued but undelivered", which is what both call
 * sites report to the admin.
 */
async function deliverInvite(email: string): Promise<IssuedInvite> {
  try {
    const sent = await sendInviteEmail(email, { ttlMs: INVITE_CHALLENGE_TTL_MS })
    if (sent.mailed) return {}
    return { inviteCode: sent.code, inviteUrl: sent.link }
  } catch (err) {
    log.error(`Invite email failed for ${email}: ${(err as Error).message}`)
    return { inviteEmailFailed: true }
  }
}

// ── User CRUD ────────────────────────────────────────────────────────────────

usersRouter.get('/', requirePermission('users:read'), async (c) => {
  // Invites create the user row up front, so the list would otherwise show a
  // never-arrived invitee exactly like someone who onboarded months ago. Holding
  // at least one passkey is what "finished setup" means on this instance, and
  // the outstanding registration challenge says whether the invite is still
  // redeemable. Counts and timestamps only — never the code or its hash.
  //
  // `isAdmin` marks system admins: a pending admin's invite link has to be opened
  // where that admin will sign in, which the web app says when it shows the link.
  const [rows, adminIds] = await Promise.all([User.findAllWithOnboarding(), systemAdminUserIds()])
  return c.json(
    rows.map(({ user, passkeyCount, inviteExpiresAt }) => ({
      ...user.toJSON(),
      passkeyCount,
      hasPasskey: passkeyCount > 0,
      isAdmin: adminIds.has(user.id),
      inviteExpiresAt: inviteExpiresAt?.toISOString() ?? null,
    }))
  )
})

/**
 * Seat billing for this instance — what one more invite costs.
 *
 * Registered BEFORE `/:id` so the literal path wins over the parameter.
 *
 * Lives on the users resource rather than in a config endpoint because it is a
 * fact about the user population (head count and the seats it bills), and it is
 * gated by exactly the permission that gets you the Users page. `pricing` is
 * null on any instance the platform does not price — a self-hosted install, or
 * a managed one whose pricing vars have not arrived — and the UI shows nothing
 * at all in that case rather than a guessed price.
 *
 * The head count is computed server-side from the same query the platform's
 * usage reporter sends (`User.countActive`), so what an admin is told here and
 * what the subscription actually bills cannot drift through a second
 * definition of "a user".
 */
usersRouter.get('/seats', requirePermission('users:read'), async (c) => {
  const config = getSeatPricingConfig()
  if (!config) return c.json({ pricing: null })
  return c.json({ pricing: summarizeSeatPricing(await User.countActive(), config) })
})

usersRouter.get('/:id', requirePermission('users:read'), async (c) => {
  const user = await User.findById(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json(user.toJSON())
})

usersRouter.post('/', requirePermission('users:create'), async (c) => {
  const body = await c.req.json()
  const { email, displayName, roleIds, assignments } = body as {
    email?: string
    displayName?: string
    roleIds?: string[]
    assignments?: unknown
  }
  if (!email) return c.json({ error: 'Email is required' }, 400)
  if (roleIds !== undefined && (!Array.isArray(roleIds) || roleIds.some((r) => typeof r !== 'string'))) {
    return c.json({ error: 'roleIds must be an array of role ids or slugs' }, 400)
  }

  const existing = await User.findByEmail(email)
  if (existing) return c.json({ error: 'User with this email already exists' }, 409)

  // Resolve + authorise roles BEFORE creating anything, so a rejected role never
  // leaves a half-invited user behind.
  const resolved = await resolveInviteAssignments(assignments, roleIds, c.get('identity') as Identity)
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)

  // One transaction: an invitee who exists without their roles is a broken invite
  // (they sign in and see nothing, and the admin has no signal it went wrong).
  const user = await db.transaction(async (tx) => {
    const created = await User.create({ email, displayName }, tx)
    if (resolved.assignments.length > 0) {
      await tx
        .insert(roleAssignments)
        .values(
          resolved.assignments.map((assignment) => ({
            subjectType: 'user' as const,
            subjectId: created.id,
            roleId: assignment.role.id,
            scope: assignment.scope,
            squadId: assignment.squadId,
          }))
        )
        // Choosing a role every new person already gets (Farmer, system-wide) is harmless.
        .onConflictDoNothing()
    }
    return created
  })
  wsManager.invalidateAccessCache()
  invalidatePermissionCache()
  // A second user changes the invite_users onboarding signal (User.count() > 1).
  notifyOnboardingChanged()

  // Actually invite them. This used to short-circuit to `undefined` whenever email
  // WAS configured, so the one case that could mail an invite never sent one and
  // the invitee heard nothing at all. A mail failure leaves the account and its
  // roles committed and reports `inviteEmailFailed` — the admin can then use
  // POST /:id/invite below instead of deleting and re-inviting.
  const invite = await deliverInvite(email)

  // `roles`: the system-wide ones (as before); `assignments`: everything the invite gave.
  const roleSlugs = resolved.assignments.filter((a) => a.scope === 'system').map((a) => a.role.slug)
  const given = resolved.assignments.map((a) => ({ role: a.role.slug, scope: a.scope, squadId: a.squadId }))
  return c.json({ ...user.toJSON(), roles: roleSlugs, assignments: given, ...invite }, 201)
})

/**
 * Re-send the invite for a user who never finished setup.
 *
 * POST / above mails the invite exactly once, at creation, and 409s on an
 * address that already exists — so before this endpoint an admin whose invitee
 * let the seven-day link lapse had no recourse but to DELETE the account (losing
 * its role assignments) and invite again.
 *
 * Guarded by `users:create`, deliberately the SAME permission as creation: this
 * issues precisely the credential that route issues, to an address that route
 * already accepted. It is not a `users:update`-shaped profile edit.
 */
usersRouter.post('/:id/invite', requirePermission('users:create'), async (c) => {
  const delivery = c.req.query('delivery') ?? 'email'
  if (delivery !== 'email' && delivery !== 'link') return c.json({ error: 'Unknown invitation delivery mode' }, 400)
  const user = await User.findById(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)

  // Holding zero credentials is what "never finished setup" means everywhere
  // else on this instance (see GET / and userSetupStatus in the web app). A
  // person who already has a passkey gains nothing from an invite, and minting a
  // fresh passkey-registration link for a live account is a credential-issuance
  // hazard rather than a no-op — refuse it outright.
  const credentials = await user.getCredentials()
  if (credentials.length > 0) {
    return c.json({ error: 'User has already completed setup — an invite would do nothing' }, 409)
  }

  // Same 3-per-15-min-per-address budget POST /auth/register/email enforces, so
  // nobody holding users:create can be used to mailbomb one address. Checked
  // BEFORE anything is superseded: a refused resend must leave the invitee's
  // existing link working.
  if ((await recentVerificationCount(user.email)) >= VERIFICATION_RATE_LIMIT) {
    return c.json({ error: 'Too many invites sent to this address. Try again later.' }, 429)
  }

  // Retire the outstanding link BEFORE minting the replacement. The ordering is
  // load-bearing in both directions: superseding first can never touch the row
  // deliverInvite is about to insert, and it makes "resend" mean what it says —
  // one live link — instead of leaving a stale one that keeps redeeming. The
  // cost is that a resend whose mail then fails leaves the invitee with a dead
  // old link; that is the right trade (the response says so via
  // `inviteEmailFailed`, and the admin can resend again).
  const superseded = await supersedeRegistrationChallenges(user.email)

  // Explicit link creation uses the same eligibility, rate limit, and supersession
  // checks as a resend, but does not send an email or expose links in list responses.
  const invite: IssuedInvite =
    delivery === 'link'
      ? {
          inviteUrl: (await issueEmailChallenge(user.email, { ttlMs: INVITE_CHALLENGE_TTL_MS, purpose: 'register' }))
            .link,
        }
      : await deliverInvite(user.email)

  log.info(
    `Invite ${delivery === 'link' ? 'link created for' : 'resent to'} user ${user.id} <${user.email}> by ${auditActor(c.get('identity') as Identity)} ` +
      `(superseded ${superseded} outstanding challenge(s)${invite.inviteEmailFailed ? ', mail FAILED' : ''})`
  )

  // Same body as creation minus `roles` — a resend grants nothing, so echoing a
  // role list would imply an assignment happened.
  return c.json({ ...user.toJSON(), ...invite })
})

usersRouter.patch('/:id', requirePermission('users:update'), async (c) => {
  const user = await User.findById(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)

  const body = await c.req.json()
  // Whitelist only safe profile fields — explicitly exclude disabledAt, id,
  // createdAt, updatedAt. Disable/enable must go through the guarded endpoints.
  const allowed: { displayName?: string; email?: string } = {}
  if (body.displayName !== undefined) allowed.displayName = body.displayName
  if (body.email !== undefined) allowed.email = body.email
  await user.update(allowed)
  return c.json(user.toJSON())
})

/**
 * Count active (non-disabled) users who have a system-scoped assignment of
 * the canonical admin role (slug = 'admin'). Used to enforce the last-active-
 * admin invariant before delete / disable operations.
 */
async function countActiveAdmins(): Promise<string[]> {
  const adminAssignments = await db
    .select({ subjectId: roleAssignments.subjectId })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.scope, 'system'),
        eq(roles.slug, 'admin'),
        isNull(users.disabledAt)
      )
    )
  return [...new Set(adminAssignments.map((a) => a.subjectId))]
}

usersRouter.delete('/:id', requirePermission('users:delete'), async (c) => {
  const userId = c.req.param('id')
  const user = await User.findById(userId)
  if (!user) return c.json({ error: 'User not found' }, 404)

  // Prevent deleting the last active admin user
  const activeAdminIds = await countActiveAdmins()
  if (activeAdminIds.length === 1 && activeAdminIds[0] === userId) {
    return c.json({ error: 'Cannot delete the last admin user' }, 400)
  }

  await endLiveActivitiesForUser(userId)
  await user.delete()
  wsManager.invalidateAccessCache()
  invalidatePermissionCache()
  // Deletion is the inverse of the create path above — it can flip the
  // invite_users onboarding signal back to 'todo' (e.g. deleting down to a
  // single remaining user), so it needs the same notify.
  notifyOnboardingChanged()
  return c.body(null, 204)
})

// ── Disable / Enable ─────────────────────────────────────────────────────────

usersRouter.patch('/:id/disable', requirePermission('users:update'), async (c) => {
  const user = await User.findById(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)
  if (user.isDisabled) return c.json({ error: 'User is already disabled' }, 400)

  // Prevent disabling last active admin
  const activeAdminIds = await countActiveAdmins()
  if (activeAdminIds.length === 1 && activeAdminIds[0] === c.req.param('id')) {
    return c.json({ error: 'Cannot disable the last active admin user' }, 400)
  }

  await user.disable()
  wsManager.invalidateAccessCache()
  invalidatePermissionCache()
  eventEmitter.emit('liveActivity.interestChanged', { userId: user.id })
  return c.json(user.toJSON())
})

usersRouter.patch('/:id/enable', requirePermission('users:update'), async (c) => {
  const user = await User.findById(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)
  if (!user.isDisabled) return c.json({ error: 'User is not disabled' }, 400)
  await user.enable()
  wsManager.invalidateAccessCache()
  invalidatePermissionCache()
  eventEmitter.emit('liveActivity.interestChanged', { userId: user.id })
  return c.json(user.toJSON())
})

// ── Role Assignments ─────────────────────────────────────────────────────────

usersRouter.get('/:id/roles', requirePermission('users:read'), async (c) => {
  const userId = c.req.param('id')
  const assignments = await db
    .select({
      id: roleAssignments.id,
      roleId: roleAssignments.roleId,
      scope: roleAssignments.scope,
      squadId: roleAssignments.squadId,
      createdAt: roleAssignments.createdAt,
      roleName: roles.name,
      roleSlug: roles.slug,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId)))

  return c.json(assignments)
})

/**
 * What a user can actually do, resolved by the same rule every route guard applies — so an admin
 * (or an agent acting with an admin's authority) can answer "can this person see X in that squad?"
 * without re-deriving role precedence by hand. With `squadId`, the squad tier is included: the
 * user's roles on that squad if any, otherwise their `squad_default` roles. Without it, system
 * scope only.
 */
usersRouter.get('/:id/permissions', requirePermission('users:read'), async (c) => {
  const user = await User.findById(c.req.param('id'))
  if (!user) return c.json({ error: 'User not found' }, 404)
  const squadParam = c.req.query('squadId')
  let squad: Squad | null = null
  if (squadParam) {
    squad = await Squad.find(squadParam).catch((error) => {
      if (error instanceof AmbiguousPrefixError) return null
      throw error
    })
    if (!squad) return c.json({ error: 'Squad not found' }, 404)
  }
  const identity = { type: 'user' as const, userId: user.id }
  const [permissions, roleSummaries] = await Promise.all([
    resolvePermissions(identity, squad?.id),
    resolveRoleSummaries(identity, squad?.id),
  ])
  return c.json({
    userId: user.id,
    email: user.email,
    disabled: user.disabledAt !== null,
    squad: squad ? { id: squad.id, name: squad.name } : null,
    roles: roleSummaries,
    permissions,
  })
})

usersRouter.post('/:id/roles', requirePermission('users:update'), async (c) => {
  const userId = c.req.param('id')

  const targetUser = await User.findById(userId)
  if (!targetUser) return c.json({ error: 'User not found' }, 404)

  const body = await c.req.json()
  const { roleId, scope, squadId } = body

  if (!roleId || !scope) return c.json({ error: 'roleId and scope are required' }, 400)

  const validScopes = ['system', 'squad_default', 'squad'] as const
  if (!validScopes.includes(scope)) {
    return c.json({ error: `scope must be one of: ${validScopes.join(', ')}` }, 400)
  }

  if (scope === 'squad' && !squadId) return c.json({ error: 'squadId is required for squad scope' }, 400)
  if (scope !== 'squad' && squadId)
    return c.json({ error: 'squadId must not be set for system or squad_default scope' }, 400)

  const role = await Role.findById(roleId)
  if (!role) return c.json({ error: 'Role not found' }, 404)

  // Agent-derived roles are meaningless on a person — an agent's permissions come
  // from its type, not from an assignment row.
  if (!isUserAssignable(role)) {
    return c.json({ error: `Role ${role.slug} cannot be assigned to a user` }, 400)
  }

  // Privilege-escalation guard: the caller may only grant permissions they
  // themselves hold, resolved in the scope the assignment targets.
  const callerIdentity = c.get('identity') as Identity
  const lacking = await ungrantablePermissions(callerIdentity, role, scope === 'squad' ? squadId : undefined)
  if (lacking.length > 0) {
    return c.json({ error: `Cannot grant permissions you do not hold: ${lacking.join(', ')}` }, 403)
  }

  try {
    const [assignment] = await db
      .insert(roleAssignments)
      .values({
        subjectType: 'user',
        subjectId: userId,
        roleId,
        scope,
        squadId: squadId ?? null,
      })
      .returning()

    wsManager.invalidateAccessCache()
    invalidatePermissionCache()
    eventEmitter.emit('liveActivity.interestChanged', { userId })
    return c.json(assignment, 201)
  } catch (err) {
    if (getPostgresError(err)?.code === '23505') {
      return c.json({ error: 'Role assignment already exists for this user, role, and scope' }, 409)
    }
    throw err
  }
})

usersRouter.delete('/:id/roles/:assignmentId', requirePermission('users:update'), async (c) => {
  const assignmentId = c.req.param('assignmentId')

  // Fetch the assignment and its role
  const [assignment] = await db
    .select({
      id: roleAssignments.id,
      subjectType: roleAssignments.subjectType,
      subjectId: roleAssignments.subjectId,
      roleId: roleAssignments.roleId,
      scope: roleAssignments.scope,
      roleSlug: roles.slug,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(eq(roleAssignments.id, assignmentId))

  if (!assignment) return c.json({ error: 'Assignment not found' }, 404)

  // Check if this is a system-level assignment of the canonical admin role
  if (assignment.scope === 'system' && assignment.roleSlug === 'admin') {
    // Count other active admin assignments (excluding this one)
    const otherAdmins = await db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
      .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
      .where(
        and(
          eq(roleAssignments.subjectType, 'user'),
          eq(roleAssignments.scope, 'system'),
          eq(roles.slug, 'admin'),
          ne(roleAssignments.id, assignmentId),
          isNull(users.disabledAt)
        )
      )

    if (otherAdmins.length === 0) {
      return c.json({ error: 'Cannot remove the last admin role assignment' }, 400)
    }
  }

  await db.delete(roleAssignments).where(eq(roleAssignments.id, assignmentId))
  wsManager.invalidateAccessCache()
  invalidatePermissionCache()
  if (assignment.subjectType === 'user') {
    eventEmitter.emit('liveActivity.interestChanged', { userId: assignment.subjectId })
  }
  return c.body(null, 204)
})

// ── Session Management (admin) ───────────────────────────────────────────────

usersRouter.get('/:id/sessions', requirePermission('users:update'), async (c) => {
  const userId = c.req.param('id')
  const userSessions = await db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ipAddress: sessions.ipAddress,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))

  return c.json(userSessions)
})

usersRouter.delete('/:id/sessions/:sessionId', requirePermission('users:update'), async (c) => {
  const userId = c.req.param('id')
  const sessionId = c.req.param('sessionId')

  await db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
  return c.body(null, 204)
})
