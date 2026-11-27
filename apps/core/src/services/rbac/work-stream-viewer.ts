import type { WorkStreamViewer } from '@ficus/shared'
import { permissionMatches, resolvePermissions, type Identity } from './permissions'

/**
 * The identity as the shared viewer rules (`workStreamWaitsOnViewer`, `viewerCanActOnWait`) read it
 * in one squad: its permissions there and who it is. Activity and the Live Activity both build
 * their "waiting on you" counts from this, so the two agree for the same user. Workflow gates are
 * decided only by users (`mayDecideWorkflowGate`), so other identities never pass on a userId.
 */
export async function resolveWorkStreamViewer(identity: Identity, squadId: string): Promise<WorkStreamViewer> {
  const permissions = await resolvePermissions(identity, squadId)
  return {
    can: (permission) => permissions.some((held) => permissionMatches(held, permission)),
    identity: identity.type === 'user' ? { type: 'user', userId: identity.userId } : { type: identity.type },
  }
}

/**
 * The viewer in each of `squadIds`, by squad ID. A user's permission resolution is cached, so
 * squads an access check just read cost no extra query.
 */
export async function resolveWorkStreamViewers(
  identity: Identity,
  squadIds: Iterable<string>
): Promise<Map<string, WorkStreamViewer>> {
  const ids = [...new Set(squadIds)]
  const viewers = await Promise.all(ids.map((squadId) => resolveWorkStreamViewer(identity, squadId)))
  return new Map(ids.map((squadId, index) => [squadId, viewers[index]!]))
}
