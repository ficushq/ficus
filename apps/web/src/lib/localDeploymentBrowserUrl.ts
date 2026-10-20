/** Absolute browser URL for a deployment; path-mode URLs resolve against the server's public address. */
export function getLocalDeploymentBrowserUrl(urlPathOrHost: string, publicAppUrl?: string | null): string {
  if (/^https?:\/\//i.test(urlPathOrHost)) return urlPathOrHost

  const appUrl = publicAppUrl || window.location.origin
  const appBasePath = __FICUS_APP_BASE_PATH__ || import.meta.env.BASE_URL || ''
  const base = new URL(appUrl)
  const existingPath = base.pathname.replace(/^\/+|\/+$/g, '')
  const basePath = appBasePath.replace(/^\/+|\/+$/g, '')
  const pathParts = existingPath.endsWith(basePath) ? [existingPath] : [existingPath, basePath]
  base.pathname = pathParts.filter(Boolean).join('/') + '/'
  return new URL(urlPathOrHost.replace(/^\/+/, ''), base).toString()
}
