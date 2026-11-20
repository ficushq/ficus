import { FICUS_GITHUB_APP_CLIENT_ID } from '@ficus/shared/oauth-providers/github/app'

let configuredClientId: () => string | undefined = () => undefined

/**
 * Supply the GitHub App this instance authorizes connections with. The output runtime registers it,
 * so normalization stays free of the secret store (and the database) in pure callers and tests.
 */
export function setConfiguredGitHubAppClientId(resolve: () => string | undefined): void {
  configuredClientId = resolve
}

/**
 * Whether a GitHub App client ID is Ficus's own app: the default Ficus Integration app, or the app
 * this instance is configured to authorize GitHub connections with. GitHub reports the writing app
 * as `performed_via_github_app.client_id` on issue and pull request comments.
 *
 * The configured app is known only once `outputs/runtime.ts` has registered its resolver (on import). A
 * caller that normalizes GitHub facts without loading that runtime recognizes only the default app; it
 * reports any other app as `other`, which is still treated as a possible Ficus echo, never as a person.
 */
export function isFicusGitHubAppClientId(clientId: unknown): boolean {
  if (typeof clientId !== 'string' || !clientId) return false
  if (clientId === FICUS_GITHUB_APP_CLIENT_ID) return true
  try {
    return configuredClientId() === clientId
  } catch {
    return false
  }
}
