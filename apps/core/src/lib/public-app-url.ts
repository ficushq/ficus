/** Canonical browser-facing application address, including any reverse-proxy base path.
 * PUBLIC_URL is a compatibility fallback for earlier mobile relay deployments.
 * FICUS_API_URL is intentionally excluded: it can be an internal/loopback address.
 */
export function resolvePublicAppUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate = env.APP_URL?.trim() || env.PUBLIC_URL?.trim()
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return undefined
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}
