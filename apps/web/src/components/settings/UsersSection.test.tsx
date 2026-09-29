import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { UserRow, UsersSection } from './UsersSection'
import { userSetupStatus } from './userSetupStatus'
import { resendInviteFeedback } from './resendInviteFeedback'
import type { UserListEntry } from '../../api/users'

const NOW = Date.parse('2026-02-01T00:00:00Z')

function user(overrides: Partial<UserListEntry> = {}): UserListEntry {
  return {
    id: 'u1',
    email: 'someone@example.com',
    displayName: null,
    disabledAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    hasPasskey: false,
    passkeyCount: 0,
    inviteExpiresAt: null,
    ...overrides,
  }
}

function renderUsers(seeded: UserListEntry[]): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.users.list(), seeded)
  queryClient.setQueryData(queryKeys.roles.list(), [])
  const ui: ReactNode = <UsersSection />
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('userSetupStatus', () => {
  test('a user holding a passkey has joined', () => {
    const status = userSetupStatus(user({ hasPasskey: true, passkeyCount: 2 }), NOW)
    expect(status.pending).toBe(false)
    expect(status.label).toBe('Active')
    expect(status.detail).toBeNull()
  })

  test('a user with no passkey is pending even when the invite is still live', () => {
    const status = userSetupStatus(user({ inviteExpiresAt: '2026-02-08T00:00:00Z' }), NOW)
    expect(status.pending).toBe(true)
    expect(status.label).toBe('Invited')
    expect(status.detail).toContain('Invite expires')
  })

  test('an outstanding challenge already past its expiry reads as lapsed', () => {
    const status = userSetupStatus(user({ inviteExpiresAt: '2026-01-02T00:00:00Z' }), NOW)
    expect(status.pending).toBe(true)
    expect(status.detail).toContain('Invite expired')
  })

  test('no challenge at all still reads as pending, with no timing detail', () => {
    const status = userSetupStatus(user(), NOW)
    expect(status.pending).toBe(true)
    expect(status.detail).toBeNull()
  })
})

describe('UsersSection invitation state', () => {
  test('an invited user who never registered renders as pending with its expiry', () => {
    // Far enough out that the row is "still redeemable" whenever this runs.
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const html = renderUsers([user({ id: 'invited', email: 'invited@example.com', inviteExpiresAt: expiresAt })])

    expect(html).toContain('invited@example.com')
    expect(html).toContain('Invited')
    expect(html).toContain('Invite expires')
    expect(html).not.toContain('>Active<')
  })

  test('a user who registered a passkey renders as active with no invite detail', () => {
    const html = renderUsers([user({ id: 'joined', email: 'joined@example.com', hasPasskey: true, passkeyCount: 1 })])

    expect(html).toContain('joined@example.com')
    expect(html).toContain('Active')
    expect(html).not.toContain('Invited')
    expect(html).not.toContain('Invite expire')
  })

  test('both states are distinguishable in one list', () => {
    const html = renderUsers([
      user({ id: 'a', email: 'joined@example.com', hasPasskey: true, passkeyCount: 1 }),
      user({ id: 'b', email: 'invited@example.com' }),
    ])

    expect(html).toContain('Active')
    expect(html).toContain('Invited')
  })

  test('a disabled invitee keeps the pending badge and never claims to be active', () => {
    const html = renderUsers([user({ id: 'c', email: 'off@example.com', disabledAt: '2026-01-15T00:00:00Z' })])

    expect(html).toContain('Disabled')
    expect(html).toContain('Invited')
  })

  // Regression: the pill's label used to wrap inside its rounded-full
  // background at narrow widths, rendering as an ellipse and colliding with
  // the actions column. Both classes are load-bearing — nowrap keeps the
  // label on one line, shrink-0 stops flex from compressing the pill in the
  // first place — so pin them rather than the visual outcome.
  test('status pills never wrap or shrink', () => {
    const html = renderUsers([
      user({ id: 'a', email: 'joined@example.com', hasPasskey: true, passkeyCount: 1 }),
      user({ id: 'b', email: 'invited@example.com' }),
      user({ id: 'c', email: 'off@example.com', disabledAt: '2026-01-15T00:00:00Z' }),
    ])

    for (const pill of html.match(/<span[^>]*rounded-full[^>]*>/g) ?? []) {
      expect(pill).toContain('whitespace-nowrap')
      expect(pill).toContain('shrink-0')
    }
    // Guard the guard: if the pills stop carrying rounded-full, the loop above
    // would vacuously pass.
    expect((html.match(/rounded-full/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  test('a disabled member shows Disabled without an Active badge', () => {
    const html = renderUsers([
      user({
        id: 'd',
        email: 'former@example.com',
        hasPasskey: true,
        passkeyCount: 1,
        disabledAt: '2026-01-15T00:00:00Z',
      }),
    ])

    expect(html).toContain('Disabled')
    expect(html).not.toContain('>Active<')
  })
})

// Before POST /users/:id/invite existed, a lapsed invite could only be fixed by
// deleting the account and re-inviting — so the action has to reach BOTH pending
// shapes (still-redeemable and lapsed), and must never appear on someone who
// already holds a passkey (the server refuses that with a 409).

describe('UsersSection resend invite action', () => {
  const RESEND = 'Resend Invite'
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  test('offered on a pending row whose invite is still redeemable', () => {
    const html = renderUsers([user({ id: 'live', email: 'live@example.com', inviteExpiresAt: future })])
    expect(html).toContain('Invite expires')
    expect(html).toContain(RESEND)
  })

  test('offered on a pending row whose invite has lapsed — the case that motivated it', () => {
    const html = renderUsers([user({ id: 'lapsed', email: 'lapsed@example.com', inviteExpiresAt: past })])
    expect(html).toContain('Invite expired')
    expect(html).toContain(RESEND)
  })

  test('offered on a pending row with no challenge on record at all', () => {
    const html = renderUsers([user({ id: 'none', email: 'none@example.com' })])
    expect(html).toContain(RESEND)
  })

  test('never offered to someone who already completed setup', () => {
    const html = renderUsers([user({ id: 'joined', email: 'joined@example.com', hasPasskey: true, passkeyCount: 1 })])
    expect(html).not.toContain(RESEND)
  })

  test('offered on a disabled invitee too — the pending badge and the remedy agree', () => {
    const html = renderUsers([
      user({ id: 'off', email: 'off@example.com', inviteExpiresAt: past, disabledAt: '2026-01-15T00:00:00Z' }),
    ])
    expect(html).toContain(RESEND)
  })

  test('only the pending rows in a mixed list carry the action', () => {
    const html = renderUsers([
      user({ id: 'a', email: 'joined@example.com', hasPasskey: true, passkeyCount: 1 }),
      user({ id: 'b', email: 'invited@example.com', inviteExpiresAt: past }),
    ])
    expect(html.split(RESEND)).toHaveLength(2) // exactly one occurrence
  })
})

describe('resendInviteFeedback', () => {
  test('says nothing before the first attempt', () => {
    expect(resendInviteFeedback({ isError: false }).message).toBeNull()
  })

  test('confirms a mailed resend, and says the old link is dead', () => {
    const feedback = resendInviteFeedback({ isError: false, data: {} })
    expect(feedback.isProblem).toBe(false)
    expect(feedback.message).toContain('Invite resent')
    expect(feedback.message).toContain('no longer works')
  })

  test('stays quiet when the link itself came back — the link panel says it instead', () => {
    const feedback = resendInviteFeedback({ isError: false, data: { inviteUrl: 'https://tau.test/register?token=x' } })
    expect(feedback.message).toBeNull()
  })

  test('a reissued-but-undelivered invite reads as a problem, not as success', () => {
    const feedback = resendInviteFeedback({ isError: false, data: { inviteEmailFailed: true } })
    expect(feedback.isProblem).toBe(true)
    expect(feedback.message).toContain('could not be sent')
  })

  test('surfaces the server error message on failure', () => {
    const feedback = resendInviteFeedback({ isError: true, error: new Error('Too many invites sent to this address') })
    expect(feedback.isProblem).toBe(true)
    expect(feedback.message).toBe('Too many invites sent to this address')
  })

  test('falls back to a generic message when the failure carries none', () => {
    expect(resendInviteFeedback({ isError: true, error: undefined }).message).toBe('Failed to resend invite')
  })
})

describe('role scope', () => {
  test('a squad-scoped role names its squad, and squad_default reads as every squad', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.users.roles('u1'), [
      { id: 'a1', roleId: 'r1', roleName: 'Operator', roleSlug: 'operator', scope: 'squad', squadId: 'squad-uuid-1' },
      { id: 'a2', roleId: 'r2', roleName: 'Viewer', roleSlug: 'viewer', scope: 'squad_default', squadId: null },
      { id: 'a3', roleId: 'r3', roleName: 'Admin', roleSlug: 'admin', scope: 'system', squadId: null },
    ])
    queryClient.setQueryData(queryKeys.squads.list(), [{ id: 'squad-uuid-1', name: 'Attune' }])
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <UserRow
          user={user()}
          roles={[]}
          isExpanded
          onToggleExpand={() => {}}
          onDelete={() => {}}
          isDeleting={false}
          onInviteLink={() => {}}
          onToggleDisable={() => {}}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('Operator')
    expect(html).toContain('(Attune)')
    expect(html).toContain('(every squad)')
    expect(html).not.toContain('(squad)')
  })
})
