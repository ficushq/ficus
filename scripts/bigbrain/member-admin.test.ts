import { describe, expect, test } from 'bun:test'
import type { ManagedBigbrainMemberRoster } from '@ficus/shared/managed-bigbrain'
import { memberAdminReply, runMemberAdmin } from './member-admin'
import { FakeBusy, fakeMemberApi as fake } from './member-test-fixtures'

const store = '/var/lib/ficus-bigbrain/vaults/v/auth/members.json'
const now = Date.parse('2026-10-20T00:00:00.000Z')
const secret = 's'.repeat(43)

describe('member admin adapter', () => {
  test('lists live members with display fields only and pending invites without their secrets', () => {
    const f = fake()
    f.invites.push({
      id: 'c'.repeat(24),
      secret,
      display: 'Lin',
      permission: 'read',
      expires: '2026-10-20T12:00:00.000Z',
    })
    const roster = runMemberAdmin({ op: 'list', membersPath: store }, f.api, now) as ManagedBigbrainMemberRoster
    expect(roster.members.map((m) => [m.handle, m.role, m.access, m.status])).toEqual([
      ['ficus', 'owner', 'write', 'active'],
      ['ficus-reader', 'member', 'read', 'active'],
      ['grace', 'member', 'write', 'active'],
      ['invite-aaaaaaaaaaaaaaaaaaaaaaaa', 'member', 'read', 'pending'],
    ])
    expect(roster.members[2]!.displayName).toBe('Grace Hopper')
    expect(roster.members[3]!.displayName.length).toBeLessThanOrEqual(120)
    expect(roster.invites).toEqual([
      { inviteId: 'c'.repeat(24), displayName: 'Lin', access: 'read', expiresAt: '2026-10-20T12:00:00.000Z' },
    ])
    const text = JSON.stringify(roster)
    for (const leaked of [secret, 'owner@example.com', 'mem_', '"sub"']) expect(text).not.toContain(leaked)
    expect(roster.membersTruncated).toBe(false)
  })
  test('bounds a long roster and flags it', () => {
    const f = fake()
    for (let i = 0; i < 120; i++)
      f.members.push({
        handle: `m${i}`,
        display: `M ${i}`,
        role: 'member',
        permissions: ['read'],
        created: '2026-03-01T00:00:00.000Z',
        revoked: null,
      })
    for (let i = 0; i < 60; i++)
      f.invites.push({
        id: i.toString(16).padStart(24, '0'),
        secret,
        display: 'x',
        permission: 'write',
        expires: '2026-10-20T12:00:00.000Z',
      })
    const roster = runMemberAdmin({ op: 'list', membersPath: store }, f.api, now) as ManagedBigbrainMemberRoster
    expect([roster.members.length, roster.invites.length, roster.membersTruncated, roster.invitesTruncated]).toEqual([
      100,
      50,
      true,
      true,
    ])
    // The system members always stay in view.
    expect(roster.members.slice(0, 2).map((m) => m.handle)).toEqual(['ficus', 'ficus-reader'])
  })
  test('creates one member invite at the controller time and checks the upstream reply', () => {
    const f = fake()
    const issuedAt = new Date(now).toISOString()
    const minted = runMemberAdmin(
      { op: 'invite', membersPath: store, displayName: 'Ada', access: 'write', issuedAt },
      f.api,
      now + 50
    )
    expect(minted).toEqual({ inviteId: 'b'.repeat(24), secret, expiresAt: '2026-10-21T00:00:00.000Z' })
    expect(f.calls).toEqual(['createMemberInvite'])
    // Stale or future issuance never mints.
    for (const at of [now - 31_000, now + 31_000])
      expect(() =>
        runMemberAdmin({ op: 'invite', membersPath: store, displayName: 'Ada', access: 'write', issuedAt }, f.api, at)
      ).toThrow('invalid_request')
    expect(f.calls).toEqual(['createMemberInvite'])
  })
  test('refuses an upstream reply that does not match the request', () => {
    for (const drift of [
      { permission: 'read' },
      { display: 'Someone else' },
      { expires: '2026-10-20T01:00:00.000Z' },
      { secret: 'short' },
      { id: 'mem_1' },
    ]) {
      const f = fake()
      const create = f.api.createMemberInvite
      f.api.createMemberInvite = (...args) => ({ ...(create(...args) as object), ...drift })
      expect(() =>
        runMemberAdmin(
          {
            op: 'invite',
            membersPath: store,
            displayName: 'Ada',
            access: 'write',
            issuedAt: new Date(now).toISOString(),
          },
          f.api,
          now
        )
      ).toThrow('upstream_protocol')
    }
  })
  test('cancels a pending invite; unknown or accepted invites are not found', () => {
    const f = fake()
    f.invites.push({
      id: 'c'.repeat(24),
      secret,
      display: 'Lin',
      permission: 'read',
      expires: '2026-10-20T12:00:00.000Z',
    })
    f.invites.push({
      id: 'd'.repeat(24),
      display: 'Used',
      permission: 'read',
      expires: '2026-10-20T12:00:00.000Z',
      used: true,
    })
    expect(runMemberAdmin({ op: 'cancel', membersPath: store, inviteId: 'c'.repeat(24) }, f.api, now)).toEqual({
      inviteId: 'c'.repeat(24),
    })
    expect(f.invites[0]!.cancelled).toBe(true)
    for (const inviteId of ['d'.repeat(24), 'e'.repeat(24)])
      expect(() => runMemberAdmin({ op: 'cancel', membersPath: store, inviteId }, f.api, now)).toThrow('not_found')
  })
  test('changes access and removes ordinary members only', () => {
    const f = fake()
    expect(
      runMemberAdmin({ op: 'set-access', membersPath: store, handle: 'grace', access: 'read' }, f.api, now)
    ).toMatchObject({
      handle: 'grace',
      access: 'read',
      status: 'active',
    })
    expect(f.members[2]!.permissions).toEqual(['read'])
    expect(runMemberAdmin({ op: 'remove', membersPath: store, handle: 'grace' }, f.api, now)).toMatchObject({
      handle: 'grace',
      status: 'removed',
    })
    // A replayed removal is idempotent; a removed member's access cannot change.
    expect(runMemberAdmin({ op: 'remove', membersPath: store, handle: 'grace' }, f.api, now)).toMatchObject({
      status: 'removed',
    })
    expect(() =>
      runMemberAdmin({ op: 'set-access', membersPath: store, handle: 'grace', access: 'write' }, f.api, now)
    ).toThrow('not_found')
    expect(() => runMemberAdmin({ op: 'remove', membersPath: store, handle: 'nobody' }, f.api, now)).toThrow(
      'not_found'
    )
  })
  test('never changes or removes the owner (any handle) or the Ficus reader', () => {
    const f = fake()
    // A legacy vault whose owner is a person's handle, and a member squatting the `ficus` name.
    f.members[0]!.handle = 'ada'
    f.members.push({ handle: 'ficus', display: 'Not the owner', role: 'member', permissions: ['read'], revoked: null })
    for (const target of ['ada', 'ficus', 'ficus-reader'])
      for (const op of [{ op: 'set-access', access: 'write' }, { op: 'remove' }])
        expect(() => runMemberAdmin({ ...op, membersPath: store, handle: target }, f.api, now)).toThrow('forbidden')
    expect(f.calls.filter((c) => c === 'setMemberPermissions' || c === 'revokeMember')).toEqual([])
  })
  test('rejects anything outside the strict request shapes before touching upstream', () => {
    const f = fake()
    for (const bad of [
      { op: 'list', membersPath: 'relative/members.json' },
      { op: 'list', membersPath: '/a/../members.json' },
      { op: 'list', membersPath: store, extra: 1 },
      { op: 'invite', membersPath: store, displayName: 'Ada', access: 'owner', issuedAt: new Date(now).toISOString() },
      { op: 'invite', membersPath: store, displayName: '', access: 'read', issuedAt: new Date(now).toISOString() },
      { op: 'set-access', membersPath: store, handle: 'Grace', access: 'read' },
      { op: 'cancel', membersPath: store, inviteId: 'zz' },
      { op: 'mint', membersPath: store },
    ])
      expect(() => runMemberAdmin(bad, f.api, now)).toThrow('invalid_request')
    expect(f.calls).toEqual([])
  })
  test('unexpected upstream member shapes fail closed', () => {
    const f = fake()
    f.members.push({ handle: 'odd', display: 'Odd', role: 'admin', permissions: ['read'], revoked: null })
    expect(() => runMemberAdmin({ op: 'list', membersPath: store }, f.api, now)).toThrow('upstream_protocol')
  })
})
test('replies carry only fixed codes: upstream text and lock contention never leak', () => {
  const f = fake()
  f.api.listMembers = () => {
    throw new Error('shared-members: no member store at /var/lib/secret/path')
  }
  expect(memberAdminReply({ op: 'list', membersPath: store }, f.api, now)).toEqual({
    ok: false,
    code: 'operation_failed',
  })
  f.api.listMembers = () => {
    throw new FakeBusy('Membership is being updated. Please retry.')
  }
  expect(memberAdminReply({ op: 'list', membersPath: store }, f.api, now)).toEqual({ ok: false, code: 'busy' })
})
