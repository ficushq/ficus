import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BigbrainSharedClient } from './shared-client'
import { createSharedBigbrainTools } from './shared-tools'
import { IntegrationRuntimeGate } from '../runtime-gate'
import { inArray } from 'drizzle-orm'
import { db, managedBigbrainVaults, users } from '../../../db'
import { ManagedHostError, type ManagedHostCall } from './managed/host-client'
import { reconcileNext } from './managed/reconciler'
import { managedVaultStore, type ManagedVault } from './managed/store'
import { nativeFixtures } from '../../../../../../scripts/bigbrain/native-fixtures'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin,
  MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS,
  managedBigbrainVaultOrigin,
} from '@ficus/shared/managed-bigbrain'
import { cachedOwnerAppLink, ownerInviteCacheSchema } from '../../../../../../scripts/bigbrain/invite-cache'
import { cachedMemberInvite } from '../../../../../../scripts/bigbrain/member-invite-cache'
import { writePrivateJson } from '../../../../../../scripts/bigbrain/secure-files'
import { createGatewayHandler } from '../../../../../../scripts/bigbrain/gateway-policy'

const artifact = process.env.FICUS_BIGBRAIN_SHARED_ARTIFACT
const nativeDeps = process.env.FICUS_BIGBRAIN_SHARED_DEPS
const required = process.env.FICUS_BIGBRAIN_REQUIRE_SHARED_SMOKE === '1'
/** Core's reconciler creates both vaults (fixture helper), then the read client and shared tools run
 * against the real native servers. The shipped gateway, launcher and HTTPS are the containment lane.
 * No TLS/UID/mount/cgroup claim: this runs unprivileged owned synthetic processes.
 * CI's required lane fails on missing artifacts rather than accepting a skip.
 */
test.skipIf(!artifact && !required)(
  'real two-vault native client writes -> read-only Ficus adapter, revoke and crash persistence',
  async () => {
    if (!artifact || !nativeDeps) throw new Error('Required pinned shared artifact/dependencies are missing')
    const root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-shared-smoke-'))
    let fixtures: Awaited<ReturnType<typeof nativeFixtures>> | undefined
    const owners: string[] = []
    try {
      fixtures = await nativeFixtures(root, artifact, nativeDeps)
      expect(fixtures.provenance.upstreamCommit).toBe(pin)
      // Both vaults are created through Core's own path: a recorded intent in Core's store, then
      // the worker reconciler driving the helper (here a fixture that starts the real native server).
      const { a, b } = await createdThroughReconciler(fixtures, owners)
      expect(a.identity.vault.id).not.toBe(b.identity.vault.id)
      // The shipped bundle serves its font assets from the release directory (unit WorkingDirectory).
      const font = await fetch(a.endpoint + '/assets/hanken-grotesk-latin.woff2')
      expect(font.status).toBe(200)
      expect(
        Buffer.from(await font.arrayBuffer()).equals(await readFile(join(artifact, 'hanken-grotesk-latin.woff2')))
      ).toBe(true)
      const connections = join(root, 'native-connections.json')
      const joinedA = await fixtures.native.connectInvite(connections, a.invite)
      const joinedB = await fixtures.native.connectInvite(connections, b.invite)
      const ownerA = fixtures.native.readConnections(connections).find((c) => c.id === joinedA.id)!
      const ownerB = fixtures.native.readConnections(connections).find((c) => c.id === joinedB.id)!
      expect(ownerA.id).not.toBe(ownerB.id)
      expect(joinedA.identity.vault.id).toBe(a.identity.vault.id)
      // Each app connection is named after the vault's Ficus name, not upstream's default.
      expect([joinedA.name, joinedB.name]).toEqual(['Alpha', 'Beta'])
      expect([ownerA.name, ownerB.name]).toEqual(['Alpha', 'Beta'])
      await expect(fixtures.native.connectInvite(connections, a.invite)).rejects.toBeDefined()
      // Real shim + root-private durable replay cache; identical retries cannot mint a replacement.
      const control = join(root, 'root-private-control')
      await mkdir(control, { mode: 0o700 })
      await writePrivateJson(control, 'owner-invites.json', { schema: 1, invites: [] }, ownerInviteCacheSchema, {
        uid: process.getuid!(),
      })
      const issuedAt = new Date().toISOString()
      const window = {
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toISOString(),
      }
      const inviteRequest = {
        contractVersion: 1,
        requestId: randomUUID(),
        tenantId: randomUUID(),
        physicalHostBinding: randomUUID(),
        hostEpoch: 1,
        action: 'owner-invite',
        vaultId: randomUUID(),
        expectedGeneration: 1,
        actorUserId: randomUUID(),
        ...window,
      }
      let mintedLinks = 0
      const cachedLink = () =>
        cachedOwnerAppLink({
          directory: control,
          uid: process.getuid!(),
          input: inviteRequest,
          authorize: async () => {},
          issue: async () => {
            mintedLinks++
            return a.issueAppLink(window)
          },
        })
      const link = await cachedLink()
      expect(link.expiresAt).toBe(window.expiresAt)
      expect(await cachedLink()).toEqual(link)
      expect(mintedLinks).toBe(1)
      const inviteUrl = `${a.endpoint}/invite#${link.secret}`
      const ownerConnections = join(root, 'native-owner-link.json')
      const linked = await fixtures.native.connectInvite(ownerConnections, inviteUrl)
      const human = fixtures.native.readConnections(ownerConnections).find((c) => c.id === linked.id)!
      const humanIdentity = await fixtures.native.sharedRequest<{
        role: string
        kind: string
        handle: string
        permissions: string[]
      }>(human, '/v1/whoami')
      expect(humanIdentity.role).toBe('owner')
      expect(humanIdentity.kind).toBe('person')
      expect(humanIdentity.handle).toBe('ada')
      expect(humanIdentity.permissions).toEqual(['read', 'write'])
      await expect(fixtures.native.connectInvite(ownerConnections, inviteUrl)).rejects.toBeDefined()
      expect(await cachedLink()).toEqual(link)
      expect(mintedLinks).toBe(1)
      // Already expired authority is refused by the compiled shim; valid near-expiry links
      // are actually expired by upstream, not merely advertised as expired in a DTO.
      const soonIssued = new Date(Date.now() - MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS + 1500).toISOString()
      const soonWindow = {
        issuedAt: soonIssued,
        expiresAt: new Date(Date.parse(soonIssued) + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toISOString(),
      }
      const soon = await a.issueAppLink(soonWindow)
      expect(soon.expiresAt).toBe(soonWindow.expiresAt)
      await Bun.sleep(Math.max(0, Date.parse(soon.expiresAt) - Date.now()) + 25)
      await expect(
        fixtures.native.connectInvite(ownerConnections, `${a.endpoint}/invite#${soon.secret}`)
      ).rejects.toBeDefined()
      await expect(a.issueAppLink(soonWindow)).rejects.toThrow('synthetic_command_failed')
      // Only the actual native human client writes. Ficus credentials are never used to contribute.
      const recordA = await fixtures.native.sharedRequest<{ id: string }>(ownerA, '/v1/evidence', {
        title: 'Amber experiment',
        body: 'Amber measurements are specific to vault A.',
      })
      const recordB = await fixtures.native.sharedRequest<{ id: string }>(ownerB, '/v1/evidence', {
        title: 'Cobalt experiment',
        body: 'Cobalt measurements are specific to vault B.',
      })
      const tenantId = randomUUID()
      const physicalHostBinding = randomUUID()
      const binding = { tenantId, physicalHostBinding, hostEpoch: 1 }
      const client = (vault: typeof a) => {
        const vaultId = vault === a ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'
        const material = {
          ...binding,
          contractVersion: 1 as const,
          vaultId,
          generation: 1,
          upstreamVaultId: vault.identity.vault.id,
          upstreamCommit: pin,
          artifactDigest: fixtures!.provenance.digest,
          credentialId: vault.minted.credential.id,
          kind: 'agent' as const,
          scopes: ['read'] as ['read'],
          followsMember: false as const,
          token: vault.minted.token,
        }
        return new BigbrainSharedClient({
          capabilities: {
            ...binding,
            contractVersion: 1,
            available: true,
            reasonCode: null,
            installed: true,
            upstreamCommit: pin,
            artifactDigest: material.artifactDigest,
            sharedProtocol: 1,
            hostState: 'active',
            zone: 'example.com',
            tenantLabel: 'acme',
            limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
            observedAt: new Date().toISOString(),
          },
          material,
          vault: {
            vaultId,
            upstreamVaultId: material.upstreamVaultId,
            // Both hostname forms: A tenant-prefixed, B the bb-<32 hex> form of an older vault.
            origin: managedBigbrainVaultOrigin({
              vaultId,
              zone: 'example.com',
              tenantLabel: vault === a ? 'acme' : null,
            }),
            appliedGeneration: 1,
            state: 'ready',
            readAccess: 'active',
          },
          beforeCall: async () => {},
          // Owned ephemeral direct transport for wire proof; shipped gateway/HTTPS is a separate lane.
          fetch: (url, init) => fetch(vault.endpoint + new URL(url).pathname, init),
        })
      }
      const readerA = client(a)
      const readerB = client(b)
      expect(await readerA.overview()).toContain('Amber experiment')
      expect(await readerB.overview()).toContain('Cobalt experiment')
      expect(await readerA.searchVault({ query: 'Amber', limit: 5 })).toContain(recordA.id)
      expect(await readerB.searchVault({ query: 'Cobalt', limit: 5 })).toContain(recordB.id)
      expect(await readerA.readRecord({ id: recordA.id })).toContain('specific to vault A')
      expect(await readerB.readRecord({ id: recordB.id })).toContain('specific to vault B')
      expect(await readerA.readRecord({ id: recordA.id, start: 0, chars: 5 })).toContain('Amber')
      expect(await readerA.recent({ limit: 5 })).toContain(recordA.id)
      expect(await readerB.recent({ limit: 5 })).toContain(recordB.id)
      expect(await readerA.searchVault({ query: 'Cobalt' })).not.toContain(recordB.id)
      // Core's actual shared agent tools over both real servers: the same content written by
      // the native human client to both vaults is never conflated, every result names its vault.
      const same = { title: 'Shared protocol', body: 'Identical wording written to both vaults.' }
      const sameA = await fixtures.native.sharedRequest<{ id: string }>(ownerA, '/v1/evidence', same)
      const sameB = await fixtures.native.sharedRequest<{ id: string }>(ownerB, '/v1/evidence', same)
      const tools = sharedToolsOver([
        { vaultId: '11111111-1111-4111-8111-111111111111', name: 'Alpha', client: readerA },
        { vaultId: '22222222-2222-4222-8222-222222222222', name: 'Beta', client: readerB },
      ])
      const listed = (await tools.run('bigbrain_shared_vaults', {})) as { vaults: { vaultId: string }[] }
      expect(listed.vaults.map((v) => v.vaultId).sort()).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ])
      const viaA = await tools.run('bigbrain_shared_read_record', {
        vaultId: '11111111-1111-4111-8111-111111111111',
        id: sameA.id,
      })
      const viaB = await tools.run('bigbrain_shared_read_record', {
        vaultId: '22222222-2222-4222-8222-222222222222',
        id: sameB.id,
      })
      expect(viaA).toMatchObject({ vaultId: '11111111-1111-4111-8111-111111111111', displayName: 'Alpha' })
      expect(viaB).toMatchObject({ vaultId: '22222222-2222-4222-8222-222222222222', displayName: 'Beta' })
      expect(String(viaA.result)).toContain('Identical wording')
      expect(String(viaB.result)).toContain('Identical wording')
      expect(
        String(
          (
            await tools.run('bigbrain_shared_search_vault', {
              vaultId: '22222222-2222-4222-8222-222222222222',
              query: 'Amber',
            })
          ).result
        )
      ).not.toContain(recordA.id)
      expect(
        String(
          (await tools.run('bigbrain_shared_recent', { vaultId: '11111111-1111-4111-8111-111111111111', limit: 5 }))
            .result
        )
      ).toContain(sameA.id)
      for (const path of ['/v1/evidence', '/v1/assertions', '/v1/members', '/v1/invites', '/v1/credentials/agent']) {
        const response = await fetch(a.endpoint + path, {
          method: 'POST',
          headers: { Authorization: `Bearer ${a.minted.token}`, 'Content-Type': 'application/json' },
          body: '{}',
        })
        expect(response.status).toBe(403)
        await response.body?.cancel()
      }
      const foreign = await fetch(b.endpoint + '/v1/whoami', { headers: { Authorization: `Bearer ${a.minted.token}` } })
      expect(foreign.status).toBe(401)
      await foreign.body?.cancel()
      const previousIdentity = a.identity.vault.id
      await a.restart()
      expect(await readerA.readRecord({ id: recordA.id })).toContain('specific to vault A')
      expect(
        (
          await fixtures.native.sharedRequest<{ vault: { id: string } }>(
            { ...ownerA, endpoint: a.endpoint },
            '/v1/whoami'
          )
        ).vault.id
      ).toBe(previousIdentity)
      await a.cli(['credential', 'revoke', a.minted.credential.id])
      await expect(readerA.overview()).rejects.toMatchObject({ code: 'invalid_auth' })
      expect(await readerB.overview()).toContain('Cobalt experiment')
      await fixtures.native.sharedRequest({ ...ownerA, endpoint: a.endpoint }, '/v1/evidence', {
        title: 'After Ficus revoke',
        body: 'The human native client can still contribute.',
      })
    } finally {
      await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.hostOwnerUserId, owners))
      if (owners.length) await db.delete(users).where(inArray(users.id, owners))
      await fixtures?.dispose()
      await rm(root, { recursive: true, force: true })
    }
    // Two compiled serving processes, real invitation redemption and 12+ CLI operations.
  },
  60000
)

const VAULT_A = '11111111-1111-4111-8111-111111111111'
const VAULT_B = '22222222-2222-4222-8222-222222222222'

/** Regression for the owner device link that failed in the BigBrain app with
 * "null is not an object (evaluating 'result.vault')". The vault's Caddy site was published where
 * the caddy user could not read it, so Caddy answered the vault host with its empty 200 fallback:
 * no BigBrain-Protocol header (the client then assumes protocol 1) and a body the native client's
 * response.json() reads as null. The link created through Ficus's owner-invite path (root-private
 * replay cache + shipped owner-link bundle) must redeem in the pinned native client through the
 * shipped gateway policy with Host routing, exactly like Caddy -> gateway -> vault socket. */
test.skipIf(!artifact && !required)(
  'owner device link from Ficus redeems in the pinned native client through the shipped gateway',
  async () => {
    if (!artifact || !nativeDeps) throw new Error('Required pinned shared artifact/dependencies are missing')
    const root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-owner-link-'))
    let fixtures: Awaited<ReturnType<typeof nativeFixtures>> | undefined
    const listeners: { stop(force?: boolean): unknown }[] = []
    try {
      fixtures = await nativeFixtures(root, artifact, nativeDeps)
      const vault = await fixtures.vault('gateway-vault')
      const vaultId = randomUUID()
      const host = `bb-${vaultId.replaceAll('-', '')}.example.com`
      const manifest = {
        contractVersion: 1,
        tenantId: randomUUID(),
        physicalHostBinding: randomUUID(),
        hostEpoch: 1,
        hostState: 'active',
        routes: [{ vaultId, upstreamVaultId: vault.identity.vault.id, origin: `https://${host}`, state: 'ready' }],
      }
      const gatewaySocket = join(root, 'gateway.sock')
      listeners.push(
        Bun.serve({
          unix: gatewaySocket,
          fetch: createGatewayHandler({ manifest: async () => manifest, socketPath: () => vault.socket }),
        })
      )
      // Caddy-equivalent ingress minus TLS: a published, readable vault site forwards by Host to the
      // gateway socket; an unknown host gets Caddy's own fallback, an empty 200.
      let siteServed = false
      const ingress = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          if (!siteServed) return new Response(null, { status: 200 })
          const url = new URL(request.url)
          const headers = new Headers(request.headers)
          headers.set('Host', host)
          headers.set('X-Forwarded-For', '127.0.0.1')
          headers.set('X-Forwarded-Proto', 'https')
          return fetch(`http://${host}${url.pathname}${url.search}`, {
            unix: gatewaySocket,
            method: request.method,
            headers,
            body: request.body,
            redirect: 'manual',
          })
        },
      })
      listeners.push(ingress)
      const endpoint = `http://127.0.0.1:${ingress.port}`

      const control = join(root, 'root-private-control')
      await mkdir(control, { mode: 0o700 })
      await writePrivateJson(control, 'owner-invites.json', { schema: 1, invites: [] }, ownerInviteCacheSchema, {
        uid: process.getuid!(),
      })
      const issuedAt = new Date().toISOString()
      const window = {
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toISOString(),
      }
      const link = await cachedOwnerAppLink({
        directory: control,
        uid: process.getuid!(),
        input: {
          contractVersion: 1,
          requestId: randomUUID(),
          tenantId: manifest.tenantId,
          physicalHostBinding: manifest.physicalHostBinding,
          hostEpoch: 1,
          action: 'owner-invite',
          vaultId,
          expectedGeneration: 1,
          actorUserId: randomUUID(),
          ...window,
        },
        authorize: async () => {},
        issue: () => vault.issueAppLink(window),
      })
      // The same shape lifecycle.ownerInvite returns: `${origin}/invite#<secret>`.
      const inviteUrl = `${endpoint}/invite#${link.secret}`
      const connections = join(root, 'native-owner-gateway.json')

      // The reported failure, reproduced with the real client: the vault host is not served.
      await expect(fixtures.native.connectInvite(connections, inviteUrl)).rejects.toThrow(
        "null is not an object (evaluating 'result.vault')"
      )
      // It never reached the vault, so the single-use link was not consumed.
      siteServed = true
      const linked = await fixtures.native.connectInvite(connections, inviteUrl)
      expect(linked.identity.vault.id).toBe(vault.identity.vault.id)
      const device = fixtures.native.readConnections(connections).find((c) => c.id === linked.id)!
      expect(device.endpoint).toBe(endpoint)
      const identity = await fixtures.native.sharedRequest<{
        role: string
        kind: string
        handle: string
        permissions: string[]
        vault: { id: string }
      }>(device, '/v1/whoami')
      expect(identity).toMatchObject({
        role: 'owner',
        kind: 'person',
        handle: 'ada',
        permissions: ['read', 'write'],
        vault: { id: vault.identity.vault.id },
      })
      // Still single use through the gateway.
      await expect(fixtures.native.connectInvite(connections, inviteUrl)).rejects.toBeDefined()
    } finally {
      for (const listener of listeners) listener.stop(true)
      await fixtures?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)

/** Member management through Ficus against the real pinned server: an invite minted by the shipped
 * member adapter behind the root-private replay cache redeems in the pinned native client as a NEW
 * member, who writes under their own handle; Ficus's read adapter shows that author; narrowing
 * access to read blocks the member's writes on the next request; removal revokes the member. */
test.skipIf(!artifact && !required)(
  'a Ficus member invite redeems natively; the member writes as themselves until narrowed and removed',
  async () => {
    if (!artifact || !nativeDeps) throw new Error('Required pinned shared artifact/dependencies are missing')
    const root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-members-'))
    let fixtures: Awaited<ReturnType<typeof nativeFixtures>> | undefined
    try {
      fixtures = await nativeFixtures(root, artifact, nativeDeps)
      const vault = await fixtures.vault('members-vault')
      const admin = async (input: Record<string, unknown>) => {
        const reply = await vault.memberAdmin(input)
        if (!reply.ok) throw new Error(reply.code)
        return reply.result as Record<string, any>
      }
      // Root-private control state, exactly where the controller keeps it.
      const state = join(root, 'state')
      const vaultId = randomUUID()
      await mkdir(join(state, 'control', vaultId), { recursive: true, mode: 0o700 })
      const request = {
        contractVersion: 1 as const,
        requestId: randomUUID(),
        tenantId: randomUUID(),
        physicalHostBinding: randomUUID(),
        hostEpoch: 1,
        action: 'member-invite' as const,
        vaultId,
        expectedGeneration: 1,
        displayName: 'Grace Hopper',
        access: 'write' as const,
      }
      let minted = 0
      const invite = () =>
        cachedMemberInvite({
          vaultId,
          root: state,
          uid: process.getuid!(),
          request,
          authorize: async () => {},
          pendingInvites: async () =>
            new Set((await admin({ op: 'list' })).invites.map((i: { inviteId: string }) => i.inviteId)),
          mint: async (issuedAt) => {
            minted++
            return (await admin({
              op: 'invite',
              displayName: request.displayName,
              access: request.access,
              issuedAt,
            })) as never
          },
        })
      const first = await invite()
      expect(await invite()).toEqual(first)
      expect(minted).toBe(1)
      const roster = await admin({ op: 'list' })
      expect(roster.invites).toEqual([
        { inviteId: first.inviteId, displayName: 'Grace Hopper', access: 'write', expiresAt: first.expiresAt },
      ])
      expect(JSON.stringify(roster)).not.toContain(first.secret)
      expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(86_400_000 - 60_000)

      // The pinned native client redeems it as a NEW member with their own handle.
      const connections = join(root, 'native-member.json')
      const joined = await fixtures.native.connectInvite(connections, `${vault.endpoint}/invite#${first.secret}`)
      const device = fixtures.native.readConnections(connections).find((c) => c.id === joined.id)!
      const handle = `invite-${first.inviteId}`
      const whoami = () =>
        fixtures!.native.sharedRequest<{ handle: string; role: string; permissions: string[] }>(device, '/v1/whoami')
      expect(await whoami()).toMatchObject({ handle, role: 'member', permissions: ['read', 'write'] })
      await expect(
        fixtures.native.connectInvite(connections, `${vault.endpoint}/invite#${first.secret}`)
      ).rejects.toBeDefined()
      // A replay after redemption never hands the spent link back.
      await expect(invite()).rejects.toThrow('invite_expired')
      expect(minted).toBe(1)

      // The member writes under their own handle; Ficus's read adapter shows that author.
      const written = await fixtures.native.sharedRequest<{ id: string; submitted_by: string }>(
        device,
        '/v1/evidence',
        {
          title: 'Hopper notes',
          body: 'Written by an invited member.',
        }
      )
      expect(written.submitted_by).toBe(handle)
      const reader = readOnlyClient(vault, fixtures)
      expect(await reader.readRecord({ id: written.id })).toContain(`Grace Hopper (@${handle})`)
      expect((await admin({ op: 'list' })).members.map((m: { handle: string }) => m.handle)).toEqual([
        'ada',
        'ficus-reader',
        handle,
      ])

      // Read access: the member's very next write is refused; reads continue.
      expect(await admin({ op: 'set-access', handle, access: 'read' })).toMatchObject({ handle, access: 'read' })
      await expect(
        fixtures.native.sharedRequest(device, '/v1/evidence', { title: 'Blocked', body: 'Should not land.' })
      ).rejects.toMatchObject({ status: 403 })
      expect((await whoami()).permissions).toEqual(['read'])

      // The owner and the Ficus reader are never changed through the adapter.
      for (const target of ['ada', 'ficus-reader'])
        await expect(admin({ op: 'remove', handle: target })).rejects.toThrow('forbidden')

      // Removal revokes the member and every credential; what they wrote stays attributed.
      expect(await admin({ op: 'remove', handle })).toMatchObject({ handle, status: 'removed' })
      await expect(whoami()).rejects.toMatchObject({ status: 401 })
      expect(await reader.readRecord({ id: written.id })).toContain(`@${handle}`)

      // A cancelled invite can no longer be redeemed.
      const second = (await admin({
        op: 'invite',
        displayName: 'Lin',
        access: 'read',
        issuedAt: new Date().toISOString(),
      })) as { inviteId: string; secret: string }
      expect(await admin({ op: 'cancel', inviteId: second.inviteId })).toEqual({ inviteId: second.inviteId })
      await expect(
        fixtures.native.connectInvite(join(root, 'cancelled.json'), `${vault.endpoint}/invite#${second.secret}`)
      ).rejects.toBeDefined()
    } finally {
      await fixtures?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)

/** Core's read-only client over one fixture vault's real Ficus read credential. */
function readOnlyClient(
  vault: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixtures>>['vault']>>,
  fixtures: Awaited<ReturnType<typeof nativeFixtures>>
) {
  const binding = { tenantId: randomUUID(), physicalHostBinding: randomUUID(), hostEpoch: 1 }
  const vaultId = randomUUID()
  const material = {
    ...binding,
    contractVersion: 1 as const,
    vaultId,
    generation: 1,
    upstreamVaultId: vault.identity.vault.id,
    upstreamCommit: pin,
    artifactDigest: fixtures.provenance.digest,
    credentialId: vault.minted.credential.id,
    kind: 'agent' as const,
    scopes: ['read'] as ['read'],
    followsMember: false as const,
    token: vault.minted.token,
  }
  return new BigbrainSharedClient({
    capabilities: {
      ...binding,
      contractVersion: 1,
      available: true,
      reasonCode: null,
      installed: true,
      upstreamCommit: pin,
      artifactDigest: material.artifactDigest,
      sharedProtocol: 1,
      hostState: 'active',
      zone: 'example.com',
      tenantLabel: null,
      limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
      observedAt: new Date().toISOString(),
    },
    material,
    vault: {
      vaultId,
      upstreamVaultId: material.upstreamVaultId,
      origin: managedBigbrainVaultOrigin({ vaultId, zone: 'example.com', tenantLabel: null }),
      appliedGeneration: 1,
      state: 'ready',
      readAccess: 'active',
    },
    beforeCall: async () => {},
    fetch: (url, init) => fetch(vault.endpoint + new URL(url).pathname, init),
  })
}

/** The vault's server name through the shipped member adapter and the PINNED native client: a
 * Ficus-named vault redeems under its name; the host's rename procedure (stop, write, start)
 * keeps the upstream id, a new device redeems under the new name and an already-connected app
 * picks it up on its next sync; a vault still on upstream's default ("Shared BigBrain", created
 * before Ficus wrote names) is repaired the same way. */
test.skipIf(!artifact && !required)(
  'Ficus-named and renamed vaults redeem with their names in the pinned client; connected apps follow renames',
  async () => {
    if (!artifact || !nativeDeps) throw new Error('Required pinned shared artifact/dependencies are missing')
    const root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-names-'))
    let fixtures: Awaited<ReturnType<typeof nativeFixtures>> | undefined
    try {
      fixtures = await nativeFixtures(root, artifact, nativeDeps)
      const named = await fixtures.vault('named', { serverName: 'Research' })
      const legacy = await fixtures.vault('legacy')
      expect(named.identity.vault).toMatchObject({ name: 'Research' })
      expect(await legacy.serverIdentity()).toEqual({
        upstreamVaultId: legacy.identity.vault.id,
        name: 'Shared BigBrain',
      })
      const connections = join(root, 'connections.json')
      const joined = await fixtures.native.connectInvite(connections, named.invite)
      expect(joined.name).toBe('Research')

      const id = named.identity.vault.id
      expect(await named.rename('Research notes')).toEqual({
        upstreamVaultId: id,
        name: 'Research notes',
        changed: true,
      })
      expect(await named.serverIdentity()).toEqual({ upstreamVaultId: id, name: 'Research notes' })
      // The connected app's next sync (whoami) renames its connection; nothing to reconnect.
      const held = fixtures.native.readConnections(connections).find((c) => c.id === joined.id)!
      const synced = await fixtures.serverStore.followServer(connections, { ...held, endpoint: named.endpoint })
      expect(synced.error).toBeUndefined()
      expect(synced.name).toBe('Research notes')
      expect((await fixtures.native.refreshConnectionNames(connections)).find((c) => c.id === joined.id)?.name).toBe(
        'Research notes'
      )
      // A new device redeems under the new name.
      const issuedAt = new Date().toISOString()
      const link = await named.issueAppLink({
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS).toISOString(),
      })
      const device = await fixtures.native.connectInvite(
        join(root, 'device.json'),
        `${named.endpoint}/invite#${link.secret}`
      )
      expect([device.name, device.identity.vault.id]).toEqual(['Research notes', id])

      // Upgrade repair of a vault still on upstream's default: same procedure, same id.
      expect(await legacy.rename('Beta')).toMatchObject({ upstreamVaultId: legacy.identity.vault.id, changed: true })
      const repaired = await fixtures.native.connectInvite(
        join(root, 'legacy.json'),
        legacy.invite.replace(/^http:\/\/127\.0\.0\.1:\d+/, legacy.endpoint)
      )
      expect([repaired.name, repaired.identity.vault.id]).toEqual(['Beta', legacy.identity.vault.id])
    } finally {
      await fixtures?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)

/** Record two create intents in Core's store and let the reconciler apply them through a fixture
 * helper that starts a real native vault server per create and answers with its receipt. */
async function createdThroughReconciler(fixtures: Awaited<ReturnType<typeof nativeFixtures>>, owners: string[]) {
  const host = {
    contractVersion: 1 as const,
    tenantId: randomUUID(),
    physicalHostBinding: randomUUID(),
    hostEpoch: 1,
    hostState: 'active' as const,
    upstreamCommit: pin,
    artifactDigest: fixtures.provenance.digest,
    zone: 'example.com',
    tenantLabel: 'acme',
    limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
    effect: null,
  }
  // Both hostname forms end to end: A is a new tenant-prefixed vault (acme-bb-<12 hex>), B keeps
  // the bb-<32 hex> form an existing vault was created with.
  const origin = (id: string) =>
    managedBigbrainVaultOrigin({ vaultId: id, zone: host.zone, tenantLabel: id === VAULT_A ? host.tenantLabel : null })
  expect(origin(VAULT_A)).toBe(`https://acme-bb-${VAULT_A.replaceAll('-', '').slice(0, 12)}.example.com`)
  await db.delete(managedBigbrainVaults).where(inArray(managedBigbrainVaults.id, [VAULT_A, VAULT_B]))
  for (const [vaultId, name] of [
    [VAULT_A, 'Alpha'],
    [VAULT_B, 'Beta'],
  ] as const) {
    const [user] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com` })
      .returning()
    owners.push(user!.id)
    await managedVaultStore.request({
      vaultId,
      requestId: randomUUID(),
      displayName: name,
      hostOwnerUserId: user!.id,
      ownerHandle: 'ada',
      ownerDisplay: 'Ada',
      actorUserId: user!.id,
      recipe: {
        origin: origin(vaultId),
        limits: host.limits,
        upstreamCommit: pin,
        artifactDigest: host.artifactDigest,
      },
    })
  }
  const started = new Map<string, Awaited<ReturnType<typeof fixtures.vault>>>()
  const dns: string[] = []
  const ours = new Set([VAULT_A, VAULT_B])
  const deps = {
    host: () => host,
    // Only this test's rows, whatever else the database holds.
    store: {
      ...managedVaultStore,
      due: async (now: Date, limit = 1) =>
        (await managedVaultStore.due(now, 100)).filter((row) => ours.has(row.id)).slice(0, limit),
    },
    platform: {
      ensureDns: (async (vaultId: string, expected: string) => {
        expect(expected).toBe(origin(vaultId))
        dns.push(vaultId)
      }) as never,
      deleteDns: async () => {},
    },
    hostClient: {
      call: (async (_host: unknown, requestId: string, call: ManagedHostCall) => {
        if (call.action !== 'create') throw new ManagedHostError('invalid_request', false)
        expect([call.expectedGeneration, call.generation, call.origin]).toEqual([0, 1, origin(call.vaultId)])
        // The host's create writes the Ficus name before the first serve (vault-name.ts).
        const vault = await fixtures.vault(call.vaultId === VAULT_A ? 'a' : 'b', { serverName: call.displayName })
        started.set(call.vaultId, vault)
        return {
          contractVersion: 1,
          requestId,
          ok: true,
          action: 'create',
          physicalHostBinding: host.physicalHostBinding,
          receipt: {
            receiptId: randomUUID(),
            tenantId: host.tenantId,
            physicalHostBinding: host.physicalHostBinding,
            vaultId: call.vaultId,
            hostEpoch: host.hostEpoch,
            generation: 1,
            upstreamVaultId: vault.identity.vault.id,
            displayName: call.displayName,
            state: 'ready',
            upstreamCommit: pin,
            artifactDigest: host.artifactDigest,
            localPort: null,
            origin: call.origin,
            readAccess: 'active',
          },
        }
      }) as never,
    },
  }
  const later = () => new Date(Date.now() + 60_000)
  expect(await reconcileNext({ ...deps, now: later })).toBe('applied')
  expect(await reconcileNext({ ...deps, now: later })).toBe('applied')
  expect(await reconcileNext({ ...deps, now: later })).toBe('idle')
  expect(dns.sort()).toEqual([VAULT_A, VAULT_B])
  for (const vaultId of [VAULT_A, VAULT_B])
    expect(await managedVaultStore.get(vaultId)).toMatchObject({
      state: 'ready',
      readAccess: 'active',
      appliedGeneration: 1,
      desiredAction: null,
      upstreamVaultId: started.get(vaultId)!.identity.vault.id,
      origin: origin(vaultId),
    })
  return { a: started.get(VAULT_A)!, b: started.get(VAULT_B)! }
}

/** Core's shared tools over real clients, with an in-memory assignment/store in front of them. */
function sharedToolsOver(vaults: { vaultId: string; name: string; client: BigbrainSharedClient }[]) {
  const now = new Date()
  const rows = new Map(
    vaults.map((v) => {
      const upstreamVaultId = randomUUID()
      return [
        v.vaultId,
        {
          id: v.vaultId,
          displayName: v.name,
          connectionId: `connection-${v.vaultId}`,
          upstreamVaultId,
          state: 'ready',
          readAccess: 'active',
          // Token-free imported material (the real client already holds the real token).
          readMaterial: {
            contractVersion: 1,
            tenantId: randomUUID(),
            physicalHostBinding: randomUUID(),
            vaultId: v.vaultId,
            hostEpoch: 1,
            generation: 1,
            upstreamVaultId,
            upstreamCommit: pin,
            artifactDigest: `sha256:${'0'.repeat(64)}`,
            credentialId: '00000000',
            kind: 'agent',
            scopes: ['read'],
            followsMember: false,
          },
        } as unknown as ManagedVault,
      ] as const
    })
  )
  const connection = (id: string) => {
    const row = [...rows.values()].find((r) => r.connectionId === id)
    return row
      ? {
          id,
          squadId: 'squad',
          providerKey: 'bigbrain',
          adapterVersion: 2,
          clientAuthority: 'local' as const,
          authorizationFlowId: null,
          displayName: row.displayName,
          configuration: {
            version: 2,
            mode: 'managed_shared',
            vaultId: row.id,
            upstreamVaultId: row.upstreamVaultId,
            upstreamCommit: pin,
          },
          credentialRef: `ref:${id}`,
          materialRevision: 'r',
          validatedRevision: 'r',
          enabled: true,
          authState: 'authenticated' as const,
          healthState: 'healthy' as const,
          grantedScopes: ['read'],
          validatedAt: now,
          validationExpiresAt: new Date(now.getTime() + 60_000),
          lastErrorCode: null,
          updatedAt: now,
        }
      : null
  }
  const gate = new IntegrationRuntimeGate({
    currentAuthority: () => 'local',
    repository: {
      getAssigned: async () => null,
      getAssignedById: async (_squad, _provider, id) => connection(id),
    },
    supportedAdapterVersion: () => 2,
    supportedConfigVersion: () => 2,
  })
  const tools = createSharedBigbrainTools({
    agent: {
      id: 'agent',
      squadId: 'squad',
      integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
    },
    squadId: 'squad',
    gate,
    credentials: { get: () => 'token-held-by-the-real-client', set: async () => {}, delete: async () => {} },
    connections: { disableRuntimeAuthFailure: async () => true } as never,
    audit: { record: async () => {} } as never,
    assignments: { listAssigned: async () => [...rows.values()].map((r) => ({ id: r.connectionId! })) },
    store: {
      get: async (id) => rows.get(id) ?? null,
      getByConnection: async (id) => [...rows.values()].find((r) => r.connectionId === id) ?? null,
    },
    resolveClient: (async (input: { configuration: { vaultId: string } }) => ({
      client: vaults.find((v) => v.vaultId === input.configuration.vaultId)!.client,
      vault: rows.get(input.configuration.vaultId)!,
    })) as never,
  })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  return {
    run: async (name: string, input: unknown) =>
      (await byName[name]!.execute('call', input as never, undefined as never, undefined as never, undefined as never))
        .details as Record<string, unknown>,
  }
}
