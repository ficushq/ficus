import { describe, expect, test } from 'bun:test'
import {
  IntegrationAuthorizationKindRequiredError,
  IntegrationConnectionCreateCommittedError,
  IntegrationConnectionInUseError,
  IntegrationConnectionService,
  type ConnectionServiceDependencies,
} from './connection-service'
import type { ProviderValidation } from './types'
import type {
  IntegrationAssignmentRepository,
  IntegrationConnectionRecord,
  IntegrationConnectionRepository,
  IntegrationConnectionUsage,
} from './connection-repository'

function setup(
  options: {
    allowsManualCredential?: (providerKey: string) => boolean
    offersOAuth?: (providerKey: string) => boolean
    safeConfiguration?: (providerKey: string, configuration: unknown) => unknown
    refreshAvailable?: (connection: IntegrationConnectionRecord, credential: string | undefined) => boolean
    refreshAuthenticationFailure?: () => Promise<{
      status: 'refreshed' | 'unchanged' | 'reauthorization_required' | 'degraded'
    }>
    createPendingCommitsThenThrows?: boolean
    createPendingFailsBeforeCommit?: boolean
    cleanupScheduleFails?: boolean
    recordValidationCommitsThenThrows?: boolean
    postCreateReadFails?: boolean
    deleteCommitsThenThrows?: boolean
    currentOAuthAuthority?: (connection: IntegrationConnectionRecord) => 'local' | 'platform_broker' | undefined
    requiresRemoteRevocation?: (connection: IntegrationConnectionRecord) => boolean
    operatorAlertFails?: boolean
    authorityCasLoses?: boolean
    prepareRemoval?: ConnectionServiceDependencies['prepareRemoval']
    parseConfig?: (value: unknown) => unknown
  } = {}
) {
  let row: IntegrationConnectionRecord | null = null
  let usage: IntegrationConnectionUsage = { squadCount: 0, squads: [] }
  let failDelete = false
  let failCredentialDelete = false
  let failAudit = false
  const secrets = new Map<string, string>()
  const scheduledCleanup: string[] = []
  const scheduledRevocation: Array<{ providerKey: string; adapterVersion: number; credentialRef: string }> = []
  const deprojections: unknown[] = []
  const operatorAlerts: unknown[] = []
  const repository = {
    createPending: async (input: any): Promise<any> => {
      if (options.createPendingFailsBeforeCommit) throw new Error('insert failed')
      row = {
        ...input,
        enabled: false,
        authState: 'pending',
        healthState: 'unknown',
        grantedScopes: [],
        validatedRevision: null,
        validatedAt: null,
        validationExpiresAt: null,
        lastErrorCode: null,
      }
      if (options.createPendingCommitsThenThrows) throw new Error('commit acknowledgement lost')
      return row
    },
    get: async (id: string) => {
      if (options.postCreateReadFails) throw new Error('read acknowledgement lost')
      return row?.id === id ? row : null
    },
    list: async () => (row ? [row] : []),
    due: async () => [],
    scheduleCredentialCleanup: async (reference) => {
      if (options.cleanupScheduleFails) throw new Error('cleanup schedule failed')
      scheduledCleanup.push(reference)
    },
    recordValidation: async (input: any) => {
      if (!row || row.materialRevision !== input.materialRevision) return false
      row = {
        ...row,
        authState: input.validation.ok ? 'authenticated' : 'invalid',
        healthState: input.validation.ok ? 'healthy' : 'unreachable',
        grantedScopes: input.validation.ok ? input.validation.grantedScopes : [],
        ...(input.validation.ok && input.validation.configuration !== undefined
          ? { configuration: input.validation.configuration }
          : {}),
        validatedRevision: input.validation.ok ? input.materialRevision : null,
        validatedAt: input.now,
        validationExpiresAt: input.expiresAt,
        lastErrorCode: input.validation.ok ? null : input.validation.code,
      }
      if (options.recordValidationCommitsThenThrows) throw new Error('validation acknowledgement lost')
      return true
    },
    enableValidated: async (input: any) => {
      if (!row || row.materialRevision !== input.materialRevision || row.authState === 'reauthorization_required')
        return false
      row = {
        ...row,
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        grantedScopes: input.validation.grantedScopes,
        validatedRevision: input.materialRevision,
        validatedAt: input.now,
        validationExpiresAt: input.expiresAt,
      }
      return true
    },
    disable: async (_id, confirmAssigned) => {
      if (!row) return { status: 'not_found' as const }
      if (usage.squadCount > 0 && !confirmAssigned) return { status: 'in_use' as const, usage }
      row = { ...row, enabled: false }
      return { status: 'updated' as const, value: undefined }
    },
    disableRuntimeAuthFailure: async () => false,
    markReauthorizationRequired: async (input) => {
      if (options.authorityCasLoses) return false
      if (!row || row.id !== input.id || row.materialRevision !== input.materialRevision) return false
      row = {
        ...row,
        authState: 'reauthorization_required',
        healthState: 'degraded',
        validatedRevision: null,
        validationExpiresAt: null,
        lastErrorCode: input.code,
      }
      return true
    },
    recordRefreshFailure: async () => false,
    rotateMaterial: async (input: any) => {
      if (!row) return { status: 'not_found' as const }
      if (usage.squadCount > 0 && !input.confirmAssigned) return { status: 'in_use' as const, usage }
      const retiredCredentialRef =
        input.credentialRef && input.credentialRef !== row.credentialRef ? row.credentialRef : null
      row = {
        ...row,
        credentialRef: input.credentialRef ?? row.credentialRef,
        materialRevision: input.materialRevision,
        validatedRevision: null,
        enabled: false,
        authState: 'pending',
        healthState: 'unknown',
      }
      return { status: 'updated' as const, value: { connection: row, retiredCredentialRef } }
    },
    deleteWithRevocation: async (_id, confirmAssigned) => {
      if (failDelete) throw new Error('database unavailable')
      if (!row) return { status: 'not_found' as const }
      if (usage.squadCount > 0 && !confirmAssigned) return { status: 'in_use' as const, usage }
      const retiredCredentialRef = row.credentialRef
      scheduledRevocation.push({
        providerKey: row.providerKey,
        adapterVersion: row.adapterVersion,
        credentialRef: retiredCredentialRef,
      })
      row = null
      if (options.deleteCommitsThenThrows) throw new Error('delete acknowledgement lost')
      return { status: 'updated' as const, value: { retiredCredentialRef } }
    },
    delete: async (_id, confirmAssigned) => {
      if (failDelete) throw new Error('database unavailable')
      if (!row) return { status: 'not_found' as const }
      if (usage.squadCount > 0 && !confirmAssigned) return { status: 'in_use' as const, usage }
      const retiredCredentialRef = row.credentialRef
      row = null
      return { status: 'updated' as const, value: { retiredCredentialRef } }
    },
  } satisfies IntegrationConnectionRepository
  const assignments = {
    usage: async () => usage,
  } as Pick<IntegrationAssignmentRepository, 'usage'>
  let validation: Promise<ProviderValidation> = Promise.resolve({ ok: true, grantedScopes: ['vault:read'] })
  let validationCalls = 0
  const audits: unknown[] = []
  const service = new IntegrationConnectionService({
    repository,
    assignments,
    credentials: {
      get: (key) => secrets.get(key),
      set: async (key, value) => {
        secrets.set(key, value)
      },
      delete: async (key) => {
        if (failCredentialDelete) throw new Error('secret store unavailable')
        secrets.delete(key)
      },
    },
    resolveProvider: (providerKey) => ({
      key: providerKey,
      adapterVersion: 1,
      parseConfig: options.parseConfig ?? ((value) => value),
      validate: () => {
        validationCalls += 1
        return validation
      },
      capabilities: {},
    }),
    requiresRemoteRevocation: options.requiresRemoteRevocation ?? ((connection) => connection.providerKey === 'notion'),
    allowsManualCredential: options.allowsManualCredential,
    offersOAuth: options.offersOAuth,
    refreshAuthenticationFailure: options.refreshAuthenticationFailure,
    safeConfiguration: options.safeConfiguration,
    refreshAvailable: options.refreshAvailable,
    currentOAuthAuthority: options.currentOAuthAuthority,
    operatorAlert: async (input) => {
      if (options.operatorAlertFails) throw new Error('inbox unavailable')
      operatorAlerts.push(input)
    },
    deproject: async (input) => void deprojections.push(input),
    prepareRemoval: options.prepareRemoval,
    audit: {
      record: async (event) => {
        if (failAudit) throw new Error('audit unavailable')
        audits.push(event)
      },
    },
    uuid: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
  })
  return {
    service,
    secrets,
    scheduledCleanup,
    scheduledRevocation,
    deprojections,
    audits,
    operatorAlerts,
    getRow: () => row,
    validationCalls: () => validationCalls,
    setUsage: (value: IntegrationConnectionUsage) => (usage = value),
    setValidation: (value: typeof validation) => (validation = value),
    markTerminal: () => {
      if (row) row = { ...row, authState: 'reauthorization_required', healthState: 'degraded' }
    },
    failDelete: () => (failDelete = true),
    failCredentialCleanup: () => (failCredentialDelete = true),
    failAuditing: () => (failAudit = true),
  }
}

async function create(service: IntegrationConnectionService) {
  return service.create({
    providerKey: 'bigbrain',
    adapterVersion: 1,
    displayName: 'Brain',
    configuration: { version: 1 },
    credential: 'fixture-bearer',
    actor: 'user:user-1',
  })
}

describe('IntegrationConnectionService', () => {
  test('creates a global connection and discloses neither bearer nor internal reference', async () => {
    const { service, audits, getRow } = setup()
    const view = await create(service)
    expect(getRow()).not.toHaveProperty('squadId')
    expect(view).toMatchObject({
      credentialConfigured: true,
      authState: 'authenticated',
      enabled: false,
      usage: { squadCount: 0, squads: [] },
    })
    expect(view).not.toHaveProperty('refreshAvailable')
    expect(JSON.stringify(view)).not.toContain('fixture-bearer')
    expect(JSON.stringify(view)).not.toContain('integration-credential:')
    expect(audits).toEqual([
      expect.objectContaining({
        squadId: undefined,
        action: 'connection_create',
        outcome: 'succeeded',
      }),
    ])
  })

  test.each([
    ['validation acknowledgement', { recordValidationCommitsThenThrows: true }],
    ['post-create reread', { postCreateReadFails: true }],
  ] as const)('%s failure reports the exact committed connection id', async (_name, options) => {
    const { service, getRow, secrets } = setup(options)
    const error = await create(service).catch((value) => value)
    expect(error).toBeInstanceOf(IntegrationConnectionCreateCommittedError)
    expect(error.connectionId).toBe(getRow()!.id)
    expect(secrets.size).toBe(1)
  })

  test('post-create audit failure reports the exact committed connection id', async () => {
    const { service, getRow, secrets, failAuditing } = setup()
    failAuditing()
    const error = await create(service).catch((value) => value)
    expect(error).toBeInstanceOf(IntegrationConnectionCreateCommittedError)
    expect(error.connectionId).toBe(getRow()!.id)
    expect(secrets.size).toBe(1)
  })

  test('brokered authorization uses the flow id for deterministic pending material', async () => {
    const { service, getRow, secrets } = setup()
    const authorizationFlowId = '80000000-0000-4000-8000-000000000099'
    await service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Workspace',
      configuration: { workspaceId: 'workspace-1' },
      credential: 'oauth-token',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
      clientAuthority: 'platform_broker',
      authorizationFlowId,
    })
    expect(getRow()).toMatchObject({
      id: 'id-1',
      materialRevision: 'id-2',
      authorizationFlowId,
      clientAuthority: 'platform_broker',
    })
    expect([...secrets.keys()]).toEqual([`__integration-credential:authorization-flow:${authorizationFlowId}:bearer`])
  })

  test('brokered create recovers a committed pending row when insert acknowledgement is lost', async () => {
    const { service, getRow, secrets } = setup({ createPendingCommitsThenThrows: true })
    const authorizationFlowId = '80000000-0000-4000-8000-000000000099'
    await expect(
      service.create({
        providerKey: 'notion',
        adapterVersion: 1,
        displayName: 'Workspace',
        configuration: { workspaceId: 'workspace-1' },
        credential: 'oauth-token',
        actor: 'user:user-1',
        authorizationGrant: true,
        authorizationKind: 'oauth2',
        clientAuthority: 'platform_broker',
        authorizationFlowId,
      })
    ).resolves.toMatchObject({ authState: 'authenticated' })
    expect(getRow()).toMatchObject({ authorizationFlowId, authState: 'authenticated' })
    expect(secrets.get(`__integration-credential:authorization-flow:${authorizationFlowId}:bearer`)).toBe('oauth-token')
  })

  test('failed manual create retires its unowned credential after proving the insert did not commit', async () => {
    const { service, secrets, scheduledCleanup } = setup({ createPendingFailsBeforeCommit: true })
    await expect(create(service)).rejects.toThrow('insert failed')
    expect(secrets.size).toBe(0)
    expect(scheduledCleanup).toEqual(['__integration-credential:id-1:id-2:bearer'])
  })

  test('failed manual create preserves material when the insert outcome cannot be read', async () => {
    const { service, secrets, scheduledCleanup } = setup({
      createPendingFailsBeforeCommit: true,
      postCreateReadFails: true,
    })
    await expect(create(service)).rejects.toThrow('insert failed')
    expect(secrets.size).toBe(1)
    expect(scheduledCleanup).toEqual([])
  })

  test('failed brokered create leaves deterministic staged material owned by its flow receipt', async () => {
    const { service, secrets, failCredentialCleanup } = setup({
      createPendingFailsBeforeCommit: true,
      cleanupScheduleFails: true,
    })
    failCredentialCleanup()
    const authorizationFlowId = '80000000-0000-4000-8000-000000000099'
    await expect(
      service.create({
        providerKey: 'notion',
        adapterVersion: 1,
        displayName: 'Workspace',
        configuration: { workspaceId: 'workspace-1' },
        credential: 'oauth-token',
        actor: 'user:user-1',
        authorizationGrant: true,
        authorizationKind: 'oauth2',
        clientAuthority: 'platform_broker',
        authorizationFlowId,
      })
    ).rejects.toThrow('insert failed')
    expect(secrets.get(`__integration-credential:authorization-flow:${authorizationFlowId}:bearer`)).toBe('oauth-token')
  })

  test('public safe views expose only refresh availability, never refresh material', async () => {
    const { service } = setup({ refreshAvailable: (_connection, credential) => credential === 'fixture-bearer' })
    const view = await create(service)
    expect(view.refreshAvailable).toBe(true)
    expect(view).not.toHaveProperty('refreshToken')
  })

  test('public safe views serialize configuration through the manifest contract', async () => {
    const { service } = setup({
      safeConfiguration: (_providerKey, configuration) => ({
        workspaceId: (configuration as { workspaceId: string }).workspaceId,
      }),
    })
    const view = await service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Notion',
      configuration: { workspaceId: 'workspace-1', privateField: 'TOKEN-SENTINEL' },
      credential: 'oauth-token',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
    })
    expect(view.configuration).toEqual({ workspaceId: 'workspace-1' })
    expect(JSON.stringify(view)).not.toContain('TOKEN-SENTINEL')
  })

  test('validation persists configuration the provider refreshed for the same account', async () => {
    const harness = setup()
    const created = await create(harness.service)
    harness.setValidation(Promise.resolve({ ok: true, grantedScopes: [], configuration: { version: 2 } }))
    await harness.service.validate(created.id)
    expect(harness.getRow()).toMatchObject({ healthState: 'healthy', configuration: { version: 2 } })
  })

  test('validation keeps stored configuration when the refreshed shape does not parse', async () => {
    const harness = setup({
      parseConfig: (value) => {
        if ((value as { version?: unknown }).version !== 1) throw new Error('Invalid configuration')
        return value
      },
    })
    const created = await create(harness.service)
    harness.setValidation(Promise.resolve({ ok: true, grantedScopes: [], configuration: { version: 'bogus' } }))
    await harness.service.validate(created.id)
    expect(harness.getRow()).toMatchObject({ healthState: 'healthy', configuration: { version: 1 } })
  })

  test('historical local OAuth validation reconciles authority before provider access', async () => {
    let authority: 'local' | 'platform_broker' = 'local'
    const harness = setup({
      currentOAuthAuthority: (connection) => (connection.providerKey === 'notion' ? authority : undefined),
    })
    const created = await harness.service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Notion',
      configuration: { version: 1 },
      credential: 'oauth-credential',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
      clientAuthority: 'local',
    })
    const callsBeforeReconciliation = harness.validationCalls()
    authority = 'platform_broker'
    expect(await harness.service.validate(created.id)).toMatchObject({ authState: 'reauthorization_required' })
    expect(harness.validationCalls()).toBe(callsBeforeReconciliation)
    expect(harness.operatorAlerts).toEqual([
      {
        connectionId: created.id,
        providerKey: 'notion',
        materialRevision: harness.getRow()!.materialRevision,
        safeCode: 'client_authority_mismatch',
      },
    ])
  })

  test('an authority mismatch CAS loser emits no stale operator alert', async () => {
    const harness = setup({
      currentOAuthAuthority: () => 'platform_broker',
      authorityCasLoses: true,
    })
    const created = await harness.service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Historical local',
      configuration: { version: 1 },
      credential: 'historical-local-token',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
      clientAuthority: 'local',
    })
    await harness.service.validate(created.id)
    expect(harness.operatorAlerts).toEqual([])
  })

  test('authority mismatch lifecycle transition survives durable alert delivery failure', async () => {
    const harness = setup({
      currentOAuthAuthority: () => 'platform_broker',
      operatorAlertFails: true,
    })
    const created = await harness.service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Historical local',
      configuration: { version: 1 },
      credential: 'historical-local-token',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
      clientAuthority: 'local',
    })
    const callsBefore = harness.validationCalls()
    await expect(harness.service.validate(created.id)).resolves.toMatchObject({
      authState: 'reauthorization_required',
    })
    expect(harness.validationCalls()).toBe(callsBefore)
  })

  test('historical local OAuth explicit enable fails closed before live validation', async () => {
    let authority: 'local' | 'platform_broker' = 'local'
    const harness = setup({
      currentOAuthAuthority: (connection) => (connection.providerKey === 'notion' ? authority : undefined),
    })
    const created = await harness.service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Notion',
      configuration: { version: 1 },
      credential: 'oauth-credential',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
      clientAuthority: 'local',
    })
    const callsBeforeReconciliation = harness.validationCalls()
    authority = 'platform_broker'
    await expect(harness.service.enable(created.id)).rejects.toThrow('client_authority_mismatch')
    expect(harness.validationCalls()).toBe(callsBeforeReconciliation)
    expect(harness.getRow()).toMatchObject({ authState: 'reauthorization_required' })
    expect(harness.operatorAlerts).toHaveLength(1)
  })

  test('an observed invalid_auth invokes one-shot refresh without overwriting reconnect state', async () => {
    let refreshes = 0
    const { service, setValidation } = setup({
      refreshAuthenticationFailure: async () => {
        refreshes += 1
        return { status: 'reauthorization_required' }
      },
    })
    const connection = await create(service)
    setValidation(Promise.resolve({ ok: false as const, code: 'invalid_auth' }))
    await service.validate(connection.id)
    expect(refreshes).toBe(1)
  })

  test('a transient refresh outage after observed invalid_auth deprojects usage without replacing refresh state', async () => {
    const { service, setValidation, setUsage, deprojections } = setup({
      refreshAuthenticationFailure: async () => ({ status: 'degraded' }),
    })
    const connection = await create(service)
    setUsage({ squadCount: 1, squads: [{ id: 'squad-1', name: 'Squad' }] })
    setValidation(Promise.resolve({ ok: false as const, code: 'invalid_auth' }))
    await service.validate(connection.id)
    expect(deprojections).toContainEqual({ squadIds: ['squad-1'], providerKey: 'bigbrain' })
  })

  test('rejects manual create and rotation for OAuth-only providers', async () => {
    const { service } = setup({ allowsManualCredential: (providerKey) => providerKey !== 'notion' })
    await expect(
      service.create({
        providerKey: 'notion',
        adapterVersion: 1,
        displayName: 'Notion',
        configuration: { version: 1 },
        credential: 'token',
        actor: 'user:user-1',
      })
    ).rejects.toThrow('OAuth authorization required')
    const connection = await service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Notion',
      configuration: { version: 1 },
      credential: 'oauth-token',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
    })
    await expect(service.replaceCredential(connection.id, 'token', 'user:user-1')).rejects.toThrow(
      'OAuth authorization required'
    )
  })

  describe('authorization kind of a granted connection', () => {
    // Mirrors the runtime wiring: OAuth2 plugins (github, notion) and manual
    // plugins with a managed driver (slack, linear) offer OAuth; bigbrain does not.
    const offersOAuth = (providerKey: string) => ['github', 'notion', 'slack', 'linear'].includes(providerKey)
    const grant = (providerKey: string) => ({
      providerKey,
      adapterVersion: 1,
      displayName: providerKey,
      configuration: { version: 1 },
      credential: 'granted-material',
      actor: 'user:user-1',
      authorizationGrant: true as const,
    })

    test.each(['github', 'notion', 'slack', 'linear'])(
      'refuses a %s grant without an explicit kind before storing anything',
      async (providerKey) => {
        const { service, getRow, secrets, validationCalls } = setup({ offersOAuth })
        await expect(service.create(grant(providerKey))).rejects.toBeInstanceOf(
          IntegrationAuthorizationKindRequiredError
        )
        expect(getRow()).toBeNull()
        expect(secrets.size).toBe(0)
        expect(validationCalls()).toBe(0)
      }
    )

    test.each([
      ['notion', 'oauth2'],
      ['slack', 'oauth2'],
      ['linear', 'manual'],
    ] as const)('stores an explicit kind unchanged (%s, %s)', async (providerKey, authorizationKind) => {
      const { service, getRow } = setup({ offersOAuth })
      await service.create({ ...grant(providerKey), authorizationKind })
      expect(getRow()!.authorizationKind).toBe(authorizationKind)
    })

    test('a service without an offersOAuth predicate fails closed for any grant without a kind', async () => {
      const { service, getRow, secrets } = setup()
      for (const providerKey of ['notion', 'slack', 'bigbrain']) {
        await expect(service.create(grant(providerKey))).rejects.toBeInstanceOf(
          IntegrationAuthorizationKindRequiredError
        )
      }
      expect(getRow()).toBeNull()
      expect(secrets.size).toBe(0)
      await service.create({ ...grant('notion'), authorizationKind: 'oauth2' })
      expect(getRow()!.authorizationKind).toBe('oauth2')
    })

    test('a grant for a manual-only provider (BigBrain) stays manual without a kind', async () => {
      const { service, getRow } = setup({ offersOAuth })
      await service.create(grant('bigbrain'))
      expect(getRow()!.authorizationKind).toBe('manual')
    })

    test('manual entry for a dual-driver provider needs no kind and stays manual', async () => {
      const { service, getRow } = setup({ offersOAuth })
      const { authorizationGrant: _grant, ...manualEntry } = grant('slack')
      await service.create(manualEntry)
      expect(getRow()!.authorizationKind).toBe('manual')
    })
  })

  test('permits multiple provider connections without a single-enabled check', async () => {
    const { service } = setup()
    const connection = await create(service)
    await expect(service.enable(connection.id)).resolves.toMatchObject({ enabled: true })
  })

  test.each(['disable', 'rotate', 'remove'] as const)(
    '%s requires explicit confirmation while assigned',
    async (action) => {
      const { service, setUsage, getRow } = setup()
      const connection = await create(service)
      await service.enable(connection.id)
      const usage = { squadCount: 1, squads: [{ id: 'squad-1', name: 'Alpha' }] }
      setUsage(usage)

      const operation =
        action === 'disable'
          ? () => service.disable(connection.id)
          : action === 'rotate'
            ? () => service.replaceCredential(connection.id, 'rotated', 'user:user-1')
            : () => service.remove(connection.id)
      await expect(operation()).rejects.toEqual(new IntegrationConnectionInUseError(usage))
      expect(getRow()).not.toBeNull()
      expect(getRow()?.enabled).toBe(true)
    }
  )

  test('confirmed removal deletes the database row before credential cleanup', async () => {
    const { service, secrets, setUsage, failDelete, getRow } = setup()
    const connection = await create(service)
    const credentialRef = getRow()!.credentialRef
    setUsage({ squadCount: 1, squads: [{ id: 'squad-1', name: 'Alpha' }] })
    failDelete()

    await expect(service.remove(connection.id, undefined, true)).rejects.toThrow('database unavailable')
    expect(secrets.has(credentialRef)).toBe(true)
  })

  test('removal hands provider cleanup the live credential and runs it only after the delete commits', async () => {
    const events: string[] = []
    const { service, getRow, secrets, deprojections, setUsage } = setup({
      prepareRemoval: async (connection, credential) => {
        events.push(`prepare:${connection.providerKey}:${credential}:${getRow() ? 'row' : 'gone'}`)
        return async () => {
          events.push(`cleanup:${getRow() ? 'row' : 'gone'}:${deprojections.length}`)
        }
      },
    })
    const connection = await service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Workspace',
      configuration: { version: 1 },
      credential: 'oauth-bundle',
      actor: 'user:user-1',
    })
    setUsage({ squadCount: 1, squads: [{ id: 'squad-1', name: 'Alpha' }] })
    const credentialRef = getRow()!.credentialRef
    await service.remove(connection.id, 'user:user-1', true)
    // Captured while the row and token exist; cleaned up after the delete, before squads deproject.
    expect(events).toEqual(['prepare:notion:oauth-bundle:row', 'cleanup:gone:0'])
    expect(deprojections).toHaveLength(1)
    expect(secrets.get(credentialRef)).toBe('oauth-bundle')
  })

  test('a removal that fails runs no provider cleanup', async () => {
    let cleaned = false
    const { service, failDelete } = setup({
      prepareRemoval: async () => async () => {
        cleaned = true
      },
    })
    const connection = await create(service)
    failDelete()
    await expect(service.remove(connection.id, undefined, true)).rejects.toThrow('database unavailable')
    expect(cleaned).toBe(false)
  })

  test('OAuth removal atomically queues remote revocation and retains the credential', async () => {
    const { service, secrets, getRow, scheduledRevocation, scheduledCleanup } = setup()
    const connection = await service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Workspace',
      configuration: { version: 1 },
      credential: 'oauth-bundle',
      actor: 'user:user-1',
    })
    const credentialRef = getRow()!.credentialRef

    await service.remove(connection.id)

    expect(getRow()).toBeNull()
    expect(secrets.get(credentialRef)).toBe('oauth-bundle')
    expect(scheduledCleanup).toEqual([])
    expect(scheduledRevocation).toEqual([{ providerKey: 'notion', adapterVersion: 1, credentialRef }])
  })

  test('a manual+managed provider (Slack-shaped) schedules revocation only for its broker-authority row', async () => {
    // Mirrors the real wiring: only `oauth2` connections require remote
    // revocation, so a manual row for the same provider key never schedules it.
    const requiresRemoteRevocation = (connection: IntegrationConnectionRecord) =>
      connection.authorizationKind === 'oauth2'

    const managed = setup({ requiresRemoteRevocation })
    const managedConnection = await managed.service.create({
      providerKey: 'slack',
      adapterVersion: 1,
      displayName: 'Acme',
      configuration: { version: 1 },
      credential: 'oauth-bundle',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
      clientAuthority: 'platform_broker',
    })
    expect(managed.getRow()!.authorizationKind).toBe('oauth2')
    const managedCredentialRef = managed.getRow()!.credentialRef
    await managed.service.remove(managedConnection.id)
    expect(managed.getRow()).toBeNull()
    expect(managed.scheduledRevocation).toEqual([
      { providerKey: 'slack', adapterVersion: 1, credentialRef: managedCredentialRef },
    ])
    expect(managed.secrets.get(managedCredentialRef)).toBe('oauth-bundle')

    const manual = setup({ requiresRemoteRevocation, allowsManualCredential: () => true })
    const manualConnection = await manual.service.create({
      providerKey: 'slack',
      adapterVersion: 1,
      displayName: 'Bring-your-own Slack app',
      configuration: { version: 1 },
      credential: 'manual-bot-token',
      actor: 'user:user-1',
    })
    expect(manual.getRow()!.authorizationKind).toBe('manual')
    const manualCredentialRef = manual.getRow()!.credentialRef
    await manual.service.remove(manualConnection.id)
    expect(manual.getRow()).toBeNull()
    expect(manual.scheduledRevocation).toEqual([])
    // A manual removal cleans up its own credential immediately (no revocation job owns it).
    expect(manual.secrets.has(manualCredentialRef)).toBe(false)
  })

  test('a manual+managed provider (Slack-shaped) is never reconciled for authority mismatch: it stays manual', async () => {
    // currentOAuthAuthority mirrors the real wiring too: it only returns an
    // authority for `oauth2` connections. A manually entered Slack app is a
    // `manual` connection, so #reconcileAuthority is always a no-op for it,
    // regardless of the deployment's current OAuth authority.
    const { service, getRow } = setup({
      currentOAuthAuthority: (connection) =>
        connection.authorizationKind === 'oauth2' ? 'platform_broker' : undefined,
    })
    const connection = await service.create({
      providerKey: 'slack',
      adapterVersion: 1,
      displayName: 'Bring-your-own Slack app',
      configuration: { version: 1 },
      credential: 'manual-bot-token',
      actor: 'user:user-1',
    })
    expect(getRow()!.clientAuthority).toBe('local')
    await service.validate(connection.id)
    expect(getRow()).toMatchObject({ authState: 'authenticated', clientAuthority: 'local' })
  })

  test('OAuth removal reconciles a committed delete acknowledgement loss without duplicating ownership', async () => {
    const { service, scheduledRevocation, getRow } = setup({ deleteCommitsThenThrows: true })
    const connection = await service.create({
      providerKey: 'notion',
      adapterVersion: 1,
      displayName: 'Notion',
      configuration: { version: 1 },
      credential: 'oauth-token',
      actor: 'user:user-1',
      authorizationGrant: true,
      authorizationKind: 'oauth2',
    })
    await service.remove(connection.id, 'user:user-1', true)
    expect(getRow()).toBeNull()
    expect(scheduledRevocation).toHaveLength(1)
  })

  test('post-delete audit failure cannot turn committed removal into a failed response or skip cleanup', async () => {
    const { service, secrets, getRow, failAuditing } = setup()
    const connection = await create(service)
    const credentialRef = getRow()!.credentialRef
    failAuditing()

    await expect(service.remove(connection.id)).resolves.toBeUndefined()
    expect(getRow()).toBeNull()
    expect(secrets.has(credentialRef)).toBe(false)
  })

  test('staged-secret cleanup failure preserves the authoritative usage conflict', async () => {
    const { service, setUsage, failCredentialCleanup, scheduledCleanup } = setup()
    const connection = await create(service)
    const usage = { squadCount: 1, squads: [{ id: 'squad-1', name: 'Alpha' }] }
    setUsage(usage)
    failCredentialCleanup()

    await expect(service.replaceCredential(connection.id, 'rotated', 'user:user-1')).rejects.toEqual(
      new IntegrationConnectionInUseError(usage)
    )
    expect(scheduledCleanup).toHaveLength(1)
    expect(scheduledCleanup[0]).toStartWith(`__integration-credential:${connection.id}:`)
  })

  test('enable rejects an already-terminal connection before provider validation', async () => {
    const { service, validationCalls, markTerminal } = setup()
    const connection = await create(service)
    markTerminal()
    const callsBefore = validationCalls()
    await expect(service.enable(connection.id)).rejects.toThrow('reauthorization_required')
    expect(validationCalls()).toBe(callsBefore)
  })

  test('enable cannot overwrite a terminal refresh that wins after live validation starts', async () => {
    const { service, getRow, setValidation, markTerminal } = setup()
    const connection = await create(service)
    let resolve!: (value: { ok: true; grantedScopes: string[] }) => void
    setValidation(
      new Promise((done) => {
        resolve = done
      })
    )
    const enabling = service.enable(connection.id)
    markTerminal()
    resolve({ ok: true, grantedScopes: ['vault:read'] })
    await expect(enabling).rejects.toThrow('Connection changed during validation')
    expect(getRow()).toMatchObject({ authState: 'reauthorization_required', enabled: false })
  })

  test('enable loses CAS to material rotation', async () => {
    const { service, getRow, setValidation } = setup()
    const connection = await create(service)
    let resolve!: (value: { ok: true; grantedScopes: string[] }) => void
    setValidation(
      new Promise((done) => {
        resolve = done
      })
    )
    const enabling = service.enable(connection.id)
    await service.replaceCredential(connection.id, 'rotated', 'user:user-1')
    resolve({ ok: true, grantedScopes: ['vault:read'] })
    await expect(enabling).rejects.toThrow('Connection changed during validation')
    expect(getRow()?.enabled).toBe(false)
  })
})
