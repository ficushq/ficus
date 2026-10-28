import { z } from 'zod'
import { DEPLOYMENT_INTEGRATION_KEYS, isDeploymentIntegrationKey } from '@ficus/shared'
import type { IntegrationPluginV1 } from '../plugin'
import { deploymentCliSetup, deploymentCliVersion } from './cli-install'

export const deploymentProviders = {
  cloudflare: {
    label: 'Cloudflare',
    binary: 'wrangler',
    variable: 'CLOUDFLARE_API_TOKEN',
    validationUrl: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
  },
  digitalocean: {
    label: 'DigitalOcean',
    binary: 'doctl',
    variable: 'DIGITALOCEAN_ACCESS_TOKEN',
    validationUrl: 'https://api.digitalocean.com/v2/account',
  },
  netlify: {
    label: 'Netlify',
    binary: 'netlify',
    variable: 'NETLIFY_AUTH_TOKEN',
    validationUrl: 'https://api.netlify.com/api/v1/user',
  },
  railway: {
    label: 'Railway',
    binary: 'railway',
    variable: 'RAILWAY_API_TOKEN',
    validationUrl: 'https://backboard.railway.com/graphql/v2',
  },
  supabase: {
    label: 'Supabase',
    binary: 'supabase',
    variable: 'SUPABASE_ACCESS_TOKEN',
    validationUrl: 'https://api.supabase.com/v1/organizations',
  },
  vercel: {
    label: 'Vercel',
    binary: 'vercel',
    variable: 'VERCEL_TOKEN',
    validationUrl: 'https://api.vercel.com/v2/user',
  },
} as const
export type DeploymentProvider = keyof typeof deploymentProviders
export function isDeploymentProvider(key: string): key is DeploymentProvider {
  return isDeploymentIntegrationKey(key)
}

type Configuration = { version: 1; accountId?: string }
const configurationSchema = z.strictObject({ version: z.literal(1) })
const cloudflareConfigurationSchema = configurationSchema.extend({ accountId: z.string().trim().max(200).optional() })
const credentialSchema = z
  .string()
  .trim()
  .min(1)
  .max(16384)
  // Token values must be single-line: reject control characters before HTTP/env use.
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\s\x00-\x1f\x7f]+$/)

function authenticated(key: DeploymentProvider, body: unknown): boolean {
  const value = body as any
  switch (key) {
    case 'cloudflare':
      return value?.success === true && value?.result?.status === 'active'
    case 'digitalocean':
      return typeof value?.account?.uuid === 'string'
    case 'netlify':
      return typeof value?.id === 'string'
    case 'railway':
      return !value?.errors?.length && Array.isArray(value?.data?.projects?.edges)
    case 'supabase':
      return Array.isArray(body)
    case 'vercel':
      return typeof value?.user?.id === 'string'
  }
}

function createDeploymentPlugin(key: DeploymentProvider): IntegrationPluginV1<Configuration, string> {
  const definition = deploymentProviders[key]
  const parseConfiguration = (input: unknown): Configuration =>
    (key === 'cloudflare' ? cloudflareConfigurationSchema : configurationSchema).parse(input)
  return {
    manifestVersion: 1,
    key,
    adapterVersion: 1,
    presentation: {
      label: definition.label,
      description: `Connect a ${definition.label} account, then assign it to squads for deployment commands.`,
      icon: key,
      connectionMode: 'credential',
      assignable: true,
      requiredCapabilities: [],
    },
    connection: {
      parseConfiguration,
      safeConfiguration: (configuration) => configuration,
      credential: { parse: (input) => credentialSchema.parse(input), serialize: (credential) => credential },
    },
    authorization: { kind: 'manual' },
    runtime: {
      provider: {
        key,
        adapterVersion: 1,
        parseConfig: parseConfiguration,
        capabilities: {},
        async validate({ credential, signal }) {
          try {
            const token = credentialSchema.parse(credential)
            const response = await fetch(definition.validationUrl, {
              headers: {
                Authorization: `Bearer ${token}`,
                ...(key === 'railway' ? { 'Content-Type': 'application/json' } : {}),
              },
              ...(key === 'railway'
                ? { method: 'POST', body: JSON.stringify({ query: 'query { projects { edges { node { id } } } }' }) }
                : {}),
              signal: signal ?? AbortSignal.timeout(10_000),
            })
            if (response.status === 401 || response.status === 403) return { ok: false, code: 'invalid_auth' }
            if (!response.ok) return { ok: false, code: 'provider_unavailable' }
            return authenticated(key, await response.json())
              ? { ok: true, grantedScopes: [] }
              : { ok: false, code: 'invalid_auth' }
          } catch {
            return { ok: false, code: 'provider_unavailable' }
          }
        },
      },
    },
    execution: {
      binaries: [definition.binary],
      environment: {
        [definition.variable]: ({ credential }) => credential,
        ...(key === 'digitalocean' ? { DIGITALOCEAN_CONTEXT: () => 'default' } : {}),
        ...(key === 'cloudflare'
          ? {
              CLOUDFLARE_ACCOUNT_ID: ({ configuration }: { configuration: Configuration }) =>
                configuration.accountId ?? '',
            }
          : {}),
      },
    },
    sandbox: {
      packages: ['nodejs@24.12.0'],
      setupSteps: [deploymentCliSetup(definition.binary)],
      initHooks: ['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'],
      readiness: [
        {
          id: `${definition.binary}-cli`,
          command: definition.binary === 'doctl' ? 'doctl version' : `${definition.binary} --version`,
          expectedSubstring: deploymentCliVersion(definition.binary),
        },
      ],
      skills: [`deploy-${key}`],
      extensions: [],
      protectedBindings: [],
    },
    lifecycle: { refresh: false, revoke: false },
    classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
  }
}

export const deploymentPlugins = DEPLOYMENT_INTEGRATION_KEYS.map(createDeploymentPlugin)
