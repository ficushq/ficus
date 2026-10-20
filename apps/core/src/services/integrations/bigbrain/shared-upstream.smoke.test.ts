import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BigbrainSharedClient } from './shared-client'
import { nativeFixtures } from '../../../../../../scripts/bigbrain/native-fixtures'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT as pin } from '@ficus/shared/managed-bigbrain'

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
      const connections = join(root, 'native-connections.json')
      const joinedA = await fixtures.native.connectInvite(connections, a.invite)
      const joinedB = await fixtures.native.connectInvite(connections, b.invite)
      const ownerA = fixtures.native.readConnections(connections).find((c) => c.id === joinedA.id)!
      const ownerB = fixtures.native.readConnections(connections).find((c) => c.id === joinedB.id)!
      expect(ownerA.id).not.toBe(ownerB.id)
      expect(joinedA.identity.vault.id).toBe(a.identity.vault.id)
      await expect(fixtures.native.connectInvite(connections, a.invite)).rejects.toBeDefined()
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
          authority: binding,
          installed: binding,
          material,
          receipt: {
            ...binding,
            receiptId: randomUUID(),
            vaultId,
            generation: 1,
            upstreamVaultId: material.upstreamVaultId,
            upstreamCommit: pin,
            artifactDigest: material.artifactDigest,
            state: 'ready',
            readAccess: 'active',
            localPort: 30000,
            origin: `https://bb-${vaultId.replaceAll('-', '')}.example.com`,
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
