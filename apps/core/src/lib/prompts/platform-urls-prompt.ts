/**
 * Build a prompt section with the platform URLs (web UI and API) so agents
 * know the current deployment's public endpoints.
 *
 * Returns empty string if APP_URL is not configured.
 */
export function buildPlatformUrlsPrompt(): string {
  const appUrl = process.env.APP_URL
  if (!appUrl) return ''

  let apiBaseUrl: string
  let apiUrl: string
  try {
    const url = new URL(appUrl)
    const basePath = normalizeBasePath(url.pathname !== '/' ? url.pathname : process.env.APP_BASE_PATH)
    // FICUS_PUBLIC_API_URL: optional override for split-domain deployments
    // (API publicly reachable on a different origin than the web UI). Unset
    // everywhere we deploy today — the default is SAME-ORIGIN, matching how
    // hosted tenants and self-hosted installs actually serve the API. The
    // old hostname sniffing (`<name>.ficus.sh` → `api-<name>.ficus.sh`,
    // the retired pre-platform layout) told every hosted tenant's agents an
    // API URL that does not resolve.
    const publicApiOverride = process.env.FICUS_PUBLIC_API_URL?.trim()
    if (publicApiOverride) {
      apiBaseUrl = new URL(publicApiOverride).toString().replace(/\/$/, '')
      apiUrl = apiBaseUrl
    } else {
      apiBaseUrl = `${url.protocol}//${url.host}${basePath}`
      apiUrl = `${apiBaseUrl}/api`
    }
  } catch {
    return ''
  }

  return `## Platform URLs

- **Web UI:** ${appUrl}
- **API:** ${apiUrl}
- **Webhook endpoint:** ${apiBaseUrl}/api/webhooks/<provider> (e.g. ${apiBaseUrl}/api/webhooks/github)`
}

function normalizeBasePath(path: string | undefined): string {
  const trimmed = path?.trim()
  if (!trimmed || trimmed === '/') return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}
