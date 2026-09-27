import type { Context } from 'hono'
import type { Identity } from '../rbac'
import { adminHasPasskey } from './admin-users'

/** The caller holds the bootstrap password session while the first administrator has no passkey yet. */
export const FIRST_ADMIN_INCOMPLETE = 'first_admin_incomplete'
/** Any other non-person identity (agent, system token) on a route that acts for one person. */
export const USER_SESSION_REQUIRED = 'user_session_required'

/**
 * The 403 for a route that acts on behalf of one person (a connected account, a
 * subscription, a session list) when the caller is not a person.
 *
 * The bootstrap `FICUS_PASSWORD` session passes admin RBAC, so it reaches these
 * routes during first-admin setup — but it belongs to nobody, so there is no user
 * to connect or subscribe. It gets a stable code and a message that says what to
 * do next instead of a bare "user required". `action` completes the sentence
 * ("connect GitHub", "manage sessions").
 *
 * Call only after establishing `identity.type !== 'user'`:
 *
 *   if (identity?.type !== 'user') return userSessionRequired(c, identity, 'connect GitHub')
 */
export async function userSessionRequired(
  c: Context<any, any, any>,
  identity: Identity | undefined,
  action: string
): Promise<Response> {
  if (identity?.type === 'legacy' && !(await adminHasPasskey())) {
    return c.json({ error: `Finish setting up your admin account to ${action}.`, code: FIRST_ADMIN_INCOMPLETE }, 403)
  }
  return c.json({ error: `Sign in with your Ficus account to ${action}.`, code: USER_SESSION_REQUIRED }, 403)
}
