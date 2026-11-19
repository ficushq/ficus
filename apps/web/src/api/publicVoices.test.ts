import { afterEach, expect, test } from 'bun:test'
import { deriveSquadVoice } from './publicVoices'
import { ApiError } from './client'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('keeps gateway HTML, authentication and network failures distinct from derivation failures', async () => {
  globalThis.fetch = (async () =>
    new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })) as typeof fetch
  await expect(deriveSquadVoice('fixture', { login: 'octocat' })).rejects.toMatchObject({
    status: 502,
    message: 'Ficus is temporarily unavailable (502). Please try again shortly.',
  })
  for (const status of [401, 403]) {
    globalThis.fetch = (async () => Response.json({ error: 'Permission denied' }, { status })) as typeof fetch
    await expect(deriveSquadVoice('fixture', { login: 'octocat' })).rejects.toMatchObject({
      status,
      message: `API error: ${status}: Permission denied`,
    })
  }
  const network = new Error('Network disconnected')
  globalThis.fetch = (async () => {
    throw network
  }) as typeof fetch
  await expect(deriveSquadVoice('fixture', { login: 'octocat' })).rejects.toBe(network)
})

test('handles an older structured 502 and never displays arbitrary validation reasons', async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: 'derivation_invalid_output', reason: 'SYNTHETIC_PRIVATE_TEXT\nforged' },
      { status: 502 }
    )) as typeof fetch
  try {
    await deriveSquadVoice('fixture', { login: 'octocat' })
    throw new Error('Expected the request to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect((error as Error).message).toStartWith('The model returned an invalid voice draft')
    expect((error as Error).message).not.toContain('SYNTHETIC_PRIVATE_TEXT')
  }
})

test('returns the unchanged draft with one request and no automatic save', async () => {
  const draft = {
    login: 'octocat',
    draft: { base: 'Synthetic draft.', surfaces: {} },
    observations: [],
    exemplars: [],
    sampling: {
      filters: {},
      counts: {
        collected: 20,
        kept: 20,
        droppedByFilter: { date: 0, repository: 0 },
        droppedAsToolAuthored: 0,
        droppedAsTemplate: 0,
      },
      dateRange: {},
      publicRepositories: [],
      privateRepositories: [],
      pagingCapped: false,
    },
    bytes: 20,
    maxBytes: 2000,
  }
  const requests: string[] = []
  globalThis.fetch = (async (input, init) => {
    requests.push(String(input))
    expect(JSON.parse(String(init?.body))).toEqual({ login: 'octocat' })
    return Response.json(draft)
  }) as typeof fetch
  expect(await deriveSquadVoice('fixture', { login: 'octocat' })).toEqual(draft as any)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toEndWith('/squads/fixture/voice/derive')
})

test('opts into streaming and reports partial progress before a typed terminal failure', async () => {
  const frames = [
    { version: 1, runId: 'fixture', seq: 1, type: 'started' },
    {
      version: 1,
      runId: 'fixture',
      seq: 2,
      type: 'error',
      error: { code: 'derivation_invalid_output', reason: 'not_json' },
    },
  ]
    .map((e) => `event: derivation\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')
  let calls = 0
  globalThis.fetch = (async (_, init) => {
    calls++
    expect(init?.headers).toMatchObject({ Accept: 'text/event-stream', 'x-ficus-csrf': '1' })
    expect(init?.credentials).toBe('include')
    return new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  const events: unknown[] = []
  await expect(
    deriveSquadVoice('fixture', { login: 'octo' }, { onProgress: (event) => events.push(event) })
  ).rejects.toMatchObject({ status: 422, payload: { error: 'derivation_invalid_output' } })
  expect(events).toHaveLength(1)
  expect(calls).toBe(1)
})
