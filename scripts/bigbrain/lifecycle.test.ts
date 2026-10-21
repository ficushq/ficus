import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { escrowSchema } from './bootstrap'
import { installedHostSchema } from './control-input'
import { dispatchHostRequest } from './control'
import { simulatedHost } from './host-test-fixtures'
import type { NativeMember } from './native-admin'
import { managedPaths } from './paths'
import { readPrivateJson, writePrivateJson } from './secure-files'
import { initializeStorageNamespace } from './volume-image'
import { memberAdminReply } from './member-admin'
import { FakeBusy, fakeMemberApi } from './member-test-fixtures'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const uid = process.getuid!()
const TENANT = '11111111-1111-4111-8111-111111111111'
const BINDING = '33333333-3333-4333-8333-333333333333'
const A = '22222222-2222-4222-8222-222222222222'
const UPSTREAM = '66666666-6666-4666-8666-666666666666'
const OWNER = { userId: '44444444-4444-4444-8444-444444444444', handle: 'ada', display: 'Ada' }
const digest = `sha256:${'a'.repeat(64)}`
let counter = 0
const rid = () => `${(++counter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const token = (id: string) => `sv_${id}_${'t'.repeat(43)}`

async function fixture(options: { loseMint?: boolean; tenantLabel?: string } = {}) {
  const outer = await mkdtemp(join(tmpdir(), 'bigbrain-lifecycle-'))
  roots.push(outer)
  const root = join(outer, 'state')
  const etc = join(outer, 'etc')
  await initializeStorageNamespace({ root, uid })
  await mkdir(etc, { mode: 0o700 })
  await writePrivateJson(
    etc,
    'host.json',
    {
      contractVersion: 1,
      tenantId: TENANT,
      physicalHostBinding: BINDING,
      hostEpoch: 1,
      hostState: 'active',
      upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
      artifactDigest: digest,
      zone: 'example.com',
      ...(options.tenantLabel ? { tenantLabel: options.tenantLabel } : {}),
      limits: { ...MANAGED_BIGBRAIN_DEFAULT_LIMITS, perVaultDiskBytes: 16 * 1024 ** 2 },
      effect: null,
    },
    installedHostSchema,
    { uid }
  )
  const host = simulatedHost({
    root,
    unitDirectory: join(outer, 'units'),
    tenantId: TENANT,
    physicalHostBinding: BINDING,
  })
  // In-memory native store: what the pinned CLI would return (wire behavior is the native smoke's job).
  const members: NativeMember[] = []
  const credentials: {
    id: string
    member_id: string
    name: string
    kind: 'person' | 'agent'
    scopes: ('read' | 'write')[]
    followsMember: boolean
    sha256: string
    revoked: string | null
  }[] = []
  const events: string[] = []
  let nextCredential = 0
  let loseMint = options.loseMint ?? false
  const mint = (memberId: string, kind: 'person' | 'agent', scopes: ('read' | 'write')[], name: string) => {
    const id = (++nextCredential).toString(16).padStart(8, '0')
    const t = token(id)
    const credential = {
      id,
      member_id: memberId,
      name,
      kind,
      scopes,
      followsMember: false,
      sha256: createHash('sha256').update(t).digest('hex'),
      revoked: null,
    }
    credentials.push(credential)
    return { credential, token: t }
  }
  const admin = () => ({
    async initializeOwner() {
      events.push('init')
      const member: NativeMember = {
        id: 'mem_00000001',
        handle: OWNER.handle,
        role: 'owner',
        permissions: ['read', 'write'],
        revoked: null,
      }
      members.push(member)
      return { ...mint(member.id, 'person', ['read', 'write'], 'owner'), member, vault: '', members: '' } as never
    },
    async listMembers() {
      return members
    },
    async listCredentials() {
      return credentials as never
    },
    async revokeCredential(id: string) {
      events.push(`revoke:${id}`)
      credentials.find((c) => c.id === id)!.revoked = '2026-10-20T00:00:00.000Z'
    },
    async ensureReadMember() {
      let reader = members.find((m) => m.handle === 'ficus-reader')
      if (!reader)
        members.push(
          (reader = {
            id: 'mem_00000002',
            handle: 'ficus-reader',
            role: 'member',
            permissions: ['read'],
            revoked: null,
          })
        )
      return reader
    },
    async mintReadCredential(member: NativeMember) {
      events.push('mint')
      const minted = mint(member.id, 'agent', ['read'], 'Ficus read')
      if (loseMint) {
        loseMint = false
        throw new Error('lost response')
      }
      return minted as never
    },
  })
  const issued: string[] = []
  let ingress = 0
  const deps = {
    root,
    etc,
    uid,
    unitDirectory: join(outer, 'units'),
    tmpfilesDirectory: join(outer, 'tmpfiles.d'),
    run: host.run,
    mountinfo: host.mountinfo,
    prepareLayout: host.prepareLayout,
    freeBytes: async () => 100 * 1024 ** 3,
    probeReady: async () => true,
    prepareSocket: async () => {},
    sleep: async () => {},
    whoami: async (_socket: string, presented: string) => {
      const credential = credentials.find((c) => token(c.id) === presented && c.revoked === null)
      if (!credential) throw new Error('upstream_unavailable')
      const member = members.find((m) => m.id === credential.member_id)!
      return {
        vault: { id: UPSTREAM },
        handle: member.handle,
        role: member.role,
        kind: credential.kind,
        permissions: credential.scopes,
        credential: { id: credential.id },
      }
    },
    readUpstreamIdentity: async () => UPSTREAM,
    admin,
    ingress: (async () => void ingress++) as () => Promise<unknown>,
    issueAppLink: async (_r: unknown, window: { issuedAt: string; expiresAt: string }) => {
      issued.push(window.issuedAt)
      return { secret: 's'.repeat(43), expiresAt: window.expiresAt }
    },
    now: () => Date.parse('2026-10-20T00:10:00.000Z'),
  }
  const send = (fields: object) =>
    dispatchHostRequest(
      { contractVersion: 1, tenantId: TENANT, physicalHostBinding: BINDING, hostEpoch: 1, ...fields },
      deps
    )
  return { root, deps, send, events, credentials, issued, ingress: () => ingress }
}
const createRequest = () => ({
  requestId: rid(),
  action: 'create',
  vaultId: A,
  expectedGeneration: 0,
  generation: 1,
  displayName: 'Research',
  owner: OWNER,
  origin: `https://bb-${A.replaceAll('-', '')}.example.com`,
  limits: { ...MANAGED_BIGBRAIN_DEFAULT_LIMITS, perVaultDiskBytes: 16 * 1024 ** 2 },
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: digest,
})

test('create runs every phase once: owner escrow, ONE read-only agent credential verified by whoami, handoff, ready, ingress', async () => {
  const f = await fixture()
  const create = createRequest()
  const reply = await f.send(create)
  expect(reply).toMatchObject({
    ok: true,
    action: 'create',
    receipt: { state: 'ready', readAccess: 'active', upstreamVaultId: UPSTREAM, generation: 1 },
  })
  expect(await f.send(create)).toEqual(reply)
  expect(f.events).toEqual(['init', 'mint'])
  const handoff = JSON.parse(await readFile(managedPaths({ root: f.root, vaultId: A }).handoff, 'utf8'))
  expect(handoff).toMatchObject({
    vaultId: A,
    upstreamVaultId: UPSTREAM,
    kind: 'agent',
    scopes: ['read'],
    followsMember: false,
    credentialId: '00000002',
  })
  // The owner's bootstrap secret never reaches Core's read material.
  expect(handoff.token).not.toBe(token('00000001'))
  expect((await stat(managedPaths({ root: f.root, vaultId: A }).handoff)).mode & 0o777).toBe(0o600)
  expect(f.ingress()).toBeGreaterThan(0)
})

test('the host refuses a new vault whose hostname another recorded vault already has, before anything exists', async () => {
  const f = await fixture({ tenantLabel: 'acme' })
  const prefixed = (id: string) => `https://acme-bb-${id.replaceAll('-', '').slice(0, 12)}.example.com`
  expect(await f.send({ ...createRequest(), origin: prefixed(A) })).toMatchObject({
    ok: true,
    receipt: { state: 'ready', origin: prefixed(A) },
  })
  // Same 12-hex short id as A (e.g. Core's database restored from an older backup): same hostname.
  const twin = `${A.slice(0, 13)}-4999-8999-999999999999`
  expect(prefixed(twin)).toBe(prefixed(A))
  expect(await f.send({ ...createRequest(), vaultId: twin, origin: prefixed(twin) })).toMatchObject({
    ok: false,
    code: 'identity_mismatch',
  })
  await expect(stat(managedPaths({ root: f.root, vaultId: twin }).control)).rejects.toThrow()
  // Its bb-<32 hex> form is a different hostname and is admitted.
  expect(
    await f.send({ ...createRequest(), vaultId: twin, origin: `https://bb-${twin.replaceAll('-', '')}.example.com` })
  ).toMatchObject({ ok: true })
})

test('read-revoke removes Core material first and revokes only the reader; reconnect mints exactly one new reader', async () => {
  const f = await fixture()
  await f.send(createRequest())
  const revoke = { requestId: rid(), action: 'read-revoke', vaultId: A, expectedGeneration: 1, generation: 2 }
  expect(await f.send(revoke)).toMatchObject({ ok: true, receipt: { readAccess: 'revoked', generation: 2 } })
  await expect(stat(managedPaths({ root: f.root, vaultId: A }).handoff)).rejects.toThrow()
  expect(f.credentials.map((c) => [c.id, c.revoked !== null])).toEqual([
    ['00000001', false],
    ['00000002', true],
  ])
  expect(await f.send(revoke)).toMatchObject({ ok: true, receipt: { readAccess: 'revoked' } })
  const reconnect = { requestId: rid(), action: 'read-reconnect', vaultId: A, expectedGeneration: 2, generation: 3 }
  expect(await f.send(reconnect)).toMatchObject({ ok: true, receipt: { readAccess: 'active', generation: 3 } })
  expect(await f.send(reconnect)).toMatchObject({ ok: true, receipt: { readAccess: 'active' } })
  expect(f.events.filter((e) => e === 'mint')).toHaveLength(2)
  const escrow = await readPrivateJson(
    managedPaths({ root: f.root, vaultId: A }).control,
    'reader.json',
    escrowSchema,
    { uid }
  )
  expect(JSON.parse(await readFile(managedPaths({ root: f.root, vaultId: A }).handoff, 'utf8')).credentialId).toBe(
    escrow.credentialId
  )
  // Stale generations are refused.
  expect(await f.send({ ...revoke, requestId: rid() })).toMatchObject({ ok: false, code: 'generation_conflict' })
})

test('a lost reconnect mint revokes the reader and refuses instead of minting again', async () => {
  const f = await fixture()
  await f.send(createRequest())
  await f.send({ requestId: rid(), action: 'read-revoke', vaultId: A, expectedGeneration: 1, generation: 2 })
  // The next mint succeeds natively but its response is lost.
  const reconnect = { requestId: rid(), action: 'read-reconnect', vaultId: A, expectedGeneration: 2, generation: 3 }
  f.deps.admin = ((original) => () => {
    const a = original()
    return {
      ...a,
      mintReadCredential: async (m: NativeMember) => {
        await a.mintReadCredential(m)
        throw new Error('lost response')
      },
    }
  })(f.deps.admin)
  expect(await f.send(reconnect)).toMatchObject({ ok: false })
  expect(await f.send(reconnect)).toMatchObject({ ok: false, code: 'operation_failed' })
  expect(f.events.filter((e) => e === 'mint')).toHaveLength(2)
  expect(f.credentials.filter((c) => c.member_id === 'mem_00000002').every((c) => c.revoked !== null)).toBe(true)
})

test('owner links: only the recorded owner, current generation; an exact replay returns the cached link', async () => {
  const f = await fixture()
  await f.send(createRequest())
  const invite = {
    requestId: rid(),
    action: 'owner-invite',
    vaultId: A,
    expectedGeneration: 1,
    actorUserId: OWNER.userId,
    issuedAt: '2026-10-20T00:05:00.000Z',
    expiresAt: '2026-10-20T01:05:00.000Z',
  }
  const reply = await f.send(invite)
  expect(reply).toMatchObject({
    ok: true,
    invite: {
      inviteUrl: `https://bb-${A.replaceAll('-', '')}.example.com/invite#${'s'.repeat(43)}`,
      expiresAt: invite.expiresAt,
    },
  })
  expect(await f.send(invite)).toEqual(reply)
  expect(f.issued).toHaveLength(1)
  expect(await f.send({ ...invite, requestId: rid(), actorUserId: TENANT })).toMatchObject({
    ok: false,
    code: 'forbidden',
  })
  expect(await f.send({ ...invite, requestId: rid(), expectedGeneration: 5 })).toMatchObject({
    ok: false,
    code: 'generation_conflict',
  })
})

test('owner links are issued only after the vault route and Caddy site are published and readable', async () => {
  const f = await fixture()
  await f.send(createRequest())
  const invite = (fields: object = {}) => ({
    requestId: rid(),
    action: 'owner-invite',
    vaultId: A,
    expectedGeneration: 1,
    actorUserId: OWNER.userId,
    issuedAt: '2026-10-20T00:05:00.000Z',
    expiresAt: '2026-10-20T01:05:00.000Z',
    ...fields,
  })
  // Caddy cannot read the vault sites (the production failure): no link is minted at all.
  const before = f.ingress()
  f.deps.ingress = async () => {
    throw new Error('tls_unavailable')
  }
  expect(await f.send(invite())).toMatchObject({ ok: false, code: 'tls_unavailable' })
  // Published, but this vault has no ready route (e.g. a suspended host): refused, retryable.
  f.deps.ingress = async () => ({
    contractVersion: 1,
    tenantId: TENANT,
    physicalHostBinding: BINDING,
    hostEpoch: 1,
    hostState: 'suspended',
    routes: [
      {
        vaultId: A,
        upstreamVaultId: UPSTREAM,
        origin: `https://bb-${A.replaceAll('-', '')}.example.com`,
        state: 'disabled',
      },
    ],
  })
  expect(await f.send(invite())).toMatchObject({ ok: false, code: 'maintenance', retryable: true })
  // Published and ready, but the RUNNING gateway does not serve it (the stale-release outage):
  // refused before any link exists, and the check is scoped to this vault.
  const ready = {
    contractVersion: 1,
    tenantId: TENANT,
    physicalHostBinding: BINDING,
    hostEpoch: 1,
    hostState: 'active',
    routes: [
      {
        vaultId: A,
        upstreamVaultId: UPSTREAM,
        origin: `https://bb-${A.replaceAll('-', '')}.example.com`,
        state: 'ready',
      },
    ],
  }
  const checked: string[] = []
  f.deps.ingress = async () => ready
  ;(f.deps as { gatewayServes?: unknown }).gatewayServes = async (_m: unknown, vaultId: string) => {
    checked.push(vaultId)
    throw new Error('upstream_unavailable')
  }
  expect(await f.send(invite())).toMatchObject({ ok: false, code: 'upstream_unavailable', retryable: true })
  expect(checked).toEqual([A])
  delete (f.deps as { gatewayServes?: unknown }).gatewayServes
  // Anything that is not a valid manifest never fails open.
  f.deps.ingress = async () => ({ routes: 'nope' })
  expect(await f.send(invite())).toMatchObject({ ok: false, code: 'operation_failed' })
  expect(f.issued).toHaveLength(0)
  // Served: the link is minted once.
  let republished = 0
  f.deps.ingress = async () => void republished++
  expect(await f.send(invite())).toMatchObject({ ok: true })
  expect(republished).toBe(1)
  expect(f.issued).toHaveLength(1)
  expect(f.ingress()).toBe(before)
})

test('rename changes only Ficus metadata at the next generation', async () => {
  const f = await fixture()
  await f.send(createRequest())
  expect(
    await f.send({
      requestId: rid(),
      action: 'rename',
      vaultId: A,
      expectedGeneration: 1,
      generation: 2,
      displayName: 'Lab',
    })
  ).toMatchObject({ ok: true, receipt: { generation: 2 } })
  expect(f.events).toEqual(['init', 'mint'])
})

// ---------------------------------------------------------------- member management
const NOW = Date.parse('2026-10-20T00:10:00.000Z')
const GRACE_INVITE = 'b'.repeat(24)
async function memberFixture() {
  const f = await fixture()
  await f.send(createRequest())
  const store = managedPaths({ root: f.root, vaultId: A }).memberStore
  const native = fakeMemberApi(store)
  const commands: string[][] = []
  // The real controller -> real adapter path; only the pinned upstream store is in memory.
  const run = f.deps.run
  f.deps.run = (async (argv: string[], options?: { input?: string }) => {
    if (!argv.some((a) => a.endsWith('/bigbrain-members.js'))) return run(argv, options as never)
    commands.push(argv)
    return { code: 0, stdout: JSON.stringify(memberAdminReply(JSON.parse(options!.input!), native.api, NOW)) + '\n' }
  }) as typeof f.deps.run
  const member = (fields: object) => f.send({ requestId: rid(), vaultId: A, expectedGeneration: 1, ...fields })
  return { ...f, native, commands, member, store }
}

test('member-list returns the roster through the installed release adapter as the vault UID', async () => {
  const f = await memberFixture()
  const reply = await f.send({ requestId: rid(), action: 'member-list', vaultId: A })
  expect(reply).toMatchObject({ ok: true, action: 'member-list', vaultId: A })
  const roster = (reply as { roster: { members: { handle: string }[] } }).roster
  expect(roster.members.map((m) => m.handle)).toEqual([
    'ficus',
    'ficus-reader',
    'grace',
    'invite-aaaaaaaaaaaaaaaaaaaaaaaa',
  ])
  const argv = f.commands[0]!
  expect(argv[0]).toBe('/usr/bin/setpriv')
  expect(argv.at(-1)).toBe(`/opt/ficus-bigbrain/releases/${digest.slice(7)}/bigbrain-members.js`)
  expect(await f.send({ requestId: rid(), action: 'member-list', vaultId: TENANT })).toMatchObject({
    ok: false,
    code: 'not_found',
  })
})

test('member-invite mints once per request ID and replays the same link while it is pending', async () => {
  const f = await memberFixture()
  const invite = {
    requestId: rid(),
    action: 'member-invite',
    vaultId: A,
    expectedGeneration: 1,
    displayName: 'Grace',
    access: 'write',
  }
  const reply = await f.send(invite)
  expect(reply).toEqual({
    contractVersion: 1,
    requestId: invite.requestId,
    ok: true,
    physicalHostBinding: BINDING,
    action: 'member-invite',
    vaultId: A,
    invite: {
      inviteId: GRACE_INVITE,
      inviteUrl: `https://bb-${A.replaceAll('-', '')}.example.com/invite#${'s'.repeat(43)}`,
      displayName: 'Grace',
      access: 'write',
      expiresAt: '2026-10-21T00:10:00.000Z',
    },
  })
  expect(await f.send(invite)).toEqual(reply)
  expect(f.native.calls.filter((c) => c === 'createMemberInvite')).toHaveLength(1)
  // The cache binds the request; it never stores the name or access.
  const cache = await readFile(join(managedPaths({ root: f.root, vaultId: A }).control, 'member-invites.json'), 'utf8')
  expect(cache).not.toContain('Grace')
  expect(await f.send({ ...invite, access: 'read' })).toMatchObject({ ok: false, code: 'request_conflict' })
  expect(await f.send({ ...invite, requestId: rid(), expectedGeneration: 2 })).toMatchObject({
    ok: false,
    code: 'generation_conflict',
  })
  // Once cancelled (or accepted) upstream, a replay never hands the dead link back.
  expect(await f.member({ action: 'invite-cancel', inviteId: GRACE_INVITE })).toMatchObject({
    ok: true,
    inviteId: GRACE_INVITE,
  })
  expect(await f.send(invite)).toMatchObject({ ok: false, code: 'invite_expired' })
  expect(f.native.calls.filter((c) => c === 'createMemberInvite')).toHaveLength(1)
})

test('a lost member-invite result is never permission to mint again; a busy refusal may retry', async () => {
  const f = await memberFixture()
  const invite = {
    requestId: rid(),
    action: 'member-invite',
    vaultId: A,
    expectedGeneration: 1,
    displayName: 'Lin',
    access: 'read',
  }
  const create = f.native.api.createMemberInvite
  f.native.api.createMemberInvite = (...args) => {
    create(...args)
    throw new Error('lost')
  }
  expect(await f.send(invite)).toMatchObject({ ok: false, code: 'operation_failed' })
  f.native.api.createMemberInvite = create
  expect(await f.send(invite)).toMatchObject({ ok: false, code: 'operation_failed' })
  expect(f.native.calls.filter((c) => c === 'createMemberInvite')).toHaveLength(1)
  // Lock contention upstream mints nothing, so the same request can succeed later.
  const busy = { ...invite, requestId: rid() }
  f.native.api.createMemberInvite = () => {
    throw new FakeBusy('Membership is being updated. Please retry.')
  }
  expect(await f.send(busy)).toMatchObject({ ok: false, code: 'busy', retryable: true })
  f.native.api.createMemberInvite = create
  expect(await f.send(busy)).toMatchObject({ ok: true, action: 'member-invite' })
})

test('member-invite needs the vault served at its origin and bounds live invites', async () => {
  const f = await memberFixture()
  f.deps.ingress = async () => {
    throw new Error('tls_unavailable')
  }
  const invite = () => ({
    requestId: rid(),
    action: 'member-invite',
    vaultId: A,
    expectedGeneration: 1,
    displayName: 'Lin',
    access: 'read',
  })
  expect(await f.send(invite())).toMatchObject({ ok: false, code: 'tls_unavailable' })
  expect(f.native.calls).not.toContain('createMemberInvite')
  f.deps.ingress = async () => {}
  const create = f.native.api.createMemberInvite
  let n = 0
  f.native.api.createMemberInvite = (...args) => ({
    ...(create(...args) as object),
    id: (++n).toString(16).padStart(24, '0'),
  })
  for (let i = 0; i < 32; i++) expect(await f.send(invite())).toMatchObject({ ok: true })
  expect(await f.send(invite())).toMatchObject({ ok: false, code: 'capacity' })
})

test('a vault created before member management gets its invite cache on first use; a corrupt one fails closed', async () => {
  const f = await memberFixture()
  const control = managedPaths({ root: f.root, vaultId: A }).control
  const { unlink, writeFile } = await import('node:fs/promises')
  await unlink(join(control, 'member-invites.json'))
  const invite = () => ({
    requestId: rid(),
    action: 'member-invite',
    vaultId: A,
    expectedGeneration: 1,
    displayName: 'Lin',
    access: 'read',
  })
  expect(await f.send(invite())).toMatchObject({ ok: true })
  await writeFile(join(control, 'member-invites.json'), '{"schema":1,"invites":"x"}', { mode: 0o600 })
  expect(await f.send(invite())).toMatchObject({ ok: false })
  expect(f.native.calls.filter((c) => c === 'createMemberInvite')).toHaveLength(1)
})

test('access changes and removal reach ordinary members only; ficus and ficus-reader are never sent', async () => {
  const f = await memberFixture()
  expect(await f.member({ action: 'member-set-access', handle: 'grace', access: 'read' })).toMatchObject({
    ok: true,
    action: 'member-set-access',
    member: { handle: 'grace', access: 'read', status: 'active' },
  })
  expect(await f.member({ action: 'member-remove', handle: 'grace' })).toMatchObject({
    ok: true,
    member: { handle: 'grace', status: 'removed' },
  })
  for (const handle of ['ficus', 'ficus-reader']) {
    expect(await f.member({ action: 'member-remove', handle })).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(await f.member({ action: 'member-set-access', handle, access: 'write' })).toMatchObject({
      ok: false,
      code: 'invalid_request',
    })
  }
  // A legacy vault's owner has a person's handle: the adapter refuses it by role.
  f.native.members[0]!.handle = 'ada'
  expect(await f.member({ action: 'member-remove', handle: 'ada' })).toMatchObject({ ok: false, code: 'forbidden' })
  expect(await f.member({ action: 'member-remove', handle: 'nobody' })).toMatchObject({ ok: false, code: 'not_found' })
  expect(await f.member({ action: 'member-remove', handle: 'grace', expectedGeneration: 2 })).toMatchObject({
    ok: false,
    code: 'generation_conflict',
  })
  expect(f.native.calls.filter((c) => c === 'revokeMember')).toHaveLength(1)
})

test('an adapter reply outside the contract is refused, never passed through', async () => {
  const f = await memberFixture()
  f.deps.memberAdmin = async () => ({ members: [{ handle: 'grace', token: 'sv_secret' }], invites: [] })
  expect(await f.send({ requestId: rid(), action: 'member-list', vaultId: A })).toMatchObject({
    ok: false,
    code: 'upstream_protocol',
  })
})
