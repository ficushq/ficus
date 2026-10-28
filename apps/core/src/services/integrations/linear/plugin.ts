import { z } from 'zod'
import type { IntegrationPluginV1 } from '../plugin'
import { linearOutputAdapter } from './outputs'

const configurationSchema = z.strictObject({ version: z.literal(1) })
export async function linearQuery<T>(
  credential: string,
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: credential },
    body: JSON.stringify({ query, variables }),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok)
    throw new Error(response.status === 401 || response.status === 403 ? 'invalid_auth' : 'provider_unavailable')
  const result = (await response.json()) as { data?: T; errors?: unknown[] }
  if (result.errors?.length || !result.data) throw new Error('provider_query_failed')
  return result.data
}

export const linearPlugin: IntegrationPluginV1<{ version: 1 }, string> = {
  manifestVersion: 1,
  key: 'linear',
  adapterVersion: 1,
  presentation: {
    label: 'Linear',
    description: 'Connect issue tracking, route assignments to squads, and search Linear issues.',
    icon: 'linear',
    connectionMode: 'credential',
    assignable: true,
    requiredCapabilities: ['issues:read'],
  },
  connection: {
    parseConfiguration: (value) => configurationSchema.parse(value),
    safeConfiguration: (configuration) => configuration,
    credential: { parse: (value) => z.string().trim().min(1).max(16384).parse(value), serialize: (value) => value },
  },
  authorization: { kind: 'manual' },
  runtime: {
    provider: {
      key: 'linear',
      adapterVersion: 1,
      parseConfig: (value) => configurationSchema.parse(value),
      outputs: linearOutputAdapter,
      async validate({ credential, signal }) {
        try {
          const data = await linearQuery<{ viewer: { id: string } }>(credential, '{ viewer { id } }', undefined, signal)
          return data.viewer?.id ? { ok: true, grantedScopes: ['issues:read'] } : { ok: false, code: 'invalid_auth' }
        } catch (error) {
          return { ok: false, code: error instanceof Error ? error.message : 'provider_unavailable' }
        }
      },
      capabilities: {},
    },
  },
  sandbox: {
    packages: [],
    setupSteps: [],
    initHooks: [],
    readiness: [],
    skills: [],
    extensions: [],
    protectedBindings: [],
  },
  lifecycle: { refresh: false, revoke: false },
  classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
}
