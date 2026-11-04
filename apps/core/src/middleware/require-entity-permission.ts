import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { getAccessibleSquadIds, hasPermission, identityUserId, isUserlessAgentIdentity } from '../services/rbac'
import type { Identity } from '../services/rbac'

/**
 * Middleware factory for "handler-scope" routes whose route param is an entity
 * id (not a squad id). Resolves the owning squad id from the entity via
 * `loadSquadId`, then checks `hasPermission` for that squad.
 *
 * Fails closed:
 * - No identity on context → 401.
 * - `loadSquadId` throws → 403 (can't determine squad).
 * - `loadSquadId` returns non-null squadId → scoped `hasPermission(identity, permission, squadId)`.
 * - `loadSquadId` returns null (squad-less entity, e.g. system-manager agent) →
 *   if `opts.loadOwnerUserId` resolves to the authenticated user's id, allow;
 *   a user-less agent identity is denied before unscoped RBAC can substitute
 *   its own squad; otherwise use unscoped system permission (admins may pass).
 * Sets `c.set('authzChecked', true)` once the guard runs for an authenticated identity,
 * including deny paths, so the runtime sentinel does not rewrite intentional 403s.
 */
export function requireEntityPermission(
  permission: string,
  loadSquadId: (c: Context) => Promise<string | null>,
  opts?: { loadOwnerUserId?: (c: Context) => Promise<string | null> }
) {
  return createMiddleware(async (c, next) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)

    let squadId: string | null
    try {
      squadId = await loadSquadId(c)
    } catch {
      return c.json({ error: 'Forbidden' }, 403)
    }

    let ownerUserId: string | null = null
    if (squadId === null && opts?.loadOwnerUserId) {
      try {
        ownerUserId = await opts.loadOwnerUserId(c)
      } catch {
        ownerUserId = null
      }
    }

    if (!(await hasEntityPermission(identity, permission, squadId, ownerUserId))) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  })
}

/**
 * Helper for filtered-list GETs: returns only rows whose squad id is in the
 * set accessible to the identity.
 *
 * - If `getAccessibleSquadIds` returns `'all'`, all rows are returned.
 * - Otherwise, rows whose `getSquadId(row)` returns null are excluded (fail
 *   closed — squad-less rows are not surfaced to non-'all' callers).
 */
export async function filterToAccessibleSquads<T>(
  identity: Identity,
  rows: T[],
  getSquadId: (row: T) => string | null
): Promise<T[]> {
  const accessible = await getAccessibleSquadIds(identity)

  if (accessible === 'all') {
    return rows
  }

  const accessibleSet = new Set(accessible)
  return rows.filter((row) => {
    const squadId = getSquadId(row)
    if (squadId === null || squadId === undefined) return false
    return accessibleSet.has(squadId)
  })
}

/**
 * The decision behind {@link requireEntityPermission}, for callers that need
 * the answer rather than a guard (for example to tell a client which controls
 * to offer). `ownerUserId` only matters for a squad-less entity.
 */
export async function hasEntityPermission(
  identity: Identity,
  permission: string,
  squadId: string | null,
  ownerUserId: string | null = null
): Promise<boolean> {
  if (squadId !== null) return hasPermission(identity, permission, squadId)
  // Private owned entity (e.g. a user's system-manager): owner-only — not
  // even admins may access another user's private agent. The owner is the
  // user, or that user's own agent token (which carries their userId).
  if (ownerUserId) return identityUserId(identity) === ownerUserId
  if (isUserlessAgentIdentity(identity)) return false
  // A squad-less entity (e.g. system-manager/artifact-builder agent) falls back
  // to a system-scope check so admins (*) and holders of a system-scoped
  // permission are still allowed through.
  return hasPermission(identity, permission)
}
