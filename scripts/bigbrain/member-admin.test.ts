import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedBigbrainMemberRoster } from '@ficus/shared/managed-bigbrain'
import { memberAdminReply, runMemberAdmin } from './member-admin'
import { FakeBusy, fakeMemberApi as fake, fileIdentityApi } from './member-test-fixtures'

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

describe('vault server name (upstream .shared-identity.json)', () => {
  const ID = '66666666-6666-4666-8666-666666666666'
  async function vault() {
    const dir = await mkdtemp(join(tmpdir(), 'bigbrain-vault-name-'))
    const identity = fileIdentityApi(() => ID)
    return { dir, file: join(dir, '.shared-identity.json'), f: fake(store, identity), writes: identity.writes }
  }
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

  test('before the first serve, upstream creates the identity (its own id) and the name is the Ficus name', async () => {
    const v = await vault()
    try {
      expect(runMemberAdmin({ op: 'vault-name', vaultPath: v.dir, name: 'Research' }, v.f.api) as unknown).toEqual({
        upstreamVaultId: ID,
        name: 'Research',
        changed: true,
      })
      // The id is upstream's (sharedVaultIdentity ran first); Ficus never invents one.
      expect(v.f.calls.slice(0, 2)).toEqual(['sharedVaultIdentity', 'writeAtomic'])
      expect(await read(v.file)).toEqual({ id: ID, name: 'Research' })
      expect(v.writes.map((w) => [w.path, w.mode])).toEqual([[v.file, 0o600]])
      expect(((await stat(v.file)).mode & 0o777).toString(8)).toBe('600')
      expect(runMemberAdmin({ op: 'vault-identity', vaultPath: v.dir }, v.f.api)).toEqual({
        upstreamVaultId: ID,
        name: 'Research',
      })
    } finally {
      await rm(v.dir, { recursive: true, force: true })
    }
  })

  test('a rename keeps the id and every other field; an equal name is never rewritten', async () => {
    const v = await vault()
    try {
      const rules = [{ id: 'r1', text: 'Sources that mention @Orchard.', mentions: ['Orchard'] }]
      await Bun.write(v.file, JSON.stringify({ id: ID, name: 'Shared BigBrain', recommended_rules: rules }))
      expect(runMemberAdmin({ op: 'vault-identity', vaultPath: v.dir }, v.f.api)).toEqual({
        upstreamVaultId: ID,
        name: 'Shared BigBrain',
      })
      expect(runMemberAdmin({ op: 'vault-name', vaultPath: v.dir, name: 'ficus-shared' }, v.f.api)).toMatchObject({
        upstreamVaultId: ID,
        changed: true,
      })
      expect(await read(v.file)).toEqual({ id: ID, name: 'ficus-shared', recommended_rules: rules })
      expect(runMemberAdmin({ op: 'vault-name', vaultPath: v.dir, name: 'ficus-shared' }, v.f.api)).toMatchObject({
        changed: false,
      })
      expect(v.writes).toHaveLength(1)
    } finally {
      await rm(v.dir, { recursive: true, force: true })
    }
  })

  test('only a valid vault label is written; a broken identity is upstream_protocol', async () => {
    const v = await vault()
    try {
      for (const name of ['', ' padded', 'two\nlines', 'bell\u0007', 'x'.repeat(121), 42])
        expect(memberAdminReply({ op: 'vault-name', vaultPath: v.dir, name }, v.f.api)).toEqual({
          ok: false,
          code: 'invalid_request',
        })
      for (const vaultPath of ['relative/vault', '/a/../b', '/vault\u0000'])
        expect(memberAdminReply({ op: 'vault-identity', vaultPath }, v.f.api)).toEqual({
          ok: false,
          code: 'invalid_request',
        })
      expect(
        memberAdminReply({ op: 'vault-name', vaultPath: v.dir, name: 'Research', membersPath: store }, v.f.api)
      ).toEqual({ ok: false, code: 'invalid_request' })
      expect(v.writes).toHaveLength(0)
      await Bun.write(v.file, JSON.stringify({ id: 'not-a-uuid', name: 'x' }))
      expect(memberAdminReply({ op: 'vault-name', vaultPath: v.dir, name: 'Research' }, v.f.api)).toEqual({
        ok: false,
        code: 'upstream_protocol',
      })
      expect(v.writes).toHaveLength(0)
      // The longest valid label is accepted as is.
      await Bun.write(v.file, JSON.stringify({ id: ID, name: 'Shared BigBrain' }))
      expect(memberAdminReply({ op: 'vault-name', vaultPath: v.dir, name: 'é'.repeat(120) }, v.f.api)).toMatchObject({
        ok: true,
      })
    } finally {
      await rm(v.dir, { recursive: true, force: true })
    }
  })
})
