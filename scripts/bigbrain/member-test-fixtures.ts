import { expect } from 'bun:test'
import type { NativeMemberApi } from './member-admin'

const DEFAULT_STORE = '/var/lib/ficus-bigbrain/vaults/v/auth/members.json'
const secret = 's'.repeat(43)
export class FakeBusy extends Error {}

/** In-memory stand-in with the pinned upstream semantics this adapter relies on. */
export function fakeMemberApi(store = DEFAULT_STORE) {
  const members: Record<string, unknown>[] = [
    {
      id: 'mem_00000001',
      handle: 'ficus',
      display: 'Ficus',
      role: 'owner',
      permissions: ['read', 'write'],
      created: '2026-01-01T00:00:00.000Z',
      revoked: null,
      email: 'owner@example.com',
    },
    {
      id: 'mem_00000002',
      handle: 'ficus-reader',
      display: 'Ficus',
      role: 'member',
      permissions: ['read'],
      created: '2026-01-02T00:00:00.000Z',
      revoked: null,
    },
    {
      id: 'mem_00000003',
      handle: 'grace',
      display: 'Grace  Hopper',
      role: 'member',
      permissions: ['read', 'write'],
      created: '2026-01-03T00:00:00.000Z',
      revoked: null,
      identity: { iss: 'x', sub: 'y' },
    },
    {
      id: 'mem_00000004',
      handle: 'gone',
      display: 'Gone',
      role: 'member',
      permissions: ['read'],
      created: '2026-01-04T00:00:00.000Z',
      revoked: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'mem_00000005',
      handle: 'invite-aaaaaaaaaaaaaaaaaaaaaaaa',
      display: `${'e'.repeat(200)}@example.com`,
      role: 'member',
      permissions: ['read'],
      created: '2026-01-05T00:00:00.000Z',
      revoked: null,
      pending: true,
    },
  ]
  const invites: {
    id: string
    secret?: string
    display: string
    permission: string
    expires: string
    used?: boolean
    cancelled?: boolean
  }[] = []
  const calls: string[] = []
  const api: NativeMemberApi = {
    listMembers: (path) => {
      expect(path).toBe(store)
      calls.push('listMembers')
      return structuredClone(members)
    },
    ownerOf: () => members.find((m) => m.role === 'owner'),
    pendingMemberInvites: (_path, at) => {
      calls.push('pendingMemberInvites')
      return invites
        .filter((i) => !i.used && !i.cancelled && Date.parse(i.expires) > at.getTime())
        .map((i) => ({ ...i }))
    },
    createMemberInvite: (_path, display, permission, at) => {
      calls.push('createMemberInvite')
      const invite = {
        id: 'b'.repeat(24),
        secret,
        display,
        permission,
        expires: new Date(at.getTime() + 86400000).toISOString(),
      }
      invites.push(invite)
      return { ...invite }
    },
    cancelMemberInvite: (_path, id) => {
      calls.push('cancelMemberInvite')
      const invite = invites.find((i) => i.id === id)
      if (!invite || invite.used) return false
      invite.cancelled = true
      delete invite.secret
      return true
    },
    setMemberPermissions: (_path, handle, permissions) => {
      calls.push('setMemberPermissions')
      const member = members.find((m) => m.handle === handle)!
      if (member.role === 'owner') throw new Error("shared-members: the owner's permissions are fixed")
      member.permissions = [...permissions]
      return { ...member }
    },
    revokeMember: (_path, handle, at) => {
      calls.push('revokeMember')
      const member = members.find((m) => m.handle === handle)!
      if (member.role === 'owner') throw new Error('shared-members: the owner cannot be revoked')
      member.revoked ??= at.toISOString()
      return { ...member }
    },
    BusyError: FakeBusy,
  }
  return { api, members, invites, calls }
}
