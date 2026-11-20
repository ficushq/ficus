import { z } from 'zod'
import { classifyLinearOAuthError } from '@ficus/shared/oauth-providers'
import { LINEAR_APP_SCOPES, LinearOAuthClient } from '@ficus/shared/oauth-providers/linear/client'
import {
  parseLinearAppConfiguration,
  parseLinearGrantScopes,
  safeLinearAppConfiguration,
  type LinearAppConfiguration,
} from '@ficus/shared/oauth-providers/linear/config'
import type { CredentialCodec, IntegrationPluginV1, ManagedOAuthDriver } from '../plugin'
import type { ProviderValidation } from '../types'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from '../authorization/credential-bundle'
import { linearOutputAdapter } from './outputs'
import type { OAuthAuthority } from '../authorization/authority'
import { isLinearScopeError, LinearInsufficientScopeError, readGraphQLErrors } from './scope-error'
import { LINEAR_CLI_PACKAGES, LINEAR_CLI_RELEASE, LINEAR_GRAPHQL_ENDPOINT, linearCliSetupStep } from './cli'

export type { LinearAppConfiguration } from '@ficus/shared/oauth-providers/linear/config'
export { isLinearScopeError, LinearInsufficientScopeError } from './scope-error'

/** `{ version: 1 }` is a personal API-key connection; version 2 is the Ficus agent app in one workspace. */
export type LinearConfiguration = { version: 1 } | LinearAppConfiguration

/** A connection holds either a raw personal API key or an OAuth bundle for the app. */
export type LinearCredential = { kind: 'api-key'; key: string } | { kind: 'oauth'; bundle: OAuthCredentialBundleV1 }

const apiKeyConfigurationSchema = z.strictObject({ version: z.literal(1) })
const apiKeySchema = z.string().trim().min(1).max(16384)

export function parseLinearConfiguration(value: unknown): LinearConfiguration {
  const apiKey = apiKeyConfigurationSchema.safeParse(value)
  return apiKey.success ? apiKey.data : parseLinearAppConfiguration(value)
}

export function isLinearAppConfiguration(configuration: LinearConfiguration): configuration is LinearAppConfiguration {
  return configuration.version === 2
}

/**
 * Stored material is an OAuth bundle when it is a JSON object the bundle
 * parser accepts; anything else is a raw API key (a Linear key is never
 * JSON). API keys serialize back unchanged, so existing secrets are never
 * rewritten.
 */
export const linearCredentialCodec: CredentialCodec<LinearCredential> = {
  parse(value) {
    if (typeof value === 'string' && value.trimStart().startsWith('{')) {
      try {
        return { kind: 'oauth', bundle: parseOAuthCredential(value) }
      } catch {
        // Not a bundle: fall through to the API-key shape.
      }
    }
    return { kind: 'api-key', key: apiKeySchema.parse(value) }
  },
  serialize(value) {
    return value.kind === 'oauth' ? serializeOAuthCredential(value.bundle) : apiKeySchema.parse(value.key)
  },
}

/**
 * The `Authorization` header value for a credential: a personal API key is
 * sent verbatim, an app access token as `Bearer <token>`. Everything that
 * calls Linear for a connection (Core queries and the CLI's LINEAR_API_KEY)
 * goes through this helper.
 */
export function linearAuthorization(credential: LinearCredential): string {
  return credential.kind === 'oauth' ? `Bearer ${credential.bundle.accessToken}` : credential.key
}

/**
 * Linear answered HTTP 429. The message stays `provider_unavailable`, the code every caller already
 * handles; `retryAfterMs` carries Linear's `Retry-After` for callers that back off (the poller).
 */
export class LinearRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('provider_unavailable')
  }
}

function retryAfterMs(value: string | null): number {
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 86_400) * 1_000
  const at = value ? Date.parse(value) : NaN
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 1_000), 86_400_000) : 60_000
}

/** Sends one GraphQL request with an `Authorization` value from `linearAuthorization`. */
export async function linearQuery<T>(
  authorization: string,
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({ query, variables }),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (response.status === 429) throw new LinearRateLimitedError(retryAfterMs(response.headers.get('Retry-After')))
  if (!response.ok) {
    if ((response.status === 400 || response.status === 403) && isLinearScopeError(await readGraphQLErrors(response)))
      throw new LinearInsufficientScopeError()
    throw new Error(response.status === 401 || response.status === 403 ? 'invalid_auth' : 'provider_unavailable')
  }
  const result = (await response.json()) as { data?: T; errors?: unknown[] }
  if (isLinearScopeError(result.errors)) throw new LinearInsufficientScopeError()
  if (result.errors?.length || !result.data) throw new Error('provider_query_failed')
  return result.data
}

/** What the app's scopes let it do, in the plugin's capability vocabulary. */
function appCapabilities(configuration: LinearAppConfiguration): string[] {
  return [
    'issues:read',
    ...(configuration.scopes.includes('issues:create') || configuration.scopes.includes('write')
      ? ['issues:write']
      : []),
    ...(configuration.scopes.includes('comments:create') || configuration.scopes.includes('write')
      ? ['comments:write']
      : []),
  ]
}

/** The app installs under both authorities: self-hosted with the operator's OAuth application, hosted through the Platform broker. */
const LINEAR_APP_AUTHORITIES: readonly OAuthAuthority[] = ['platform_broker', 'local']

export interface LinearPluginDependencies {
  /** Reads the app user and workspace for a token; injectable for tests. */
  client?: Pick<LinearOAuthClient, 'identity'>
}

export function createLinearPlugin(dependencies: LinearPluginDependencies = {}): IntegrationPluginV1<
  LinearConfiguration,
  LinearCredential
> & {
  authorization: { kind: 'manual'; managed: ManagedOAuthDriver<LinearConfiguration> }
} {
  const client = dependencies.client ?? new LinearOAuthClient()

  /** The token must still belong to the same app user in the same workspace. */
  async function validateApp(input: {
    configuration: LinearConfiguration
    credential: OAuthCredentialBundleV1
    signal?: AbortSignal
  }): Promise<ProviderValidation> {
    if (!isLinearAppConfiguration(input.configuration)) return { ok: false, code: 'invalid_auth' }
    const configuration = input.configuration
    try {
      const identity = await client.identity({ accessToken: input.credential.accessToken, signal: input.signal })
      if (identity.appUserId !== configuration.appUserId || identity.organizationId !== configuration.organizationId)
        return { ok: false, code: 'workspace_identity_mismatch' }
      const refreshed: LinearAppConfiguration = { ...configuration, ...identity }
      // Names and the URL key can change in Linear; the IDs prove it is the same installation.
      return JSON.stringify(refreshed) === JSON.stringify(configuration)
        ? { ok: true, grantedScopes: appCapabilities(configuration) }
        : { ok: true, grantedScopes: appCapabilities(configuration), configuration: refreshed }
    } catch (error) {
      const code = classifyLinearOAuthError(error).code
      // A token whose viewer is not an app user is not this app connection.
      return { ok: false, code: code === 'not_app_actor' ? 'workspace_identity_mismatch' : code }
    }
  }

  const linearAppDriver: ManagedOAuthDriver<LinearConfiguration> = {
    kind: 'oauth2',
    adapter: 'linear',
    authorities: LINEAR_APP_AUTHORITIES,
    // One app connection per Linear workspace: reconnecting the same workspace updates it.
    identity: (configuration) => ({
      organizationId: isLinearAppConfiguration(configuration) ? configuration.organizationId : '',
    }),
    // Linear rotates the pair on every refresh; persist before validating.
    refreshInvalidatesPreviousTokens: true,
    // The adapter's grant configuration carries only the granted scopes; the identity is read here.
    grantNeedsIdentity: (grantConfiguration) => parseLinearGrantScopes(grantConfiguration) !== null,
    async resolveGrantIdentity(credential, grantConfiguration) {
      const identity = await client.identity({ accessToken: credential.accessToken })
      const configuration = parseLinearAppConfiguration({
        version: 2,
        mode: 'app',
        ...identity,
        // What Linear granted. A broker that does not report scopes leaves the requested set; a
        // scope Linear then refuses at use time marks the connection for reconnect.
        scopes: parseLinearGrantScopes(grantConfiguration) ?? [...LINEAR_APP_SCOPES],
      })
      return { configuration, displayName: `${identity.organizationName.trim().slice(0, 180)} (Ficus app)` }
    },
    validate: validateApp,
  }

  return {
    manifestVersion: 1,
    key: 'linear',
    adapterVersion: 1,
    presentation: {
      label: 'Linear',
      description:
        'Connect issue tracking, route assignments to squads, search Linear issues, and let agents read, create, update and comment on issues with the Linear CLI.',
      icon: 'linear',
      connectionMode: 'credential',
      assignable: true,
      requiredCapabilities: ['issues:read', 'issues:write', 'comments:write'],
    },
    connection: {
      parseConfiguration: parseLinearConfiguration,
      safeConfiguration: (configuration) =>
        isLinearAppConfiguration(configuration) ? safeLinearAppConfiguration(configuration) : configuration,
      credential: linearCredentialCodec,
    },
    authorization: { kind: 'manual', managed: linearAppDriver },
    runtime: {
      provider: {
        key: 'linear',
        adapterVersion: 1,
        parseConfig: parseLinearConfiguration,
        outputs: linearOutputAdapter,
        async validate({ connection, credential, signal }) {
          let parsed: LinearCredential
          let configuration: LinearConfiguration
          try {
            parsed = linearCredentialCodec.parse(credential)
            // A caller without a connection record validates a bare key, as before the app existed.
            configuration = parseLinearConfiguration(connection?.configuration ?? { version: 1 })
          } catch {
            return { ok: false, code: 'invalid_auth' }
          }
          // The credential must match the connection's mode: an app connection
          // never runs on a personal key, and an API-key connection never on an app token.
          if (parsed.kind === 'oauth')
            return isLinearAppConfiguration(configuration)
              ? validateApp({ configuration, credential: parsed.bundle, signal })
              : { ok: false, code: 'invalid_auth' }
          if (isLinearAppConfiguration(configuration)) return { ok: false, code: 'invalid_auth' }
          try {
            // Linear does not report a personal key's permissions, so validation
            // records only the read access it proves. Writes fail at use time.
            const data = await linearQuery<{ viewer: { id: string } }>(
              linearAuthorization(parsed),
              '{ viewer { id } }',
              undefined,
              signal
            )
            return data.viewer?.id ? { ok: true, grantedScopes: ['issues:read'] } : { ok: false, code: 'invalid_auth' }
          } catch (error) {
            return { ok: false, code: error instanceof Error ? error.message : 'provider_unavailable' }
          }
        },
        capabilities: {
          // The agent app's polling fallback (5.7); it returns no events for API-key connections.
          // Loaded lazily: the poller reaches the database and app ingress, which import this plugin.
          event_polling: {
            poll: async (connection, cursor, signal) =>
              (await import('./polling-runtime')).linearAgentSessionPolling.poll(connection, cursor, signal),
          },
        },
      },
    },
    execution: {
      binaries: ['linear'],
      environment: {
        // The CLI sends this value verbatim as the Authorization header: a
        // personal API key as is, an app token as `Bearer <token>`.
        LINEAR_API_KEY: ({ credential }) => linearAuthorization(credential),
        // A repository .env could otherwise supply another key or redirect the
        // endpoint, and with it the injected key, to another host.
        LINEAR_IGNORE_ENV_FILE: () => '1',
        LINEAR_GRAPHQL_ENDPOINT: () => LINEAR_GRAPHQL_ENDPOINT,
      },
    },
    sandbox: {
      packages: [...LINEAR_CLI_PACKAGES],
      setupSteps: [linearCliSetupStep()],
      initHooks: ['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'],
      readiness: [
        { id: 'linear-cli', command: 'linear --version', expectedSubstring: `linear ${LINEAR_CLI_RELEASE.version}` },
      ],
      skills: ['linear'],
      extensions: [],
      // App connections name their workspace; API-key connections have no such field, so the binding is omitted.
      protectedBindings: [
        {
          name: 'LINEAR_ORGANIZATION_URL_KEY',
          source: { kind: 'configuration', field: 'organizationUrlKey' },
          optional: true,
        },
      ],
    },
    // Both act only on app (`oauth2`) connections; API-key connections are never refreshed or revoked.
    lifecycle: { refresh: true, revoke: true },
    classifyError: (error) => {
      const failure = classifyLinearOAuthError(error)
      return {
        code: failure.code,
        retryable: failure.retryable,
        ...(failure.retryAfterSeconds !== undefined ? { retryAfterMs: failure.retryAfterSeconds * 1_000 } : {}),
      }
    },
  }
}

export const linearPlugin = createLinearPlugin()
