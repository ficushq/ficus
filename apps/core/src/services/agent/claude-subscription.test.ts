import { expect, test } from 'bun:test'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'

// Pins the pi-ai patch (patches/@earendil-works%2Fpi-ai@0.99.1.patch): Anthropic does not permit
// third-party products to use Claude subscription credentials, so the Anthropic provider offers no
// Claude Pro/Max login and never resolves a subscription token. A pi upgrade that drops the patch
// fails here.
const subscriptionToken = 'sk-ant-oat01-test-fixture'

async function resolve(credential: { type: 'api_key'; key: string } | undefined, env: Record<string, string> = {}) {
  const auth = anthropicProvider().auth.apiKey!
  return auth.resolve({
    ctx: { env: async (name: string) => env[name] },
    credential,
    signal: new AbortController().signal,
  } as never)
}

test('the Anthropic provider has no Claude Pro/Max login', () => {
  expect(anthropicProvider().auth.oauth).toBeUndefined()
})

test('an Anthropic API key still resolves', async () => {
  expect((await resolve({ type: 'api_key', key: 'sk-ant-api03-key' }))?.auth).toEqual({ apiKey: 'sk-ant-api03-key' })
  expect((await resolve(undefined, { ANTHROPIC_API_KEY: 'sk-ant-api03-env' }))?.auth).toEqual({
    apiKey: 'sk-ant-api03-env',
  })
})

test('a Claude subscription token never resolves, stored or from the environment', async () => {
  expect(await resolve({ type: 'api_key', key: subscriptionToken })).toBeUndefined()
  for (const name of ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])
    expect(await resolve(undefined, { [name]: subscriptionToken })).toBeUndefined()
})
