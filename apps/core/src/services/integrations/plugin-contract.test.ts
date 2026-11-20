import { describe, expect, test } from 'bun:test'
import { bigbrainPlugin } from './bigbrain/plugin'
import { assertIntegrationPluginContract } from './plugin-contract'
import { notionPlugin } from './notion/plugin'
import { linearPlugin } from './linear/plugin'

const fixtures = {
  validConfiguration: {
    version: 2 as const,
    bindingId: 'approved',
    bindingFingerprint: 'a'.repeat(64),
    vaultPath: '/vault',
    executablePath: '/bin/bigbrain',
  },
  invalidConfigurations: [{ version: 1, apiBase: 'https://brain.example', extra: true }],
  credential: 'aabb0011',
  secretSentinels: ['aabb0011'],
}

describe('first-party integration plugin contract', () => {
  test('Notion strictly parses configuration and exposes only safe deterministic metadata', () => {
    expect(() =>
      assertIntegrationPluginContract(notionPlugin, {
        validConfiguration: {
          version: 1,
          workspaceId: 'workspace-1',
          workspaceName: 'Workspace',
          workspaceIcon: null,
          botId: 'bot-1',
        },
        invalidConfigurations: [{ version: 1, workspaceId: 'workspace-1', botId: 'bot-1', extra: true }],
        credential: {
          version: 1,
          accessToken: 'access-SENTINEL',
          refreshToken: 'refresh-SENTINEL',
          expiresAt: null,
          tokenRevision: 1,
        },
        secretSentinels: ['access-SENTINEL', 'refresh-SENTINEL'],
      })
    ).not.toThrow()
    expect(notionPlugin.lifecycle).toEqual({ refresh: true, revoke: true })
  })

  test('Linear accepts both connection modes and exposes no key or token', () => {
    const appConfiguration = {
      version: 2 as const,
      mode: 'app' as const,
      organizationId: 'org-1',
      organizationName: 'Acme',
      organizationUrlKey: 'acme',
      appUserId: 'app-user',
      appUserName: 'Ficus',
      scopes: ['read'],
    }
    for (const [validConfiguration, credential, secretSentinels] of [
      [{ version: 1 as const }, { kind: 'api-key' as const, key: 'lin_api_SENTINEL' }, ['lin_api_SENTINEL']],
      [
        appConfiguration,
        {
          kind: 'oauth' as const,
          bundle: {
            version: 1 as const,
            accessToken: 'access-SENTINEL',
            refreshToken: 'refresh-SENTINEL',
            expiresAt: null,
            tokenRevision: 1,
          },
        },
        ['access-SENTINEL', 'refresh-SENTINEL'],
      ],
    ] as const) {
      expect(() =>
        assertIntegrationPluginContract(linearPlugin, {
          validConfiguration,
          invalidConfigurations: [{ version: 1, extra: true }, { ...appConfiguration, mode: 'key' }],
          credential,
          secretSentinels,
        })
      ).not.toThrow()
    }
  })

  test('Bigbrain strictly parses configuration and exposes only safe deterministic metadata', () => {
    expect(() => assertIntegrationPluginContract(bigbrainPlugin, fixtures)).not.toThrow()
    expect(bigbrainPlugin.lifecycle).toEqual({ refresh: false, revoke: false })
    expect(bigbrainPlugin.classifyError(new Error('bearer-SENTINEL'))).toEqual({
      code: 'provider_error',
      retryable: true,
    })
  })
})
