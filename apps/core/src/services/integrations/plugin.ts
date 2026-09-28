import type { IntegrationProvider, ProviderValidation, RuntimeConnection, SanitizedConversationRecord } from './types'
import type { OAuthAuthority } from './authorization/authority'
import type { OAuthCredentialBundleV1 } from './authorization/credential-bundle'

export interface CredentialCodec<Credential> {
  parse(value: unknown): Credential
  serialize(value: Credential): string
}

export interface AuthorizationGrant<C, Credential> {
  configuration: C
  credential: Credential
  displayName: string
}

export interface OAuth2Authorization<C, Credential> {
  readonly kind: 'oauth2'
  /** Key into the server-only @ficus/shared provider registry. */
  readonly adapter: string
  /** Stable fields identifying the account/workspace, independent of display-name changes. */
  identity?(configuration: C): Readonly<Record<string, string | number>>
  /** Providers that invalidate the previous pair on refresh need persistence before API validation. */
  readonly refreshInvalidatesPreviousTokens?: boolean
  /** Resolve identity after the raw credential is durably staged. */
  resolveGrantIdentity?(credential: Credential): Promise<{ configuration: C; displayName: string }>
  /** Bearer-only validation stays with Core, which owns the connection identity. */
  validate(input: { configuration: C; credential: Credential; signal?: AbortSignal }): Promise<ProviderValidation>
}

/**
 * A same-provider OAuth install offered alongside manual credential entry
 * (e.g. hosted "Add to Slack" next to bring-your-own-app). Scoped to the
 * `authorities` it is valid under so a later phase can widen it (self-hosted
 * instances borrowing a Cloud connection) without touching this shape.
 */
export interface ManagedOAuthDriver<C> extends OAuth2Authorization<C, OAuthCredentialBundleV1> {
  readonly authorities: readonly OAuthAuthority[]
}

export interface ManualCredentialDriver<C = unknown> {
  readonly kind: 'manual'
  readonly managed?: ManagedOAuthDriver<C>
}

export interface IntegrationSandboxProjection {
  readonly packages: readonly string[]
  readonly setupSteps: readonly { id: string; script: string }[]
  readonly initHooks: readonly string[]
  readonly readiness: readonly { id: string; command: string; expectedSubstring: string }[]
  readonly skills: readonly string[]
  readonly extensions: readonly string[]
  readonly protectedBindings: readonly {
    name: string
    source: { kind: 'oauth_access_token' } | { kind: 'configuration'; field: string }
  }[]
}

export interface SanitizedProviderFailure {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
}

export interface IntegrationAgentToolFactory<Context = unknown, Tool = unknown> {
  createTools(context: Context): readonly Tool[] | Promise<readonly Tool[]>
}

export interface IntegrationConversationExportDriver<C = unknown> {
  encode(records: readonly SanitizedConversationRecord[], connection: RuntimeConnection<C>): Uint8Array
  send(input: {
    payload: Uint8Array
    connection: RuntimeConnection<C>
    credential: string
    agentId: string
    squadId: string
    streamId: string
    fromLine: number
  }): Promise<void>
}

export interface IntegrationPluginV1<
  C,
  Credential,
  AgentTools extends IntegrationAgentToolFactory = IntegrationAgentToolFactory,
> {
  readonly manifestVersion: 1
  readonly key: string
  readonly adapterVersion: number
  readonly presentation: {
    readonly label: string
    readonly description: string
    readonly icon:
      | 'bigbrain'
      | 'notion'
      | 'github'
      | 'linear'
      | 'discord'
      | 'slack'
      | 'telegram'
      | 'cloudflare'
      | 'digitalocean'
      | 'netlify'
      | 'railway'
      | 'supabase'
      | 'vercel'
      | 'google-cloud'
      | 'apple-push'
      | 'web-push'
      | 'openai-services'
    readonly connectionMode: 'credential' | 'oauth2' | 'channel' | 'deployment' | 'service'
    readonly assignable: boolean
    readonly requiredCapabilities: readonly string[]
  }
  readonly connection: {
    parseConfiguration(input: unknown): C
    safeConfiguration(configuration: C): unknown
    readonly credential: CredentialCodec<Credential>
  }
  readonly authorization: ManualCredentialDriver<C> | OAuth2Authorization<C, Credential>
  readonly runtime: {
    readonly provider: IntegrationProvider<C>
    readonly agentTools?: AgentTools
    readonly conversationExport?: IntegrationConversationExportDriver<C>
  }
  readonly sandbox: IntegrationSandboxProjection
  readonly lifecycle: { readonly refresh: boolean; readonly revoke: boolean }
  classifyError(error: unknown): SanitizedProviderFailure
}

export interface IntegrationSetupStatus {
  state: 'configured' | 'needs_setup' | 'needs_attention'
  issues: string[]
}

export interface SafeIntegrationCatalogEntry {
  setup?: IntegrationSetupStatus
  manifestVersion: 1
  key: string
  adapterVersion: number
  label: string
  description: string
  icon:
    | 'bigbrain'
    | 'notion'
    | 'github'
    | 'linear'
    | 'discord'
    | 'slack'
    | 'telegram'
    | 'cloudflare'
    | 'digitalocean'
    | 'netlify'
    | 'railway'
    | 'supabase'
    | 'vercel'
    | 'google-cloud'
    | 'apple-push'
    | 'web-push'
    | 'openai-services'
  connectionMode: 'credential' | 'oauth2' | 'channel' | 'deployment' | 'service'
  assignable: boolean
  requiredCapabilities: readonly string[]
  sandbox: {
    packages: readonly string[]
    skills: readonly string[]
    extensions: readonly string[]
    protectedBindingNames: readonly string[]
  }
}

/** Build the catalog DTO field-by-field so executable and private manifest fields cannot escape. */
export function toSafeCatalogEntry(plugin: IntegrationPluginV1<unknown, unknown>): SafeIntegrationCatalogEntry {
  return {
    manifestVersion: plugin.manifestVersion,
    key: plugin.key,
    adapterVersion: plugin.adapterVersion,
    label: plugin.presentation.label,
    description: plugin.presentation.description,
    icon: plugin.presentation.icon,
    connectionMode: plugin.presentation.connectionMode,
    assignable: plugin.presentation.assignable,
    requiredCapabilities: [...plugin.presentation.requiredCapabilities],
    sandbox: {
      packages: [...plugin.sandbox.packages],
      skills: [...plugin.sandbox.skills],
      extensions: [...plugin.sandbox.extensions],
      protectedBindingNames: plugin.sandbox.protectedBindings.map((binding) => binding.name),
    },
  }
}
