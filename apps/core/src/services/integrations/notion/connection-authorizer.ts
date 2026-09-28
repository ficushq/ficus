import type { NotionConnectionConfiguration } from '@ficus/shared/oauth-providers/notion/config'
import {
  OAuthConnectionAuthorizer,
  type OAuthConnectionAuthorizerDependencies,
} from '../authorization/connection-authorizer'

export { AuthorizationGrantAbandonedError } from '../authorization/connection-authorizer'
export type NotionConnectionAuthorizerDependencies = Omit<
  OAuthConnectionAuthorizerDependencies<NotionConnectionConfiguration>,
  'identity'
>

/** Compatibility facade; provider-neutral installation owns all credential lifecycle behavior. */
export class NotionConnectionAuthorizer extends OAuthConnectionAuthorizer<NotionConnectionConfiguration> {
  constructor(dependencies: NotionConnectionAuthorizerDependencies) {
    super({ ...dependencies, identity: (configuration) => ({ workspaceId: configuration.workspaceId }) })
  }
}
