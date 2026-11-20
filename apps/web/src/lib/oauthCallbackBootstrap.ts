import {
  OAUTH_CALLBACK_OUTCOME_STATE_KEY,
  OAUTH_CALLBACK_PROVIDER_STATE_KEY,
  OAUTH_CALLBACK_REASON_STATE_KEY,
  OAUTH_COMPLETION_STATE_KEY,
  OAUTH_LOCAL_CALLBACK_STATE_KEY,
  OAUTH_PROVIDER_HINT_SESSION_KEY,
} from '@ficus/shared/browser-keys'

const CALLBACK_PATH_SUFFIX = '/settings/integrations/oauth/callback'
const FLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPAQUE_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const BROKER_STATE_KEY = OAUTH_COMPLETION_STATE_KEY
const LOCAL_STATE_KEY = OAUTH_LOCAL_CALLBACK_STATE_KEY
const OUTCOME_STATE_KEY = OAUTH_CALLBACK_OUTCOME_STATE_KEY
const ROUTER_HISTORY_KEYS = new Set(['idx', 'key', 'usr'])
const PROVIDER_STATE_KEY = OAUTH_CALLBACK_PROVIDER_STATE_KEY
const REASON_STATE_KEY = OAUTH_CALLBACK_REASON_STATE_KEY
/** The broker's redirect names a failure with a short safe code, never provider text. */
const SAFE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export type OAuthHintProvider = 'linear' | 'notion' | 'slack'
export type BrokerCompletionPayload = { localFlowId: string; handle: string }
export type LocalCallbackPayload = { state: string; code?: string; denied?: true }
/**
 * A completion carries no provider: the page asks Core which provider started the flow. A settled
 * outcome has no flow to ask about, so the initiating tab's hint (when this tab has it) only labels it.
 */
export type PreparedOAuthCallback =
  | { kind: 'broker'; body: BrokerCompletionPayload }
  | { kind: 'local'; body: LocalCallbackPayload }
  | { kind: 'cancelled'; provider?: OAuthHintProvider }
  | { kind: 'terminal'; provider?: OAuthHintProvider; reason?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validBrokerPayload(value: unknown): value is BrokerCompletionPayload {
  if (!isRecord(value)) return false
  return (
    Object.keys(value).length === 2 &&
    typeof value.localFlowId === 'string' &&
    FLOW_ID_PATTERN.test(value.localFlowId) &&
    typeof value.handle === 'string' &&
    OPAQUE_STATE_PATTERN.test(value.handle)
  )
}

function validLocalPayload(value: unknown): value is LocalCallbackPayload {
  if (!isRecord(value) || typeof value.state !== 'string' || !OPAQUE_STATE_PATTERN.test(value.state)) return false
  const keys = Object.keys(value).sort().join(',')
  if (keys === 'denied,state') return value.denied === true
  return keys === 'code,state' && typeof value.code === 'string' && value.code.length >= 1 && value.code.length <= 4_096
}

function validProviderHintValue(value: unknown): value is OAuthHintProvider {
  return value === 'linear' || value === 'notion' || value === 'slack'
}

function validReason(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value)
}

/** GitHub and Linear self-hosted callbacks name their provider in the path. */
const PROVIDER_CALLBACK_SUFFIXES = ['github', 'linear'] as const

function validRouterHistoryMetadata(key: string, value: unknown): boolean {
  if (!ROUTER_HISTORY_KEYS.has(key)) return false
  if (key === 'idx') return typeof value === 'number' && Number.isInteger(value)
  if (key === 'key') return typeof value === 'string'
  return true
}

function replaceCallbackState(state: Record<string, unknown>): void {
  window.history.replaceState(state, '', window.location.pathname)
}

/**
 * Capture OAuth callback material before any app bootstrap work can issue a
 * request whose Referer still contains the query. Only same-tab history state
 * is used; no payload reaches storage, logs, analytics, or rendered output.
 */
export function prepareOAuthCallbackHistory(): void {
  if (
    !(
      window.location.pathname.endsWith(CALLBACK_PATH_SUFFIX) ||
      PROVIDER_CALLBACK_SUFFIXES.some((provider) =>
        window.location.pathname.endsWith(`${CALLBACK_PATH_SUFFIX}/${provider}`)
      )
    ) ||
    window.location.search === ''
  )
    return

  const params = new URLSearchParams(window.location.search)
  // Always clear the hint so it cannot outlive this callback and mislabel a later one. It only ever
  // labels a settled outcome: it exists only in the tab that started the flow, and a flow started in
  // the Desktop app or another tab returns here without it.
  const providerHint = consumeOAuthProviderHint()
  const hinted = validProviderHintValue(providerHint) ? { [PROVIDER_STATE_KEY]: providerHint } : {}
  if (params.has('status')) {
    const status = params.get('status')
    if (status === 'denied') {
      replaceCallbackState({ [OUTCOME_STATE_KEY]: 'cancelled', ...hinted })
      return
    }
    const payload = { localFlowId: params.get('flow'), handle: params.get('handle') }
    if (status === 'ok' && validBrokerPayload(payload)) {
      replaceCallbackState({ [BROKER_STATE_KEY]: payload })
      return
    }
    const reason = params.get('code')
    replaceCallbackState({
      [OUTCOME_STATE_KEY]: 'terminal',
      ...hinted,
      ...(validReason(reason) ? { [REASON_STATE_KEY]: reason } : {}),
    })
    return
  }

  const state = params.get('state')
  if (state && OPAQUE_STATE_PATTERN.test(state)) {
    if (params.has('error')) {
      replaceCallbackState({ [LOCAL_STATE_KEY]: { state, denied: true } })
      return
    }
    const code = params.get('code')
    if (code && code.length <= 4_096) {
      replaceCallbackState({ [LOCAL_STATE_KEY]: { state, code } })
      return
    }
  }
  replaceCallbackState({ [OUTCOME_STATE_KEY]: 'terminal', ...hinted })
}

/** Read and strictly validate the callback payload plus known BrowserRouter metadata. */
export function readPreparedOAuthCallback(): PreparedOAuthCallback | undefined {
  const state = window.history.state as unknown
  if (!isRecord(state)) return undefined
  const preparedKeys = [BROKER_STATE_KEY, LOCAL_STATE_KEY, OUTCOME_STATE_KEY].filter((key) => key in state)
  if (preparedKeys.length !== 1) return undefined
  const outcome = preparedKeys[0] === OUTCOME_STATE_KEY
  for (const [key, value] of Object.entries(state)) {
    if (preparedKeys.includes(key)) continue
    // A completion saved by an earlier release may still carry a hint; it is ignored there.
    if (key === PROVIDER_STATE_KEY && validProviderHintValue(value)) continue
    if (outcome && key === REASON_STATE_KEY && state[OUTCOME_STATE_KEY] === 'terminal' && validReason(value)) continue
    if (!validRouterHistoryMetadata(key, value)) return undefined
  }

  if (validBrokerPayload(state[BROKER_STATE_KEY])) return { kind: 'broker', body: state[BROKER_STATE_KEY] }
  if (validLocalPayload(state[LOCAL_STATE_KEY])) return { kind: 'local', body: state[LOCAL_STATE_KEY] }
  const provider = state[PROVIDER_STATE_KEY]
  const label = validProviderHintValue(provider) ? { provider } : {}
  if (state[OUTCOME_STATE_KEY] === 'cancelled') return { kind: 'cancelled', ...label }
  if (state[OUTCOME_STATE_KEY] === 'terminal') {
    const reason = state[REASON_STATE_KEY]
    return { kind: 'terminal', ...label, ...(validReason(reason) ? { reason } : {}) }
  }
  return undefined
}

export function clearPreparedOAuthCallback(): void {
  window.history.replaceState(null, '', window.location.pathname)
}

/**
 * Records which provider this tab is starting, right before leaving for it. The callback page uses
 * it only to name the provider on a cancelled or failed callback, which carries no flow Core could
 * look up; a completion always asks Core. Not sensitive material, just a provider key. Always
 * overwrite on start so an abandoned flow's hint cannot mislabel a later one; the callback page
 * consumes (and clears) it once.
 */
export function rememberOAuthProviderHint(provider: string): void {
  try {
    window.sessionStorage.setItem(OAUTH_PROVIDER_HINT_SESSION_KEY, provider)
  } catch {
    // Storage may be unavailable (private browsing); the callback page falls back to its default.
  }
}

export function consumeOAuthProviderHint(): string | undefined {
  try {
    const value = window.sessionStorage.getItem(OAUTH_PROVIDER_HINT_SESSION_KEY)
    window.sessionStorage.removeItem(OAUTH_PROVIDER_HINT_SESSION_KEY)
    return value ?? undefined
  } catch {
    return undefined
  }
}
