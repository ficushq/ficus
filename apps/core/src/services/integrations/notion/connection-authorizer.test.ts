import { describe, expect, test } from 'bun:test'
import type { OAuthStateRecord } from '../authorization/state-repository'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { NotionConnectionAuthorizer } from './connection-authorizer'
import { IntegrationConnectionCreateCommittedError } from '../connection-service'
import { createNotionPlugin } from './plugin'
import { ConnectionAuthorizationLease } from '../authorization/connection-lease'
import type { AuthorizationFlowReceipt } from '../authorization/flow-repository'
import type { IntegrationConnectionRecord } from '../connection-repository'

function integrationRecord(overrides: Partial<IntegrationConnectionRecord> = {}): IntegrationConnectionRecord {
  return {
    id: 'new-connection',
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'platform_broker',
    authorizationFlowId: null,
    displayName: 'Workspace',
    configuration: {
      version: 1,
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      workspaceIcon: null,
      botId: 'bot-1',
    },
    credentialRef: 'flow-credential-ref',
    materialRevision: 'flow-material-revision',
    validatedRevision: null,
    enabled: false,
    authState: 'pending',
    healthState: 'unknown',
    grantedScopes: [],
    validatedAt: null,
    validationExpiresAt: null,
    lastErrorCode: null,
    updatedAt: new Date(),
    ...overrides,
  }
}

const grant = {
  configuration: {
    version: 1 as const,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    workspaceIcon: null,
    botId: 'bot-1',
  },
  credential: {
    version: 1 as const,
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
    expiresAt: null,
    tokenRevision: 1,
  },
  displayName: 'Workspace',
}

function reconnectIntent(): OAuthStateRecord {
  return {
    stateHash: 'hash',
    localFlowId: null,
    authority: 'local',
    completionHandleHash: null,
    recoveryExpiresAt: null,
    providerKey: 'notion',
    userId: 'user-1',
    intent: 'reconnect',
    connectionId: '90000000-0000-4000-8000-000000000001',
    expectedMaterialRevision: '90000000-0000-4000-8000-000000000002',
    redirectUri: 'https://ficus.example/callback',
    returnTo: '/settings/integrations',
    expiresAt: new Date(),
    createdAt: new Date(),
  }
}

function harness(
  options: {
    resolveIdentity?: (staged: Map<string, string>) => Promise<typeof grant.configuration>
    targetWorkspace?: string
    targetConfiguration?: unknown
    installStatus?: 'updated' | 'changed'
    validationOk?: boolean
    reprojectFails?: boolean
    revokeFails?: boolean
    authority?: 'local' | 'platform_broker'
    lease?: { runExclusiveMany<T>(resources: readonly string[], operation: () => Promise<T>): Promise<T> }
    resumeFails?: boolean
    installCommitsThenThrows?: boolean
    createFails?: boolean
    createCommitsThenThrows?: boolean
    createPostCommitFails?: boolean
    removeFails?: boolean
    removeCommitsThenThrows?: boolean
    deleteFails?: boolean
    enqueueFails?: boolean
    enqueueCommitsThenThrows?: boolean
    createCleanupFails?: boolean
    enableCommitsThenThrows?: boolean
    enableFailsBeforeCommit?: boolean
    setCommitsThenThrows?: boolean
    stageCommitsThenThrows?: boolean
    stagingExpired?: boolean
    isStagingExpired?: () => boolean
  } = {}
) {
  const staged = new Map<string, string>()
  let setAcknowledgementsLost = 0
  const deleted: string[] = []
  const revoked: string[] = []
  const creates: unknown[] = []
  const queuedRevocations: Array<{ credentialRef: string; clientAuthority: string }> = []
  const installInputs: unknown[] = []
  const enabled: string[] = []
  const enabledFlows: Array<string | undefined> = []
  const validated: string[] = []
  const removed: string[] = []
  const flowConnections = new Map<string, IntegrationConnectionRecord>()
  const receipts = new Map<string, AuthorizationFlowReceipt>()
  const receiptFor = (localFlowId: string): AuthorizationFlowReceipt => {
    let receipt = receipts.get(localFlowId)
    if (!receipt) {
      receipt = {
        localFlowId,
        providerKey: 'notion',
        authority: options.authority ?? 'local',
        intent: 'connect',
        initiatingUserId: 'user-1',
        returnTo: '/settings/integrations',
        completionHandleHash: 'a'.repeat(64),
        adapterVersion: null,
        sourceConnectionId: null,
        sourceMaterialRevision: null,
        artifactCredentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
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
        recoveryExpiresAt: new Date('2026-08-30T00:00:00.000Z'),
        retainUntil: new Date('2026-08-30T00:00:00.000Z'),
      }
      receipts.set(localFlowId, receipt)
    }
    return receipt
  }
  const target = integrationRecord({
    id: '90000000-0000-4000-8000-000000000001',
    providerKey: 'notion',
    adapterVersion: 1,
    displayName: 'Workspace',
    configuration: options.targetConfiguration ?? {
      version: 1,
      workspaceId: options.targetWorkspace ?? 'workspace-1',
      workspaceName: 'Old',
      workspaceIcon: null,
      botId: 'bot-old',
    },
    credentialRef: 'old-ref',
    materialRevision: '90000000-0000-4000-8000-000000000002',
    authorizationFlowId: null,
    clientAuthority: 'local',
    validatedRevision: '90000000-0000-4000-8000-000000000002',
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    grantedScopes: [],
    validatedAt: new Date(),
    validationExpiresAt: new Date(Date.now() + 60_000),
    lastErrorCode: null,
  })
  const plugin = createNotionPlugin({
    currentBot: async () =>
      options.validationOk === false ? { botId: 'different' } : { botId: grant.configuration.botId },
  })
  if (options.resolveIdentity)
    plugin.authorization.resolveGrantIdentity = async () => ({
      configuration: await options.resolveIdentity!(staged),
      displayName: 'Workspace',
    })
  const authorizer = new NotionConnectionAuthorizer({
    repository: {
      get: async () => target,
      getByAuthorizationFlow: async (localFlowId) => flowConnections.get(localFlowId) ?? null,
      list: async () => [target, ...flowConnections.values()],
      installAuthorizedMaterial: async (input) => {
        installInputs.push(input)
        if ((options.installStatus ?? 'updated') === 'updated') {
          target.authorizationFlowId = input.authorizationFlowId ?? null
          target.materialRevision = input.materialRevision
          target.credentialRef = input.credentialRef
          target.clientAuthority = input.clientAuthority
          if (input.adoptStagedRevocationRef) {
            const index = queuedRevocations.findIndex((job) => job.credentialRef === input.credentialRef)
            if (index >= 0) queuedRevocations.splice(index, 1)
          }
          if (input.authorizationFlowId) {
            flowConnections.set(input.authorizationFlowId, target)
            Object.assign(receiptFor(input.authorizationFlowId), {
              installKind: 'reconnect_same',
              installedConnectionId: target.id,
              installedMaterialRevision: input.materialRevision,
              installedAt: new Date(),
            })
          }
        }
        if (options.installCommitsThenThrows) throw new Error('commit acknowledgement lost')
        return { status: options.installStatus ?? 'updated' }
      },
      enqueueRevocation: async (input) => {
        if (options.enqueueCommitsThenThrows) {
          queuedRevocations.push(input)
          throw new Error('revocation enqueue acknowledgement lost')
        }
        if (options.enqueueFails) throw new Error('revocation enqueue failed')
        queuedRevocations.push(input)
      },
      ownsRevocation: async (input) =>
        queuedRevocations.some(
          (job) => job.credentialRef === input.credentialRef && job.clientAuthority === input.clientAuthority
        ),
      abandonPendingAuthorization: async ({ id, localFlowId }) => {
        const row = flowConnections.get(localFlowId)
        if (!row || row.id !== id) return 'not_found'
        if (options.removeFails) return 'changed'
        flowConnections.delete(localFlowId)
        Object.assign(receiptFor(localFlowId), {
          terminalCode: 'grant_abandoned',
          terminalAt: new Date(),
          revocationRequiredAt: new Date(),
        })
        queuedRevocations.push({
          credentialRef: receiptFor(localFlowId).artifactCredentialRef,
          clientAuthority: options.authority ?? 'local',
        })
        if (options.removeCommitsThenThrows) throw new Error('remove acknowledgement lost')
        return 'updated'
      },
    },
    stageRevocationArtifact: async (input) => {
      if (options.enqueueFails) throw new Error('revocation enqueue failed')
      staged.set(input.credentialRef, input.credential)
      queuedRevocations.push(input)
      if (options.stageCommitsThenThrows && setAcknowledgementsLost++ === 0) {
        throw new Error('artifact transaction acknowledgement lost')
      }
      if (options.enqueueCommitsThenThrows) throw new Error('revocation enqueue acknowledgement lost')
    },
    flowReceipts: {
      getRecoverable: async (localFlowId) => receiptFor(localFlowId),
      get: async (localFlowId, binding) => {
        const receipt = receiptFor(localFlowId)
        if (binding) {
          Object.assign(receipt, {
            providerKey: binding.providerKey,
            authority: binding.authority,
            intent: binding.intent,
            initiatingUserId: binding.userId,
            sourceConnectionId: binding.connectionId,
            sourceMaterialRevision: binding.expectedMaterialRevision,
          })
        }
        return receipt
      },
      beginStaging: async (localFlowId, adapterVersion) => {
        const receipt = receiptFor(localFlowId)
        if ((options.stagingExpired || options.isStagingExpired?.()) && !receipt.stagingStartedAt) return null
        receipt.stagingStartedAt ??= new Date()
        receipt.adapterVersion ??= adapterVersion
        return receipt
      },
      markTerminal: async (localFlowId, code) => {
        const receipt = receiptFor(localFlowId)
        receipt.terminalCode ??= code
        receipt.terminalAt ??= new Date()
        return receipt
      },
      requireRevocation: async ({ localFlowId, code }) => {
        if (options.enqueueFails) throw new Error('revocation enqueue failed')
        const receipt = receiptFor(localFlowId)
        receipt.terminalCode ??= code
        receipt.terminalAt ??= new Date()
        receipt.revocationRequiredAt ??= new Date()
        if (!queuedRevocations.some((job) => job.credentialRef === receipt.artifactCredentialRef)) {
          queuedRevocations.push({
            credentialRef: receipt.artifactCredentialRef,
            clientAuthority: options.authority ?? 'local',
          })
        }
        if (options.enqueueCommitsThenThrows) throw new Error('revocation enqueue acknowledgement lost')
        return receipt
      },
      requireCleanup: async (localFlowId, code) => {
        const receipt = receiptFor(localFlowId)
        receipt.terminalCode ??= code
        receipt.terminalAt ??= new Date()
        receipt.cleanupRequiredAt ??= new Date()
        return receipt
      },
    },
    connectionService: {
      create: async (input) => {
        creates.push(input)
        if (options.createFails) throw new Error('connection insert failed')
        if (options.createCleanupFails) {
          throw Object.assign(new Error('staged cleanup failed'), { code: 'staged_credential_cleanup_failed' })
        }
        const created = {
          id: 'new-connection',
          providerKey: 'notion',
          adapterVersion: 1,
          clientAuthority: input.clientAuthority,
          authorizationFlowId: input.authorizationFlowId ?? null,
          displayName: input.displayName,
          enabled: false,
          authState: 'pending' as const,
        }
        if (input.authorizationFlowId) {
          flowConnections.set(
            input.authorizationFlowId,
            integrationRecord({
              ...created,
              configuration: input.configuration,
              credentialRef: receiptFor(input.authorizationFlowId).artifactCredentialRef,
              materialRevision: 'new-material-revision',
            })
          )
        }
        if (options.createCommitsThenThrows) throw new Error('create acknowledgement lost')
        if (options.createPostCommitFails) {
          throw new IntegrationConnectionCreateCommittedError(created.id, { cause: new Error('audit failed') })
        }
        return created
      },
      validate: async (id) => {
        validated.push(id)
        if (options.resumeFails) throw new Error('pending validation failed')
      },
      enable: async (id, _actor, authorizationFlowId) => {
        if (options.enableFailsBeforeCommit) throw new Error('enable failed before commit')
        enabled.push(id)
        const stagedCredentialRef =
          id === 'new-connection'
            ? (creates.at(-1) as { stagedCredentialRef?: string } | undefined)?.stagedCredentialRef
            : undefined
        if (stagedCredentialRef) {
          const stagedIndex = queuedRevocations.findIndex((job) => job.credentialRef === stagedCredentialRef)
          if (stagedIndex >= 0) queuedRevocations.splice(stagedIndex, 1)
        }
        enabledFlows.push(authorizationFlowId)
        const created = [...flowConnections.values()].find((row) => row.id === id)
        if (created) {
          created.enabled = true
          created.authState = 'authenticated'
          if (created.authorizationFlowId) {
            const receipt = receiptFor(created.authorizationFlowId)
            Object.assign(receipt, {
              installKind: receipt.intent === 'connect' ? 'connect' : 'reconnect_distinct',
              installedConnectionId: created.id,
              installedMaterialRevision: 'revision-1',
              installedAt: new Date(),
            })
          }
        }
        if (options.enableCommitsThenThrows) throw new Error('enable acknowledgement lost')
      },
      rollbackPendingLocal: async (id, credentialRef) => {
        removed.push(id)
        if (!queuedRevocations.some((job) => job.credentialRef === credentialRef)) {
          queuedRevocations.push({ credentialRef, clientAuthority: options.authority ?? 'local' })
        }
        for (const [flowId, row] of flowConnections) {
          if (row.id === id) flowConnections.delete(flowId)
        }
      },
      remove: async (id) => {
        if (options.removeFails) throw new Error('remove failed')
        removed.push(id)
        const stagedCredentialRef = (creates.at(-1) as { stagedCredentialRef?: string } | undefined)
          ?.stagedCredentialRef
        if (stagedCredentialRef && !queuedRevocations.some((job) => job.credentialRef === stagedCredentialRef)) {
          queuedRevocations.push({ credentialRef: stagedCredentialRef, clientAuthority: options.authority ?? 'local' })
        }
        for (const [flowId, row] of flowConnections) {
          if (row.id === id) flowConnections.delete(flowId)
        }
        if (options.removeCommitsThenThrows) throw new Error('remove acknowledgement lost')
      },
    },
    credentials: {
      set: async (key, value) => {
        staged.set(key, value)
        if (options.setCommitsThenThrows && setAcknowledgementsLost++ === 0) {
          throw new Error('secret write acknowledgement lost')
        }
      },
      delete: async (key) => {
        if (options.deleteFails) throw new Error('secret delete failed')
        staged.delete(key)
        deleted.push(key)
      },
    },
    plugin,
    transport: {
      authority: options.authority ?? 'local',
      revoke: async ({ token }) => {
        revoked.push(token)
        if (options.revokeFails) throw new Error('provider unavailable')
      },
    },
    uuid: (() => {
      let value = 0
      return () => `revision-${++value}`
    })(),
    reproject: async () => {
      if (options.reprojectFails) throw new Error('env write failed')
    },
    lease:
      options.lease ??
      ({
        runExclusiveMany: async <T>(_resources: readonly string[], operation: () => Promise<T>): Promise<T> =>
          operation(),
      } as const),
  })
  return {
    authorizer,
    staged,
    deleted,
    revoked,
    creates,
    queuedRevocations,
    installInputs,
    enabled,
    enabledFlows,
    validated,
    removed,
    flowConnections,
    receipts,
    receiptFor,
    target,
  }
}

describe('NotionConnectionAuthorizer', () => {
  test('provider-neutral identity resolution has durable cleanup ownership before a failed profile request', async () => {
    const h = harness({
      resolveIdentity: async (staged) => {
        expect([...staged.values()][0]).toContain('refresh-new')
        throw new Error('profile unavailable')
      },
    })
    await expect(
      h.authorizer.install({
        intent: { ...reconnectIntent(), intent: 'connect', connectionId: null, expectedMaterialRevision: null },
        userId: 'user-1',
        exchange: async () => ({ ...grant, configuration: null }),
      })
    ).rejects.toThrow('profile unavailable')
    expect(h.queuedRevocations).toHaveLength(1)
    expect(h.creates).toEqual([])
  })

  test('same-workspace reconnect stamps the selected client authority', async () => {
    const { authorizer, staged, creates, installInputs } = harness({ authority: 'platform_broker' })
    await authorizer.install({
      grant,
      intent: { ...reconnectIntent(), authority: 'platform_broker', localFlowId: crypto.randomUUID() },
      userId: 'user-1',
    })
    expect(creates).toEqual([])
    expect(staged.size).toBe(1)
    expect([...staged.values()]).toEqual([serializeOAuthCredential(grant.credential)])
    expect(installInputs).toEqual([expect.objectContaining({ clientAuthority: 'platform_broker' })])
  })

  test('brokered connect retries reuse one authorization flow connection without revoking the winner', async () => {
    const { authorizer, creates, enabled, revoked } = harness({ authority: 'platform_broker' })
    const intent = {
      ...reconnectIntent(),
      intent: 'connect' as const,
      connectionId: null,
      expectedMaterialRevision: null,
      authority: 'platform_broker' as const,
      localFlowId: '80000000-0000-4000-8000-000000000099',
    }
    await authorizer.install({ grant, intent, userId: 'user-1' })
    await authorizer.install({ grant, intent, userId: 'user-1' })
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({
      authorizationFlowId: intent.localFlowId,
      displayName: 'Workspace (2)',
    })
    expect(enabled).toEqual(['new-connection'])
    expect(revoked).toEqual([])
  })

  test('brokered connect recovers when create commits before losing its acknowledgement', async () => {
    const { authorizer, creates, enabled, revoked, staged } = harness({
      authority: 'platform_broker',
      createCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    await authorizer.install({
      grant,
      intent: {
        ...reconnectIntent(),
        intent: 'connect',
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker',
        localFlowId,
      },
      userId: 'user-1',
    })
    expect(creates).toHaveLength(1)
    expect(enabled).toEqual(['new-connection'])
    expect(revoked).toEqual([])
    expect(staged.size).toBe(1)
  })

  test('initial deterministic secret acknowledgement loss reuses one receipt-owned artifact', async () => {
    const { authorizer, creates, staged } = harness({
      authority: 'platform_broker',
      setCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    const input = {
      grant,
      intent: {
        ...reconnectIntent(),
        intent: 'connect' as const,
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker' as const,
        localFlowId,
      },
      userId: 'user-1',
    }
    await expect(authorizer.install(input)).rejects.toThrow('secret write acknowledgement lost')
    expect(await authorizer.install(input)).toBeUndefined()
    expect(creates).toHaveLength(1)
    expect([...staged.keys()]).toEqual([`__integration-credential:authorization-flow:${localFlowId}:bearer`])
  })

  test('fresh connect enable acknowledgement loss preserves the installed receipt winner', async () => {
    const { authorizer, receipts, enabledFlows, removed, queuedRevocations } = harness({
      authority: 'platform_broker',
      enableCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    await authorizer.install({
      grant,
      intent: {
        ...reconnectIntent(),
        intent: 'connect',
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker',
        localFlowId,
      },
      userId: 'user-1',
    })
    expect(receipts.get(localFlowId)).toMatchObject({
      installKind: 'connect',
      installedConnectionId: 'new-connection',
    })
    expect(enabledFlows).toEqual([localFlowId])
    expect(removed).toEqual([])
    expect(queuedRevocations).toEqual([])
  })

  test('connect cleanup failure retains the flow and never revokes the staged grant', async () => {
    const { authorizer, revoked } = harness({ authority: 'platform_broker', createCleanupFails: true })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    const error = await authorizer
      .install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
      .catch((value) => value)
    expect(error).toMatchObject({ code: 'staged_credential_cleanup_failed' })
    expect(revoked).toEqual([])
  })

  test('concurrent brokered connect installs serialize on the database flow lock', async () => {
    const { authorizer, creates, revoked } = harness({
      authority: 'platform_broker',
      lease: new ConnectionAuthorizationLease({ acquireTimeoutMs: 5_000 }),
    })
    const intent = {
      ...reconnectIntent(),
      intent: 'connect' as const,
      connectionId: null,
      expectedMaterialRevision: null,
      authority: 'platform_broker' as const,
      localFlowId: '80000000-0000-4000-8000-000000000099',
    }
    await Promise.all([
      authorizer.install({ grant, intent, userId: 'user-1' }),
      authorizer.install({ grant, intent, userId: 'user-1' }),
    ])
    expect(creates).toHaveLength(1)
    expect(revoked).toEqual([])
  })

  test('pending brokered connect resumes validation instead of creating another connection', async () => {
    const { authorizer, flowConnections, creates, validated, enabled } = harness({ authority: 'platform_broker' })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: localFlowId,
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'pending',
      })
    )
    await authorizer.install({
      grant,
      intent: {
        ...reconnectIntent(),
        intent: 'connect',
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker',
        localFlowId,
      },
      userId: 'user-1',
    })
    expect(creates).toEqual([])
    expect(validated).toEqual([localFlowId])
    expect(enabled).toEqual([localFlowId])
  })

  test('a pending resume queued past recovery expiry performs no validation or provider act', async () => {
    let expired = false
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    const { authorizer, flowConnections, validated } = harness({
      authority: 'platform_broker',
      isStagingExpired: () => expired,
      lease: {
        runExclusiveMany: async <T>(_resources: readonly string[], operation: () => Promise<T>): Promise<T> => {
          expired = true
          return operation()
        },
      },
    })
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: localFlowId,
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'pending',
      })
    )
    let brokerCalls = 0
    await expect(
      authorizer.install({
        exchange: async () => {
          brokerCalls += 1
          return grant
        },
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'flow_expired' })
    expect(validated).toEqual([])
    expect(brokerCalls).toBe(0)
  })

  test('pending resume enable acknowledgement loss preserves the installed receipt winner', async () => {
    const { authorizer, flowConnections, receipts, removed, queuedRevocations } = harness({
      authority: 'platform_broker',
      enableCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: 'pending-connection',
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'pending',
      })
    )
    await authorizer.install({
      grant,
      intent: {
        ...reconnectIntent(),
        intent: 'connect',
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker',
        localFlowId,
      },
      userId: 'user-1',
    })
    expect(receipts.get(localFlowId)).toMatchObject({
      installKind: 'connect',
      installedConnectionId: 'pending-connection',
    })
    expect(removed).toEqual([])
    expect(queuedRevocations).toEqual([])
  })

  test('failed pending-install resume abandons the marker for terminal flow burn', async () => {
    const { authorizer, flowConnections, removed } = harness({
      authority: 'platform_broker',
      resumeFails: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: 'pending-connection',
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'pending',
      })
    )
    const error = await authorizer
      .install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
      .catch((value) => value)
    expect(error).toMatchObject({ code: 'grant_abandoned', message: 'pending validation failed' })
    expect(removed).toEqual([])
  })

  test('pending resume removal failure retains recovery and never declares the grant abandoned', async () => {
    const { authorizer, flowConnections, revoked } = harness({
      authority: 'platform_broker',
      resumeFails: true,
      removeFails: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: 'pending-connection',
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'pending',
      })
    )
    const error = await authorizer
      .install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
      .catch((value) => value)
    expect(error).toEqual(new Error('Pending authorization cleanup failed'))
    expect(error).not.toHaveProperty('code')
    expect(flowConnections.has(localFlowId)).toBe(true)
    expect(revoked).toEqual([])
  })

  test('pending removal acknowledgement loss reconciles absence before declaring abandonment', async () => {
    const { authorizer, flowConnections, removed } = harness({
      authority: 'platform_broker',
      resumeFails: true,
      removeCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: 'pending-connection',
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'pending',
      })
    )
    const error = await authorizer
      .install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
      .catch((value) => value)
    expect(error).toEqual(new Error('remove acknowledgement lost'))
    expect(removed).toEqual([])
    expect(flowConnections.has(localFlowId)).toBe(false)
    await expect(
      authorizer.install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'grant_abandoned' })
  })

  test('brokered reconnect retry is recognized before stale expected-revision rejection', async () => {
    const { authorizer, installInputs, revoked } = harness({ authority: 'platform_broker' })
    const intent = {
      ...reconnectIntent(),
      authority: 'platform_broker' as const,
      localFlowId: '80000000-0000-4000-8000-000000000099',
    }
    await authorizer.install({ grant, intent, userId: 'user-1' })
    await authorizer.install({ grant, intent, userId: 'user-1' })
    expect(installInputs).toHaveLength(1)
    expect(installInputs[0]).toMatchObject({
      authorizationFlowId: intent.localFlowId,
      materialRevision: 'revision-1',
      credentialRef: `__integration-credential:authorization-flow:${intent.localFlowId}:bearer`,
    })
    expect(revoked).toEqual([])
  })

  test('committed reconnect replay preserves disabled and changed lifecycle state', async () => {
    const { authorizer, flowConnections, receiptFor, target, validated, enabled, removed, revoked } = harness({
      authority: 'platform_broker',
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    target.authorizationFlowId = localFlowId
    target.clientAuthority = 'platform_broker'
    target.materialRevision = 'later-lifecycle-revision'
    target.enabled = false
    target.authState = 'invalid'
    flowConnections.set(localFlowId, target)
    Object.assign(receiptFor(localFlowId), {
      installKind: 'reconnect_same',
      installedConnectionId: target.id,
      installedMaterialRevision: 'installed-revision',
      installedAt: new Date(),
    })
    await authorizer.install({
      grant,
      intent: { ...reconnectIntent(), authority: 'platform_broker', localFlowId },
      userId: 'user-1',
    })
    expect(target).toMatchObject({
      materialRevision: 'later-lifecycle-revision',
      enabled: false,
      authState: 'invalid',
    })
    expect(validated).toEqual([])
    expect(enabled).toEqual([])
    expect(removed).toEqual([])
    expect(revoked).toEqual([])
  })

  test.each([
    { kind: 'connect' as const, intent: 'connect' as const, connectionId: null, expectedMaterialRevision: null },
    {
      kind: 'reconnect_distinct' as const,
      intent: 'reconnect' as const,
      connectionId: '90000000-0000-4000-8000-000000000001',
      expectedMaterialRevision: '90000000-0000-4000-8000-000000000002',
    },
  ])('installed $kind replay never overrides later disabled lifecycle state', async (variant) => {
    const { authorizer, flowConnections, receiptFor, validated, enabled, removed } = harness({
      authority: 'platform_broker',
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    flowConnections.set(
      localFlowId,
      integrationRecord({
        id: 'installed-distinct',
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        authorizationFlowId: localFlowId,
        enabled: false,
        authState: 'invalid',
      })
    )
    Object.assign(receiptFor(localFlowId), {
      installKind: variant.kind,
      installedConnectionId: 'installed-distinct',
      installedMaterialRevision: 'installed-revision',
      installedAt: new Date(),
    })
    await authorizer.install({
      grant,
      intent: {
        ...reconnectIntent(),
        intent: variant.intent,
        connectionId: variant.connectionId,
        expectedMaterialRevision: variant.expectedMaterialRevision,
        authority: 'platform_broker',
        localFlowId,
      },
      userId: 'user-1',
    })
    expect(validated).toEqual([])
    expect(enabled).toEqual([])
    expect(removed).toEqual([])
  })

  test('incompatible installed receipt tuple is rejected before lifecycle mutation', async () => {
    const { authorizer, receiptFor, creates, validated, enabled } = harness({ authority: 'platform_broker' })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    Object.assign(receiptFor(localFlowId), {
      installKind: 'connect',
      installedConnectionId: 'different-connection',
      installedMaterialRevision: 'installed-revision',
      installedAt: new Date(),
    })
    await expect(
      authorizer.install({
        grant,
        intent: { ...reconnectIntent(), authority: 'platform_broker', localFlowId },
        userId: 'user-1',
      })
    ).rejects.toThrow('Authorization flow receipt mismatch')
    expect(creates).toEqual([])
    expect(validated).toEqual([])
    expect(enabled).toEqual([])
  })

  test('reconnect preserves a committed winner when the database acknowledgement is lost', async () => {
    const { authorizer, target, staged, deleted, revoked, installInputs } = harness({
      authority: 'platform_broker',
      installCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    await authorizer.install({
      grant,
      intent: { ...reconnectIntent(), authority: 'platform_broker', localFlowId },
      userId: 'user-1',
    })
    expect(installInputs).toHaveLength(1)
    expect(target).toMatchObject({
      authorizationFlowId: localFlowId,
      materialRevision: 'revision-1',
      credentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
    })
    expect(staged.get(target.credentialRef)).toBe(serializeOAuthCredential(grant.credential))
    expect(deleted).toEqual([])
    expect(revoked).toEqual([])
  })

  test('different-workspace brokered reconnect retry reuses the distinct flow connection', async () => {
    const { authorizer, creates, revoked } = harness({
      authority: 'platform_broker',
      targetWorkspace: 'different-workspace',
    })
    const intent = {
      ...reconnectIntent(),
      authority: 'platform_broker' as const,
      localFlowId: '80000000-0000-4000-8000-000000000099',
    }
    await authorizer.install({ grant, intent, userId: 'user-1' })
    await authorizer.install({ grant, intent, userId: 'user-1' })
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ authorizationFlowId: intent.localFlowId })
    expect(revoked).toEqual([])
  })

  test('post-commit reprojection failure preserves newly authoritative material', async () => {
    const { authorizer, staged, deleted, revoked } = harness({ reprojectFails: true })

    await authorizer.install({ grant, intent: reconnectIntent(), userId: 'user-1' })

    expect(staged.size).toBe(1)
    expect(deleted).toEqual([])
    expect(revoked).toEqual([])
  })

  test('malformed persisted reconnect configuration fails before staging or lifecycle mutation', async () => {
    const { authorizer, staged, revoked, installInputs, creates } = harness({
      targetConfiguration: { version: 1, workspaceId: 42 },
    })
    await expect(authorizer.install({ grant, intent: reconnectIntent(), userId: 'user-1' })).rejects.toThrow(
      'Reconnect target changed'
    )
    expect(staged.size).toBe(0)
    expect(revoked).toEqual([])
    expect(installInputs).toEqual([])
    expect(creates).toEqual([])
  })

  test('fresh local create failure leaves its exact staged ref durably owned', async () => {
    const { authorizer, creates, staged, queuedRevocations } = harness({ createFails: true })
    await expect(
      authorizer.install({
        grant,
        intent: { ...reconnectIntent(), intent: 'connect', connectionId: null, expectedMaterialRevision: null },
        userId: 'user-1',
      })
    ).rejects.toThrow('connection insert failed')
    const [{ stagedCredentialRef }] = creates as Array<{ stagedCredentialRef: string }>
    expect([...staged.keys()]).toEqual([stagedCredentialRef])
    expect(queuedRevocations).toEqual([
      expect.objectContaining({ credentialRef: stagedCredentialRef, clientAuthority: 'local' }),
    ])
  })

  test('fresh local staging acknowledgement loss adopts the exact committed artifact', async () => {
    const { authorizer, creates, queuedRevocations } = harness({ stageCommitsThenThrows: true })
    await authorizer.install({
      grant,
      intent: { ...reconnectIntent(), intent: 'connect', connectionId: null, expectedMaterialRevision: null },
      userId: 'user-1',
    })
    expect((creates[0] as { stagedCredentialRef: string }).stagedCredentialRef).toBe(
      '__integration-credential:rollback:revision-1:bearer'
    )
    expect(queuedRevocations).toEqual([])
  })

  test('fresh local post-persistence failure removes the committed row and restores exact revocation ownership', async () => {
    const { authorizer, creates, removed, queuedRevocations } = harness({ createPostCommitFails: true })
    await expect(
      authorizer.install({
        grant,
        intent: { ...reconnectIntent(), intent: 'connect', connectionId: null, expectedMaterialRevision: null },
        userId: 'user-1',
      })
    ).rejects.toThrow('Integration connection creation committed')
    const stagedCredentialRef = (creates[0] as { stagedCredentialRef: string }).stagedCredentialRef
    expect(removed).toEqual(['new-connection'])
    expect(queuedRevocations).toEqual([
      expect.objectContaining({ credentialRef: stagedCredentialRef, clientAuthority: 'local' }),
    ])
  })

  test('same-workspace local install acknowledgement loss keeps the adopted ref authoritative', async () => {
    const { authorizer, installInputs, queuedRevocations } = harness({ installCommitsThenThrows: true })
    await authorizer.install({ grant, intent: reconnectIntent(), userId: 'user-1' })
    const [input] = installInputs as Array<{ credentialRef: string; adoptStagedRevocationRef: string }>
    expect(input.adoptStagedRevocationRef).toBe(input.credentialRef)
    expect(queuedRevocations).toEqual([])
  })

  test('expected revision race preserves one staged artifact behind a durable revocation job', async () => {
    const { authorizer, staged, deleted, revoked, queuedRevocations } = harness({ installStatus: 'changed' })
    await expect(authorizer.install({ grant, intent: reconnectIntent(), userId: 'user-1' })).rejects.toThrow(
      'Reconnect target changed'
    )
    expect(staged.size).toBe(1)
    expect(queuedRevocations).toHaveLength(1)
    expect(deleted).toHaveLength(0)
    expect(revoked).toEqual([])
  })

  test('different-workspace reconnect creates a distinct unassigned connection with a collision suffix', async () => {
    const { authorizer, creates, enabled, enabledFlows } = harness({ targetWorkspace: 'different-workspace' })
    await authorizer.install({ grant, intent: reconnectIntent(), userId: 'user-1' })
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({
      providerKey: 'notion',
      displayName: 'Workspace (2)',
      authorizationGrant: true,
      clientAuthority: 'local',
    })
    expect(enabled).toEqual(['new-connection'])
    expect(enabledFlows).toEqual([undefined])
  })

  test('brokered reconnect race durably revokes the receipt-owned artifact', async () => {
    const { authorizer, staged, revoked, queuedRevocations } = harness({
      authority: 'platform_broker',
      installStatus: 'changed',
      deleteFails: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    const error = await authorizer
      .install({
        grant,
        intent: { ...reconnectIntent(), authority: 'platform_broker', localFlowId },
        userId: 'user-1',
      })
      .catch((value) => value)
    expect(error).toMatchObject({ code: 'grant_abandoned' })
    expect(staged.has(`__integration-credential:authorization-flow:${localFlowId}:bearer`)).toBe(true)
    expect(revoked).toEqual([])
    expect(queuedRevocations).toEqual([
      expect.objectContaining({
        credentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
      }),
    ])
  })

  test('failed receipt revocation enqueue retains the owned artifact for retry', async () => {
    const { authorizer, staged, queuedRevocations } = harness({
      authority: 'platform_broker',
      validationOk: false,
      revokeFails: true,
      enqueueFails: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    await expect(
      authorizer.install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
    ).rejects.toThrow('revocation enqueue failed')
    expect([...staged.keys()]).toEqual([`__integration-credential:authorization-flow:${localFlowId}:bearer`])
    expect(queuedRevocations).toEqual([])
  })

  test('repeated revocation transaction failure reuses one deterministic receipt artifact', async () => {
    const { authorizer, staged, queuedRevocations } = harness({
      authority: 'platform_broker',
      validationOk: false,
      revokeFails: true,
      enqueueFails: true,
      deleteFails: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    const input = {
      grant,
      intent: {
        ...reconnectIntent(),
        intent: 'connect' as const,
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker' as const,
        localFlowId,
      },
      userId: 'user-1',
    }
    await expect(authorizer.install(input)).rejects.toThrow('revocation enqueue failed')
    await expect(authorizer.install(input)).rejects.toThrow('revocation enqueue failed')
    expect([...staged.keys()]).toEqual([`__integration-credential:authorization-flow:${localFlowId}:bearer`])
    expect(queuedRevocations).toEqual([])
  })

  test('rollback enqueue acknowledgement loss preserves the worker credential and safely abandons', async () => {
    const { authorizer, staged, queuedRevocations } = harness({
      authority: 'platform_broker',
      validationOk: false,
      revokeFails: true,
      enqueueCommitsThenThrows: true,
    })
    const localFlowId = '80000000-0000-4000-8000-000000000099'
    const error = await authorizer
      .install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
      .catch((value) => value)
    expect(error).toEqual(new Error('revocation enqueue acknowledgement lost'))
    expect(queuedRevocations).toEqual([
      expect.objectContaining({
        credentialRef: `__integration-credential:authorization-flow:${localFlowId}:bearer`,
      }),
    ])
    expect(staged.has(`__integration-credential:authorization-flow:${localFlowId}:bearer`)).toBe(true)
    await expect(
      authorizer.install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId,
        },
        userId: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'grant_abandoned' })
  })

  test('local rollback is durably staged before any remote revocation attempt', async () => {
    const { authorizer, staged, queuedRevocations, revoked } = harness({ validationOk: false })
    await expect(
      authorizer.install({ grant, intent: { ...reconnectIntent(), intent: 'connect' }, userId: 'user-1' })
    ).rejects.toThrow('Notion grant validation failed')
    expect(queuedRevocations).toEqual([expect.objectContaining({ clientAuthority: 'local' })])
    expect(staged.has(queuedRevocations[0]!.credentialRef)).toBe(true)
    expect(revoked).toEqual([])
  })

  test('brokered rollback persists broker authority on the durable revocation job', async () => {
    const { authorizer, queuedRevocations } = harness({
      validationOk: false,
      revokeFails: true,
      authority: 'platform_broker',
    })
    await expect(
      authorizer.install({
        grant,
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          authority: 'platform_broker',
          localFlowId: crypto.randomUUID(),
        },
        userId: 'user-1',
      })
    ).rejects.toThrow('Notion grant validation failed')
    expect(queuedRevocations).toEqual([expect.objectContaining({ clientAuthority: 'platform_broker' })])
  })

  test('a broker grant returning after expiry persists under its pre-expiry admission', async () => {
    let expired = false
    const { authorizer, creates, queuedRevocations } = harness({
      authority: 'platform_broker',
      isStagingExpired: () => expired,
    })
    await authorizer.install({
      exchange: async () => {
        expired = true
        return grant
      },
      intent: {
        ...reconnectIntent(),
        intent: 'connect',
        connectionId: null,
        expectedMaterialRevision: null,
        authority: 'platform_broker',
        localFlowId: crypto.randomUUID(),
      },
      userId: 'user-1',
    })
    expect(creates).toHaveLength(1)
    expect(queuedRevocations).toEqual([])
  })

  test('expired recovery inside the flow lease makes zero broker calls', async () => {
    const { authorizer } = harness({ authority: 'platform_broker', stagingExpired: true })
    let brokerCalls = 0
    await expect(
      authorizer.install({
        exchange: async () => {
          brokerCalls += 1
          return grant
        },
        intent: {
          ...reconnectIntent(),
          intent: 'connect',
          connectionId: null,
          expectedMaterialRevision: null,
          authority: 'platform_broker',
          localFlowId: crypto.randomUUID(),
        },
        userId: 'user-1',
      })
    ).rejects.toMatchObject({ code: 'flow_expired' })
    expect(brokerCalls).toBe(0)
  })

  test('opposite-order reconnect resource plans make progress through canonical acquisition', async () => {
    const lease = new ConnectionAuthorizationLease({ acquireTimeoutMs: 5_000 })
    const completed: string[] = []
    await Promise.all([
      lease.runExclusiveMany(['order-a', 'order-b'], async () => void completed.push('a')),
      lease.runExclusiveMany(['order-b', 'order-a'], async () => void completed.push('b')),
    ])
    expect(new Set(completed)).toEqual(new Set(['a', 'b']))
  })

  test('shared reconnect resources never overlap and both contenders make progress', async () => {
    const lease = new ConnectionAuthorizationLease({ acquireTimeoutMs: 5_000 })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let signalFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve
    })
    let active = 0
    let maximumActive = 0
    const first = lease.runExclusiveMany(['flow:broker-a', 'shared-connection'], async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      signalFirst()
      await firstGate
      active -= 1
    })
    await firstEntered
    const second = lease.runExclusiveMany(['shared-connection', 'flow:broker-b'], async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      active -= 1
    })
    await Bun.sleep(50)
    expect(active).toBe(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(maximumActive).toBe(1)
  })

  test('two concurrent post-create local failures drain without nested removal leases', async () => {
    const { authorizer, removed, queuedRevocations } = harness({
      enableFailsBeforeCommit: true,
      removeFails: true,
      lease: new ConnectionAuthorizationLease({ acquireTimeoutMs: 5_000 }),
    })
    const intent = {
      ...reconnectIntent(),
      intent: 'connect' as const,
      connectionId: null,
      expectedMaterialRevision: null,
    }
    const outcomes = await Promise.allSettled([
      authorizer.install({ grant, intent, userId: 'user-1' }),
      authorizer.install({
        grant: {
          ...grant,
          credential: { ...grant.credential, accessToken: 'access-token-two' },
          configuration: { ...grant.configuration, workspaceId: 'workspace-two' },
        },
        intent,
        userId: 'user-1',
      }),
    ])
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
    expect(removed).toHaveLength(2)
    expect(queuedRevocations).toHaveLength(2)
  })

  test('validation failure creates one durable rollback artifact and no synchronous revoke', async () => {
    const { authorizer, creates, staged, revoked, queuedRevocations } = harness({ validationOk: false })
    const error = await authorizer
      .install({ grant, intent: { ...reconnectIntent(), intent: 'connect' }, userId: 'user-1' })
      .catch((value) => value)
    expect(error).toMatchObject({ message: 'Notion grant validation failed', code: 'grant_abandoned' })
    expect(creates).toEqual([])
    expect(staged.size).toBe(1)
    expect(queuedRevocations).toHaveLength(1)
    expect(revoked).toEqual([])
  })
})
