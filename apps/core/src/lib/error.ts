import type { ProviderHealthKind } from '@ficus/shared/provider-health'
import type { ExhaustionReason } from '../services/provider-health/registry'
import { CLAUDE_CODE_SIGN_IN_FAILED, CLAUDE_CODE_TOO_OLD } from '../services/agent/claude-code/failures'

export interface CaughtProviderErrorClassification {
  kind: ProviderHealthKind
  retryAt?: number
  status?: number
}

export type ProviderTransportReason = 'unexpected-socket-close' | 'connection-reset'

export interface ProviderTransportClassification {
  kind: 'network'
  reason: ProviderTransportReason
}

const DURABLE_SOCKET_CLOSE = 'Provider transport failure: The socket connection was closed unexpectedly'
const DURABLE_CONNECTION_RESET = 'Provider transport failure: Connection reset (ECONNRESET)'
const AUTH_ERROR_MARKERS = [
  'authentication',
  'authorization',
  'unauthorized',
  'invalid credentials',
  'invalid api key',
  'no api key',
  '/login',
]
/**
 * An OAuth sign-in the provider has revoked or can no longer refresh. Unlike a
 * generic 401 (which says nothing certain about the account), these are
 * account-level and stay broken until someone signs in again, so they park the
 * account and fail over. Matched on normalized text (`_`/`-` → space) because
 * pi-ai surfaces both as bare messages without a status:
 * - the codex backend's response: "Your authentication token has been invalidated. Please try signing in again."
 * - a failed token refresh: "OpenAI Codex token refresh failed (401): {…"refresh_token_reused"…}"
 */
const REVOKED_OAUTH_MARKERS = [
  'authentication token has been invalidated',
  'refresh token reused',
  'refresh token has already been used',
  'refresh token expired',
  'refresh token invalidated',
  'refresh token was revoked',
]
const AUTH_ERROR_SYSTEM_MESSAGE =
  '[System] Authentication failed for this model provider. Re-authorize it in Settings → AI Providers, or run `ficus provider-auth login <provider>`. Execution stopped.'

/**
 * Classification of a provider error as exhaustion, with the reason and a
 * suggested cooldown. Returned by {@link classifyProviderError} when the error
 * indicates the provider is exhausted (rate-limited, out of plan credit, at
 * capacity, …). `null` means the error is unrelated to provider exhaustion.
 */
export interface ProviderErrorClassification {
  exhausted: true
  reason: ExhaustionReason
  /** Suggested cooldown ms; the caller may override with a server retry-after. */
  cooldownMs: number
  /**
   * Absolute epoch-ms when the provider should next be retried, parsed from an
   * explicit reset time in the error text (e.g. "Your limit will reset at
   * 2026-06-27 23:58:24"). When present it takes precedence over `cooldownMs` at
   * the failover site, so a hard weekly/monthly limit stays exhausted until its
   * real reset instead of recovering after the default cooldown. `undefined`
   * when the error gives no parseable future reset time.
   */
  retryAt?: number
}

const PLAN_CREDIT_COOLDOWN_MS = 30 * 60_000
const RATE_LIMIT_COOLDOWN_MS = 60_000

/**
 * The two shapes a codex usage limit reaches Ficus in. BOTH are AMBIGUOUS — a
 * transient throttle and an exhausted weekly plan window arrive as the same
 * wording — so the announced window is what decides (see
 * {@link classifyCodexUsageLimit}), never the wording alone.
 *
 * 1. The rewritten HTTP 429. `parseErrorResponse` (openai-codex-responses.js)
 *    discards the upstream `usage_limit_reached` / `plan_type` / `resets_at`
 *    markers and throws `new Error("You have hit your ChatGPT usage limit
 *    (<plan> plan). Try again in ~N min.")`, so that prose is the only limit
 *    signal that survives — the window has to be read back out of it.
 * 2. The in-stream error event. The codex backend can also report the limit as
 *    an SSE/WebSocket `error` event mid-stream; `mapCodexEvents` throws
 *    `CodexApiError("Codex error: The usage limit has been reached")` with the
 *    raw `code` (`usage_limit_reached`) and `payload` (the event, optionally
 *    carrying `plan_type` / `resets_at` / `resets_in_seconds`) as OWN
 *    ENUMERABLE fields. {@link providerErrorText} folds those into the text so
 *    the code is matched here, and {@link parseStructuredRetryAt} reads the
 *    window out of the payload.
 */
const CODEX_USAGE_LIMIT_MARKERS = [
  // 1. the SDK's friendly 429 rewrite
  'chatgpt usage limit',
  // 2. the in-stream error event's message and its raw upstream code
  'usage limit has been reached',
  'usage_limit_reached',
]

/**
 * Rules that map error substrings to an exhaustion reason + cooldown policy.
 *
 * Order matters: more specific/specifically-persistent reasons (plan-credit)
 * are checked before transient ones (rate-limit) so that e.g. "insufficient
 * quota" (matched via 'quota') is classified as plan-credit rather than a generic
 * rate limit.
 */
const EXHAUSTION_RULES: Array<{ substrings: string[]; reason: ExhaustionReason; cooldownMs: number }> = [
  {
    // Hard plan-window limits (e.g. z.ai "429 Weekly/Monthly Limit Exhausted",
    // codex `usage_limit_reached`). These carry a leading "429"/"limit"/
    // "usage limit" that would otherwise match the transient rate-limit rule
    // below and win a too-short 60s cooldown; treat them as plan-credit so they
    // get the long window (and an explicit reset time when present — see
    // classifyProviderError). The codex-specific signatures (`usage_limit_reached`,
    // `plan_type`, `credits-has-credits`, `has-credits:false`) are checked here
    // FIRST so they win over the generic 'usage limit' rate-limit substring even though both may
    // appear in the same codex payload. `usage_limit_reached` is additionally
    // claimed (and hedged on its announced window) by classifyCodexUsageLimit
    // ahead of these rules; it stays listed here as the backstop for a payload
    // that carries the code without any codex window at all.
    substrings: [
      'plan credit',
      'quota',
      'balance',
      'credit',
      'billing',
      'limit exhausted',
      'limit will reset',
      // codex hard plan-limit (usage_limit_reached) — distinct from the
      // space-separated 'usage limit' that stays a transient rate-limit.
      'usage_limit_reached',
      'plan_type',
      'credits-has-credits',
      'has-credits": "false',
      'has-credits":"false',
      // Anthropic, when a Claude plan's extra usage is spent or off.
      'out of extra usage',
    ],
    reason: 'plan-credit',
    cooldownMs: PLAN_CREDIT_COOLDOWN_MS,
  },
  {
    substrings: ['capacity', 'overloaded', 'service unavailable', 'no allowed providers available'],
    reason: 'capacity',
    cooldownMs: 5 * 60_000,
  },
  {
    substrings: ['rate limit', 'usage limit', '429', 'too many requests'],
    reason: 'rate-limit',
    cooldownMs: RATE_LIMIT_COOLDOWN_MS,
  },
]

/**
 * Errors Ficus raises about ITSELF, which must never be read as provider signals.
 *
 * The classifiers below match bare substrings, so any text containing
 * `capacity`, `429` or `quota` is attributed to the model provider no matter who
 * produced it. Ficus's own admission vocabulary collides directly: "Execution
 * session capacity reservation was refused" contains `capacity`, so an internal
 * reservation failure was reported to agents as "[System] Rate limit or plan
 * credit exhaustion. Execution stopped." and classified as provider exhaustion —
 * while the account in question had 68% of its weekly limit remaining.
 *
 * That misattribution is self-sustaining: the agent is parked with a
 * `rate_limit` question, `provider-health-auto-restart` restarts it, admission
 * refuses again, and the loop repeats while the real cause stays invisible.
 *
 * This is a closed set: every string here is one Ficus itself throws, so matching
 * them is exact rather than a guess about a provider's wording.
 */
const INTERNAL_EXECUTION_ERROR_MARKERS = [
  'execution session capacity reservation was refused',
  'admission effect was refused by the durable fence',
  'admission effect fence was revoked',
  'admission effect was revoked or superseded',
  'sandbox provisioning failed',
  'sandbox provisioning was cancelled',
  'sandbox provisioning result expired',
]

/** True when the error is Ficus's own, not a provider's. */
export function isInternalExecutionError(error: string): boolean {
  const lower = error.toLowerCase()
  return INTERNAL_EXECUTION_ERROR_MARKERS.some((marker) => lower.includes(marker))
}

export function classifyCaughtProviderError(
  error: unknown,
  opts: { now?: number } = {}
): CaughtProviderErrorClassification | null {
  const now = opts.now ?? Date.now()
  const text = providerErrorText(error)
  if (text && isInternalExecutionError(text)) return null
  // Claude Code failures the user must fix on their machine: park that account and fail over.
  if (text?.includes(CLAUDE_CODE_SIGN_IN_FAILED)) return { kind: 'expired-oauth' }
  if (text?.includes(CLAUDE_CODE_TOO_OLD)) return { kind: 'invalid-credential' }
  if (text && isRevokedOAuthErrorText(text)) return { kind: 'expired-oauth' }

  const status = findFiniteNumber(error, ['status', 'statusCode']) ?? parseGenericHttpStatus(text)
  // Generic turn auth failures intentionally remain outside routing health.
  if (status === 401 || status === 403) return null

  const legacy = text ? classifyProviderError(text, { now }) : null
  const kind: ProviderHealthKind | undefined =
    legacy?.reason ??
    (status === 429 ? 'rate-limit' : status != null && status >= 500 && status < 600 ? 'capacity' : undefined)
  if (!kind) return null

  const structuredRetryAt = parseStructuredRetryAt(error, now)
  const retryAt = structuredRetryAt ?? (hasStructuredAbsoluteReset(error) ? undefined : legacy?.retryAt)
  // The codex in-stream error event announces its window as structured payload
  // fields (`resets_at` / `resets_in_seconds`) instead of prose, so the string
  // classifier above saw no window and defaulted to plan-credit. Re-run the
  // same hedge now that the window is parsed.
  const hedged =
    structuredRetryAt != null && text != null && isCodexUsageLimitText(text)
      ? hedgeCodexUsageLimit(structuredRetryAt, now).reason
      : kind
  return {
    kind: hedged,
    ...(retryAt ? { retryAt } : {}),
    ...(status != null ? { status } : {}),
  }
}

function normalizedErrorText(message: string): string {
  return message.trim().toLowerCase().replace(/[_-]+/g, ' ')
}

function isAuthenticationErrorText(message: string): boolean {
  const normalized = normalizedErrorText(message)
  return AUTH_ERROR_MARKERS.some((marker) => normalized.includes(marker))
}

function isRevokedOAuthErrorText(message: string): boolean {
  const normalized = normalizedErrorText(message)
  return (
    REVOKED_OAUTH_MARKERS.some((marker) => normalized.includes(marker)) ||
    (normalized.includes('token refresh failed') && normalized.includes('invalid grant'))
  )
}

function isTextualCancellationError(message: string): boolean {
  const normalized = normalizedErrorText(message)
  return [
    'operation aborted by user',
    'operation canceled by user',
    'operation cancelled by user',
    'request aborted by user',
    'request canceled by user',
    'request cancelled by user',
  ].some((marker) => normalized.includes(marker))
}

function providerTransportReason(error: unknown): ProviderTransportReason | null {
  const nodes = providerErrorChain(error)
  if (
    nodes.some((node) => {
      const message = typeof node.message === 'string' ? node.message : ''
      return (
        (typeof node.name === 'string' && node.name.toLowerCase() === 'aborterror') ||
        (typeof node.code === 'string' && node.code.toUpperCase() === 'ABORT_ERR') ||
        node.status === 401 ||
        node.status === 403 ||
        isInternalExecutionError(message) ||
        isAuthenticationErrorText(message) ||
        isTextualCancellationError(message) ||
        classifyProviderError(message) != null
      )
    })
  ) {
    return null
  }

  for (const node of nodes) {
    const message = typeof node.message === 'string' ? node.message.trim().toLowerCase() : ''
    const code = typeof node.code === 'string' ? node.code.toUpperCase() : ''
    if (message === 'the socket connection was closed unexpectedly') return 'unexpected-socket-close'
    if (code === 'ECONNRESET' || message === 'socket hang up' || message === 'connection reset by peer') {
      return 'connection-reset'
    }
  }
  return null
}

/** Classify only narrow model-call transport resets; shared provider consumers must opt in. */
export function classifyProviderTransportError(error: unknown): ProviderTransportClassification | null {
  const reason = providerTransportReason(error)
  return reason ? { kind: 'network', reason } : null
}

/** Return a credential-safe durable marker for eligible provider transport failures. */
export function durableProviderTransportFailureText(error: unknown): string | null {
  const classification = classifyProviderTransportError(error)
  if (!classification) return null
  return classification.reason === 'unexpected-socket-close' ? DURABLE_SOCKET_CLOSE : DURABLE_CONNECTION_RESET
}

/** True only for transport markers emitted at the model/provider call boundary. */
export function isDurableProviderTransportFailure(error: unknown): boolean {
  return error === DURABLE_SOCKET_CLOSE || error === DURABLE_CONNECTION_RESET
}

function providerErrorChain(error: unknown): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    nodes.push({
      message: value instanceof Error ? value.message : record.message,
      name: value instanceof Error ? value.name : record.name,
      code: record.code,
      status: record.status ?? record.statusCode,
    })
    for (const key of ['cause', 'error', 'body', 'response']) visit(record[key], depth + 1)
  }
  visit(error, 0)
  if (typeof error === 'string') nodes.push({ message: error })
  return nodes
}

function parseGenericHttpStatus(text: string | undefined): number | undefined {
  if (!text) return undefined
  const framed = text.match(
    /\bAPI error\s*\((5\d{2})\)(?::|\s|$)|\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s+(5\d{2})\b/i
  )
  if (framed) return Number(framed[1] ?? framed[2])
  const conventional = text.match(
    /^(5\d{2})\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i
  )
  return conventional ? Number(conventional[1]) : undefined
}

/** Keys whose string values carry provider signal, and whose objects are worth descending into. */
const PROVIDER_TEXT_KEYS = ['message', 'type', 'code', 'error', 'body', 'response', 'payload'] as const

/**
 * Flatten an error into the text the substring classifiers read.
 *
 * An `Error`'s `message` is not necessarily its whole signal: the codex client
 * throws `CodexApiError("Codex error: The usage limit has been reached")` whose
 * own enumerable `code` (`usage_limit_reached`) and `payload` (the raw event)
 * carry the hard-limit markers, and dropping them left the bare sentence to
 * match the generic 'usage limit' rate-limit substring for a 60s cooldown. So
 * the message is combined with the same key walk applied to the error's OWN
 * ENUMERABLE properties (`{ ...error }` is exactly those; `message`/`stack` are
 * not enumerable, so nothing is duplicated).
 */
export function providerErrorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (!isRecord(error)) return undefined
  const values: string[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || !isRecord(value)) return
    for (const key of PROVIDER_TEXT_KEYS) {
      const child = value[key]
      if (typeof child === 'string') values.push(child)
      else visit(child, depth + 1)
    }
  }
  if (error instanceof Error) {
    values.push(error.message)
    visit({ ...error }, 0)
  } else {
    visit(error, 0)
  }
  return values.join(' ') || undefined
}

function findFiniteNumber(error: unknown, keys: readonly string[]): number | undefined {
  let found: number | undefined
  const visit = (value: unknown, depth: number) => {
    if (found != null || depth > 3 || !isRecord(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && typeof child === 'number' && Number.isFinite(child)) {
        found = child
        return
      }
      if (['response', 'error', 'body', 'payload'].includes(key)) visit(child, depth + 1)
    }
  }
  visit(error, 0)
  return found
}

function hasStructuredAbsoluteReset(error: unknown): boolean {
  let present = false
  const visit = (value: unknown, depth: number) => {
    if (present || depth > 3 || !isRecord(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (['reset_at', 'resetAt', 'resets_at', 'reset-at'].includes(key)) {
        const numeric = typeof child === 'number' || typeof child === 'string' ? Number(child) : Number.NaN
        const parsed = typeof child === 'string' ? Date.parse(child) : Number.NaN
        present = Number.isFinite(numeric) || Number.isFinite(parsed)
        if (present) return
      }
      if (['response', 'body', 'error', 'payload'].includes(key)) visit(child, depth + 1)
    }
  }
  visit(error, 0)
  return present
}

function parseStructuredRetryAt(error: unknown, now: number): number | undefined {
  if (!isRecord(error)) return undefined
  const response = isRecord(error.response) ? error.response : error
  const nodes: Record<string, unknown>[] = []
  const collect = (value: unknown, depth: number) => {
    if (depth > 3 || !isRecord(value)) return
    nodes.push(value)
    // `payload` is the codex in-stream error event's raw body (CodexApiError.payload),
    // where that shape's `resets_at` / `resets_in_seconds` live.
    for (const key of ['response', 'body', 'error', 'payload']) collect(value[key], depth + 1)
  }
  collect(error, 0)

  for (const node of nodes) {
    for (const key of ['reset_at', 'resetAt', 'resets_at', 'reset-at']) {
      if (!(key in node)) continue
      const value = node[key]
      const numeric = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
      if (Number.isFinite(numeric)) {
        const timestamp = numeric < 10_000_000_000 ? numeric * 1_000 : numeric
        return timestamp > now ? timestamp : undefined
      }
      if (typeof value === 'string') {
        const timestamp = Date.parse(value)
        return Number.isFinite(timestamp) && timestamp > now ? timestamp : undefined
      }
      return undefined
    }
  }
  const headers = isRecord(response.headers) ? response.headers : undefined
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof retryAfter === 'string' || typeof retryAfter === 'number') {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1_000
    const date = Date.parse(String(retryAfter))
    if (Number.isFinite(date) && date > now) return date
  }
  for (const node of nodes) {
    for (const key of ['reset_after', 'resetAfter', 'resets_in_seconds', 'reset-after']) {
      const seconds = Number(node[key])
      if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1_000
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

/**
 * Classify an error string as provider exhaustion, or `null` if unrelated.
 *
 * This is the reactive, error-based health signal used by runtime failover: on
 * a settled error or a thrown `prompt()`, the runner calls this to decide
 * whether to mark the active provider exhausted and fail over to the next
 * candidate. Pi retries transient errors (`maxRetries: 5`) internally, so for
 * those this only acts once the error settles. Hard plan limits (`limit
 * exhausted` / `limit will reset`) are made non-retryable in the SDK by the Ficus
 * patch (patches/@earendil-works%2Fpi-ai@0.99.1.patch, extending both
 * `retry.js`'s NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN and
 * `openai-codex-responses.js`'s isTerminalRateLimitError; guarded by
 * AgentSession.retry-patch.test.ts), so they settle on attempt 1 and fail over
 * immediately instead of burning all five retries.
 */
export function classifyProviderError(error: string, opts: { now?: number } = {}): ProviderErrorClassification | null {
  // A Ficus-internal failure is never provider exhaustion, whatever words it shares.
  if (isInternalExecutionError(error)) return null
  const lower = error.toLowerCase()
  // Claude Code's subscription-window refusal contains neither "rate limit"
  // nor "usage limit". It is account exhaustion even without an HTTP status.
  if (/\byou['’]ve hit your session limit\b/i.test(error)) {
    return {
      exhausted: true,
      reason: 'plan-credit',
      cooldownMs: PLAN_CREDIT_COOLDOWN_MS,
      retryAt: parseClaudeSessionReset(error, opts.now ?? Date.now()),
    }
  }
  const codex = classifyCodexUsageLimit(error, lower)
  if (codex) return codex
  for (const rule of EXHAUSTION_RULES) {
    if (rule.substrings.some((s) => lower.includes(s))) {
      return {
        exhausted: true,
        reason: rule.reason,
        cooldownMs: rule.cooldownMs,
        retryAt: parseResetTimestamp(error),
      }
    }
  }
  return null
}

/** A clock-only UTC reset means its next occurrence; never guess an absent/local timezone. */
function parseClaudeSessionReset(error: string, now: number): number | undefined {
  const match = error.match(/\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour < 1 || hour > 12 || minute > 59) return undefined
  const reset = new Date(now)
  reset.setUTCHours((hour % 12) + (match[3]!.toLowerCase() === 'pm' ? 12 : 0), minute, 0, 0)
  if (reset.getTime() <= now) reset.setUTCDate(reset.getUTCDate() + 1)
  return reset.getTime()
}

/**
 * Classify either codex usage-limit shape (see {@link CODEX_USAGE_LIMIT_MARKERS}).
 *
 * The wording alone cannot tell a transient throttle from an exhausted plan
 * window, so the announced window decides: a window shorter than the
 * plan-credit cooldown is treated as the transient rate limit it almost
 * certainly is (and keeps its own, shorter, retryAt rather than parking the
 * account for half an hour), while a longer or ABSENT window is treated as a
 * plan limit — absent means the upstream sent no reset at all, which is the
 * shape a hard plan window arrives in. Checked before {@link EXHAUSTION_RULES}
 * because the bare 'usage limit' substring there would otherwise win every one
 * of these a 60s cooldown with no reset at all.
 *
 * The window can be prose ("Try again in ~43 min.") or a `resets_at` /
 * `resets_in_seconds` marker, so the full {@link parseResetTimestamp} runs
 * here. The in-stream event carries its window as STRUCTURED payload fields
 * that never reach this string, so {@link classifyCaughtProviderError} re-runs
 * the same hedge once it has parsed them.
 */
function classifyCodexUsageLimit(error: string, lower: string): ProviderErrorClassification | null {
  if (!isCodexUsageLimitText(lower)) return null
  return hedgeCodexUsageLimit(parseResetTimestamp(error))
}

/** True when the text carries either codex usage-limit shape (already lowercased is fine). */
function isCodexUsageLimitText(text: string): boolean {
  const lower = text.toLowerCase()
  return CODEX_USAGE_LIMIT_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * The codex hedge: an announced window shorter than the plan-credit cooldown is
 * the transient throttle it almost certainly is (and keeps its own, shorter,
 * retryAt); a longer or ABSENT window is a plan limit.
 */
function hedgeCodexUsageLimit(retryAt: number | undefined, now: number = Date.now()): ProviderErrorClassification {
  const transient = retryAt != null && retryAt - now < PLAN_CREDIT_COOLDOWN_MS
  return {
    exhausted: true,
    reason: transient ? 'rate-limit' : 'plan-credit',
    cooldownMs: transient ? RATE_LIMIT_COOLDOWN_MS : PLAN_CREDIT_COOLDOWN_MS,
    ...(retryAt != null ? { retryAt } : {}),
  }
}

/**
 * Parse an explicit reset time embedded in a provider error message into an
 * absolute epoch-ms timestamp. Returns `undefined` when there is no parseable
 * future reset (an expired/past reset would un-exhaust the provider
 * immediately, defeating the point).
 *
 * Recognized forms, tried in order:
 *  1. Human-readable date: "Your limit will reset at 2026-06-27 23:58:24"
 *     (space-separated local time) or ISO-8601.
 *  2. Unix-seconds absolute, as used by codex:
 *     `"resets_at":1786984973` (JSON body) or
 *     `"X-Codex-Primary-Reset-At":"1786984973"` (header).
 *  3. Unix-seconds relative, as used by codex:
 *     `"X-Codex-Primary-Reset-After-Seconds":"2583500"` → now + seconds.
 *     Used only when no absolute reset key is present. If an absolute key is
 *     present but stale/past, absolute still wins and the result is
 *     `undefined` rather than falling back to a relative window.
 *  4. Human-readable relative, as written by the bundled codex client's
 *     friendly 429 rewrite: "Try again in ~43 min." → now + 43 min.
 */
function parseResetTimestamp(error: string): number | undefined {
  const dateReset = parseDateResetTimestamp(error)
  if (dateReset !== undefined) return dateReset

  const absoluteReset = parseUnixAbsoluteResetTimestamp(error)
  if (absoluteReset.present) return absoluteReset.retryAt

  const unixRelative = parseUnixRelativeResetTimestamp(error)
  if (unixRelative !== undefined) return unixRelative

  return parseFriendlyRelativeResetTimestamp(error)
}

/**
 * Human-readable RELATIVE reset, as written by the bundled codex client when it
 * rewrites a 429: `Try again in ~43 min.` (it computes the minutes from the
 * upstream `resets_at` and then discards it, so this prose is the only reset
 * signal that survives). Also accepts the unabbreviated and hour forms
 * ("in 15 minutes", "in ~2 h"). Returns `now + N * 60_000`; `undefined` for a
 * zero/absent window, which leaves the caller on its default cooldown.
 */
function parseFriendlyRelativeResetTimestamp(error: string): number | undefined {
  const match = error.match(/try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|m|h)\b/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const unitMs = /^h/i.test(match[2]) ? 60 * 60_000 : 60_000
  return Date.now() + amount * unitMs
}

/**
 * Human-readable "reset[s] [at|on] <date>" form. The trailing class captures
 * dates, times, and the ISO 'T'/'Z' separators; punctuation is trimmed after.
 */
function parseDateResetTimestamp(error: string): number | undefined {
  const match = error.match(/reset(?:s|ting)?(?:\s+(?:at|on))?\s+([0-9T:.\-/ ]+)/i)
  if (!match) return undefined
  const raw = match[1].trim().replace(/[.\s]+$/, '')
  // Normalize the "YYYY-MM-DD HH:MM:SS" form to ISO-local so Date.parse is
  // reliable across engines (JSC/V8); a bare space form is otherwise iffy.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw
  const ts = Date.parse(normalized)
  if (Number.isNaN(ts)) return undefined
  return ts > Date.now() ? ts : undefined
}

/**
 * Unix-seconds ABSOLUTE reset, as surfaced by codex either in the JSON body
 * (`"resets_at":1786984973`) or in a header (`"X-Codex-Primary-Reset-At":
 * "1786984973"`). Recognizes the keys `resets_at`, `reset[-_]at`, and any
 * header ending in `reset-at` (e.g. `x-codex-primary-reset-at`). The value is
 * seconds-since-epoch; multiply by 1000 for ms. Requires >= 9 digits to avoid
 * matching short relative counters.
 */
function parseUnixAbsoluteResetTimestamp(error: string): { present: boolean; retryAt?: number } {
  // Key (possibly quoted, possibly kebab/snake) then ':' then an optional quote, then digits.
  const match = error.match(/(?:resets_at|reset[-_]?at)["']?\s*:\s*"?(\d{9,})/i)
  if (!match) return { present: false }
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds)) return { present: true }
  const ts = seconds * 1000
  return ts > Date.now() ? { present: true, retryAt: ts } : { present: true }
}

/**
 * Unix-seconds RELATIVE reset, as surfaced by codex in the
 * `X-Codex-Primary-Reset-After-Seconds` header or a `resets_in_seconds` body
 * field. Returns `now + seconds*1000`. Always in the future for seconds > 0.
 * Only consulted when no absolute reset is present.
 */
function parseUnixRelativeResetTimestamp(error: string): number | undefined {
  const match = error.match(/(?:reset[-_]?after[-_]?seconds|resets[-_]?in[-_]?seconds)["']?\s*:\s*"?(\d{1,})/i)
  if (!match) return undefined
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Date.now() + seconds * 1000
}

/**
 * Match an error string against known error types and return the appropriate system message.
 * Returns null if no known error type matches.
 * Priority order: rate limit > overloaded > authentication
 */
export function getErrorSystemMessage(error: string): string | null {
  // Never tell an operator their plan is exhausted because Ficus refused its own
  // capacity reservation.
  if (isInternalExecutionError(error)) return null
  const lower = error.toLowerCase()
  for (const { substrings, message } of ERROR_CONFIG) {
    if (substrings.some((s) => lower.includes(s))) return message
  }
  return isAuthenticationErrorText(error) ? AUTH_ERROR_SYSTEM_MESSAGE : null
}

const ERROR_CONFIG: Array<{ substrings: string[]; message: string }> = [
  {
    substrings: ['rate limit', 'usage limit', '429', 'quota', 'plan credit', 'capacity'],
    message: '[System] Rate limit or plan credit exhaustion. Execution stopped.',
  },
  {
    substrings: ['overloaded_error'],
    message: '[System] Provider is overloaded. Execution stopped.',
  },
]
