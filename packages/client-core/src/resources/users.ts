import type { Transport } from '../transport'
import type { AuthUser } from './auth'
import type { SessionSummary } from './sessions'

export interface UserRoleAssignment {
  id: string
  roleId: string
  roleName?: string
  roleSlug?: string
  scope: 'system' | 'squad_default' | 'squad'
  squadId?: string | null
  squadName?: string | null
}

/**
 * With email configured the invite is MAILED and nothing sensitive comes back.
 * Without an email provider there is no delivery channel, so the one-time code and
 * the deep link come back for the admin to hand over.
 */
export type InvitedUser = AuthUser & {
  inviteCode?: string
  /** Absolute link that lands the invitee straight on passkey registration. */
  inviteUrl?: string
  /** Slugs of the roles granted at invite time. */
  roles?: string[]
  /** Email is configured but the send failed — the account exists, the invite didn't arrive. */
  inviteEmailFailed?: boolean
}

export function usersResource(t: Transport) {
  return {
    listUsers: (): Promise<AuthUser[]> => t.request('/users'),
    getUser: (id: string): Promise<AuthUser> => t.request(`/users/${id}`),
    /** @param roleIds role ids or slugs; omitted means the server default (`operator`). */
    /**
     * Invites someone. `roleIds` give roles system-wide; `assignments` give roles in any scope (system,
     * every squad, or one squad), as the per-user role editor does.
     */
    inviteUser: (
      email: string,
      displayName?: string,
      roleIds?: string[],
      assignments?: Array<{ roleId: string; scope: 'system' | 'squad_default' | 'squad'; squadId?: string }>
    ): Promise<InvitedUser> =>
      t.request('/users', { method: 'POST', body: { email, displayName, roleIds, assignments } }),
    updateUser: (id: string, data: { email?: string; displayName?: string }): Promise<AuthUser> =>
      t.request(`/users/${id}`, { method: 'PATCH', body: data }),
    deleteUser: (userId: string): Promise<void> => t.request(`/users/${userId}`, { method: 'DELETE' }),
    disableUser: (userId: string): Promise<AuthUser> => t.request(`/users/${userId}/disable`, { method: 'PATCH' }),
    enableUser: (userId: string): Promise<AuthUser> => t.request(`/users/${userId}/enable`, { method: 'PATCH' }),
    getUserRoles: (userId: string): Promise<UserRoleAssignment[]> => t.request(`/users/${userId}/roles`),
    assignUserRole: (
      userId: string,
      data: { roleId: string; scope: 'system' | 'squad_default' | 'squad'; squadId?: string }
    ): Promise<UserRoleAssignment> => t.request(`/users/${userId}/roles`, { method: 'POST', body: data }),
    removeUserRole: (userId: string, assignmentId: string): Promise<void> =>
      t.request(`/users/${userId}/roles/${assignmentId}`, { method: 'DELETE' }),
    listUserSessions: (userId: string): Promise<SessionSummary[]> => t.request(`/users/${userId}/sessions`),
    revokeUserSession: (userId: string, sessionId: string): Promise<void> =>
      t.request(`/users/${userId}/sessions/${sessionId}`, { method: 'DELETE' }),
  }
}
