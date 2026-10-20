import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BigbrainSharedClient } from './shared-client'
import { createSharedBigbrainTools } from './shared-tools'
import { IntegrationRuntimeGate } from '../runtime-gate'
import type { ManagedVault } from './managed/store'
import { nativeFixtures } from '../../../../../../scripts/bigbrain/native-fixtures'
import {
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin,
  MANAGED_BIGBRAIN_OWNER_INVITE_TTL_MS,
} from '@ficus/shared/managed-bigbrain'
import { cachedOwnerAppLink, ownerInviteCacheSchema } from '../../../../../../scripts/bigbrain/invite-cache'
import { writePrivateJson } from '../../../../../../scripts/bigbrain/secure-files'

const artifact = process.env.FICUS_BIGBRAIN_SHARED_ARTIFACT
const nativeDeps = process.env.FICUS_BIGBRAIN_SHARED_DEPS
const required = process.env.FICUS_BIGBRAIN_REQUIRE_SHARED_SMOKE === '1'
/** Wire-level evidence only until the management/helper/gateway/tool path is added.
 * No TLS/UID/mount/cgroup claim: this runs unprivileged owned synthetic processes.
 * CI's required lane fails on missing artifacts rather than accepting a skip.
 */
test.skipIf(!artifact && !required)(
  'real two-vault native client writes -> read-only Ficus adapter, revoke and crash persistence',
  async () => {
    if (!artifact || !nativeDeps) throw new Error('Required pinned shared artifact/dependencies are missing')
    const root = await mkdtemp(join(tmpdir(), 'ficus-bigbrain-shared-smoke-'))
    let fixtures: Awaited<ReturnType<typeof nativeFixtures>> | undefined
    try {
      fixtures = await nativeFixtures(root, artifact, nativeDeps)
      expect(fixtures.provenance.upstreamCommit).toBe(pin)
      const a = await fixtures.vault('a')
      const b = await fixtures.vault('b')
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
            limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
            observedAt: new Date().toISOString(),
          },
          material,
          vault: {
            vaultId,
            upstreamVaultId: material.upstreamVaultId,
            origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
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
      await fixtures?.dispose()
      await rm(root, { recursive: true, force: true })
    }
    // Two compiled serving processes, real invitation redemption and 12+ CLI operations.
  },
  60000
)

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
