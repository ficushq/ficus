import type {
  DeploymentAppType,
  DeploymentProviderAuth,
  DeploymentProviderBillingRisk,
  DeploymentProviderId,
} from '@ficus/shared'

export type { DeploymentProviderId } from '@ficus/shared'
export type DeploymentProviderSupport = Exclude<DeploymentAppType, 'unknown'>

export interface DeploymentProviderDefinition {
  id: DeploymentProviderId
  label: string
  supports: DeploymentProviderSupport[]
  cliPackages: string[]
  auth: DeploymentProviderAuth[]
  needsBillingFor: DeploymentProviderBillingRisk[]
  docsUrl: string
}

export const deploymentProviders: DeploymentProviderDefinition[] = [
  {
    id: 'vercel',
    label: 'Vercel',
    supports: ['spa', 'next'],
    cliPackages: ['vercel'],
    auth: ['api_token', 'browser_login'],
    needsBillingFor: ['project_create'],
    docsUrl: 'https://vercel.com/docs',
  },
  {
    id: 'netlify',
    label: 'Netlify',
    supports: ['static', 'spa'],
    cliPackages: ['netlify-cli'],
    auth: ['api_token', 'browser_login'],
    needsBillingFor: ['project_create'],
    docsUrl: 'https://docs.netlify.com',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    supports: ['static', 'spa', 'worker'],
    cliPackages: ['wrangler'],
    auth: ['api_token', 'browser_login'],
    needsBillingFor: ['project_create', 'public_egress'],
    docsUrl: 'https://developers.cloudflare.com',
  },
  {
    id: 'github-pages',
    label: 'GitHub Pages',
    supports: ['static'],
    cliPackages: ['gh'],
    auth: ['api_token', 'oauth_device'],
    needsBillingFor: [],
    docsUrl: 'https://docs.github.com/pages',
  },
  {
    id: 'railway',
    label: 'Railway',
    supports: ['api', 'container', 'db'],
    cliPackages: ['railway'],
    auth: ['api_token', 'browser_login'],
    needsBillingFor: ['always_on', 'managed_db'],
    docsUrl: 'https://docs.railway.com',
  },
  {
    id: 'supabase',
    label: 'Supabase',
    supports: ['db', 'worker'],
    cliPackages: ['supabase-cli'],
    auth: ['api_token', 'browser_login'],
    needsBillingFor: ['project_create', 'managed_db'],
    docsUrl: 'https://supabase.com/docs',
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    supports: ['api', 'container', 'db'],
    cliPackages: ['doctl'],
    auth: ['api_token'],
    needsBillingFor: ['project_create', 'always_on', 'managed_db'],
    docsUrl: 'https://docs.digitalocean.com',
  },
]
