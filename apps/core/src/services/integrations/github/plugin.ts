import { GitHubOAuthClient } from '@ficus/shared/oauth-providers/github/client'
import {
  parseGitHubConfiguration,
  type GitHubConnectionConfiguration,
} from '@ficus/shared/oauth-providers/github/config'
import { classifyGitHubOAuthError } from '@ficus/shared/oauth-providers'
import type { IntegrationPluginV1, OAuth2Authorization } from '../plugin'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from '../authorization/credential-bundle'
import { GitHubPollingProvider, type GitHubPollingCredentialResolver } from './provider'

type GitHubPlugin = IntegrationPluginV1<GitHubConnectionConfiguration, OAuthCredentialBundleV1> & {
  authorization: OAuth2Authorization<GitHubConnectionConfiguration, OAuthCredentialBundleV1>
}

export function createGitHubPlugin(
  client: Pick<GitHubOAuthClient, 'currentUser'>,
  resolvePollingCredential: GitHubPollingCredentialResolver
): GitHubPlugin {
  const polling = new GitHubPollingProvider(resolvePollingCredential)
  const validate: GitHubPlugin['authorization']['validate'] = async ({ configuration, credential, signal }) => {
    try {
      const actual = await client.currentUser({ accessToken: credential.accessToken, signal })
      if (actual.userId !== configuration.userId) return { ok: false, code: 'account_identity_mismatch' }
      // Logins route webhooks and can change at any time; the account ID proves it is the same account.
      return actual.login === configuration.login
        ? { ok: true, grantedScopes: [] }
        : { ok: true, grantedScopes: [], configuration: actual }
    } catch (error) {
      return { ok: false, code: classifyGitHubOAuthError(error).code }
    }
  }
  return {
    manifestVersion: 1,
    key: 'github',
    adapterVersion: 1,
    presentation: {
      label: 'GitHub',
      description:
        'Connect your GitHub account and selected repositories for git, issues, pull requests, and workflows.',
      icon: 'github',
      connectionMode: 'oauth2',
      assignable: true,
      requiredCapabilities: [
        'Contents: write',
        'Pull requests: write',
        'Issues: write',
        'Actions: write',
        'Workflows: write',
        'Checks: read',
        'Commit statuses: read',
        'SSH signing keys: write (account permission, for commit signing)',
      ],
    },
    connection: {
      parseConfiguration: parseGitHubConfiguration,
      safeConfiguration: (configuration) => ({ userId: configuration.userId, login: configuration.login }),
      credential: { parse: parseOAuthCredential, serialize: serializeOAuthCredential },
    },
    authorization: {
      kind: 'oauth2',
      adapter: 'github',
      identity: (configuration) => ({ userId: configuration.userId }),
      refreshInvalidatesPreviousTokens: true,
      async resolveGrantIdentity(credential) {
        const configuration = await client.currentUser({ accessToken: credential.accessToken })
        return { configuration, displayName: configuration.login }
      },
      validate,
    },
    runtime: {
      provider: {
        key: 'github',
        adapterVersion: 1,
        parseConfig: parseGitHubConfiguration,
        outputs: polling.outputs,
        async validate(context) {
          try {
            return await validate({
              configuration: context.connection.configuration,
              credential: parseOAuthCredential(context.credential),
              signal: context.signal,
            })
          } catch {
            return { ok: false, code: 'invalid_auth' }
          }
        },
        capabilities: {
          event_polling: {
            poll: (connection, cursor, signal) =>
              polling.capabilities.event_polling!.poll(
                {
                  ...connection,
                  configuration: polling.parseConfig(connection.configuration),
                },
                cursor,
                signal
              ),
          },
        },
      },
    },
    sandbox: {
      packages: [],
      setupSteps: [],
      initHooks: [],
      readiness: [],
      skills: [],
      extensions: [],
      // Credentials are acquired by `ficus integration exec` at invocation time.
      // Never project an access token into a persistent agent process environment.
      protectedBindings: [],
    },
    lifecycle: { refresh: true, revoke: true },
    classifyError: classifyGitHubOAuthError,
  }
}

export const githubPlugin = createGitHubPlugin(new GitHubOAuthClient(), async (connection) => {
  const { resolveGitHubConnection } = await import('./resolve-connection')
  const resolved = await resolveGitHubConnection(connection.squadId, connection.id)
  return resolved?.credential.accessToken
})
