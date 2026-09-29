import { describe, it, expect, beforeAll } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Guards the Ficus patch to the Pi SDK
 * (patches/@earendil-works%2Fpi-ai@0.87.1.patch) that keeps hard plan-window
 * limits (e.g. z.ai "429 Weekly/Monthly Limit Exhausted. Your limit will reset
 * at ...") NON-retryable. Without it a turn that hits an exhausted provider
 * matches the leading "429" against the SDK's retryable regex and burns all
 * five retries (~1+2+4+8+16 ≈ 31s of backoff, hammering the exhausted provider)
 * before the settled error reaches Ficus's failover; with it the error is
 * non-retryable so failover fires on attempt 1.
 *
 * Two INDEPENDENT retry classifiers must recognize the wording, so the patch
 * touches both:
 *   - the agent-loop retry (`utils/retry.js` `isRetryableAssistantError`) — the
 *     path Ficus's runtime failover actually rides for z.ai / anthropic / generic
 *     providers (`zai:glm-5.3` is the failover candidate in every agent-type
 *     chain, so this is a recurring production event, not an edge case).
 *   - the OpenAI Codex responses streaming retry
 *     (`api/openai-codex-responses.js` `isTerminalRateLimitError`) — the
 *     primary-model (`openai-codex:gpt-5.6-sol`) path.
 *
 * Both codex usage-limit wordings are asserted: the client's friendly 429
 * rewrite ("You have hit your ChatGPT usage limit") and the in-stream `error`
 * event mapCodexEvents throws ("Codex error: The usage limit has been
 * reached"), which shares no phrasing with the first.
 *
 * If a future `bun install` / SDK bump drops the patch, the "hard limit" cases
 * below go red. See apps/core/src/lib/error.ts (classifyProviderError) for the
 * downstream failover that relies on this settling on attempt 1.
 */
function piAiDist(rel: string): string {
  // The package's `exports` map only declares `import` conditions and does not
  // expose `./utils/*`, so neither require.resolve nor a subpath import resolves
  // these deep artifacts. Walk up to the hoisted node_modules and read directly.
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'node_modules/@earendil-works/pi-ai/dist', rel)
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error(`Could not locate the installed Pi SDK artifact: ${rel}`)
}

// The codex responses classifier is an internal (non-exported) function, so we
// read the installed artifact and execute the SAME regex the SDK uses.
function codexTerminalRateLimitRegex(): RegExp {
  const src = readFileSync(piAiDist('api/openai-codex-responses.js'), 'utf8')
  const m = src.match(/isTerminalRateLimitError\(errorText\)\s*\{\s*return\s+(\/.*?\/[a-z]*)\.test/s)
  if (!m) throw new Error('Could not locate isTerminalRateLimitError regex in installed SDK')
  const flags = m[1].match(/\/([a-z]*)$/)?.[1] ?? ''
  const body = m[1].replace(/\/([a-z]*)$/, '').slice(1, -1)
  return new RegExp(body, flags)
}

describe('Pi SDK non-retryable hard-limit patch', () => {
  describe('agent-loop retry — utils/retry.js isRetryableAssistantError (real classifier)', () => {
    // retry.js is dependency-free, so importing the artifact directly (bypassing
    // the package `exports` map) exercises the REAL function the agent loop calls.
    let isRetryable: (msg: string) => boolean
    beforeAll(async () => {
      const mod = await import(pathToFileURL(piAiDist('utils/retry.js')).href)
      const fn = mod.isRetryableAssistantError as (m: { stopReason: string; errorMessage: string }) => boolean
      isRetryable = (errorMessage: string) => fn({ stopReason: 'error', errorMessage })
    })

    it('treats a z.ai weekly/monthly hard limit as NON-retryable (fail over on attempt 1)', () => {
      // Without the patch this returns true: NON_RETRYABLE misses the wording and
      // the leading "429" matches RETRYABLE — burning all five retries.
      expect(isRetryable('429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-06-27 23:58:24')).toBe(
        false
      )
    })

    it('treats an explicit "limit will reset" hard limit as NON-retryable', () => {
      expect(isRetryable('Usage limit reached; your limit will reset at 2026-06-27T23:58:24Z')).toBe(false)
    })

    it('still lets a plain transient 429 stay retryable (no hard-limit phrasing)', () => {
      // A bare 429 / "too many requests" must NOT be suppressed — only hard plan
      // limits are, so transient blips still get the SDK's backoff/retries.
      expect(isRetryable('429 Too Many Requests')).toBe(true)
    })

    it('treats the codex plan-window markers as NON-retryable', () => {
      // The bundled codex client rewrites a 429 body into this friendly string
      // (openai-codex-responses.js parseErrorResponse), so the raw
      // `usage_limit_reached` code usually never survives — both wordings must
      // fail over on attempt 1 rather than hammer an exhausted ChatGPT plan.
      // Asserted with the transient "429" token the wrapper text carries, which
      // is exactly what makes these RETRYABLE without the patch.
      expect(isRetryable('429 You have hit your ChatGPT usage limit (plus plan). Try again in ~43 min.')).toBe(false)
      expect(isRetryable('429 usage_limit_reached')).toBe(false)
      // The in-stream `error` event's wording (mapCodexEvents' CodexApiError)
      // carries neither of the two above, so it needs its own pattern.
      expect(isRetryable('Codex error: The usage limit has been reached')).toBe(false)
    })

    it("preserves the SDK's original non-retryable signals", () => {
      expect(isRetryable('insufficient_quota')).toBe(false)
      expect(isRetryable('Monthly usage limit reached')).toBe(false)
    })
  })

  describe('OpenAI Codex responses retry — api/openai-codex-responses.js isTerminalRateLimitError', () => {
    const isTerminal = (msg: string) => codexTerminalRateLimitRegex().test(msg)

    it('treats a codex weekly/monthly hard limit as terminal (non-retryable)', () => {
      expect(isTerminal('429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-06-27 23:58:24')).toBe(true)
    })

    it('treats an explicit "limit will reset" error as terminal', () => {
      expect(isTerminal('Usage limit reached; your limit will reset at 2026-06-27T23:58:24Z')).toBe(true)
    })

    it('still lets a plain transient rate limit stay retryable', () => {
      expect(isTerminal('429 Too Many Requests')).toBe(false)
      expect(isTerminal('rate limit exceeded, please retry')).toBe(false)
    })

    it('treats the codex plan-window markers as terminal', () => {
      expect(isTerminal('You have hit your ChatGPT usage limit (plus plan). Try again in ~43 min.')).toBe(true)
      expect(isTerminal('usage_limit_reached')).toBe(true)
      expect(isTerminal('Codex error: The usage limit has been reached')).toBe(true)
    })

    it("preserves the SDK's original terminal signals", () => {
      expect(isTerminal('insufficient_quota')).toBe(true)
      expect(isTerminal('billing issue')).toBe(true)
    })
  })
})
