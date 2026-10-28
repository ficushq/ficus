/** Public provider keys shared by the catalog, assignment UI and exec lifecycle. */
export const DEPLOYMENT_INTEGRATION_KEYS = [
  'cloudflare',
  'digitalocean',
  'netlify',
  'railway',
  'supabase',
  'vercel',
] as const
export type DeploymentIntegrationKey = (typeof DEPLOYMENT_INTEGRATION_KEYS)[number]
export function isDeploymentIntegrationKey(key: string): key is DeploymentIntegrationKey {
  return (DEPLOYMENT_INTEGRATION_KEYS as readonly string[]).includes(key)
}
