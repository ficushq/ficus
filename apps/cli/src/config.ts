import { getDotenvEnv, getExplicitEnv, loadEnv } from './env'
import { existsSync, readFileSync } from 'fs'
import { sandboxPasswordPath } from '@ficus/shared/node'
import { getActiveBackend, loadAuthStore } from './auth-store'
loadEnv()

let selectedBackendLabel: string | undefined

export function setSelectedBackend(label: string | undefined) {
  selectedBackendLabel = label
}

/**
 * True inside a shell the Ficus runtime built for an agent (the sandbox/host
 * runtime injects FICUS_AGENT_CONTEXT=1 alongside the agent's own FICUS_API_URL,
 * FICUS_TOKEN and FICUS_AUTH_STORE).
 *
 * On the host runtime an agent runs as the operator's unix user, with the
 * operator's $HOME — so every fallback below (the auth store, the dotenv
 * heuristic, /etc/tau/password) can hand it the HUMAN's login and point it at a
 * DIFFERENT instance. In agent context resolution is therefore env-only and
 * fails closed instead of falling back.
 */
export function isAgentContext(): boolean {
  return process.env.FICUS_AGENT_CONTEXT === '1'
}

/** `--backend` names a stored human login, which an agent shell may never assume. */
function refuseSelectedBackendInAgentContext(): void {
  if (selectedBackendLabel)
    throw new Error('`--backend` selects a human login; an agent shell always uses its injected identity')
}

function getSelectedBackend() {
  if (!selectedBackendLabel) return undefined
  const store = loadAuthStore()
  const backend = store.backends[selectedBackendLabel]
  if (!backend) throw new Error(`Unknown Ficus backend '${selectedBackendLabel}'`)
  return { label: selectedBackendLabel, backend }
}

/** The instance an agent shell was pointed at. Raw env: no dotenv heuristic, no store. */
function requireAgentApiUrl(): string {
  const apiUrl = process.env.FICUS_API_URL
  if (!apiUrl)
    throw new Error(
      'This is an agent shell (FICUS_AGENT_CONTEXT=1) but FICUS_API_URL is not set, so there is no instance to talk to.'
    )
  return apiUrl
}

/** The agent's own scoped token. Raw env: no dotenv heuristic, no store. */
function requireAgentToken(): string {
  const token = process.env.FICUS_TOKEN
  if (!token)
    throw new Error(
      'This is an agent shell (FICUS_AGENT_CONTEXT=1) but the agent token FICUS_TOKEN is absent; ' +
        'ficus will not fall back to a human login.'
    )
  return token
}

/** Webhook scripts run as the host user but must never borrow that user's backend. */
function webhookAuth(): ResolvedAuth | undefined {
  if (process.env.FICUS_WEBHOOK_CONTEXT !== '1') return undefined
  if (selectedBackendLabel) throw new Error('`--backend` cannot override a webhook script’s injected identity')
  const apiUrl = process.env.FICUS_API_URL ?? ''
  const credential = process.env.FICUS_TOKEN || process.env.FICUS_PASSWORD
  const missing = [...(!apiUrl ? ['FICUS_API_URL'] : []), ...(!credential ? ['FICUS_TOKEN or FICUS_PASSWORD'] : [])]
  return {
    source: 'webhook-context',
    apiUrl,
    ...(missing.length ? { missing } : {}),
    authenticated: missing.length === 0,
  }
}

/**
 * Read FICUS_PASSWORD from env var, active auth store backend, or the mounted sandbox
 * secret file (`sandboxPasswordPath()`: the ficus path, else the legacy one, whichever is
 * actually mounted) — auto-updated by K8s when the secret changes.
 *
 * `deps.secretExists`/`deps.readSecret` override the filesystem for tests only; every
 * production call site (the `config.password` getter below) omits them and gets the real
 * `existsSync`/`readFileSync`.
 */
export function getPassword(
  deps: {
    secretExists?: (path: string) => boolean
    readSecret?: (path: string) => string
  } = {}
): string {
  if (webhookAuth()) {
    const credential = process.env.FICUS_TOKEN || process.env.FICUS_PASSWORD
    if (!credential)
      throw new Error('Webhook credential missing: inject FICUS_TOKEN or FICUS_PASSWORD; no human login fallback')
    return credential
  }
  if (isAgentContext()) {
    refuseSelectedBackendInAgentContext()
    return requireAgentToken()
  }
  // A per-agent scoped token (injected into the sandbox bash environment as
  // FICUS_TOKEN) takes precedence so an agent's `ficus` commands authenticate AS that
  // agent (RBAC squad-scoped) rather than via the shared FICUS_PASSWORD.
  const selectedBackend = getSelectedBackend()
  if (selectedBackend) return selectedBackend.backend.password
  const explicitToken = getExplicitEnv('FICUS_TOKEN')
  if (explicitToken) return explicitToken
  const explicitPassword = getExplicitEnv('FICUS_PASSWORD')
  if (explicitPassword) return explicitPassword
  const activeBackend = getActiveBackend(loadAuthStore())
  if (activeBackend) return activeBackend.backend.password
  const dotenvPassword = getDotenvEnv('FICUS_PASSWORD')
  if (dotenvPassword) return dotenvPassword
  const secretExists = deps.secretExists ?? existsSync
  const readSecret = deps.readSecret ?? ((path: string) => readFileSync(path, 'utf-8').trim())
  const secretPath = sandboxPasswordPath({ exists: secretExists })
  if (secretExists(secretPath)) {
    return readSecret(secretPath)
  }
  return ''
}

function getApiUrl(): string {
  const webhook = webhookAuth()
  if (webhook) {
    if (!webhook.apiUrl) throw new Error('Webhook FICUS_API_URL is missing; no saved backend fallback')
    return webhook.apiUrl
  }
  if (isAgentContext()) {
    refuseSelectedBackendInAgentContext()
    return requireAgentApiUrl()
  }
  const selectedBackend = getSelectedBackend()
  if (selectedBackend) return selectedBackend.backend.apiUrl
  const explicitApiUrl = getExplicitEnv('FICUS_API_URL')
  if (explicitApiUrl) return explicitApiUrl
  const activeBackend = getActiveBackend(loadAuthStore())
  if (activeBackend) return activeBackend.backend.apiUrl
  return getDotenvEnv('FICUS_API_URL') ?? 'http://localhost:3000'
}

export type AuthSource =
  | 'webhook-context' // instance-bound identity injected into webhook scripts
  | 'agent-context' // FICUS_AGENT_CONTEXT=1: the identity the runtime injected into this agent shell
  | 'selected-backend' // --backend <label>
  | 'env-token' // FICUS_TOKEN (per-agent scoped token injected into a sandbox)
  | 'env-password' // FICUS_PASSWORD set explicitly in the environment
  | 'auth-store' // the active `ficus auth login` backend
  | 'dotenv' // FICUS_PASSWORD from a .env file
  | 'secret-file' // /etc/tau/password (mounted K8s Secret)
  | 'none'

export interface ResolvedAuth {
  source: AuthSource
  /** Auth-store label when the credential comes from a stored backend. */
  label?: string
  /** The agent this shell belongs to, in agent context. */
  agentId?: string
  /**
   * Identity variables an agent shell is missing. Reporting is deliberately
   * non-throwing: `ficus whoami` / `ficus auth status` exist to diagnose exactly this
   * state, so they must be able to describe a broken agent shell rather than
   * exit on it. Applying the credential (config.apiUrl/config.password) still throws.
   */
  missing?: string[]
  apiUrl: string
  authenticated: boolean
}

/**
 * Which credential `ficus` is ACTUALLY using — the same precedence as
 * `config.password`, reported rather than applied. Lets `ficus auth status` be
 * truthful inside sandboxes, where agents authenticate via the injected
 * FICUS_TOKEN and have no auth-store backend at all (the old "No active Ficus
 * backend configured" there read as "not logged in" while every command worked).
 *
 * `deps.secretExists` overrides the filesystem check for tests only; every production call
 * site omits it and gets the real `existsSync`.
 */
export function resolveAuth(deps: { secretExists?: (path: string) => boolean } = {}): ResolvedAuth {
  const webhook = webhookAuth()
  if (webhook) return webhook
  if (isAgentContext()) {
    refuseSelectedBackendInAgentContext()
    const missing = (['FICUS_API_URL', 'FICUS_TOKEN'] as const).filter((key) => !process.env[key])
    return {
      source: 'agent-context',
      apiUrl: process.env.FICUS_API_URL ?? '',
      ...(process.env.FICUS_AGENT_ID ? { agentId: process.env.FICUS_AGENT_ID } : {}),
      ...(missing.length > 0 ? { missing: [...missing] } : {}),
      authenticated: missing.length === 0,
    }
  }
  const apiUrl = getApiUrl()
  const selectedBackend = getSelectedBackend()
  if (selectedBackend) return { source: 'selected-backend', label: selectedBackend.label, apiUrl, authenticated: true }
  if (getExplicitEnv('FICUS_TOKEN')) return { source: 'env-token', apiUrl, authenticated: true }
  if (getExplicitEnv('FICUS_PASSWORD')) return { source: 'env-password', apiUrl, authenticated: true }
  const activeBackend = getActiveBackend(loadAuthStore())
  if (activeBackend) return { source: 'auth-store', label: activeBackend.label, apiUrl, authenticated: true }
  if (getDotenvEnv('FICUS_PASSWORD')) return { source: 'dotenv', apiUrl, authenticated: true }
  const secretExists = deps.secretExists ?? existsSync
  if (secretExists(sandboxPasswordPath({ exists: secretExists })))
    return { source: 'secret-file', apiUrl, authenticated: true }
  return { source: 'none', apiUrl, authenticated: false }
}

export const config = {
  get apiUrl() {
    return getApiUrl()
  },
  get password() {
    return getPassword()
  },
}
