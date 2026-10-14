import { afterEach, expect, spyOn, test } from 'bun:test'
import * as resolveConnection from '../integrations/github/resolve-connection'
import { githubApiGet, GitHubApiUnavailableError } from './api-client'

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function stubGitHub(responses: Record<string, Response>) {
  spies.push(
    spyOn(resolveConnection, 'resolveGitHubConnection').mockResolvedValue({
      credential: { accessToken: 'token' },
    } as any)
  )
  const calls: Array<{ url: string; authorization: string | null }> = []
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation((async (input: URL, init: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init.headers).get('authorization') })
      return responses[String(input)] ?? new Response('not found', { status: 404 })
    }) as any)
  )
  return calls
}

const redirect = (location: string) => new Response(null, { status: 301, headers: { location } })

test('follows a renamed repository redirect within the API origin', async () => {
  const calls = stubGitHub({
    'https://api.github.com/repos/old-owner/repo/pulls/237': redirect(
      'https://api.github.com/repositories/1365257444/pulls/237'
    ),
    'https://api.github.com/repositories/1365257444/pulls/237': Response.json({ merged: true }),
  })
  expect(await githubApiGet<{ merged: boolean }>('/repos/old-owner/repo/pulls/237', 'squad')).toEqual({ merged: true })
  expect(calls).toEqual([
    { url: 'https://api.github.com/repos/old-owner/repo/pulls/237', authorization: 'Bearer token' },
    { url: 'https://api.github.com/repositories/1365257444/pulls/237', authorization: 'Bearer token' },
  ])
})

test('never sends the token to a redirect outside the API origin', async () => {
  const calls = stubGitHub({
    'https://api.github.com/repos/owner/repo': redirect('https://example.com/steal'),
  })
  expect(await githubApiGet('/repos/owner/repo', 'squad')).toBeNull()
  expect(calls.map((call) => call.url)).toEqual(['https://api.github.com/repos/owner/repo'])
})

test('gives up on a redirect loop instead of following it forever', async () => {
  const calls = stubGitHub({
    'https://api.github.com/repos/owner/repo': redirect('/repos/owner/repo'),
  })
  expect(await githubApiGet('/repos/owner/repo', 'squad')).toBeNull()
  expect(calls).toHaveLength(4)
})

const strict = { distinguishUnavailable: true }

test('an explicit denial under a usable token is null, so callers may settle it', async () => {
  for (const response of [
    new Response('not found', { status: 404 }),
    new Response('gone', { status: 410 }),
    new Response('forbidden', { status: 403 }),
  ]) {
    stubGitHub({ 'https://api.github.com/repos/owner/repo': response })
    expect(await githubApiGet('/repos/owner/repo', 'squad', undefined, strict)).toBeNull()
    for (const spy of spies.splice(0)) spy.mockRestore()
  }
})

test('an outage, rate limit or unusable token is unavailable, never a denial', async () => {
  const cases: Array<[string, () => Response]> = [
    ['http_500', () => new Response('boom', { status: 500 })],
    ['http_502', () => new Response('bad gateway', { status: 502 })],
    ['http_429', () => new Response('slow down', { status: 429 })],
    ['http_401', () => new Response('bad credentials', { status: 401 })],
    ['http_403', () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })],
    ['http_403', () => new Response('secondary', { status: 403, headers: { 'retry-after': '60' } })],
  ]
  for (const [reason, response] of cases) {
    stubGitHub({ 'https://api.github.com/repos/owner/repo': response() })
    const error = await githubApiGet('/repos/owner/repo', 'squad', undefined, strict).catch((e) => e)
    expect(error).toBeInstanceOf(GitHubApiUnavailableError)
    expect(error.reason).toBe(reason)
    // Callers that do not ask keep the historic null.
    stubGitHub({ 'https://api.github.com/repos/owner/repo': response() })
    expect(await githubApiGet('/repos/owner/repo', 'squad')).toBeNull()
    for (const spy of spies.splice(0)) spy.mockRestore()
  }
})

test('a network failure or missing token is unavailable', async () => {
  spies.push(spyOn(resolveConnection, 'resolveGitHubConnection').mockResolvedValue(null as any))
  const fetch = spyOn(globalThis, 'fetch')
  spies.push(fetch)
  expect(await githubApiGet('/repos/owner/repo', 'squad')).toBeNull()
  expect(await githubApiGet('/repos/owner/repo', 'squad', undefined, strict).catch((e) => e.reason)).toBe('no_token')
  expect(fetch).not.toHaveBeenCalled()
  for (const spy of spies.splice(0)) spy.mockRestore()
  stubGitHub({})
  spies.push(
    spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed')) as unknown as { mockRestore(): void }
  )
  expect(await githubApiGet('/repos/owner/repo', 'squad', undefined, strict).catch((e) => e.reason)).toBe('network')
})
