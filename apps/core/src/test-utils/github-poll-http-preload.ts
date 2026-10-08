/** Test-only, subprocess-scoped HTTP fence. The production singleton captures fetch while
 * constructing its real plugin, before a test can install a per-request transport spy.
 * Never fall back to real network access; all Core/runtime dependencies remain unchanged.
 */
const transport = globalThis as typeof globalThis & {
  __githubPollTestHttp?: typeof fetch
  __githubPollHttpFenced?: boolean
}
transport.__githubPollHttpFenced = true
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  if (!transport.__githubPollTestHttp) throw new Error('github_poll_test_http_not_installed')
  return transport.__githubPollTestHttp(...args)
}) as typeof fetch
