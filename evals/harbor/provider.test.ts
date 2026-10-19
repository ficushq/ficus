import { test, expect } from 'bun:test'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { configureHarborProvider } from '../../apps/core/src/scripts/harbor-provider'

test('Harbor uses native Pi Responses with only a local endpoint override', async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  configureHarborProvider(runtime, 'http://127.0.0.1:12345/v1')
  const model = runtime.getModel('openai', 'gpt-6.1-sol')!
  expect(model.api).toBe('openai-responses')
  expect(model.baseUrl).toBe('http://127.0.0.1:12345/v1')
  expect(model.reasoning).toBe(true)
  expect(model.maxTokens).toBe(8192)
  expect(runtime.getProvider('openai')?.id).toBe('openai')
  expect(() => configureHarborProvider(runtime, 'https://api.openai.com/v1')).toThrow()
})
