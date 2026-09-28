import type { IntegrationPluginV1, OAuth2Authorization } from '../plugin'
import type { ProviderValidation } from '../types'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from '../authorization/credential-bundle'
import { NotionClient } from '@ficus/shared/oauth-providers/notion/client'
import { classifyNotionError } from '@ficus/shared/oauth-providers'
import {
  parseNotionConfiguration,
  safeNotionConfiguration,
  type NotionConnectionConfiguration,
} from '@ficus/shared/oauth-providers/notion/config'

const CLI_INTEGRITY = 'f7HzeXdh9MPn67Bwlryh28v7ljy9i5yoibA67wFYqh7vezlh4aXCiEonVPuyrkSsv05i6PDITh5UiL/Xk+4i5w=='
const CLI_SETUP_SCRIPT = [
  'archive=$(npm pack --silent ntn@0.22.10)',
  `actual=$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64'))" "$archive")`,
  `test "$actual" = "${CLI_INTEGRITY}"`,
  'npm install --global --prefix "$DEVBOX_PROJECT_ROOT/npm" --no-audit --no-fund "./$archive"',
  'rm -f -- "$archive"',
].join('\n')

type NotionPlugin = Omit<
  IntegrationPluginV1<NotionConnectionConfiguration, OAuthCredentialBundleV1>,
  'authorization'
> & {
  authorization: OAuth2Authorization<NotionConnectionConfiguration, OAuthCredentialBundleV1>
}

interface NotionClientContract {
  currentBot(input: { accessToken: string; signal?: AbortSignal }): Promise<{ botId: string }>
}

export function createNotionPlugin(client: NotionClientContract): NotionPlugin {
  const validate = async (input: {
    configuration: NotionConnectionConfiguration
    credential: OAuthCredentialBundleV1
    signal?: AbortSignal
  }): Promise<ProviderValidation> => {
    try {
      const identity = await client.currentBot({ accessToken: input.credential.accessToken, signal: input.signal })
      return identity.botId === input.configuration.botId
        ? { ok: true, grantedScopes: [] }
        : { ok: false, code: 'workspace_identity_mismatch' }
    } catch (error) {
      const failure = classifyNotionError(error)
      return { ok: false, code: failure.code }
    }
  }

  return {
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
    connection: {
      parseConfiguration: parseNotionConfiguration,
      safeConfiguration: safeNotionConfiguration,
      credential: { parse: parseOAuthCredential, serialize: serializeOAuthCredential },
    },
    authorization: {
      kind: 'oauth2',
      adapter: 'notion',
      identity: (configuration) => ({ workspaceId: configuration.workspaceId }),
      validate,
    },
    runtime: {
      provider: {
        key: 'notion',
        adapterVersion: 1,
        parseConfig: parseNotionConfiguration,
        async validate(context) {
          try {
            return await validate({
              configuration: context.connection.configuration,
              credential: parseOAuthCredential(context.credential),
              signal: context.signal,
            })
          } catch {
            return { ok: false, code: 'invalid_auth', retryable: false }
          }
        },
        capabilities: {},
      },
    },
    sandbox: {
      packages: ['nodejs@24.12.0'],
      setupSteps: [{ id: 'notion-cli@0.22.10', script: CLI_SETUP_SCRIPT }],
      initHooks: ['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'],
      readiness: [{ id: 'notion-cli', command: 'ntn --version', expectedSubstring: '0.22.10' }],
      skills: ['notion'],
      extensions: [],
      protectedBindings: [
        { name: 'NOTION_API_TOKEN', source: { kind: 'oauth_access_token' } },
        { name: 'NOTION_WORKSPACE_ID', source: { kind: 'configuration', field: 'workspaceId' } },
      ],
    },
    lifecycle: { refresh: true, revoke: true },
    classifyError: classifyNotionError,
  }
}

export const notionPlugin = createNotionPlugin(new NotionClient())
