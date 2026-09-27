import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'

function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

afterEach(() => {
  globalThis.localStorage?.clear()
})

describe('token storage', () => {
  test('stores tokens under the ficus_password key', async () => {
    installLocalStorage()
    const { getStoredToken, setStoredToken, clearStoredToken } = await import('./client')

    setStoredToken('session-token')

    expect(getStoredToken()).toBe('session-token')
    expect(localStorage.getItem('ficus_password')).toBe('session-token')

    clearStoredToken()
    expect(getStoredToken()).toBeFalsy()
  })
})

test('apiUrl resolves against the current Window instead of a DOM captured at module load', async () => {
  const { apiUrl } = await import('./client')
  const first = await acquireDomHarness({ url: 'http://first.local/settings' })
  try {
    expect(apiUrl('/status')).toBe('http://first.local/api/status')
  } finally {
    await first.cleanup()
  }
  const second = await acquireDomHarness({ url: 'http://second.local/settings' })
  try {
    expect(apiUrl('/status')).toBe('http://second.local/api/status')
  } finally {
    await second.cleanup()
  }
})

describe('readApiErrorMessage', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost:5173/' })
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  test('includes API error response text when JSON error body is returned', async () => {
    const { readApiErrorMessage } = await import('./client')
    const response = new Response(JSON.stringify({ error: 'edit[1] matched more than one location' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })

    await expect(readApiErrorMessage(response)).resolves.toBe('API error: 400: edit[1] matched more than one location')
  })
})

test('proxy HTML errors are concise through both API clients without losing JSON validation details', async () => {
  const { readApiErrorMessage: legacy } = await import('./client')
  const { readApiErrorMessage: shared } = await import('@ficus/client-core')
  expect(legacy).toBe(shared)
  for (const contentType of ['text/html', 'text/plain']) {
    const response = new Response('<!DOCTYPE html><html><body>Bad gateway ' + 'x'.repeat(6000) + '</body></html>', {
      status: 502,
      headers: { 'Content-Type': contentType },
    })
    expect(await shared(response)).toBe('Tau is temporarily unavailable (502). Please try again shortly.')
  }
  const details = JSON.stringify([
    { code: 'invalid_literal', path: ['schemaVersion'], expected: 1, message: 'Expected 1' },
  ])
  expect(
    await shared(
      new Response(JSON.stringify({ error: details }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    )
  ).toBe(`API error: 400: ${details}`)
})

test('schema validation errors preserve nested issue paths for assistant tool retries', async () => {
  const { readApiErrorMessage } = await import('@ficus/client-core')
  const issues = [
    {
      code: 'invalid_string',
      validation: 'regex',
      path: ['operations', 3, 'step', 'outcomes', 'changes_requested'],
      message: 'Use a lowercase identifier with optional hyphens',
    },
  ]
  const message = await readApiErrorMessage(
    Response.json({ success: false, error: { name: 'ZodError', issues } }, { status: 400 })
  )
  expect(message).toBe(`API error: 400: ${JSON.stringify(issues)}`)
})
