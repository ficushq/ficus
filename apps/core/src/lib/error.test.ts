import { describe, expect, it, test } from 'bun:test'
import {
  classifyCaughtProviderError,
  classifyProviderError,
  classifyProviderTransportError,
  durableProviderTransportFailureText,
  getErrorSystemMessage,
  isDurableProviderTransportFailure,
  isInternalExecutionError,
  providerErrorText,
} from './error'

describe('classifyCaughtProviderError', () => {
  test('reads structured status and Retry-After without returning raw provider text', () => {
    const error = {
      response: {
        status: 429,
        headers: { 'retry-after': '30' },
        body: { message: 'secret-token https://provider.invalid/private rate limit' },
      },
    }
    expect(classifyCaughtProviderError(error, { now: 1_000 })).toEqual({
      kind: 'rate-limit',
      retryAt: 31_000,
      status: 429,
    })
  })

  test('parses field-aware structured absolute and relative resets', () => {
    expect(
      classifyCaughtProviderError({ status: 429, body: { reset_at: 2_000_000_000 } }, { now: 1_000 })?.retryAt
    ).toBe(2_000_000_000_000)
    expect(
      classifyCaughtProviderError({ status: 429, body: { resetAt: 2_000_000_000_000 } }, { now: 1_000 })?.retryAt
    ).toBe(2_000_000_000_000)
    expect(classifyCaughtProviderError({ status: 429, body: { reset_after: 30 } }, { now: 1_000 })?.retryAt).toBe(
      31_000
    )
  })

  test('preserves legacy string and Error reset timestamps', () => {
    const reset = 2_000_000_000
    const text = `usage_limit_reached "resets_at":${reset}`
    expect(classifyCaughtProviderError(text, { now: 1_000 })?.retryAt).toBe(reset * 1_000)
    expect(classifyCaughtProviderError(new Error(text), { now: 1_000 })?.retryAt).toBe(reset * 1_000)
  })

  test('a stale structured absolute reset suppresses every relative reset source', () => {
    const legacyRelative = Object.assign(
      new Error('usage_limit_reached X-Codex-Primary-Reset-After-Seconds: 2583500'),
      { body: { resets_at: 1 } }
    )
    const retryAfter = {
      status: 429,
      response: { headers: { 'retry-after': '30' }, body: { resets_at: 1 } },
    }
    const structuredRelative = { status: 429, body: { resets_at: 1, reset_after: 30 } }

    for (const error of [legacyRelative, retryAfter, structuredRelative]) {
      expect(classifyCaughtProviderError(error, { now: 10_000 })?.retryAt).toBeUndefined()
    }
  })

  test('falls back from malformed structured fields to legacy Error signatures', () => {
    expect(
      classifyCaughtProviderError(Object.assign(new Error('service unavailable'), { status: 'bad' }), { now: 1_000 })
    ).toEqual({ kind: 'capacity' })
  })

  test('classifies the full framed 5xx class as capacity without matching arbitrary numbers', () => {
    for (const [status, phrase] of [
      [500, 'Internal Server Error'],
      [501, 'Not Implemented'],
      [502, 'Bad Gateway'],
      [504, 'Gateway Timeout'],
      [505, 'HTTP Version Not Supported'],
      [507, 'Insufficient Storage'],
      [599, 'Unknown Server Error'],
    ] as const) {
      expect(classifyCaughtProviderError(`OpenAI API error (${status}): ${phrase}`)).toEqual({
        kind: 'capacity',
        status,
      })
    }
    for (const [status, phrase] of [
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [504, 'Gateway Timeout'],
    ] as const) {
      expect(classifyCaughtProviderError(`${status} ${phrase}`)).toEqual({ kind: 'capacity', status })
    }
    expect(classifyCaughtProviderError('Tool processed 500 records successfully')).toBeNull()
  })

  test('classifies OpenRouter hard-pin endpoint exhaustion as capacity', () => {
    expect(classifyCaughtProviderError('No allowed providers available for this model')).toEqual({
      kind: 'capacity',
    })
  })

  test('does not classify Ficus internal or generic credential errors', () => {
    expect(classifyCaughtProviderError(new Error('Execution session capacity reservation was refused'))).toBeNull()
    expect(classifyCaughtProviderError({ status: 401, message: 'invalid api key' })).toBeNull()
    expect(classifyCaughtProviderError('OpenAI Codex token refresh failed (500): upstream error')).toBeNull()
  })

  test('parks a revoked OAuth sign-in so its account fails over instead of halting every agent on it', () => {
    for (const error of [
      // The codex backend's response once the ChatGPT sign-in is revoked (a bare message, no status).
      'Your authentication token has been invalidated. Please try signing in again.',
      new Error('Your authentication token has been invalidated. Please try signing in again.'),
      { status: 401, message: 'Your authentication token has been invalidated. Please try signing in again.' },
      // A refresh with a spent or revoked refresh token.
      'OpenAI Codex token refresh failed (401): {"error":{"code":"refresh_token_reused"}}',
      'OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}',
      'OpenAI Codex token refresh failed (401): {"error":{"code":"refresh_token_expired"}}',
    ]) {
      expect(classifyCaughtProviderError(error)).toEqual({ kind: 'expired-oauth' })
    }
  })

  test('keeps transport resets out of the shared provider classifier', () => {
    expect(classifyCaughtProviderError('The socket connection was closed unexpectedly')).toBeNull()
    expect(classifyCaughtProviderError(new Error('socket hang up'))).toBeNull()
    expect(
      classifyCaughtProviderError(
        new Error('fetch failed', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        })
      )
    ).toBeNull()
  })

  test('classifies narrow socket reset signatures at the transport boundary', () => {
    expect(classifyProviderTransportError('The socket connection was closed unexpectedly')).toEqual({
      kind: 'network',
      reason: 'unexpected-socket-close',
    })
    expect(classifyProviderTransportError(new Error('socket hang up'))).toEqual({
      kind: 'network',
      reason: 'connection-reset',
    })
    expect(
      classifyProviderTransportError(
        new Error('fetch failed', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        })
      )
    ).toEqual({ kind: 'network', reason: 'connection-reset' })
  })

  test('maps transport resets to closed durable provenance', () => {
    expect(durableProviderTransportFailureText('The socket connection was closed unexpectedly')).toBe(
      'Provider transport failure: The socket connection was closed unexpectedly'
    )
    expect(isDurableProviderTransportFailure('The socket connection was closed unexpectedly')).toBe(false)
    expect(
      isDurableProviderTransportFailure('Provider transport failure: The socket connection was closed unexpectedly')
    ).toBe(true)
    expect(durableProviderTransportFailureText(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      'Provider transport failure: Connection reset (ECONNRESET)'
    )
  })

  test('excludes cancellation, auth, quota, internal, sandbox, DNS, and TLS errors from network classification', () => {
    const socketClosed = 'The socket connection was closed unexpectedly'
    const errors = [
      Object.assign(new Error(socketClosed), { name: 'AbortError' }),
      Object.assign(new Error(socketClosed), { code: 'ABORT_ERR' }),
      { status: 401, cause: { code: 'ECONNRESET' }, message: 'invalid api key' },
      'insufficient_quota ECONNRESET',
      'Execution session capacity reservation was refused: ECONNRESET',
      'Sandbox provisioning failed: The socket connection was closed unexpectedly',
      'Connection failed',
      Object.assign(new Error('certificate rejected'), { code: 'CERT_HAS_EXPIRED' }),
      Object.assign(new Error('host not found'), { code: 'ENOTFOUND' }),
      new Error('fetch failed', {
        cause: Object.assign(new Error('Sandbox provisioning failed'), { code: 'ECONNRESET' }),
      }),
      new Error('fetch failed', {
        cause: { status: 401, code: 'ECONNRESET', message: 'invalid api key' },
      }),
      new Error('fetch failed', {
        cause: Object.assign(new Error('insufficient_quota'), { code: 'ECONNRESET' }),
      }),
      new Error('fetch failed', {
        cause: Object.assign(new Error('invalid api key'), { code: 'ECONNRESET' }),
      }),
      new Error('fetch failed', {
        cause: Object.assign(new Error('Operation aborted by user'), { code: 'ECONNRESET' }),
      }),
      Object.assign(new Error('Unauthorized'), { code: 'ECONNRESET' }),
      Object.assign(new Error('invalid_api_key'), { code: 'ECONNRESET' }),
      Object.assign(new Error('authentication_error'), { code: 'ECONNRESET' }),
    ]

    for (const error of errors) {
      expect(classifyCaughtProviderError(error)).not.toEqual({ kind: 'network' })
      expect(classifyProviderTransportError(error)).toBeNull()
      expect(durableProviderTransportFailureText(error)).toBeNull()
    }
    expect(classifyCaughtProviderError('insufficient_quota ECONNRESET')).toEqual({ kind: 'plan-credit' })
  })
})

describe('classifyProviderError', () => {
  it('classifies rate limit errors', () => {
    expect(classifyProviderError('Rate limit exceeded')).toEqual({
      exhausted: true,
      reason: 'rate-limit',
      cooldownMs: 60_000,
    })
  })

  it('classifies 429 as rate-limit', () => {
    expect(classifyProviderError('429 Too Many Requests')?.reason).toBe('rate-limit')
  })

  it('classifies usage limit as rate-limit', () => {
    expect(classifyProviderError('usage limit reached')?.reason).toBe('rate-limit')
  })

  it('classifies plan credit exhaustion as plan-credit', () => {
    expect(classifyProviderError('plan credit exhausted')?.reason).toBe('plan-credit')
  })

  it('classifies insufficient_quota as plan-credit (via the quota substring)', () => {
    expect(classifyProviderError('insufficient_quota')?.reason).toBe('plan-credit')
  })

  it('does not classify permission/auth errors containing insufficient as plan-credit', () => {
    expect(classifyProviderError('insufficient permissions')).toBeNull()
    expect(classifyProviderError('insufficient authentication')).toBeNull()
  })

  it('classifies billing/balance errors as plan-credit', () => {
    expect(classifyProviderError('Your balance is too low')?.reason).toBe('plan-credit')
    expect(classifyProviderError('billing problem')?.reason).toBe('plan-credit')
  })

  it('classifies overloaded_error as capacity', () => {
    expect(classifyProviderError('Overloaded_error: try again later')?.reason).toBe('capacity')
  })

  it('classifies capacity errors as capacity', () => {
    expect(classifyProviderError('service unavailable')?.reason).toBe('capacity')
  })

  it('plan-credit cooldown is longer than rate-limit cooldown', () => {
    const plan = classifyProviderError('plan credit exhausted')!
    const rate = classifyProviderError('rate limit')!
    expect(plan.cooldownMs).toBeGreaterThan(rate.cooldownMs)
  })

  it('returns null for non-exhaustion errors', () => {
    expect(classifyProviderError('authentication failed')).toBeNull()
    expect(classifyProviderError('some random error')).toBeNull()
    expect(classifyProviderError('Connection failed')).toBeNull()
  })

  it('prefers plan-credit over rate-limit when both substrings match', () => {
    // "quota" matches plan-credit; without the plan-credit-first ordering this
    // could be misclassified. Ensures persistent exhaustion wins over transient.
    expect(classifyProviderError('rate limit: quota exceeded')?.reason).toBe('plan-credit')
  })

  // --- Hard plan-limit exhaustion (e.g. z.ai weekly/monthly) ---

  it('classifies "Limit Exhausted" as a hard plan-credit limit, not a transient rate-limit', () => {
    // z.ai surfaces "429 Weekly/Monthly Limit Exhausted". The leading 429 must
    // NOT win it a transient 60s rate-limit cooldown — it is a hard limit.
    expect(classifyProviderError('429 Weekly/Monthly Limit Exhausted')?.reason).toBe('plan-credit')
  })

  it('does not regress "usage limit reached" (stays a transient rate-limit)', () => {
    expect(classifyProviderError('usage limit reached')?.reason).toBe('rate-limit')
  })

  it('parses an explicit reset timestamp into retryAt (space-separated form)', () => {
    const reset = new Date(Date.now() + 36 * 60 * 60 * 1000)
    const stamp = formatSpaceTimestamp(reset)
    const c = classifyProviderError(`429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${stamp}`)
    expect(c?.retryAt).toBeDefined()
    // Local-time interpretation of the space form; equal to the same string with a 'T'.
    expect(c?.retryAt).toBe(Date.parse(stamp.replace(' ', 'T')))
  })

  it('parses an explicit reset timestamp into retryAt (ISO form)', () => {
    const iso = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString()
    const c = classifyProviderError(`limit exhausted, will reset at ${iso}`)
    expect(c?.retryAt).toBe(Date.parse(iso))
  })

  it('honors a reset far beyond the default cooldown cap (the whole point of #2)', () => {
    const reset = Date.now() + 40 * 60 * 60 * 1000 // ~1.7 days out
    const iso = new Date(reset).toISOString()
    const c = classifyProviderError(`429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${iso}`)
    expect(c?.retryAt).toBe(Date.parse(iso))
  })

  it('ignores a past/expired reset timestamp (would otherwise un-exhaust immediately)', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const c = classifyProviderError(`429 Weekly/Monthly Limit Exhausted. Your limit will reset at ${past}`)
    expect(c?.retryAt).toBeUndefined()
  })

  it('leaves retryAt undefined for a transient rate-limit with no reset time', () => {
    expect(classifyProviderError('429 Too Many Requests')?.retryAt).toBeUndefined()
  })

  // --- Codex hard plan-limit (usage_limit_reached) ---

  it('classifies codex usage_limit_reached as plan-credit (hard plan limit, not 60s rate-limit)', () => {
    // Real codex payload shape. The bare "usage limit" substring (with spaces)
    // would otherwise match the rate-limit rule and win a 60s cooldown.
    const codex = JSON.stringify({
      type: 'error',
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'free',
        resets_at: futureUnixSeconds(30),
      },
      status_code: 429,
    })
    expect(classifyProviderError(codex)?.reason).toBe('plan-credit')
  })

  it('classifies a codex error carrying only the credits-has-credits:false header as plan-credit', () => {
    expect(classifyProviderError('"X-Codex-Credits-Has-Credits":"False"')?.reason).toBe('plan-credit')
  })

  it('parses Unix-seconds absolute reset from resets_at field', () => {
    const futureUnix = futureUnixSeconds(30)
    const c = classifyProviderError(`usage_limit_reached; "resets_at":${futureUnix}`)
    expect(c?.retryAt).toBe(futureUnix * 1000)
  })

  it('parses Unix-seconds absolute reset from X-Codex-Primary-Reset-At header', () => {
    const futureUnix = futureUnixSeconds(25)
    // Include a plan-credit classifier trigger so the parser is reached.
    const c = classifyProviderError(`usage_limit_reached "X-Codex-Primary-Reset-At":"${futureUnix}"`)
    expect(c?.retryAt).toBe(futureUnix * 1000)
  })

  it('parses Unix-seconds relative reset from X-Codex-Primary-Reset-After-Seconds', () => {
    const seconds = 2_583_500 // ~30d
    const before = Date.now()
    // No absolute reset present, only the relative seconds header.
    const c = classifyProviderError(`usage_limit_reached "X-Codex-Primary-Reset-After-Seconds":"${seconds}"`)
    const after = Date.now()
    expect(c?.retryAt).toBeGreaterThanOrEqual(before + seconds * 1000)
    expect(c?.retryAt).toBeLessThanOrEqual(after + seconds * 1000)
  })

  it('prefers absolute resets_at over relative reset-after-seconds when both are present', () => {
    const futureUnix = futureUnixSeconds(30)
    const payload = JSON.stringify({
      type: 'error',
      error: { type: 'usage_limit_reached', resets_at: futureUnix },
      headers: { 'X-Codex-Primary-Reset-After-Seconds': '3600', 'X-Codex-Primary-Reset-At': String(futureUnix) },
    })
    const c = classifyProviderError(payload)
    expect(c?.retryAt).toBe(futureUnix * 1000)
  })

  it('full codex usage_limit_reached payload → plan-credit + correct Unix-seconds retryAt', () => {
    const futureUnix = futureUnixSeconds(30)
    const payload = JSON.stringify({
      type: 'error',
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'free',
        resets_at: futureUnix,
      },
      status_code: 429,
      headers: {
        'X-Codex-Plan-Type': 'free',
        'X-Codex-Credits-Has-Credits': 'False',
        'X-Codex-Primary-Reset-After-Seconds': '2583500',
        'X-Codex-Primary-Reset-At': String(futureUnix),
      },
    })
    const c = classifyProviderError(payload)
    expect(c?.reason).toBe('plan-credit')
    expect(c?.retryAt).toBe(futureUnix * 1000)
  })

  it('ignores a past Unix-seconds reset (would otherwise un-exhaust immediately)', () => {
    const pastUnix = Math.floor((Date.now() - 60_000) / 1000)
    const c = classifyProviderError(`usage_limit_reached "resets_at":${pastUnix}`)
    expect(c?.retryAt).toBeUndefined()
  })

  it('does not fall back to relative seconds when an absolute Unix reset key is present but stale', () => {
    const pastUnix = Math.floor((Date.now() - 60_000) / 1000)
    const c = classifyProviderError(
      `usage_limit_reached "resets_at":${pastUnix}, "X-Codex-Primary-Reset-After-Seconds":"2583500"`
    )
    expect(c?.retryAt).toBeUndefined()
  })
})

/** Format a Date as "YYYY-MM-DD HH:MM:SS" in local time (z.ai's reset form). */
function formatSpaceTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** A Unix-seconds timestamp ~`daysAhead` days in the future (the codex plan-limit window). */
function futureUnixSeconds(daysAhead = 30): number {
  return Math.floor((Date.now() + daysAhead * 24 * 60 * 60 * 1000) / 1000)
}

describe('getErrorSystemMessage', () => {
  it('returns rate limit message for rate limit errors', () => {
    const msg = getErrorSystemMessage('rate limit exceeded')
    expect(msg).toContain('Rate limit')
  })

  it('returns overloaded message for overloaded_error', () => {
    const msg = getErrorSystemMessage('overloaded_error: try again later')
    expect(msg).toContain('overloaded')
  })

  it('returns authentication message for canonical and separator-variant auth errors', () => {
    for (const error of ['unauthorized', 'invalid api key', 'invalid_api_key', 'authentication_error']) {
      expect(getErrorSystemMessage(error)).toContain('Authentication')
    }
  })

  it('returns null for unknown errors', () => {
    expect(getErrorSystemMessage('Connection failed')).toBe(null)
    expect(getErrorSystemMessage('Not found')).toBe(null)
  })

  it('prefers rate limit over overloaded over auth (priority order)', () => {
    expect(getErrorSystemMessage('rate limit')).toContain('Rate limit')
    expect(getErrorSystemMessage('overloaded_error')).toContain('overloaded')
    expect(getErrorSystemMessage('unauthorized')).toContain('Authentication')
  })
})

describe('internal errors are never attributed to the provider', () => {
  // A live incident: Ficus refused its own capacity reservation, the agent was
  // told "[System] Rate limit or plan credit exhaustion. Execution stopped.",
  // and the codex account it named had 68% of its weekly limit remaining. The
  // substring `capacity` was the entire cause.
  const internal = [
    'Execution session capacity reservation was refused',
    'Admission effect was refused by the durable fence',
    'Admission effect fence was revoked',
    'Admission effect was revoked or superseded',
    'Sandbox provisioning failed.',
    'Sandbox provisioning was cancelled.',
    'Sandbox provisioning result expired.',
  ]

  test.each(internal)('does not classify %p as provider exhaustion', (error) => {
    expect(classifyProviderError(error)).toBeNull()
  })

  test.each(internal)('does not show a provider system message for %p', (error) => {
    expect(getErrorSystemMessage(error)).toBeNull()
  })

  test('the capacity substring is what collided — prove the trap is closed', () => {
    // Guards the specific collision rather than the general rule: a provider
    // capacity error must still classify, so the fix cannot be "drop capacity".
    expect(classifyProviderError('Execution session capacity reservation was refused')).toBeNull()
    expect(classifyProviderError('The service is at capacity')?.reason).toBe('capacity')
  })

  test('real provider exhaustion is unaffected', () => {
    expect(classifyProviderError('429 Too Many Requests')?.reason).toBe('rate-limit')
    expect(classifyProviderError('insufficient quota')?.reason).toBe('plan-credit')
    expect(classifyProviderError('overloaded_error')?.reason).toBe('capacity')
    expect(getErrorSystemMessage('429 Too Many Requests')).toContain('Rate limit')
  })

  test('isInternalExecutionError is case-insensitive and substring-based', () => {
    expect(isInternalExecutionError('WRAPPED: Admission Effect Fence Was Revoked (retrying)')).toBe(true)
    expect(isInternalExecutionError('a totally unrelated failure')).toBe(false)
  })
})

/**
 * The bundled codex client rewrites a 429 body before Ficus ever sees it: it
 * throws `new Error(friendlyMessage)` where `friendlyMessage` is built as
 * `You have hit your ChatGPT usage limit (<plan> plan). Try again in ~N min.`
 * (see node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js,
 * parseErrorResponse). The raw `usage_limit_reached` / `plan_type` /
 * `resets_at` markers never reach the classifier, so this friendly string is
 * the ONLY signal available — it must classify as a hard plan limit and its
 * relative "try again in" window must become the retryAt.
 */
describe('codex friendly usage-limit string (SDK-rewritten 429)', () => {
  const WITH_RESET = 'You have hit your ChatGPT usage limit (plus plan). Try again in ~43 min.'
  const WITHOUT_RESET = 'You have hit your ChatGPT usage limit (plus plan).'

  it('classifies the production string as plan-credit, not a transient rate-limit', () => {
    expect(classifyProviderError(WITH_RESET)?.reason).toBe('plan-credit')
    expect(classifyProviderError(WITHOUT_RESET)?.reason).toBe('plan-credit')
  })

  it('parses "Try again in ~N min." into retryAt ≈ now + N minutes', () => {
    const before = Date.now()
    const retryAt = classifyProviderError(WITH_RESET)?.retryAt
    expect(retryAt).toBeDefined()
    expect(retryAt!).toBeGreaterThanOrEqual(before + 43 * 60_000)
    expect(retryAt!).toBeLessThanOrEqual(Date.now() + 43 * 60_000 + 5_000)
  })

  it('falls back to the 30-minute plan-credit cooldown when the SDK omits the reset', () => {
    const classification = classifyProviderError(WITHOUT_RESET)
    expect(classification?.retryAt).toBeUndefined()
    expect(classification?.cooldownMs).toBe(30 * 60_000)
  })

  it('accepts the "N minutes" and "~N h" wordings', () => {
    const before = Date.now()
    const minutes = classifyProviderError('You have hit your ChatGPT usage limit. Try again in 15 minutes.')?.retryAt
    expect(minutes!).toBeGreaterThanOrEqual(before + 15 * 60_000)
    const hours = classifyProviderError('You have hit your ChatGPT usage limit. Try again in ~2 h.')?.retryAt
    expect(hours!).toBeGreaterThanOrEqual(before + 2 * 60 * 60_000)
  })

  it('classifies the thrown Error exactly as production raises it (no status property)', () => {
    const now = Date.now()
    const classification = classifyCaughtProviderError(new Error(WITH_RESET), { now })
    expect(classification?.kind).toBe('plan-credit')
    expect(classification?.status).toBeUndefined()
    expect(classification?.retryAt).toBeGreaterThanOrEqual(now + 43 * 60_000)
  })

  it('classifies the reset-less thrown Error as plan-credit with no retryAt', () => {
    const classification = classifyCaughtProviderError(new Error(WITHOUT_RESET))
    expect(classification?.kind).toBe('plan-credit')
    expect(classification?.retryAt).toBeUndefined()
  })

  // The SDK writes this same sentence for EVERY codex 429, transient throttles
  // included — only the announced window separates them, so the window decides.
  it('treats a short announced window as a transient rate-limit, keeping its retryAt', () => {
    const before = Date.now()
    const classification = classifyProviderError(
      'You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.'
    )
    expect(classification?.reason).toBe('rate-limit')
    expect(classification!.retryAt!).toBeGreaterThanOrEqual(before + 5 * 60_000)
    expect(classification!.retryAt!).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 5_000)
  })

  it('treats a long announced window as a plan limit', () => {
    const before = Date.now()
    const classification = classifyProviderError(
      'You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.'
    )
    expect(classification?.reason).toBe('plan-credit')
    expect(classification!.retryAt!).toBeGreaterThanOrEqual(before + 120 * 60_000)
  })

  it('treats an unannounced window as a plan limit on the 30-minute default', () => {
    const classification = classifyProviderError('You have hit your ChatGPT usage limit (plus plan).')
    expect(classification?.reason).toBe('plan-credit')
    expect(classification?.retryAt).toBeUndefined()
    expect(classification?.cooldownMs).toBe(30 * 60_000)
  })

  it('leaves a bare "usage limit" error a transient rate-limit', () => {
    expect(classifyProviderError('usage limit reached')?.reason).toBe('rate-limit')
    expect(classifyProviderError('429 usage limit')?.reason).toBe('rate-limit')
  })
})

/**
 * The codex backend's OTHER usage-limit shape: an in-stream SSE/WebSocket
 * `error` event. `mapCodexEvents` (openai-codex-responses.js) throws
 * `new CodexApiError("Codex error: " + message, { code, payload: event })`, so
 * unlike the rewritten 429 the raw `code` and the event survive — but only as
 * OWN ENUMERABLE fields of the Error, which `error.message` alone discarded.
 * The bare sentence then matched the generic 'usage limit' rate-limit substring
 * and parked an exhausted plan for 60 seconds.
 */
describe('codex in-stream usage-limit error event (CodexApiError)', () => {
  const STREAM_MESSAGE = 'Codex error: The usage limit has been reached'

  /** Mirrors the SDK's CodexApiError: `code` and `payload` are own enumerable props. */
  class CodexApiErrorStub extends Error {
    code?: string
    payload?: Record<string, unknown>
    constructor(message: string, options: { code?: string; payload?: Record<string, unknown> } = {}) {
      super(message)
      this.name = 'CodexApiError'
      this.code = options.code
      this.payload = options.payload
    }
  }

  const streamError = (payload: Record<string, unknown> = {}, code = 'usage_limit_reached') =>
    new CodexApiErrorStub(STREAM_MESSAGE, {
      code,
      payload: { type: 'error', code, message: 'The usage limit has been reached', ...payload },
    })

  it("folds an Error's own `code` into providerErrorText", () => {
    const text = providerErrorText(streamError())
    expect(text).toContain('The usage limit has been reached')
    expect(text).toContain('usage_limit_reached')
    // Plain Errors still read as their message alone.
    expect(providerErrorText(new Error('plain failure'))).toBe('plain failure')
  })

  it('classifies the stream message alone as a plan limit on the default cooldown', () => {
    const classification = classifyProviderError(STREAM_MESSAGE)
    expect(classification?.reason).toBe('plan-credit')
    expect(classification?.cooldownMs).toBe(30 * 60_000)
    expect(classification?.retryAt).toBeUndefined()
  })

  it('classifies an event with no announced window as plan-credit on the default cooldown', () => {
    const now = Date.now()
    const classification = classifyCaughtProviderError(streamError(), { now })
    expect(classification?.kind).toBe('plan-credit')
    expect(classification?.retryAt).toBeUndefined()
    expect(classifyProviderError(providerErrorText(streamError())!)?.cooldownMs).toBe(30 * 60_000)
  })

  it('reads `resets_at` out of the payload and keeps a two-hour window a plan limit', () => {
    const now = Date.now()
    const resetsAt = Math.floor((now + 2 * 60 * 60_000) / 1000)
    const classification = classifyCaughtProviderError(streamError({ plan_type: 'plus', resets_at: resetsAt }), { now })
    expect(classification?.kind).toBe('plan-credit')
    expect(classification?.retryAt).toBe(resetsAt * 1000)
  })

  it('treats a short `resets_in_seconds` window as a transient rate-limit', () => {
    const now = Date.now()
    const classification = classifyCaughtProviderError(streamError({ resets_in_seconds: 600 }), { now })
    expect(classification?.kind).toBe('rate-limit')
    expect(classification?.retryAt).toBe(now + 600_000)
  })

  it('classifies the code alone as a plan limit even with a generic message', () => {
    const error = new CodexApiErrorStub('Codex error: request failed', {
      code: 'usage_limit_reached',
      payload: { type: 'error', code: 'usage_limit_reached' },
    })
    expect(classifyCaughtProviderError(error)?.kind).toBe('plan-credit')
  })

  it('leaves an unrelated codex stream error unclassified', () => {
    const error = new CodexApiErrorStub('Codex error: stream ended unexpectedly', {
      code: 'internal_error',
      payload: { type: 'error', code: 'internal_error' },
    })
    expect(classifyCaughtProviderError(error)).toBeNull()
  })
})

describe('Claude Code session window exhaustion', () => {
  const now = Date.parse('2026-09-29T01:00:00Z')
  const text = "You've hit your session limit · resets 2:20am (UTC)"
  test('classifies the raw refusal and Error with its actual UTC reset', () => {
    for (const error of [text, new Error(text)]) {
      expect(classifyCaughtProviderError(error, { now })).toEqual({
        kind: 'plan-credit',
        retryAt: Date.parse('2026-09-29T02:20:00Z'),
      })
    }
    expect(classifyProviderError(text, { now })).toMatchObject({
      exhausted: true,
      reason: 'plan-credit',
      retryAt: Date.parse('2026-09-29T02:20:00Z'),
    })
  })
  test('handles tomorrow, midnight, noon, and typographic apostrophes', () => {
    expect(classifyCaughtProviderError(text, { now: Date.parse('2026-09-29T23:00:00Z') })?.retryAt).toBe(
      Date.parse('2026-09-30T02:20:00Z')
    )
    for (const [clock, iso] of [
      ['12am', '2026-09-30T00:00:00Z'],
      ['12pm', '2026-09-29T12:00:00Z'],
    ]) {
      expect(
        classifyCaughtProviderError(`You’ve hit your session limit · resets ${clock} (UTC)`, { now })?.retryAt
      ).toBe(Date.parse(iso!))
    }
  })
  test('keeps a bounded default cooldown when the clock is missing, invalid or ambiguous', () => {
    for (const suffix of [
      '',
      'resets 13:20am (UTC)',
      'resets 2:60am (UTC)',
      'resets 2:20am',
      'resets 2:20am (America/New_York)',
    ]) {
      expect(classifyProviderError(`You've hit your session limit · ${suffix}`, { now })).toMatchObject({
        reason: 'plan-credit',
        cooldownMs: 30 * 60_000,
        retryAt: undefined,
      })
    }
    expect(classifyCaughtProviderError('Session limit configuration is invalid')).toBeNull()
  })
})
