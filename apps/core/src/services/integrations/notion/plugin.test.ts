import { describe, expect, test } from 'bun:test'
import { NotionClientError } from '@ficus/shared/oauth-providers/notion/client'
import { integrationRegistry } from '../runtime'
import { assertNotionIdentity } from './identity'
import { createNotionPlugin } from './plugin'

function createPlugin(overrides: Record<string, unknown> = {}) {
  return createNotionPlugin({
    currentBot: async () => ({ botId: 'bot-id' }),
    ...overrides,
  } as any)
}

describe('notionPlugin', () => {
  test('is registered as a first-party catalog plugin without native Ficus capabilities', () => {
    expect(integrationRegistry.catalog().map((entry) => entry.key)).toContain('notion')
    expect(integrationRegistry.require('notion', 1).capabilities).toEqual({})
  })

  test('declares the exact safe manifest and fixed CLI projection', () => {
    const plugin = createPlugin()
    expect({
      manifestVersion: plugin.manifestVersion,
      key: plugin.key,
      adapterVersion: plugin.adapterVersion,
      presentation: plugin.presentation,
      lifecycle: plugin.lifecycle,
    }).toEqual({
      manifestVersion: 1,
      key: 'notion',
      adapterVersion: 1,
      presentation: {
        label: 'Notion',
        description: 'Connect a Notion workspace for the Notion CLI.',
        icon: 'notion',
        connectionMode: 'oauth2',
        assignable: true,
        requiredCapabilities: ['Read content', 'Insert content', 'Update content'],
      },
      lifecycle: { refresh: true, revoke: true },
    })
    expect(plugin.sandbox.packages).toEqual(['nodejs@24.12.0'])
    expect(plugin.sandbox.setupSteps).toHaveLength(1)
    expect(plugin.sandbox.setupSteps[0].id).toBe('notion-cli@0.22.10')
    expect(plugin.sandbox.setupSteps[0].script).toContain('npm pack --silent ntn@0.22.10')
    expect(plugin.sandbox.protectedBindings).toEqual([
      { name: 'NOTION_API_TOKEN', source: { kind: 'oauth_access_token' } },
      { name: 'NOTION_WORKSPACE_ID', source: { kind: 'configuration', field: 'workspaceId' } },
    ])
    expect(plugin.runtime.provider.capabilities).toEqual({})
  })

  test('strictly parses configuration and exposes only normalized workspace presentation', () => {
    const plugin = createPlugin()
    const configuration = {
      version: 1 as const,
      workspaceId: 'workspace-id',
      workspaceName: 'Workspace',
      workspaceIcon: 'https://cdn.example/icon.png',
      botId: 'bot-id',
    }
    expect(plugin.connection.parseConfiguration(configuration)).toEqual(configuration)
    expect(plugin.connection.safeConfiguration(configuration)).toEqual({
      workspaceId: 'workspace-id',
      workspaceName: 'Workspace',
      workspaceIcon: 'https://cdn.example/icon.png',
    })
    expect(() => plugin.connection.parseConfiguration({ ...configuration, accessToken: 'TOKEN-SENTINEL' })).toThrow()
  })

  test('validates bot identity for a revision-one nullable-expiry bundle', async () => {
    const plugin = createPlugin()
    const grant = {
      configuration: {
        version: 1 as const,
        workspaceId: 'workspace-id',
        workspaceName: 'Workspace',
        workspaceIcon: 'https://cdn.example/icon.png',
        botId: 'bot-id',
      },
      credential: {
        version: 1 as const,
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: null,
        tokenRevision: 1,
      },
      displayName: 'Workspace',
    }
    expect(
      await plugin.authorization.validate({ configuration: grant.configuration, credential: grant.credential })
    ).toEqual({
      ok: true,
      grantedScopes: [],
    })

    const mismatch = createPlugin({ currentBot: async () => ({ botId: 'different-bot' }) })
    expect(
      await mismatch.authorization.validate({ configuration: grant.configuration, credential: grant.credential })
    ).toEqual({
      ok: false,
      code: 'workspace_identity_mismatch',
    })
  })

  test('refuses refresh metadata from another workspace or bot', () => {
    expect(() =>
      assertNotionIdentity(
        {
          version: 1,
          workspaceId: 'workspace-id',
          workspaceName: 'Workspace',
          workspaceIcon: null,
          botId: 'bot-id',
        },
        {
          version: 1,
          workspaceId: 'other-workspace',
          workspaceName: 'Workspace',
          workspaceIcon: null,
          botId: 'bot-id',
        }
      )
    ).toThrow(new NotionClientError('workspace_identity_mismatch'))
  })

  test('classifies only fixed Ficus-observed provider outcomes', () => {
    const plugin = createPlugin()
    expect(plugin.classifyError(new NotionClientError('restricted_resource', 403))).toEqual({
      code: 'capability_or_resource_denied',
      retryable: false,
    })
    expect(plugin.classifyError(new NotionClientError('invalid_auth', 401))).toEqual({
      code: 'invalid_auth',
      retryable: false,
    })
    expect(plugin.classifyError(new Error('TOKEN-SENTINEL'))).toEqual({
      code: 'provider_error',
      retryable: true,
    })
  })
})
