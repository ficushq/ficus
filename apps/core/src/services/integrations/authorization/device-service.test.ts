import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { describe, expect, test } from 'bun:test'
import { GitHubOAuthError, type GitHubDevicePoll } from '@ficus/shared/oauth-providers/github/client'
import {
  DeviceAuthorizationService,
  type DeviceAuthorizationDependencies,
  type DeviceAuthorizationRecord,
} from './device-service'
import type { AuthorizationFlowReceipt } from './flow-repository'
import type { OAuthCredentialBundleV1 } from './credential-bundle'

function harness() {
  let now = new Date('2026-09-07T12:00:00.000Z')
  let record: DeviceAuthorizationRecord | null = null
  let credential: OAuthCredentialBundleV1 | undefined
  const calls: string[] = []
  const outcomes: GitHubDevicePoll[] = []
  let profileFailure = false
  const id = 'a0000000-0000-4000-8000-000000000001'
  const receipt: AuthorizationFlowReceipt = {
    localFlowId: id,
    providerKey: 'github',
    authority: 'local',
    intent: 'connect',
    initiatingUserId: 'user',
    returnTo: '/settings/integrations',
    completionHandleHash: 'a'.repeat(64),
    adapterVersion: null,
    sourceConnectionId: null,
    sourceMaterialRevision: null,
    artifactCredentialRef: 'artifact',
    stagingStartedAt: null,
    installKind: null,
    installedConnectionId: null,
    installedMaterialRevision: null,
    installedAt: null,
    terminalCode: null,
    terminalAt: null,
    revocationRequiredAt: null,
    revocationSettledAt: null,
    cleanupRequiredAt: null,
    cleanupSettledAt: null,
    recoveryExpiresAt: new Date(now.getTime() + 900_000),
    retainUntil: new Date(now.getTime() + 86_400_000),
  }
  const dependencies: DeviceAuthorizationDependencies = {
    now: () => now,
    uuid: () => id,
    requireLocal() {},
    resolveClient: () => ({ clientId: 'public' }),
    lease: { runExclusive: async (_key, operation) => operation() },
    receipts: {
      get: async () => receipt,
      getRecoverable: async () => receipt,
      beginStaging: async () => receipt,
      markTerminal: async (_id, code) => {
        receipt.terminalAt = now
        receipt.terminalCode = code
        return receipt
      },
      requireRevocation: async ({ code }) => {
        calls.push('revoke')
        receipt.terminalAt = now
        receipt.terminalCode = code
        receipt.revocationRequiredAt = now
        return receipt
      },
      requireCleanup: async () => receipt,
    },
    repository: {
      create: async (input) => {
        record = {
          id,
          userId: input.userId,
          clientBinding: input.clientBinding,
          deviceCode: input.device.deviceCode,
          status: 'pending',
          intervalSeconds: input.device.interval,
          nextPollAt: new Date(now.getTime() + 5000),
          expiresAt: receipt.recoveryExpiresAt,
          receipt,
        }
        return { expiresAt: record.expiresAt }
      },
      get: async (_id, userId) => (userId === record?.userId ? record : null),
      defer: async (_id, intervalSeconds) => {
        record!.intervalSeconds = intervalSeconds
        record!.nextPollAt = new Date(now.getTime() + intervalSeconds * 1000)
      },
      stage: async (_record, next) => {
        calls.push('stage')
        credential = next
        record!.status = 'authorized'
        record!.deviceCode = null
        receipt.stagingStartedAt = now
        receipt.adapterVersion = 1
        receipt.recoveryExpiresAt = new Date(now.getTime() + 900_000)
      },
      credential: async () => credential!,
      remove: async () => {
        record = null
      },
    },
    client: {
      startDevice: async () => {
        calls.push('start')
        return {
          deviceCode: 'SECRET_DEVICE',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 900,
          interval: 5,
        }
      },
      pollDevice: async () => {
        calls.push('poll')
        return outcomes.shift() ?? { status: 'pending' }
      },
      currentUser: async () => {
        calls.push('profile')
        if (profileFailure) throw new GitHubOAuthError('provider_unavailable')
        return { version: 1, userId: 123, login: 'octocat' }
      },
    },
    install: async ({ grant }) => {
      calls.push('install')
      expect(grant.credential).toBe(credential!)
      receipt.installKind = 'connect'
      receipt.installedAt = now
      receipt.installedConnectionId = 'connection'
    },
  }
  return {
    id,
    calls,
    outcomes,
    dependencies,
    receipt,
    service: new DeviceAuthorizationService(dependencies),
    advance(seconds: number) {
      now = new Date(now.getTime() + seconds * 1000)
    },
    profileFails(value: boolean) {
      profileFailure = value
    },
  }
}

const authorized: GitHubDevicePoll = {
  status: 'authorized',
  tokens: { accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH', expiresAt: '2026-09-07T20:00:00.000Z' },
}
const start = { userId: 'user', returnTo: '/settings/integrations' }

describe('device authorization coordination', () => {
  test('only the public verification fields reach the start response', async () => {
    const h = harness()
    const result = await h.service.start(start)
    expect(result).toMatchObject({
      kind: 'device',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  test('another user cannot poll or cancel even knowing the authorization ID', async () => {
    const h = harness()
    await h.service.start(start)
    h.advance(5)
    await expect(h.service.poll({ id: h.id, userId: 'other' })).rejects.toThrow('invalid_or_expired_state')
    await expect(h.service.cancel({ id: h.id, userId: 'other' })).rejects.toThrow('invalid_or_expired_state')
    expect(h.calls).toEqual(['start'])
  })

  test('persisted deadlines throttle polls across service restarts', async () => {
    const h = harness()
    await h.service.start(start)
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'pending', retryAfterSeconds: 5 })
    h.advance(5)
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'pending', retryAfterSeconds: 5 })
    const restarted = new DeviceAuthorizationService(h.dependencies)
    expect(await restarted.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'pending', retryAfterSeconds: 5 })
    expect(h.calls.filter((call) => call === 'poll')).toHaveLength(1)
  })

  test('slow_down increases the persisted minimum even if the supplied interval is smaller', async () => {
    const h = harness()
    await h.service.start(start)
    h.advance(5)
    h.outcomes.push({ status: 'slow_down', interval: 3 })
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'pending', retryAfterSeconds: 10 })
    h.advance(9)
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'pending', retryAfterSeconds: 1 })
    expect(h.calls.filter((call) => call === 'poll')).toHaveLength(1)
  })

  test('saves the grant before profile lookup and resumes without exchanging twice', async () => {
    const h = harness()
    await h.service.start(start)
    h.advance(5)
    h.outcomes.push(authorized)
    h.profileFails(true)
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'pending', retryAfterSeconds: 5 })
    expect(h.calls).toEqual(['start', 'poll', 'stage', 'profile'])
    h.profileFails(false)
    const restarted = new DeviceAuthorizationService(h.dependencies)
    expect(await restarted.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'complete', returnTo: start.returnTo })
    expect(h.calls).toEqual(['start', 'poll', 'stage', 'profile', 'profile', 'install'])
    expect(await restarted.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'complete', returnTo: start.returnTo })
    expect(h.calls.filter((call) => call === 'install')).toHaveLength(1)
  })

  test('expiry makes no external request', async () => {
    const h = harness()
    await h.service.start(start)
    h.advance(900)
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'failed', code: 'flow_expired' })
    expect(h.calls).toEqual(['start'])
  })

  test('cancelling a staged grant leaves a durable revocation obligation', async () => {
    const h = harness()
    await h.service.start(start)
    h.advance(5)
    h.outcomes.push(authorized)
    h.profileFails(true)
    await h.service.poll({ id: h.id, userId: 'user' })
    await h.service.cancel({ id: h.id, userId: 'user' })
    expect(h.calls).toEqual(['start', 'poll', 'stage', 'profile', 'revoke'])
    expect(h.receipt.revocationRequiredAt).not.toBeNull()
  })

  test('an expired staged grant cannot extend its recovery window indefinitely', async () => {
    const h = harness()
    await h.service.start(start)
    h.advance(5)
    h.outcomes.push(authorized)
    h.profileFails(true)
    await h.service.poll({ id: h.id, userId: 'user' })
    h.advance(900)
    expect(await h.service.poll({ id: h.id, userId: 'user' })).toEqual({ status: 'failed', code: 'flow_expired' })
    expect(h.calls).toEqual(['start', 'poll', 'stage', 'profile', 'revoke'])
  })

  test('hosted deployment cannot fall back to the public local client', async () => {
    const h = harness()
    h.dependencies.requireLocal = () => {
      throw new Error('client_authority_mismatch')
    }
    await expect(h.service.start(start)).rejects.toThrow('client_authority_mismatch')
    expect(h.calls).toEqual([])
  })
})

test('database device authorization encrypts the code and atomically replaces it with a recoverable grant', async () => {
  const { db, users, integrationDeviceAuthorizations, integrationAuthorizationFlowReceipts } =
    await import('../../../db')
  const { eq } = await import('drizzle-orm')
  const { createTestGitHubConnection } = await import('../../../test-utils/github-connection')
  const { DbDeviceAuthorizationRepository } = await import('./db-device-repository')
  const { getSecretStore } = await import('../../secrets')
  const fixture = await createTestGitHubConnection()
  const id = crypto.randomUUID(),
    userId = crypto.randomUUID()
  const repository = new DbDeviceAuthorizationRepository()
  try {
    await db.insert(users).values({ id: userId, email: `${userId}@example.test` })
    await repository.create({
      id,
      userId,
      connectionId: null,
      expectedMaterialRevision: null,
      returnTo: '/settings',
      clientBinding: { clientId: 'public-app' },
      device: {
        deviceCode: 'PRIVATE-DEVICE-CODE',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      },
    })
    const [stored] = await db
      .select()
      .from(integrationDeviceAuthorizations)
      .where(eq(integrationDeviceAuthorizations.id, id))
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-DEVICE-CODE')
    expect(await repository.get(id, crypto.randomUUID())).toBeNull()
    const record = (await repository.get(id, userId))!
    expect(record.deviceCode).toBe('PRIVATE-DEVICE-CODE')
    const credential: OAuthCredentialBundleV1 = {
      version: 1,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: null,
      tokenRevision: 1,
      clientBinding: record.clientBinding,
    }
    await repository.stage(record, credential)
    const authorized = (await repository.get(id, userId))!
    expect(authorized.deviceCode).toBeNull()
    expect(authorized.status).toBe('authorized')
    expect(authorized.receipt.stagingStartedAt).not.toBeNull()
    expect(await repository.credential(authorized)).toEqual(credential)
    await expect(repository.stage(record, { ...credential, accessToken: 'wrong' })).rejects.toThrow(
      'Device authorization changed'
    )
    expect((await repository.credential(authorized)).accessToken).toBe('new-access')
  } finally {
    await repository.remove(id)
    await db
      .delete(integrationAuthorizationFlowReceipts)
      .where(eq(integrationAuthorizationFlowReceipts.localFlowId, id))
    await getSecretStore().delete(`__integration-credential:authorization-flow:${id}:bearer`)
    await db.delete(users).where(eq(users.id, userId))
    await fixture.dispose()
  }
})
