import { describe, expect, test } from 'bun:test'
import type { IntegrationPluginV1 } from '../plugin'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { ConnectionAuthorizationLease } from './connection-lease'
import { parseOAuthCredential, serializeOAuthCredential, type OAuthCredentialBundleV1 } from './credential-bundle'
import { IntegrationRefreshService, shouldProactivelyRefresh } from './refresh-service'
import { OAuthTransportError } from './transport'
import { PlatformRequestError } from '../../platform/instance-client'
import { BrokerUnconfiguredError } from './authority'
import { parseNotionConfiguration } from '@ficus/shared/oauth-providers/notion/config'

const connection: IntegrationConnectionRecord = {
  id: '80000000-0000-4000-8000-000000000001',
  providerKey: 'notion',
  adapterVersion: 1,
  clientAuthority: 'local',
  authorizationFlowId: null,
  displayName: 'Workspace',
  configuration: {
    version: 1,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    workspaceIcon: null,
    botId: 'bot-1',
  },
  credentialRef: '__integration-credential:test',
  materialRevision: '80000000-0000-4000-8000-000000000002',
  validatedRevision: '80000000-0000-4000-8000-000000000002',
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: [],
  validatedAt: new Date(),
  validationExpiresAt: new Date(Date.now() + 60_000),
  lastErrorCode: null,
  updatedAt: new Date(),
}

function initialCredential(overrides: Partial<OAuthCredentialBundleV1> = {}): OAuthCredentialBundleV1 {
  return {
    version: 1,
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: null,
    tokenRevision: 1,
    ...overrides,
  }
}

function createHarness(
  options: {
    rotatingProvider?: boolean
    onValidate?: (raw: string | undefined) => void
    refreshError?: Error
    refreshGate?: Promise<void>
    validation?: { ok: true; grantedScopes: string[] } | { ok: false; code: string }
    credential?: OAuthCredentialBundleV1
    clientAuthority?: 'local' | 'platform_broker'
    transportAuthority?: 'local' | 'platform_broker'
    reportedConfiguration?: unknown
    initiallyMissingCredential?: boolean
    onRefreshKey?: (calls: number) => void
    onTransportRefresh?: () => void
    markReauthorizationResult?: boolean
    recordValidationResult?: boolean
    recordValidationError?: Error
    recordRefreshFailureResult?: boolean
    invalidateError?: Error
    auditError?: Error
    operatorAlertError?: Error
    configuration?: unknown
  } = {}
) {
  const authoritativeRaw = serializeOAuthCredential(options.credential ?? initialCredential())
  let raw: string | undefined = options.initiallyMissingCredential ? undefined : authoritativeRaw
  let refreshCalls = 0
  let refreshKeyCalls = 0
  let credentialReads = 0
  const reauthorizationCodes: string[] = []
  const degradedCodes: string[] = []
  const successfulValidations: string[] = []
  const authenticationInvalidations: boolean[] = []
  const audits: unknown[] = []
  const invalidations: string[] = []
  const operationalIssues: Array<{ severity: string; connectionId: string; code: string }> = []
  const operatorAlerts: unknown[] = []

  const provider = {
    key: 'notion',
    adapterVersion: 1,
    parseConfig: parseNotionConfiguration,
    validate: async () => ({ ok: true as const, grantedScopes: [] }),
    capabilities: {},
  }
  const plugin: IntegrationPluginV1<{ workspaceId: string }, OAuthCredentialBundleV1> = {
    manifestVersion: 1,
    key: 'notion',
    adapterVersion: 1,
    presentation: {
      label: 'Notion',
      description: 'Notion',
      icon: 'notion',
      connectionMode: 'oauth2',
      assignable: true,
      requiredCapabilities: [],
    },
    connection: {
      parseConfiguration: provider.parseConfig,
      safeConfiguration: (value) => value,
      credential: { parse: parseOAuthCredential, serialize: serializeOAuthCredential },
    },
    authorization: {
      kind: 'oauth2',
      adapter: 'notion',
      refreshInvalidatesPreviousTokens: options.rotatingProvider,
      async validate() {
        options.onValidate?.(raw)
        return options.validation ?? { ok: true, grantedScopes: [] }
      },
    },
    runtime: { provider },
    sandbox: {
      packages: [],
      setupSteps: [],
      initHooks: [],
      readiness: [],
      skills: [],
      extensions: [],
      protectedBindings: [],
    },
    lifecycle: { refresh: true, revoke: true },
    classifyError(error) {
      if (error instanceof Error && error.message === 'invalid_grant') {
        return { code: 'invalid_grant', retryable: false }
      }
      if (error instanceof Error && error.message === 'workspace_identity_mismatch') {
        return { code: 'workspace_identity_mismatch', retryable: false }
      }
      return { code: 'provider_unavailable', retryable: true }
    },
  }

  const selectedConnection = {
    ...connection,
    clientAuthority: options.clientAuthority ?? 'local',
    configuration: options.configuration ?? connection.configuration,
  }
  const service = new IntegrationRefreshService({
    connections: {
      get: async () => selectedConnection,
      markReauthorizationRequired: async (_input) => {
        reauthorizationCodes.push(_input.code)
        return options.markReauthorizationResult ?? true
      },
      recordValidation: async (_input) => {
        successfulValidations.push(_input.id)
        if (options.recordValidationError) throw options.recordValidationError
        return options.recordValidationResult ?? true
      },
      recordRefreshFailure: async (_input) => {
        degradedCodes.push(_input.code)
        authenticationInvalidations.push(_input.invalidateAuthentication === true)
        return options.recordRefreshFailureResult ?? true
      },
    },
    credentials: {
      get: () => {
        credentialReads += 1
        return raw
      },
      refreshKey: async () => {
        refreshKeyCalls += 1
        if (raw === undefined) raw = authoritativeRaw
        options.onRefreshKey?.(refreshKeyCalls)
      },
      mutateSecret: async (_key, mutate) => {
        const next = mutate(raw)
        if (next !== undefined) raw = next
      },
    },
    resolvePlugin: () => plugin,
    transport: {
      authority: options.transportAuthority ?? 'local',
      async refresh() {
        refreshCalls += 1
        options.onTransportRefresh?.()
        if (options.refreshGate) await options.refreshGate
        if (options.refreshError) throw options.refreshError
        return {
          tokens: { accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: null },
          configuration: options.reportedConfiguration ?? selectedConnection.configuration,
          displayName: 'Workspace',
        }
      },
    },
    lease: new ConnectionAuthorizationLease(),
    invalidateAssignments: async (id) => {
      if (options.invalidateError) throw options.invalidateError
      invalidations.push(id)
    },
    audit: {
      record: async (event) => {
        if (options.auditError) throw options.auditError
        audits.push(event)
      },
    },
    operatorAlert: async (alert) => {
      operatorAlerts.push(alert)
      if (options.operatorAlertError) throw options.operatorAlertError
    },
    reportOperationalIssue: async (issue) => void operationalIssues.push(issue),
  })

  return {
    service,
    raw: () => raw,
    refreshCalls: () => refreshCalls,
    refreshKeyCalls: () => refreshKeyCalls,
    credentialReads: () => credentialReads,
    reauthorizationCodes,
    degradedCodes,
    successfulValidations,
    authenticationInvalidations,
    audits,
    invalidations,
    operationalIssues,
    operatorAlerts,
  }
}

describe('IntegrationRefreshService', () => {
  test('rotating providers persist the replacement pair before fallible identity validation', async () => {
    const harness = createHarness({
      rotatingProvider: true,
      validation: { ok: false, code: 'provider_unavailable' },
      onValidate(raw) {
        expect(parseOAuthCredential(raw).refreshToken).toBe('refresh-new')
      },
    })
    await harness.service.refresh(connection.id, 'explicit')
    expect(parseOAuthCredential(harness.raw()).refreshToken).toBe('refresh-new')
    expect(harness.authenticationInvalidations).toContain(true)
    expect(harness.successfulValidations).toEqual([])
  })

  test('authoritative in-lease refresh recovers an initially stale missing secret', async () => {
    const harness = createHarness({ initiallyMissingCredential: true })
    expect(await harness.service.refresh(connection.id, 'authentication_failure')).toEqual({ status: 'refreshed' })
    expect(harness.reauthorizationCodes).toEqual([])
    expect(harness.refreshCalls()).toBe(1)
    expect(parseOAuthCredential(harness.raw()!).accessToken).toBe('access-new')
  })

  test('nullable expiry is never proactively selected', () => {
    expect(shouldProactivelyRefresh(initialCredential(), new Date(), 5 * 60_000)).toBe(false)
    expect(
      shouldProactivelyRefresh(
        initialCredential({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        new Date(),
        5 * 60_000
      )
    ).toBe(true)
  })

  test('atomically rotates the access and refresh pair once across concurrent requests', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const harness = createHarness({ refreshGate: gate })
    const first = harness.service.refresh(connection.id, 'explicit')
    await Bun.sleep(25)
    const second = harness.service.refresh(connection.id, 'explicit')
    release()
    const results = await Promise.all([first, second])

    expect(results.map((result) => result.status).sort()).toEqual(['refreshed', 'unchanged'])
    expect(harness.refreshCalls()).toBe(1)
    expect(parseOAuthCredential(harness.raw())).toEqual({
      version: 1,
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: null,
      tokenRevision: 2,
    })
    expect(harness.invalidations).toEqual([connection.id])
    expect(harness.successfulValidations).toEqual([connection.id])
  })

  test('concurrent initially-missing cache rotates the provider exactly once', async () => {
    let release!: () => void
    let started!: () => void
    let secondSnapshot!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const transportStarted = new Promise<void>((resolve) => (started = resolve))
    const secondSnapshotReady = new Promise<void>((resolve) => (secondSnapshot = resolve))
    const harness = createHarness({
      initiallyMissingCredential: true,
      refreshGate: gate,
      onTransportRefresh: started,
      onRefreshKey: (calls) => {
        if (calls >= 3) secondSnapshot()
      },
    })
    const first = harness.service.refresh(connection.id, 'explicit')
    await transportStarted
    const second = harness.service.refresh(connection.id, 'explicit')
    await secondSnapshotReady
    release()
    const results = await Promise.all([first, second])

    expect(results.map((result) => result.status).sort()).toEqual(['refreshed', 'unchanged'])
    expect(harness.refreshCalls()).toBe(1)
    expect(parseOAuthCredential(harness.raw()!).tokenRevision).toBe(2)
    expect(harness.invalidations).toEqual([connection.id])
    expect(harness.successfulValidations).toEqual([connection.id])
  })

  test('missing local client credentials degrade while preserving the current material', async () => {
    const harness = createHarness({ refreshError: new OAuthTransportError('oauth_app_unconfigured') })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'degraded',
      code: 'oauth_app_unconfigured',
    })
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
    expect(harness.reauthorizationCodes).toEqual([])
    expect(harness.degradedCodes).toEqual(['oauth_app_unconfigured'])
  })

  test('broker outages and broker authentication failures degrade without rotating the existing token', async () => {
    for (const code of [
      'broker_unavailable',
      'broker_timeout',
      'operation_in_flight',
      'broker_unauthorized',
      'insufficient_scope',
    ]) {
      const harness = createHarness({
        clientAuthority: 'platform_broker',
        transportAuthority: 'platform_broker',
        refreshError: new PlatformRequestError(code, code !== 'broker_unauthorized' && code !== 'insufficient_scope'),
      })
      expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({ status: 'degraded', code })
      expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
      expect(harness.reauthorizationCodes).toEqual([])
      expect(harness.operationalIssues).toEqual(
        code === 'broker_unauthorized' || code === 'insufficient_scope'
          ? [{ severity: 'alert', connectionId: connection.id, code }]
          : []
      )
    }
  })

  test.each(['invalid_grant', 'refresh_ambiguous'])(
    'retryable broker %s body degrades and preserves the current token',
    async (code) => {
      const harness = createHarness({
        clientAuthority: 'platform_broker',
        transportAuthority: 'platform_broker',
        refreshError: new PlatformRequestError(code, true, 503),
      })
      expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({ status: 'degraded', code })
      expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
      expect(harness.reauthorizationCodes).toEqual([])
    }
  )

  test('broker access alert failure cannot change degraded token preservation', async () => {
    const harness = createHarness({
      clientAuthority: 'platform_broker',
      transportAuthority: 'platform_broker',
      refreshError: new PlatformRequestError('broker_unauthorized', false, 401),
      operatorAlertError: new Error('inbox unavailable'),
    })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'degraded',
      code: 'broker_unauthorized',
    })
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
    expect(harness.operatorAlerts).toEqual([
      {
        connectionId: connection.id,
        providerKey: 'notion',
        materialRevision: connection.materialRevision,
        safeCode: 'broker_unauthorized',
      },
    ])
  })

  test.each(['invalidation', 'audit'] as const)(
    'durable broker alert precedes failing post-persistence %s',
    async (failure) => {
      const harness = createHarness({
        clientAuthority: 'platform_broker',
        transportAuthority: 'platform_broker',
        refreshError: new PlatformRequestError('broker_unauthorized', false, 401),
        ...(failure === 'invalidation' ? { invalidateError: new Error('projection unavailable') } : {}),
        ...(failure === 'audit' ? { auditError: new Error('audit unavailable') } : {}),
      })
      await expect(
        harness.service.refresh(connection.id, failure === 'invalidation' ? 'authentication_failure' : 'explicit')
      ).rejects.toThrow()
      expect(harness.degradedCodes).toEqual(['broker_unauthorized'])
      expect(harness.operatorAlerts).toHaveLength(1)
      expect(harness.operationalIssues).toEqual([
        { severity: 'alert', connectionId: connection.id, code: 'broker_unauthorized' },
      ])
    }
  )

  test('missing broker configuration degrades and preserves the existing token', async () => {
    const harness = createHarness({
      clientAuthority: 'platform_broker',
      transportAuthority: 'platform_broker',
      refreshError: new BrokerUnconfiguredError(),
    })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'degraded',
      code: 'broker_unconfigured',
    })
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
  })

  test('invalid_grant and refresh_ambiguous are terminal for brokered refresh', async () => {
    for (const code of ['invalid_grant', 'refresh_ambiguous']) {
      const harness = createHarness({
        clientAuthority: 'platform_broker',
        transportAuthority: 'platform_broker',
        refreshError: new PlatformRequestError(code, false, 409),
      })
      expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
        status: 'reauthorization_required',
        code,
      })
      expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
    }
  })

  test('authority mismatch requires reauthorization before making a transport call', async () => {
    const harness = createHarness({ clientAuthority: 'local', transportAuthority: 'platform_broker' })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'reauthorization_required',
      code: 'client_authority_mismatch',
    })
    expect(harness.refreshCalls()).toBe(0)
    expect(harness.refreshKeyCalls()).toBe(0)
    expect(harness.credentialReads()).toBe(0)
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
    expect(harness.operationalIssues).toEqual([
      { severity: 'error', connectionId: connection.id, code: 'client_authority_mismatch' },
    ])
  })

  test('authority mismatch CAS loss returns connection_changed without stale side effects', async () => {
    const harness = createHarness({
      clientAuthority: 'local',
      transportAuthority: 'platform_broker',
      markReauthorizationResult: false,
    })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'unchanged',
      code: 'connection_changed',
    })
    expect(harness.refreshKeyCalls()).toBe(0)
    expect(harness.credentialReads()).toBe(0)
    expect(harness.invalidations).toEqual([])
    expect(harness.audits).toEqual([])
    expect(harness.operationalIssues).toEqual([])
  })

  test('post-rotation validation CAS loss preserves the committed token without stale side effects', async () => {
    const harness = createHarness({ recordValidationResult: false })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'unchanged',
      code: 'connection_changed',
    })
    expect(parseOAuthCredential(harness.raw())).toEqual(
      initialCredential({
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        tokenRevision: 2,
      })
    )
    expect(harness.invalidations).toEqual([])
    expect(harness.audits).toEqual([])
  })

  test('post-rotation repository failure reports committed refresh success for reconciliation', async () => {
    const harness = createHarness({ recordValidationError: new Error('database unavailable') })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'refreshed',
      code: 'post_commit_reconciliation_required',
    })
    expect(parseOAuthCredential(harness.raw()).tokenRevision).toBe(2)
    expect(harness.invalidations).toEqual([])
    expect(harness.audits).toEqual([])
    expect(harness.operationalIssues).toEqual([
      { severity: 'error', connectionId: connection.id, code: 'post_commit_reconciliation_required' },
    ])
  })

  test.each(['projection', 'audit'] as const)(
    'post-commit %s failure reports committed refresh success for reconciliation',
    async (failure) => {
      const harness = createHarness({
        ...(failure === 'projection'
          ? { invalidateError: new Error('projection unavailable') }
          : { auditError: new Error('audit unavailable') }),
      })
      expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
        status: 'refreshed',
        code: 'post_commit_side_effect_failed',
      })
      expect(parseOAuthCredential(harness.raw()).tokenRevision).toBe(2)
      expect(harness.operationalIssues).toEqual([
        { severity: 'error', connectionId: connection.id, code: 'post_commit_side_effect_failed' },
      ])
    }
  )

  test('refresh failure CAS loss returns connection_changed without stale invalidation or audit', async () => {
    const harness = createHarness({
      refreshError: new Error('transient'),
      recordRefreshFailureResult: false,
    })
    expect(await harness.service.refresh(connection.id, 'authentication_failure')).toEqual({
      status: 'unchanged',
      code: 'connection_changed',
    })
    expect(harness.invalidations).toEqual([])
    expect(harness.audits).toEqual([])
  })

  test('operation in flight remains degraded even when the broker marks it non-retryable', async () => {
    const harness = createHarness({
      clientAuthority: 'platform_broker',
      transportAuthority: 'platform_broker',
      refreshError: new PlatformRequestError('operation_in_flight', false, 409),
    })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'degraded',
      code: 'operation_in_flight',
    })
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
    expect(harness.reauthorizationCodes).toEqual([])
  })

  test('operation key conflicts degrade and emit a sanitized operational error', async () => {
    const harness = createHarness({
      clientAuthority: 'platform_broker',
      transportAuthority: 'platform_broker',
      refreshError: new PlatformRequestError('operation_key_conflict', false, 409),
    })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'degraded',
      code: 'operation_key_conflict',
    })
    expect(harness.operationalIssues).toEqual([
      { severity: 'error', connectionId: connection.id, code: 'operation_key_conflict' },
    ])
    expect(JSON.stringify(harness.operationalIssues)).not.toContain('access-old')
    expect(JSON.stringify(harness.operationalIssues)).not.toContain('refresh-old')
  })

  test('malformed persisted configuration requires reauthorization before provider transport', async () => {
    const harness = createHarness({ configuration: { version: 1, workspaceId: 42 } })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'reauthorization_required',
      code: 'invalid_configuration',
    })
    expect(harness.refreshCalls()).toBe(0)
    expect(harness.reauthorizationCodes).toEqual(['invalid_configuration'])
  })

  test('provider-reported workspace identity is checked before rotating brokered credentials', async () => {
    const harness = createHarness({
      clientAuthority: 'platform_broker',
      transportAuthority: 'platform_broker',
      reportedConfiguration: {
        ...(connection.configuration as Record<string, unknown>),
        workspaceId: 'other-workspace',
      },
    })
    expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({
      status: 'reauthorization_required',
      code: 'workspace_identity_mismatch',
    })
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
  })

  test('missing refresh token and invalid_grant require reauthorization without retry', async () => {
    const missing = createHarness({ credential: initialCredential({ refreshToken: null }) })
    expect((await missing.service.refresh(connection.id, 'explicit')).status).toBe('reauthorization_required')
    expect(missing.reauthorizationCodes).toEqual(['refresh_token_unavailable'])
    expect(missing.invalidations).toEqual([connection.id])

    const invalid = createHarness({ refreshError: new Error('invalid_grant') })
    expect((await invalid.service.refresh(connection.id, 'explicit')).status).toBe('reauthorization_required')
    expect(invalid.reauthorizationCodes).toEqual(['invalid_grant'])
    expect(invalid.invalidations).toEqual([connection.id])
    expect(parseOAuthCredential(invalid.raw()).tokenRevision).toBe(1)
  })

  test('transient failure degrades without changing an unknown-expiry credential', async () => {
    const harness = createHarness({ refreshError: new Error('network body TOKEN-SENTINEL') })
    expect((await harness.service.refresh(connection.id, 'authentication_failure')).status).toBe('degraded')
    expect(harness.degradedCodes).toEqual(['provider_unavailable'])
    expect(harness.authenticationInvalidations).toEqual([true])
    expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
    expect(harness.invalidations).toEqual([connection.id])
    expect(JSON.stringify(harness.audits)).not.toContain('TOKEN-SENTINEL')
  })

  test('transient proactive failure retains a still-valid token but deprojects an expired token', async () => {
    const future = createHarness({
      refreshError: new Error('network'),
      credential: initialCredential({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    })
    await future.service.refresh(connection.id, 'proactive')
    expect(future.invalidations).toEqual([])
    expect(future.authenticationInvalidations).toEqual([false])

    const expired = createHarness({
      refreshError: new Error('network'),
      credential: initialCredential({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    })
    await expired.service.refresh(connection.id, 'proactive')
    expect(expired.invalidations).toEqual([connection.id])
    expect(expired.authenticationInvalidations).toEqual([true])
  })

  test.each(['provider_unavailable', 'invalid_auth', 'invalid_grant'])(
    'non-identity candidate validation %s retains the authoritative bundle',
    async (code) => {
      const harness = createHarness({ validation: { ok: false, code } })
      expect(await harness.service.refresh(connection.id, 'explicit')).toEqual({ status: 'degraded', code })
      expect(parseOAuthCredential(harness.raw())).toEqual(initialCredential())
      expect(harness.reauthorizationCodes).toEqual([])
      expect(harness.degradedCodes).toEqual([code])
    }
  )

  test('validates rotated identity before installing the pair', async () => {
    const harness = createHarness({ validation: { ok: false, code: 'workspace_mismatch' } })
    expect((await harness.service.refresh(connection.id, 'explicit')).status).toBe('reauthorization_required')
    expect(harness.reauthorizationCodes).toEqual(['workspace_mismatch'])
    expect(harness.invalidations).toEqual([connection.id])
    expect(parseOAuthCredential(harness.raw()).tokenRevision).toBe(1)
  })
})
