import type { IntegrationPluginV1, OAuth2Authorization } from './plugin'
import type { OAuthAuthority } from './authorization/authority'
import type { IntegrationConnectionRecord } from './connection-repository'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from './authorization/credential-bundle'

// Authorization does not consume execution callbacks. In a managed view the credential codec changes,
// so carrying a manual resolver through as an OAuth-bundle resolver would be unsound.
export type OAuthPluginSource<C> = Omit<IntegrationPluginV1<C, unknown>, 'execution'> & { readonly execution?: unknown }

/** An `IntegrationPluginV1` narrowed to its OAuth2 shape, whether that is the plugin's own `authorization` or a manual plugin's `managed` driver. */
export type OAuthPluginView<C> = Omit<IntegrationPluginV1<C, OAuthCredentialBundleV1>, 'execution'> & {
  readonly authorization: OAuth2Authorization<C, OAuthCredentialBundleV1>
}

/**
 * The OAuth-flow-only view of a plugin: itself when it is a true OAuth2
 * plugin, or a manual plugin's `managed` driver reshaped to the same
 * contract when `authority` is one it is offered under. Authorization flows
 * use it before a connection exists; code that acts on an existing
 * connection uses `connectionOAuthView` instead.
 */
export function oauthPluginView<C>(
  plugin: OAuthPluginSource<C>,
  authority: OAuthAuthority
): OAuthPluginView<C> | undefined {
  if (plugin.authorization.kind === 'oauth2') return plugin as OAuthPluginView<C>
  const managed = plugin.authorization.managed
  if (!managed || !managed.authorities.includes(authority)) return undefined
  const { execution: _execution, ...source } = plugin
  return {
    ...source,
    connection: {
      ...plugin.connection,
      credential: { parse: parseOAuthCredential, serialize: serializeOAuthCredential },
    },
    authorization: managed,
  }
}

/** The connection fields that decide whether it gets the OAuth lifecycle. */
export type OAuthConnectionFacts = Pick<IntegrationConnectionRecord, 'authorizationKind' | 'clientAuthority'>

/**
 * The OAuth view for one existing connection. Only `oauth2` connections have
 * one: refresh, revocation, execution expiry and authority fencing all key
 * off this, so a manual plugin's managed-driver connections get the full
 * lifecycle while its manually entered connections get none of it.
 * Undefined for `manual` connections, and for an `oauth2` connection whose
 * plugin no longer offers OAuth under the connection's authority.
 */
export function connectionOAuthView<C>(
  plugin: OAuthPluginSource<C>,
  connection: OAuthConnectionFacts
): OAuthPluginView<C> | undefined {
  if (connection.authorizationKind !== 'oauth2') return undefined
  return oauthPluginView(plugin, connection.clientAuthority)
}

/**
 * Whether deleting a connection must revoke its material at the provider:
 * only `oauth2` connections whose plugin (at the connection's adapter
 * version) still treats them as OAuth.
 */
export function connectionRequiresRemoteRevocation<C>(
  plugin: OAuthPluginSource<C> | undefined,
  connection: OAuthConnectionFacts & Pick<IntegrationConnectionRecord, 'adapterVersion'>
): boolean {
  if (!plugin || plugin.adapterVersion !== connection.adapterVersion) return false
  return connectionOAuthView(plugin, connection) !== undefined
}

/**
 * Providers the proactive refresh worker sweeps: OAuth2 plugins, and manual
 * plugins whose managed driver opts in with `lifecycle.refresh`. The sweep
 * itself only selects `oauth2` connections.
 */
export function refreshableOAuthProviderKeys(
  plugins: readonly Pick<OAuthPluginSource<unknown>, 'key' | 'authorization' | 'lifecycle'>[]
): string[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.authorization.kind === 'oauth2' ||
        (plugin.authorization.managed !== undefined && plugin.lifecycle.refresh)
    )
    .map((plugin) => plugin.key)
}

/**
 * The client authority a connection must hold to be used by a deployment
 * whose authority is `currentAuthority`, or undefined when it is not fenced.
 * Only `oauth2` connections are fenced; manual material is not bound to an
 * OAuth client.
 */
export function oauthFencingAuthority(
  connection: Pick<IntegrationConnectionRecord, 'authorizationKind'>,
  currentAuthority: OAuthAuthority
): OAuthAuthority | undefined {
  return connection.authorizationKind === 'oauth2' ? currentAuthority : undefined
}

/**
 * True when an `oauth2` connection must not be used by this deployment: its
 * client authority is not the current one, or its plugin cannot treat it as
 * OAuth. Manual connections are never fenced.
 */
export function isFencedOAuthConnection<C>(
  plugin: OAuthPluginSource<C>,
  connection: OAuthConnectionFacts,
  currentAuthority: OAuthAuthority
): boolean {
  if (connection.authorizationKind !== 'oauth2') return false
  return connection.clientAuthority !== currentAuthority || !connectionOAuthView(plugin, connection)
}
