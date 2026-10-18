/**
 * Which `Authorization` header a local app may receive.
 *
 * On a per-app origin (`<tenant>--<id>.<apps domain>`) the app owns its origin,
 * so the browser never attaches a Ficus credential to its requests: an
 * `Authorization` header there is the app's own (`Bearer <app token>` from its
 * own JavaScript) and is forwarded. On the path mount (`/api/app/<id>/` on the
 * Ficus origin) it is never forwarded, so the caller does not ask.
 *
 * Even on the app's own origin a value that is, or contains, a Ficus credential
 * is dropped, so no path can hand one to an app: any Core-minted token prefix
 * (session, agent, device, system, WebSocket ticket, web handoff), the
 * credential that authorized this request, any deployment's browser access
 * token, the bootstrap password, or the sandbox callback secret. A Basic value
 * is decoded and checked the same way. The value is never logged.
 */
import { createHash, timingSafeEqual } from 'crypto'
import { DEVICE_TOKEN_PREFIX } from '../auth/device-tokens'
import {
  AGENT_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  SYSTEM_TOKEN_PREFIX,
  WEB_HANDOFF_PREFIX,
  WS_TICKET_PREFIX,
} from '../auth/token-prefixes'
import { getSecretStore } from '../secrets'
import { isAnyLocalDeploymentBrowserToken } from './local-deployment-service'

const FICUS_TOKEN_PREFIXES = [
  SESSION_TOKEN_PREFIX,
  AGENT_TOKEN_PREFIX,
  DEVICE_TOKEN_PREFIX,
  SYSTEM_TOKEN_PREFIX,
  WS_TICKET_PREFIX,
  WEB_HANDOFF_PREFIX,
]

/** Instance secrets that authenticate to Core when presented as a bearer value. */
const FICUS_SECRET_NAMES = ['FICUS_PASSWORD', 'SANDBOX_CALLBACK_SECRET'] as const

/** A deployment browser token: 24 random bytes, base64url (local-deployment-service.ts). */
const BROWSER_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

/**
 * The strings a value could present as a credential: the whole value, the part
 * after the scheme, and for Basic the decoded pair and each half of it.
 */
function credentialCandidates(value: string): string[] {
  const trimmed = value.trim()
  const candidates = [trimmed]
  const space = trimmed.search(/\s/)
  if (space === -1) return candidates
  const scheme = trimmed.slice(0, space).toLowerCase()
  const credentials = trimmed.slice(space).trim()
  candidates.push(credentials)
  if (scheme === 'basic') {
    const decoded = Buffer.from(credentials, 'base64').toString('utf8')
    candidates.push(decoded)
    const colon = decoded.indexOf(':')
    if (colon !== -1) candidates.push(decoded.slice(0, colon), decoded.slice(colon + 1))
  }
  return candidates.filter(Boolean)
}

interface AppAuthorizationDependencies {
  isAnyLocalDeploymentBrowserToken: (token: string) => Promise<boolean>
  getSecret: (name: string) => string | undefined
}

const defaultDependencies: AppAuthorizationDependencies = {
  isAnyLocalDeploymentBrowserToken,
  getSecret: (name) => getSecretStore().get(name),
}

/** Whether an Authorization value is, or carries, a Ficus credential. */
export async function isFicusCredentialAuthorization(
  value: string,
  accessToken: string,
  deps: AppAuthorizationDependencies = defaultDependencies
): Promise<boolean> {
  const candidates = credentialCandidates(value)
  if (candidates.some((candidate) => FICUS_TOKEN_PREFIXES.some((prefix) => candidate.includes(prefix)))) return true
  const secrets = [accessToken, ...FICUS_SECRET_NAMES.map((name) => deps.getSecret(name))].filter(
    (secret): secret is string => !!secret
  )
  if (candidates.some((candidate) => secrets.some((secret) => sameSecret(candidate, secret)))) return true
  for (const candidate of candidates) {
    if (BROWSER_TOKEN_SHAPE.test(candidate) && (await deps.isAnyLocalDeploymentBrowserToken(candidate))) return true
  }
  return false
}

/**
 * The Authorization header to send a local app on its own origin: the
 * browser's value, or null when there is none or it is a Ficus credential.
 * Call only after the request has been authorized with `accessToken`.
 */
export async function appOriginAuthorization(
  value: string | null,
  accessToken: string,
  deps: AppAuthorizationDependencies = defaultDependencies
): Promise<string | null> {
  if (!value?.trim()) return null
  return (await isFicusCredentialAuthorization(value, accessToken, deps)) ? null : value
}
