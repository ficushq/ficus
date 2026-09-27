import { afterEach, expect, spyOn, test } from 'bun:test'
import * as resolveConnection from '../integrations/github/resolve-connection'
import { githubApiGet } from './api-client'

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
