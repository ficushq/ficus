import { describe, expect, test } from 'bun:test'
import { oauthPluginView } from './oauth-plugin-view'
import type { IntegrationPluginV1, ManagedOAuthDriver } from './plugin'
import { serializeOAuthCredential, type OAuthCredentialBundleV1 } from './authorization/credential-bundle'

interface FakeConfiguration {
  version: 1
  teamId: string
}

const sandbox = {
  packages: [],
  setupSteps: [],
  initHooks: [],
  readiness: [],
  skills: [],
  extensions: [],
  protectedBindings: [],
} as const

function oauthPlugin(): IntegrationPluginV1<FakeConfiguration, OAuthCredentialBundleV1> {
  return {
    manifestVersion: 1,
    key: 'fake-oauth',
    adapterVersion: 1,
    presentation: {
      label: 'Fake OAuth',
      description: 'Fake OAuth',
      icon: 'notion',
      connectionMode: 'oauth2',
      assignable: true,
      requiredCapabilities: [],
    },
    connection: {
      parseConfiguration: (value) => value as FakeConfiguration,
      safeConfiguration: (value) => value,
      credential: {
        parse: (value) => JSON.parse(value as string) as OAuthCredentialBundleV1,
        serialize: (value) => JSON.stringify(value),
      },
    },
    authorization: {
      kind: 'oauth2',
      adapter: 'fake',
      async validate() {
        return { ok: true, grantedScopes: [] }
      },
    },
    runtime: {
      provider: {
        key: 'fake-oauth',
        adapterVersion: 1,
        parseConfig: (value) => value as FakeConfiguration,
        validate: async () => ({ ok: true, grantedScopes: [] }),
        capabilities: {},
      },
    },
    sandbox,
    lifecycle: { refresh: true, revoke: true },
    classifyError: () => ({ code: 'provider_error', retryable: true }),
  }
}

function manualOnlyPlugin(): IntegrationPluginV1<FakeConfiguration, { token: string }> {
  return {
    manifestVersion: 1,
    key: 'fake-manual',
    adapterVersion: 1,
    presentation: {
      label: 'Fake Manual',
      description: 'Fake Manual',
      icon: 'discord',
      connectionMode: 'channel',
      assignable: false,
      requiredCapabilities: [],
    },
    connection: {
      parseConfiguration: (value) => value as FakeConfiguration,
      safeConfiguration: (value) => value,
      credential: { parse: (value) => value as { token: string }, serialize: (value) => JSON.stringify(value) },
    },
    authorization: { kind: 'manual' },
    runtime: {
      provider: {
        key: 'fake-manual',
        adapterVersion: 1,
        parseConfig: (value) => value as FakeConfiguration,
        validate: async () => ({ ok: true, grantedScopes: [] }),
        capabilities: {},
      },
    },
    sandbox,
    lifecycle: { refresh: false, revoke: false },
    classifyError: () => ({ code: 'provider_error', retryable: true }),
  }
}

function manualWithManagedPlugin(
  authorities: readonly ('local' | 'platform_broker')[]
): IntegrationPluginV1<FakeConfiguration, { token: string }> {
  const managed: ManagedOAuthDriver<FakeConfiguration> = {
    kind: 'oauth2',
    adapter: 'fake-managed',
    authorities,
    identity: (configuration) => ({ teamId: configuration.teamId }),
    validate: async () => ({ ok: true, grantedScopes: [] }),
  }
  const plugin = manualOnlyPlugin()
  return { ...plugin, key: 'fake-managed', authorization: { kind: 'manual', managed } }
}

describe('oauthPluginView', () => {
  test('a true OAuth2 plugin is returned as-is, for any authority', () => {
    const plugin = oauthPlugin()
    expect(oauthPluginView(plugin, 'local') === plugin).toBe(true)
    expect(oauthPluginView(plugin, 'platform_broker') === plugin).toBe(true)
  })

  test('a manual-only plugin has no OAuth view under any authority', () => {
    const plugin = manualOnlyPlugin()
    expect(oauthPluginView(plugin, 'local')).toBeUndefined()
    expect(oauthPluginView(plugin, 'platform_broker')).toBeUndefined()
  })

  test('a manual+managed plugin is viewable only under an authority its driver allows', () => {
    const plugin = manualWithManagedPlugin(['platform_broker'])
    expect(oauthPluginView(plugin, 'local')).toBeUndefined()
    const view = oauthPluginView(plugin, 'platform_broker')
    expect(view).toBeDefined()
    expect(view?.authorization.kind).toBe('oauth2')
    expect(view?.key).toBe('fake-managed')
  })

  test('the view swaps in the OAuth bundle codec without touching parseConfiguration', () => {
    const plugin = manualWithManagedPlugin(['platform_broker'])
    const view = oauthPluginView(plugin, 'platform_broker')!
    const bundle: OAuthCredentialBundleV1 = {
      version: 1,
      accessToken: 'access-token',
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    }
    const serialized = view.connection.credential.serialize(bundle)
    expect(view.connection.credential.parse(serialized)).toEqual(bundle)
    expect(serialized).toBe(serializeOAuthCredential(bundle))
    // parseConfiguration is untouched: still the plugin's own configuration parser.
    expect(view.connection.parseConfiguration({ version: 1, teamId: 'T1' })).toEqual({ version: 1, teamId: 'T1' })
  })

  test('managed OAuth views do not expose execution callbacks for the original manual credential', () => {
    const plugin: IntegrationPluginV1<FakeConfiguration, { token: string }> = {
      ...manualWithManagedPlugin(['platform_broker']),
      execution: { binaries: ['fake'], environment: { TOKEN: ({ credential }) => credential.token } },
    }
    const execution = plugin.execution!
    const view = oauthPluginView(plugin, 'platform_broker')!
    expect(view).not.toHaveProperty('execution')
    expect(plugin.execution).toBe(execution)
    expect(
      execution.environment.TOKEN!({
        configuration: { version: 1, teamId: 'T1' },
        credential: { token: 'synthetic-manual' },
      })
    ).toBe('synthetic-manual')
  })

  test('OAuth-independent plugin metadata survives the managed view unchanged', () => {
    const plugin = manualWithManagedPlugin(['platform_broker'])
    const view = oauthPluginView(plugin, 'platform_broker')!
    expect(view.presentation).toBe(plugin.presentation)
    expect(view.runtime).toBe(plugin.runtime)
    expect(view.sandbox).toBe(plugin.sandbox)
    expect(view.lifecycle).toBe(plugin.lifecycle)
  })
})
