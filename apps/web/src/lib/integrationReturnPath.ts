type OAuthProvider = 'github' | 'notion' | 'slack'

/** Authorization accepts paths only. The callback restores the integration query parameters. */
export function integrationAuthorizationReturnPath(baseUrl = import.meta.env?.BASE_URL ?? '/') {
  return `${baseUrl.replace(/\/$/, '')}/settings`
}

export function integrationSettingsPath(provider: OAuthProvider, baseUrl = import.meta.env?.BASE_URL ?? '/') {
  return `${integrationAuthorizationReturnPath(baseUrl)}?section=integrations&setting=integration-${provider}`
}

/**
 * Personal GitHub identity links return here. Authorization accepts paths only, so this marker path
 * is mapped back to the account page's linked-GitHub setting by `integrationReturnPath`.
 */
export function githubIdentityAuthorizationReturnPath(baseUrl = import.meta.env?.BASE_URL ?? '/') {
  return `${baseUrl.replace(/\/$/, '')}/settings/github-identity`
}

/** Older authorization flows saved only /settings, which opens the personal account page. */
export function integrationReturnPath(
  returnTo: string,
  provider: OAuthProvider,
  baseUrl = import.meta.env?.BASE_URL ?? '/'
) {
  const settingsPath = `${baseUrl.replace(/\/$/, '')}/settings`
  const pathname = returnTo.split(/[?#]/, 1)[0]?.replace(/\/$/, '')
  if (provider === 'github' && pathname === githubIdentityAuthorizationReturnPath(baseUrl))
    return `${settingsPath}?section=account&setting=github-identity`
  if (
    provider === 'github' &&
    (pathname === '/onboarding' || pathname === `${baseUrl.replace(/\/$/, '')}/onboarding`)
  ) {
    return `${baseUrl.replace(/\/$/, '')}/onboarding?setup=github`
  }
  if (pathname !== '/settings' && pathname !== settingsPath) return returnTo
  const url = new URL(returnTo, 'https://ficus.invalid')
  url.pathname = settingsPath
  url.searchParams.set('section', 'integrations')
  url.searchParams.set('setting', `integration-${provider}`)
  return `${url.pathname}${url.search}${url.hash}`
}
