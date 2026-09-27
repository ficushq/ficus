import { OAUTH_PROVIDER_HINT_SESSION_KEY } from '@ficus/shared/browser-keys'
const CALLBACK_PATH_SUFFIX = '/settings/integrations/oauth/callback'
const FLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPAQUE_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const BROKER_STATE_KEY = 'tauOAuthCompletion'
const LOCAL_STATE_KEY = 'tauOAuthLocalCallback'
const OUTCOME_STATE_KEY = 'tauOAuthCallbackOutcome'
const ROUTER_HISTORY_KEYS = new Set(['idx', 'key', 'usr'])
const PROVIDER_STATE_KEY = 'tauOAuthCallbackProvider'

export type BrokerCompletionPayload = { localFlowId: string; handle: string }
export type LocalCallbackPayload = { state: string; code?: string; denied?: true }
export type PreparedOAuthCallback =
  | { kind: 'broker'; body: BrokerCompletionPayload; provider?: 'notion' | 'slack' }
  | { kind: 'local'; body: LocalCallbackPayload }
  | { kind: 'cancelled' }
  | { kind: 'terminal' }

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

function validProviderHintValue(value: unknown): value is 'notion' | 'slack' {
  return value === 'notion' || value === 'slack'
}

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
      window.location.pathname.endsWith(`${CALLBACK_PATH_SUFFIX}/github`)
    ) ||
    window.location.search === ''
  )
    return

  const params = new URLSearchParams(window.location.search)
  if (params.has('status')) {
    const status = params.get('status')
    if (status === 'denied') {
      replaceCallbackState({ [OUTCOME_STATE_KEY]: 'cancelled' })
      return
    }
    const payload = { localFlowId: params.get('flow'), handle: params.get('handle') }
    if (status === 'ok' && validBrokerPayload(payload)) {
      // Read (and clear) the initiating component's sessionStorage hint now,
      // and carry it in the same reload-surviving history state as the
      // payload. Consuming it only once, at first render, would lose it on a
      // later reload (e.g. retrying after a retryable completion failure),
      // silently falling back to the wrong provider.
      const providerHint = consumeOAuthProviderHint()
      replaceCallbackState({
        [BROKER_STATE_KEY]: payload,
        ...(validProviderHintValue(providerHint) ? { [PROVIDER_STATE_KEY]: providerHint } : {}),
      })
      return
    }
    replaceCallbackState({ [OUTCOME_STATE_KEY]: 'terminal' })
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
  replaceCallbackState({ [OUTCOME_STATE_KEY]: 'terminal' })
}

/** Read and strictly validate the callback payload plus known BrowserRouter metadata. */
export function readPreparedOAuthCallback(): PreparedOAuthCallback | undefined {
  const state = window.history.state as unknown
  if (!isRecord(state)) return undefined
  const preparedKeys = [BROKER_STATE_KEY, LOCAL_STATE_KEY, OUTCOME_STATE_KEY].filter((key) => key in state)
  if (preparedKeys.length !== 1) return undefined
  for (const [key, value] of Object.entries(state)) {
    if (preparedKeys.includes(key)) continue
    if (key === PROVIDER_STATE_KEY && validProviderHintValue(value)) continue
    if (!validRouterHistoryMetadata(key, value)) return undefined
  }

  if (validBrokerPayload(state[BROKER_STATE_KEY])) {
    const provider = state[PROVIDER_STATE_KEY]
    return {
      kind: 'broker',
      body: state[BROKER_STATE_KEY],
      ...(validProviderHintValue(provider) ? { provider } : {}),
    }
  }
  if (validLocalPayload(state[LOCAL_STATE_KEY])) return { kind: 'local', body: state[LOCAL_STATE_KEY] }
  if (state[OUTCOME_STATE_KEY] === 'cancelled') return { kind: 'cancelled' }
  if (state[OUTCOME_STATE_KEY] === 'terminal') return { kind: 'terminal' }
  return undefined
}

export function clearPreparedOAuthCallback(): void {
  window.history.replaceState(null, '', window.location.pathname)
}

/**
 * Only GitHub's callback URL carries a path suffix identifying its provider;
 * every other broker/local flow (Notion, Slack, …) shares one callback path,
 * so the initiating component records which provider it started in
 * sessionStorage right before leaving the page. Not sensitive material — just
 * a provider key — so sessionStorage (rather than history state) is fine.
 * Always overwrite on start so an abandoned flow's hint cannot mislabel a
 * later one; the callback page consumes (and clears) it once.
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
