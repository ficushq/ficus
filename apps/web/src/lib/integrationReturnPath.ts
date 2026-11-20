import { appBasePath } from './basePath'

type OAuthProvider = 'github' | 'linear' | 'notion' | 'slack'

/** Authorization accepts paths only. The callback restores the integration query parameters. */
export function integrationAuthorizationReturnPath(baseUrl = appBasePath()) {
  return `${baseUrl.replace(/\/$/, '')}/settings`
}

export function integrationSettingsPath(provider: OAuthProvider, baseUrl = appBasePath()) {
  return `${integrationAuthorizationReturnPath(baseUrl)}?section=integrations&setting=integration-${provider}`
}

/**
 * Personal GitHub identity links return here. Authorization accepts paths only, so this marker path
 * is mapped back to the account page's linked-GitHub setting by `integrationReturnPath`.
 */
export function githubIdentityAuthorizationReturnPath(baseUrl = appBasePath()) {
  return `${baseUrl.replace(/\/$/, '')}/settings/github-identity`
}

/** Linked Linear account flows return here; mapped back to the account page's Linear setting. */
export function linearIdentityAuthorizationReturnPath(baseUrl = appBasePath()) {
  return `${baseUrl.replace(/\/$/, '')}/settings/linear-identity`
}

const SAME_ORIGIN_PROBE = 'https://ficus.invalid'

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Whether a return target is a path on this origin. Core checks the target when the flow starts; this
 * repeats the check before the callback redirects to it or renders it as a link. It accepts only a
 * single leading "/" and rejects anything a browser could read as another origin or a script: "//"
 * and backslash variants, schemes such as javascript: or data:, control characters (the URL parser
 * strips tabs and newlines, so "/\t/host" becomes "//host"), and the same tricks percent-encoded.
 */
export function isSameOriginReturnPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false
  }
  for (const candidate of [value, decoded]) {
    if (candidate.startsWith('//') || candidate.includes('\\') || hasControlCharacter(candidate)) return false
  }
  try {
    return new URL(value, SAME_ORIGIN_PROBE).origin === SAME_ORIGIN_PROBE
  } catch {
    return false
  }
}

/**
 * Where the callback sends a person once the connection is saved. Older authorization flows saved
 * only /settings, which opens the personal account page, so that is mapped to the provider's card.
 * A target that is not a same-origin path falls back to the provider's settings.
 */
export function integrationReturnPath(returnTo: string, provider: string, baseUrl = appBasePath()) {
  const settingsPath = `${baseUrl.replace(/\/$/, '')}/settings`
  if (!isSameOriginReturnPath(returnTo))
    return `${settingsPath}?section=integrations&setting=integration-${encodeURIComponent(provider)}`
  const pathname = returnTo.split(/[?#]/, 1)[0]?.replace(/\/$/, '')
  if (provider === 'github' && pathname === githubIdentityAuthorizationReturnPath(baseUrl))
    return `${settingsPath}?section=account&setting=github-identity`
  if (provider === 'linear' && pathname === linearIdentityAuthorizationReturnPath(baseUrl))
    return `${settingsPath}?section=account&setting=linear-account`
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
