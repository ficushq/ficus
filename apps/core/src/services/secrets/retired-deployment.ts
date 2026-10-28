/** Only the one-time upgrade importer may read these names. Never expose them or revive host fallbacks. */
export const retiredDeploymentKeys = {
  cloudflare: 'DEPLOY_CLOUDFLARE_TOKEN',
  digitalocean: 'DEPLOY_DIGITALOCEAN_TOKEN',
  netlify: 'DEPLOY_NETLIFY_TOKEN',
  railway: 'DEPLOY_RAILWAY_TOKEN',
  supabase: 'DEPLOY_SUPABASE_TOKEN',
  vercel: 'DEPLOY_VERCEL_TOKEN',
} as const
const retired = new Set<string>(Object.values(retiredDeploymentKeys))
export function isRetiredDeploymentKey(key: string): boolean {
  return retired.has(key)
}
