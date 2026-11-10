import {
  isCookieSafeBasePath,
  isStrippableBasePath,
  localAppsBasePath,
  normalizeBasePath,
} from '../../lib/app-base-path'
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
  /** The base path the web app and documentation will be served under ('' at the root). */
  basePath: string
  /** The base path differs from the current one: open tabs and installed apps must be reopened. */
  basePathChanged: boolean
  /**
   * False when the path's first segment is also a Ficus page or API route: Core then
   * never removes it from request paths, so only a reverse proxy that strips it works.
   */
  basePathStrippable: boolean
  /**
   * False when the path has characters that cannot go in a cookie Path (for example `;`):
   * squad apps are then served only at the unprefixed `/api/app/<id>/`, not under this path.
   */
  localAppsUnderBasePath: boolean
  /** Running managed squad apps that Ficus restarts so their links use the new path (when the apps' base changes). */
  localAppsAffected: number
  /** Running apps started outside Ficus (attached) that must be restarted by hand. */
  externalAppsAffected: number
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

/** The base an address serves the web app under: its own path, else APP_BASE_PATH. */
function basePathOf(url: string | undefined, legacyBasePath: string | undefined): string {
  let path: string
  try {
    path = url ? normalizeBasePath(new URL(url).pathname) : ''
  } catch {
    path = ''
  }
  return path || normalizeBasePath(legacyBasePath)
}

/** Live path-mounted local apps whose links depend on the base path. */
export interface AffectedLocalApps {
  managed: number
  external: number
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
  basePath: string | undefined = process.env.APP_BASE_PATH,
  apps: AffectedLocalApps = { managed: 0, external: 0 }
): PublicAppUrlChangeImpact {
  const b = providerUrls(before, basePath)
  const a = providerUrls(after, basePath)
  const beforeBase = basePathOf(before, basePath)
  const afterBase = basePathOf(after, basePath)
  const basePathChanged = beforeBase !== afterBase
  // Local apps restart only when the base they are served under changes.
  const localAppsBaseChanged = localAppsBasePath(beforeBase) !== localAppsBasePath(afterBase)
  return {
    originChanged: originOf(before) !== originOf(after),
    relayReconnectRequired: before !== after,
    mobileReady: after?.startsWith('https:') ?? false,
    basePath: afterBase,
    basePathChanged,
    basePathStrippable: !afterBase || isStrippableBasePath(afterBase),
    localAppsUnderBasePath: !afterBase || isCookieSafeBasePath(afterBase),
    localAppsAffected: localAppsBaseChanged ? apps.managed : 0,
    externalAppsAffected: localAppsBaseChanged ? apps.external : 0,
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
