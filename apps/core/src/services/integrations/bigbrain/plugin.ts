import { BigbrainError } from './errors'
import { BigbrainProvider, type BigbrainConfigV2 } from './provider'
import { createBigbrainTools, type BigbrainTool, type BigbrainToolContext } from './tools'
import type { IntegrationPluginV1 } from '../plugin'

const provider = new BigbrainProvider()

const plugin: IntegrationPluginV1<
  BigbrainConfigV2,
  string,
  { createTools(context: BigbrainToolContext): readonly BigbrainTool[] }
> = {
  manifestVersion: 1,
  key: 'bigbrain',
  adapterVersion: 2,
  presentation: {
    label: 'Bigbrain',
    description: 'Connect an approved local BigBrain vault on the Core host.',
    icon: 'bigbrain',
    connectionMode: 'local',
    assignable: true,
    requiredCapabilities: ['agent_tools'],
  },
  connection: {
    parseConfiguration: (input) => provider.parseConfig(input),
    safeConfiguration: (configuration) => ({ ...configuration }),
    credential: {
      parse(value) {
        if (typeof value !== 'string' || !/^[a-f0-9]{8}$/.test(value)) throw new Error('Invalid credential')
        return value
      },
      serialize(value) {
        return this.parse(value)
      },
    },
  },
  authorization: { kind: 'manual' },
  runtime: {
    provider,
    agentTools: { createTools: createBigbrainTools },
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
  classifyError(error) {
    if (error instanceof BigbrainError) {
      return {
        code: error.code,
        retryable: !['invalid_auth', 'missing_scope', 'invalid_configuration'].includes(error.code),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }
    }
    return { code: 'provider_error', retryable: true }
  },
}

export const bigbrainPlugin = Object.freeze(plugin)
