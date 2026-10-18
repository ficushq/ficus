/**
 * The app's own host on a hosted instance (`<tenant>--<alias or id>.<apps
 * domain>`), or null on the path mount, where an alias has no effect. Read from
 * the URL Ficus issued, which already prefers the alias host.
 */
export function getLocalDeploymentAppHost(urlPathOrHost: string): string | null {
  if (!/^https:\/\//i.test(urlPathOrHost)) return null
  try {
    return new URL(urlPathOrHost).host
  } catch {
    return null
  }
}

/** `https://<tenant>--<alias>.<apps domain>/` for a candidate alias, from the app's current host. */
export function previewLocalDeploymentAliasUrl(appHost: string, alias: string): string {
  const dot = appHost.indexOf('.')
  const label = appHost.slice(0, dot)
  const tenant = label.slice(0, label.lastIndexOf('--'))
  return `https://${tenant}--${alias}${appHost.slice(dot)}/`
}
