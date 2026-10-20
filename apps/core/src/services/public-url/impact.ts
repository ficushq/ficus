import { resolveOAuthCallbackUrl } from '../integrations/authorization/public-url'

export interface UrlChange {
  label: string
  before: string | null
  after: string | null
}

/** What an administrator must know before changing the public address. */
export interface PublicAppUrlChangeImpact {
  /** Browser origin changes: sign in again there; passkeys are bound to a hostname. */
  originChanged: boolean
  /** The Ficus account connection is keyed by the canonical address; reconnect is required. */
  relayReconnectRequired: boolean
  /** Mobile & Pro requires HTTPS. */
  mobileReady: boolean
  /** The URL's path differs from APP_BASE_PATH, which the web app is built with. */
  basePathMismatch: boolean
  oauthCallbacks: UrlChange[]
  webhooks: UrlChange[]
}

const OAUTH_CALLBACK_SUFFIX = /\/settings\/integrations\/oauth\/callback$/

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function pathOf(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, '')
}

function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}` : ''
}

function callbackFor(appUrl: string | undefined, basePath: string | undefined): string | null {
  if (!appUrl) return null
  try {
    return resolveOAuthCallbackUrl(appUrl, basePath)
  } catch {
    return null
  }
}

/** Mirrors resolveIntegrationOAuthCallbackUrl and the GitHub/Linear webhook URL derivation, for an explicit address. */
function providerUrls(appUrl: string | undefined, basePath: string | undefined) {
  const callback = callbackFor(appUrl, basePath)
  const webhook = (provider: string) => callback?.replace(OAUTH_CALLBACK_SUFFIX, `/api/webhooks/${provider}`) ?? null
  return {
    oauthGithub: callback ? `${callback}/github` : null,
    oauthOther: callback,
    webhookGithub: webhook('github'),
    webhookLinear: webhook('linear'),
  }
}

export function computePublicAppUrlChangeImpact(
  before: string | undefined,
  after: string | undefined,
  basePath: string | undefined = process.env.APP_BASE_PATH
): PublicAppUrlChangeImpact {
  const b = providerUrls(before, basePath)
  const a = providerUrls(after, basePath)
  return {
    originChanged: originOf(before) !== originOf(after),
    relayReconnectRequired: before !== after,
    mobileReady: after?.startsWith('https:') ?? false,
    basePathMismatch: after !== undefined && pathOf(after) !== normalizeBasePath(basePath),
    oauthCallbacks: [
      { label: 'GitHub OAuth callback', before: b.oauthGithub, after: a.oauthGithub },
      { label: 'Other integrations OAuth callback', before: b.oauthOther, after: a.oauthOther },
    ],
    webhooks: [
      { label: 'GitHub webhook', before: b.webhookGithub, after: a.webhookGithub },
      { label: 'Linear webhook', before: b.webhookLinear, after: a.webhookLinear },
    ],
  }
}
