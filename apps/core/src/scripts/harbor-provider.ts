/** Trial-only endpoint override; reuse Pi's native OpenAI transport. */
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export function configureHarborProvider(runtime: ModelRuntime, baseUrl: string) {
  const url = new URL(baseUrl)
  if (
    !['host.docker.internal', '127.0.0.1'].includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.pathname !== '/v1'
  ) {
    throw new Error('Harbor requires its local budget proxy')
  }
  runtime.registerProvider('openai', {
    baseUrl,
    api: 'openai-responses',
    models: [
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol (Harbor)',
        api: 'openai-responses',
        reasoning: true,
        input: ['text'],
        contextWindow: 1050000,
        maxTokens: 8192,
        cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
        thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' },
      },
    ],
  })
}

// Imported only with Bun --preload by the disposable evaluation adapter.
if (process.env.FICUS_HARBOR_MODEL_API === 'openai-responses') {
  const root = '/opt/ficus-harbor'
  const database = new URL(process.env.DATABASE_URL ?? '')
  if (
    process.env.FICUS_HARBOR_TRIAL !== '1' ||
    process.env.HOME_DIR !== `${root}/data` ||
    database.pathname !== '/ficus_harbor' ||
    !database.hostname.startsWith('ficus-harbor-db-')
  ) {
    throw new Error('Native provider override requires the disposable Harbor runtime')
  }
  const { getModelRuntime } = await import('../services/agent/auth-backend')
  configureHarborProvider(await getModelRuntime(), process.env.FICUS_HARBOR_BASE_URL ?? '')
}
