import { describe, expect, test } from 'bun:test'
import { bigbrainPlugin } from './bigbrain/plugin'
import { assertIntegrationPluginContract } from './plugin-contract'
import { notionPlugin } from './notion/plugin'

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

  test('Bigbrain strictly parses configuration and exposes only safe deterministic metadata', () => {
    expect(() => assertIntegrationPluginContract(bigbrainPlugin, fixtures)).not.toThrow()
    expect(bigbrainPlugin.lifecycle).toEqual({ refresh: false, revoke: false })
    expect(bigbrainPlugin.classifyError(new Error('bearer-SENTINEL'))).toEqual({
      code: 'provider_error',
      retryable: true,
    })
  })
})
