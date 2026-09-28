// Thin shim over @ficus/client-core (see ./clientInstance). Types + logic live in the shared package.
import { client } from './clientInstance'
import { apiFetch } from './client'
import type { AuthUser } from '@ficus/client-core'

export type { UserRoleAssignment, InvitedUser } from '@ficus/client-core'

/**
 * A row from GET /users. The admin list carries onboarding state the shared
 * `AuthUser` shape doesn't model (see apps/core/src/routes/users.ts): an invite
 * creates the user row up front, so only these fields say whether the person
 * ever arrived. Declared here rather than in @ficus/client-core because the admin
 * Users list is the only surface that consumes it.
 */
export interface UserListEntry extends AuthUser {
  /** At least one passkey registered — i.e. registration was completed. */
  hasPasskey: boolean
  passkeyCount: number
  /** Holds the system admin role. Absent on servers that predate it. */
  isAdmin?: boolean
  /**
   * Expiry of the newest unconsumed registration challenge, or null when there
   * is none. A value in the past means the invite lapsed unused.
   */
  inviteExpiresAt: string | null
}

/**
 * What POST /users/:id/invite hands back. Same invite fields as creation: with
 * email configured the invitee is mailed and nothing sensitive comes back;
 * without a provider the one-time link comes back for out-of-band handover.
 */
export interface ResentInvite extends AuthUser {
  inviteCode?: string
  inviteUrl?: string
  /** Email is configured but the send failed — a new link exists, it just didn't arrive. */
  inviteEmailFailed?: boolean
}

/**
 * What this instance bills per user seat, as delivered by the hosted platform
 * (see apps/core/src/services/platform/seat-pricing.ts). Every field comes from
 * the server — nothing here is re-derived in the browser, so what an admin is
 * shown and what the subscription charges cannot drift.
 */
export interface SeatPricing {
  /** Enabled accounts — the population the platform bills on. */
  userCount: number
  /** Seats the base plan already covers. */
  includedSeats: number
  /** max(0, userCount - includedSeats). */
  billedSeats: number
  /** Price per billed seat per month, in minor units of `currency`. */
  seatPriceCents: number
  currency: string
}

/**
 * Seat billing for this instance, or `null` when there is none to show — a
 * self-hosted install, or a managed one whose pricing hasn't been delivered.
 * `null` means render NO pricing UI; there is deliberately no fallback price.
 *
 * Called through `apiFetch` rather than the shared client because
 * @ficus/client-core doesn't model this admin-only endpoint yet, and the Users
 * list is its only consumer (same reasoning as `resendInvite` above).
 */
export const getSeatPricing = (): Promise<{ pricing: SeatPricing | null }> =>
  apiFetch<{ pricing: SeatPricing | null }>('/users/seats')

/**
 * Re-issue the invite for a user who never finished setup. Superseding the old
 * challenge is the server's job (see apps/core/src/routes/users.ts), so the only
 * thing the caller must do is refresh the list afterwards — `inviteExpiresAt`
 * moves to the new link's expiry.
 *
 * Called through `apiFetch` rather than the shared client because @ficus/client-core
 * doesn't model this admin-only endpoint yet, and the Users list is its only consumer.
 */
export const resendInvite = (userId: string): Promise<ResentInvite> =>
  apiFetch<ResentInvite>(`/users/${userId}/invite`, { method: 'POST' })

/** Mint a replacement link for a pending invite without emailing it. */
export const createInviteLink = (userId: string): Promise<ResentInvite> =>
  apiFetch<ResentInvite>(`/users/${userId}/invite?delivery=link`, { method: 'POST' })

// Narrowed once, here, so no caller has to assert: the shared resource declares
// the common AuthUser shape, while this endpoint returns the richer list row.
export const listUsers = client.users.listUsers as () => Promise<UserListEntry[]>
export const getUser = client.users.getUser
export const inviteUser = client.users.inviteUser
export const updateUser = client.users.updateUser
export const deleteUser = client.users.deleteUser
export const disableUser = client.users.disableUser
export const enableUser = client.users.enableUser
export const getUserRoles = client.users.getUserRoles
export const assignUserRole = client.users.assignUserRole
export const removeUserRole = client.users.removeUserRole
export const listUserSessions = client.users.listUserSessions
export const revokeUserSession = client.users.revokeUserSession
