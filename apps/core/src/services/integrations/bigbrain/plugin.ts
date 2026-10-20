import { isPlatformManaged } from '../../secrets/managed'
import { requireSandboxRuntime } from '../../sandbox/runtime'
import { BigbrainError } from './errors'
import { bigbrainDeploymentAvailability } from './managed/availability'
import { parseBigbrainCredential, type BigbrainConfiguration } from './managed/config'
import { BigbrainProvider } from './provider'
import { createSharedBigbrainTools } from './shared-tools'
import { createBigbrainTools, type BigbrainTool, type BigbrainToolContext } from './tools'
import type { IntegrationPluginV1 } from '../plugin'

const provider = new BigbrainProvider()

/** Shared vault reads are offered only to agents on an isolated runtime: a `host` agent shell
 * runs as the Core service account, which can read every vault's private material. */
function isolatedAgentRuntime(): boolean {
  try {
    return requireSandboxRuntime() !== 'host'
  } catch {
    return false
  }
}

const plugin: IntegrationPluginV1<
  BigbrainConfiguration,
  string,
  { createTools(context: BigbrainToolContext): readonly BigbrainTool[] }
> = {
  availability: () => bigbrainDeploymentAvailability(),
  manifestVersion: 1,
  key: 'bigbrain',
  adapterVersion: 2,
  presentation: {
    label: 'BigBrain',
    description: 'Connect BigBrain on the Core host in one click: Ficus finds BigBrain and its vault.',
    icon: 'bigbrain',
    connectionMode: 'local',
    // Ficus Cloud hosts managed shared vaults; elsewhere a local binding on the Core host.
    resolveConnectionMode: () => (isPlatformManaged() ? 'managed' : 'local'),
    assignable: true,
    requiredCapabilities: ['agent_tools'],
  },
  connection: {
    parseConfiguration: (input) => provider.parseConfig(input),
    safeConfiguration: (configuration) => ({ ...configuration }),
    credential: {
      parse: parseBigbrainCredential,
      serialize(value) {
        return this.parse(value)
      },
    },
  },
  authorization: { kind: 'manual' },
  runtime: {
    provider,
    agentTools: {
      // Ficus Cloud: only the read-only managed shared tools (never personal drop). Elsewhere the
      // unchanged personal local-binding tools.
      createTools: (context) =>
        isPlatformManaged()
          ? context.assignments && isolatedAgentRuntime()
            ? createSharedBigbrainTools({ ...context, assignments: context.assignments })
            : []
          : createBigbrainTools(context),
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
  classifyError(error) {
    if (error instanceof BigbrainError) {
      return {
        code: error.code,
        retryable: ![
          'invalid_auth',
          'missing_scope',
          'invalid_configuration',
          'unsupported_host',
          'binding_changed',
          'binding_unavailable',
          'outcome_unknown',
        ].includes(error.code),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }
    }
    return { code: 'provider_error', retryable: true }
  },
}

export const bigbrainPlugin = Object.freeze(plugin)
