import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstPartyIntegrationPlugin } from '../first-party-plugins'
import { projectIntegrationAssignments } from '../projection/projector'
import { LINEAR_CLI_RELEASE } from './cli'
import { linearWrite, type LinearWriteError } from './write-api'
import {
  createLinearPlugin,
  linearAuthorization,
  linearCredentialCodec,
  linearPlugin,
  LinearInsufficientScopeError,
  linearQuery,
  parseLinearConfiguration,
} from './plugin'
import { LinearOAuthError } from '@ficus/shared/oauth-providers/linear/client'
import { connectionOAuthView, oauthPluginView, refreshableOAuthProviderKeys } from '../oauth-plugin-view'
import { BrokerUnconfiguredError } from '../authorization/authority'
import { PlatformRequestError } from '../../platform/instance-client'
import { OAuthTransportError } from '../authorization/transport'
import { IntegrationAuthorizationService } from '../authorization/service'
import type { OAuthTransport } from '../authorization/transport'

const bundle = {
  version: 1 as const,
  accessToken: 'synthetic-oauth-token',
  refreshToken: 'synthetic-refresh-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  tokenRevision: 1,
}
const appConfiguration = {
  version: 2 as const,
  mode: 'app' as const,
  organizationId: 'org-1',
  organizationName: 'Acme',
  organizationUrlKey: 'acme',
  appUserId: 'app-user',
  appUserName: 'Ficus',
  scopes: ['read', 'write', 'app:assignable', 'app:mentionable'],
}
const identity = {
  appUserId: 'app-user',
  appUserName: 'Ficus',
  organizationId: 'org-1',
  organizationName: 'Acme',
  organizationUrlKey: 'acme',
}

const repoRoot = join(import.meta.dir, '../../../../../..')

test('Linear checks GraphQL errors and validates an API key without leaking provider error text', async () => {
  const old = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      Response.json({ errors: [{ message: 'sensitive provider detail' }] })) as unknown as typeof fetch
    await expect(linearQuery('test-key', '{}')).rejects.toThrow('provider_query_failed')
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe('https://api.linear.app/graphql')
      expect(new Headers(init?.headers).get('Authorization')).toBe('test-key')
      return Response.json({ data: { viewer: { id: 'viewer' } } })
    }) as typeof fetch
    expect(
      await linearPlugin.runtime.provider.validate({ credential: 'test-key', configuration: { version: 1 } } as never)
    ).toEqual({ ok: true, grantedScopes: ['issues:read'] })
  } finally {
    globalThis.fetch = old
  }
})

describe('linearPlugin CLI projection', () => {
  test('is registered with the read and write capability claim and unchanged API-key connection mode', () => {
    expect(firstPartyIntegrationPlugin('linear')).toBe(linearPlugin)
    expect(linearPlugin.presentation).toEqual({
      label: 'Linear',
      description:
        'Connect issue tracking, route assignments to squads, search Linear issues, and let agents read, create, update and comment on issues with the Linear CLI.',
      icon: 'linear',
      connectionMode: 'credential',
      assignable: true,
      requiredCapabilities: ['issues:read', 'issues:write', 'comments:write'],
    })
    // API-key entry stays manual; the agent app is the managed OAuth driver beside it.
    expect(linearPlugin.authorization.kind).toBe('manual')
    expect(linearPlugin.authorization.managed).toMatchObject({
      kind: 'oauth2',
      adapter: 'linear',
      refreshInvalidatesPreviousTokens: true,
    })
    // Refresh and revocation act only on app (`oauth2`) connections.
    expect(linearPlugin.lifecycle).toEqual({ refresh: true, revoke: true })
    expect(linearPlugin.runtime.provider.outputs).toBeDefined()
  })

  test('wraps the linear binary and injects the credential verbatim with env-file loading off and a pinned endpoint', () => {
    expect(linearPlugin.execution?.binaries).toEqual(['linear'])
    const environment = linearPlugin.execution!.environment
    expect(Object.keys(environment).sort()).toEqual([
      'LINEAR_API_KEY',
      'LINEAR_GRAPHQL_ENDPOINT',
      'LINEAR_IGNORE_ENV_FILE',
    ])
    const resolve = (raw: string) =>
      Object.fromEntries(
        Object.entries(environment).map(([name, value]) => [
          name,
          value({ credential: linearCredentialCodec.parse(raw), configuration: { version: 1 } }),
        ])
      )
    expect(resolve('lin_api_synthetic-key')).toEqual({
      LINEAR_API_KEY: 'lin_api_synthetic-key',
      LINEAR_IGNORE_ENV_FILE: '1',
      LINEAR_GRAPHQL_ENDPOINT: 'https://api.linear.app/graphql',
    })
    // An app connection's bundle becomes a complete Bearer Authorization value.
    expect(resolve(JSON.stringify(bundle)).LINEAR_API_KEY).toBe('Bearer synthetic-oauth-token')
  })

  test('installs a pinned, digest-checked release with a version readiness check and the linear skill', () => {
    expect(LINEAR_CLI_RELEASE.version).toBe('3.1.0')
    expect(linearPlugin.sandbox.packages).toEqual(['nodejs@24.12.0', 'xz@5.8.3'])
    expect(linearPlugin.sandbox.setupSteps).toHaveLength(1)
    const [step] = linearPlugin.sandbox.setupSteps
    expect(step!.id).toBe('linear-cli@3.1.0')
    for (const asset of Object.values(LINEAR_CLI_RELEASE.assets)) {
      expect(asset.url).toStartWith('https://github.com/schpet/linear-cli/releases/download/v3.1.0/')
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(step!.script).toContain(`url='${asset.url}'; digest='${asset.sha256}'`)
    }
    expect(step!.script).toContain('if [ "$actual" != "$digest" ]')
    expect(step!.script).not.toContain('npm install')
    expect(step!.script).not.toContain('@latest')
    expect(linearPlugin.sandbox.initHooks).toEqual(['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'])
    expect(linearPlugin.sandbox.readiness).toEqual([
      { id: 'linear-cli', command: 'linear --version', expectedSubstring: 'linear 3.1.0' },
    ])
    expect(linearPlugin.sandbox.skills).toEqual(['linear'])
    expect(linearPlugin.sandbox.protectedBindings).toEqual([
      {
        name: 'LINEAR_ORGANIZATION_URL_KEY',
        source: { kind: 'configuration', field: 'organizationUrlKey' },
        optional: true,
      },
    ])
    expect(existsSync(join(repoRoot, 'config/skills/linear/SKILL.md'))).toBe(true)
  })

  test('projects the CLI and skill without any credential in the public declaration', () => {
    const projection = projectIntegrationAssignments([
      { plugin: linearPlugin, connection: { id: 'linear-connection', configuration: { version: 1 } } } as any,
    ])
    expect(projection.publicDeclaration.skills).toEqual(['linear'])
    expect(projection.publicDeclaration.readiness).toContainEqual({
      id: 'linear-cli',
      command: 'linear --version',
      expectedSubstring: 'linear 3.1.0',
    })
    expect(projection.publicDeclaration.setupSteps.map((step) => step.id)).toEqual(['linear-cli@3.1.0'])
    expect(JSON.stringify(projection.publicDeclaration)).not.toContain('LINEAR_API_KEY')
  })

  test('the linear skill keeps authentication with Ficus and states the write rules', () => {
    const skill = readFileSync(join(repoRoot, 'config/skills/linear/SKILL.md'), 'utf8')
    expect(skill).toStartWith('---\nname: linear\n')
    for (const phrase of [
      'linear auth login',
      'LINEAR_API_KEY',
      '--json',
      'linear api',
      'explicit confirmation',
      'workflow state',
      'delegate',
      '--workspace',
    ])
      expect(skill).toContain(phrase)
  })
})

describe('Linear credential codec', () => {
  test('keeps existing raw API keys unchanged and parses OAuth bundles', () => {
    expect(linearCredentialCodec.parse('lin_api_synthetic')).toEqual({ kind: 'api-key', key: 'lin_api_synthetic' })
    expect(linearCredentialCodec.serialize({ kind: 'api-key', key: 'lin_api_synthetic' })).toBe('lin_api_synthetic')
    // Stored keys are trimmed exactly as the API-key codec always did.
    expect(linearCredentialCodec.parse('  lin_api_padded \n')).toEqual({ kind: 'api-key', key: 'lin_api_padded' })
    const raw = JSON.stringify(bundle)
    expect(linearCredentialCodec.parse(raw)).toEqual({ kind: 'oauth', bundle })
    expect(JSON.parse(linearCredentialCodec.serialize({ kind: 'oauth', bundle }))).toEqual(bundle)
    expect(() => linearCredentialCodec.parse('')).toThrow()
    expect(() => linearCredentialCodec.parse(undefined)).toThrow()
  })

  test('builds the Authorization value for each mode', () => {
    expect(linearAuthorization({ kind: 'api-key', key: 'lin_api_synthetic' })).toBe('lin_api_synthetic')
    expect(linearAuthorization({ kind: 'oauth', bundle })).toBe('Bearer synthetic-oauth-token')
  })

  test('linearQuery sends the helper value verbatim as the Authorization header', async () => {
    const old = globalThis.fetch
    try {
      globalThis.fetch = (async (_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-oauth-token')
        return Response.json({ data: { viewer: { id: 'app-user' } } })
      }) as typeof fetch
      expect(await linearQuery(linearAuthorization({ kind: 'oauth', bundle }), '{ viewer { id } }')).toEqual({
        viewer: { id: 'app-user' },
      })
    } finally {
      globalThis.fetch = old
    }
  })
})

describe('Linear scope refusals', () => {
  // Linear's answer when the app token lacks `write`, as recorded live: FORBIDDEN, sent with HTTP 400.
  const refusal = {
    errors: [
      {
        message: 'Invalid scope: `write` required',
        extensions: { type: 'forbidden', code: 'FORBIDDEN', statusCode: 403, userError: true },
      },
    ],
  }

  test('linearQuery reports insufficient_scope for the refusal at HTTP 400, 403 or 200', async () => {
    const old = globalThis.fetch
    try {
      for (const status of [400, 403, 200]) {
        globalThis.fetch = (async () => Response.json(refusal, { status })) as unknown as typeof fetch
        const error = await linearQuery('Bearer t', 'mutation { x }').catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(LinearInsufficientScopeError)
        expect((error as Error).message).toBe('insufficient_scope')
      }
      // Other refusals keep their codes.
      globalThis.fetch = (async () =>
        Response.json({ errors: [{ message: 'no' }] }, { status: 403 })) as unknown as typeof fetch
      await expect(linearQuery('Bearer t', '{}')).rejects.toThrow('invalid_auth')
      globalThis.fetch = (async () =>
        Response.json({ errors: [{ message: 'no' }] }, { status: 400 })) as unknown as typeof fetch
      await expect(linearQuery('Bearer t', '{}')).rejects.toThrow('provider_unavailable')
    } finally {
      globalThis.fetch = old
    }
  })

  test('linearWrite classifies the refusal as insufficient_scope, not a lost session', async () => {
    const old = globalThis.fetch
    try {
      for (const status of [400, 403, 200]) {
        globalThis.fetch = (async () => Response.json(refusal, { status })) as unknown as typeof fetch
        const error = (await linearWrite('Bearer t', 'mutation { x }', {}).catch(
          (caught: unknown) => caught
        )) as LinearWriteError
        expect(error.code).toBe('insufficient_scope')
        expect(error.permanent).toBe(false)
      }
      globalThis.fetch = (async () =>
        Response.json(
          { errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }] },
          { status: 403 }
        )) as unknown as typeof fetch
      expect(
        ((await linearWrite('Bearer t', 'mutation { x }', {}).catch((caught: unknown) => caught)) as LinearWriteError)
          .code
      ).toBe('forbidden')
    } finally {
      globalThis.fetch = old
    }
  })

  test('marks only an app connection for reconnect, at its current revision', async () => {
    const { markLinearScopeMissing } = await import('./scope-health')
    const marks: unknown[] = []
    const repository = (connection: Record<string, unknown> | null) => ({
      get: async () => connection as never,
      markReauthorizationRequired: async (input: unknown) => {
        marks.push(input)
        return true
      },
    })
    const app = {
      id: 'app',
      providerKey: 'linear',
      authorizationKind: 'oauth2',
      authState: 'authenticated',
      materialRevision: 'rev-2',
    }
    expect(await markLinearScopeMissing('app', { repository: repository(app) })).toBe(true)
    expect(marks).toEqual([{ id: 'app', materialRevision: 'rev-2', code: 'insufficient_scope' }])
    // Already waiting for reconnect: nothing more to record.
    expect(
      await markLinearScopeMissing('app', { repository: repository({ ...app, authState: 'reauthorization_required' }) })
    ).toBe(true)
    // A personal API key cannot gain a scope by reconnecting; a missing or foreign connection is ignored.
    expect(
      await markLinearScopeMissing('key', { repository: repository({ ...app, authorizationKind: 'manual' }) })
    ).toBe(false)
    expect(await markLinearScopeMissing('gone', { repository: repository(null) })).toBe(false)
    expect(await markLinearScopeMissing('gh', { repository: repository({ ...app, providerKey: 'github' }) })).toBe(
      false
    )
    expect(marks).toHaveLength(1)
    // A repository failure never escapes into the caller's write path.
    expect(
      await markLinearScopeMissing('app', {
        repository: {
          get: async () => {
            throw new Error('db down')
          },
          markReauthorizationRequired: async () => true,
        },
      })
    ).toBe(false)
  })
})

describe('Linear configuration', () => {
  test('accepts the unchanged API-key shape and the app shape, and hides app scopes', () => {
    expect(parseLinearConfiguration({ version: 1 })).toEqual({ version: 1 })
    expect(parseLinearConfiguration(appConfiguration)).toEqual(appConfiguration)
    expect(() => parseLinearConfiguration({ version: 1, extra: true })).toThrow()
    expect(() => parseLinearConfiguration({ ...appConfiguration, mode: 'key' })).toThrow()
    expect(linearPlugin.connection.safeConfiguration({ version: 1 })).toEqual({ version: 1 })
    expect(linearPlugin.connection.safeConfiguration(appConfiguration)).not.toHaveProperty('scopes')
  })

  test('projects the workspace URL key only for app connections', async () => {
    const apiKey = projectIntegrationAssignments([
      { plugin: linearPlugin, connection: { id: 'key', configuration: { version: 1 } } } as any,
    ])
    expect(apiKey.publicDeclaration.protectedBindingNames).toEqual([])
    const app = projectIntegrationAssignments([
      { plugin: linearPlugin, connection: { id: 'app', configuration: appConfiguration } } as any,
    ])
    expect(app.publicDeclaration.protectedBindingNames).toEqual(['LINEAR_ORGANIZATION_URL_KEY'])
    expect(await app.privateMaterial.bindings.get('LINEAR_ORGANIZATION_URL_KEY')?.()).toBe('acme')
  })
})

describe('Linear app availability', () => {
  function startService(authority: 'local' | 'platform_broker', failure?: Error) {
    const urls: string[] = []
    const transport = {
      authority,
      requireConfigured() {
        if (failure instanceof OAuthTransportError) throw failure
      },
      async authorizationUrl(input: { localFlowId: string }) {
        if (failure) throw failure
        urls.push(input.localFlowId)
        return {
          authorizationUrl: `https://linear.app/oauth/authorize?state=${input.localFlowId}`,
          expiresAt: '2030-01-01T00:10:00.000Z',
        }
      },
      async completeAuthorization() {
        throw new Error('unused')
      },
      async refresh() {
        throw new Error('unused')
      },
      async revoke() {},
    } as unknown as OAuthTransport
    const service = new IntegrationAuthorizationService({
      states: { create: async () => {} } as never,
      resolvePlugin: (key) => (key === 'linear' ? linearPlugin : undefined),
      transport,
      callbackUrl: () => 'https://ficus.example/settings/integrations/oauth/callback/linear',
      installGrant: async () => {
        throw new Error('unused')
      },
      randomBytes: () => Buffer.alloc(32, 7),
    })
    const start = () =>
      service.start({ providerKey: 'linear', userId: 'user-1', returnTo: '/settings', intent: { kind: 'connect' } })
    return { start, urls }
  }

  test('is offered under both authorities, so an install can start on self-hosted and hosted instances', async () => {
    expect(linearPlugin.authorization.managed.authorities).toEqual(['platform_broker', 'local'])
    for (const authority of ['local', 'platform_broker'] as const) {
      expect(oauthPluginView(linearPlugin, authority)).toBeDefined()
      const { start, urls } = startService(authority)
      expect((await start()).authorizationUrl).toStartWith('https://linear.app/oauth/authorize')
      expect(urls).toHaveLength(1)
    }
  })

  test('a hosted install fails with broker_unconfigured when Platform has no Linear application', async () => {
    for (const failure of [new PlatformRequestError('broker_unconfigured', true, 503), new BrokerUnconfiguredError()]) {
      const { start, urls } = startService('platform_broker', failure)
      expect(((await start().catch((caught: unknown) => caught)) as { code?: string }).code).toBe('broker_unconfigured')
      expect(urls).toEqual([])
    }
  })

  test('a self-hosted install fails with oauth_app_unconfigured until the Linear application is saved', async () => {
    const { start, urls } = startService('local', new OAuthTransportError('oauth_app_unconfigured'))
    expect(((await start().catch((caught: unknown) => caught)) as { code?: string }).code).toBe(
      'oauth_app_unconfigured'
    )
    expect(urls).toEqual([])
  })

  test('API-key connections are unchanged', async () => {
    const old = globalThis.fetch
    try {
      globalThis.fetch = (async () => Response.json({ data: { viewer: { id: 'viewer' } } })) as unknown as typeof fetch
      const validate = () =>
        linearPlugin.runtime.provider.validate({
          connection: { id: 'c', providerKey: 'linear', adapterVersion: 1, configuration: { version: 1 } },
          credential: 'lin_api_synthetic',
        } as never)
      expect(await validate()).toEqual({ ok: true, grantedScopes: ['issues:read'] })
    } finally {
      globalThis.fetch = old
    }
  })
})

describe('Linear app driver', () => {
  const fakeClient = (result: typeof identity | Error) => {
    const calls: string[] = []
    return {
      calls,
      client: {
        async identity(input: { accessToken: string }) {
          calls.push(input.accessToken)
          if (result instanceof Error) throw result
          return result
        },
      },
    }
  }

  test('identifies a connection by organization and resolves the grant identity', async () => {
    const { client, calls } = fakeClient(identity)
    const driver = createLinearPlugin({ client }).authorization.managed
    expect(driver.identity!(appConfiguration)).toEqual({ organizationId: 'org-1' })
    // No scopes reported (a broker that does not pass them on): the requested set is recorded.
    expect(await driver.resolveGrantIdentity!(bundle)).toEqual({
      configuration: appConfiguration,
      displayName: 'Acme (Ficus app)',
    })
    expect(calls).toEqual(['synthetic-oauth-token'])
  })

  test('records the scopes Linear granted, so an install without write shows up as missing it', async () => {
    const driver = createLinearPlugin({ client: fakeClient(identity).client }).authorization.managed
    const granted = { version: 'linear-grant', scopes: ['read', 'issues:create', 'app:assignable', 'app:mentionable'] }
    expect(driver.grantNeedsIdentity!(granted)).toBe(true)
    expect(driver.grantNeedsIdentity!(appConfiguration)).toBe(false)
    const resolved = await driver.resolveGrantIdentity!(bundle, granted)
    expect(resolved.configuration).toEqual({ ...appConfiguration, scopes: granted.scopes })
    expect(linearPlugin.connection.safeConfiguration(resolved.configuration)).toMatchObject({
      missingScopes: ['write'],
    })
    expect(linearPlugin.connection.safeConfiguration(appConfiguration)).toMatchObject({ missingScopes: [] })
  })

  test('validates the app user, the app flag and the organization', async () => {
    const valid = createLinearPlugin({ client: fakeClient(identity).client }).authorization.managed
    expect(await valid.validate({ configuration: appConfiguration, credential: bundle })).toEqual({
      ok: true,
      grantedScopes: ['issues:read', 'issues:write', 'comments:write'],
    })
    for (const changed of [{ appUserId: 'other-app-user' }, { organizationId: 'org-2' }]) {
      const driver = createLinearPlugin({ client: fakeClient({ ...identity, ...changed }).client }).authorization
        .managed
      expect(await driver.validate({ configuration: appConfiguration, credential: bundle })).toEqual({
        ok: false,
        code: 'workspace_identity_mismatch',
      })
    }
    // The client refuses a token whose viewer is not an app user.
    const person = createLinearPlugin({ client: fakeClient(new LinearOAuthError('not_app_actor')).client })
      .authorization.managed
    expect(await person.validate({ configuration: appConfiguration, credential: bundle })).toEqual({
      ok: false,
      code: 'workspace_identity_mismatch',
    })
    const revoked = createLinearPlugin({ client: fakeClient(new LinearOAuthError('invalid_auth', 401)).client })
      .authorization.managed
    expect(await revoked.validate({ configuration: appConfiguration, credential: bundle })).toEqual({
      ok: false,
      code: 'invalid_auth',
    })
  })

  test('a renamed workspace refreshes the stored names for the same IDs', async () => {
    const driver = createLinearPlugin({
      client: fakeClient({ ...identity, organizationName: 'Acme Inc', organizationUrlKey: 'acme-inc' }).client,
    }).authorization.managed
    expect(await driver.validate({ configuration: appConfiguration, credential: bundle })).toEqual({
      ok: true,
      grantedScopes: ['issues:read', 'issues:write', 'comments:write'],
      configuration: { ...appConfiguration, organizationName: 'Acme Inc', organizationUrlKey: 'acme-inc' },
    })
  })

  test('runtime validation requires the credential to match the connection mode', async () => {
    const plugin = createLinearPlugin({ client: fakeClient(identity).client })
    const validate = (configuration: unknown, credential: string) =>
      plugin.runtime.provider.validate({
        connection: { id: 'c', providerKey: 'linear', adapterVersion: 1, configuration },
        credential,
      } as never)
    expect(await validate(appConfiguration, JSON.stringify(bundle))).toMatchObject({ ok: true })
    expect(await validate(appConfiguration, 'lin_api_synthetic')).toEqual({ ok: false, code: 'invalid_auth' })
    expect(await validate({ version: 1 }, JSON.stringify(bundle))).toEqual({ ok: false, code: 'invalid_auth' })
  })

  test('manual connections get no OAuth view; app connections get the managed driver under both authorities', () => {
    expect(connectionOAuthView(linearPlugin, { authorizationKind: 'manual', clientAuthority: 'local' })).toBeUndefined()
    for (const clientAuthority of ['local', 'platform_broker'] as const) {
      const view = connectionOAuthView(linearPlugin, { authorizationKind: 'oauth2', clientAuthority })
      expect(view?.authorization.adapter).toBe('linear')
      expect(view?.connection.credential.parse(JSON.stringify(bundle))).toEqual(bundle)
    }
    expect(refreshableOAuthProviderKeys([linearPlugin])).toEqual(['linear'])
  })

  test('classifies OAuth failures so a lost refresh grant needs reauthorization', () => {
    expect(linearPlugin.classifyError(new LinearOAuthError('invalid_grant'))).toEqual({
      code: 'invalid_grant',
      retryable: false,
    })
    expect(linearPlugin.classifyError(new LinearOAuthError('rate_limited', 429, true, 30))).toEqual({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 30_000,
    })
    expect(linearPlugin.classifyError(new Error('lin_api_secret-sentinel'))).toEqual({
      code: 'provider_error',
      retryable: true,
    })
  })
})
