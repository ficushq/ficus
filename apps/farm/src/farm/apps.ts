import type { LocalDeployment } from '@ficus/shared'

/*
 * A squad's apps, for its server rack: the apps its agents deployed somewhere
 * (a hosting provider, with a public URL) and the local apps running in its
 * sandbox (reached through Core with a one-time access token in the URL Core
 * issues). The rack only shows up while a squad has any to open.
 */

/** A remote deployment as `/squads/:id/deployments` returns it (the fields the farm reads). */
export interface RemoteDeployment {
  id: string
  squadId: string
  name: string
  provider: string
  environment: string
  status: string
  url?: string | null
  archivedAt?: string | null
}

export interface FarmApp {
  id: string
  squadId: string
  name: string
  kind: 'local' | 'remote'
  /** Where it runs: the hosting provider and environment, or "Sandbox". */
  where: string
  status: string
  /** Opens the app: a full URL, or (local) a path under the instance that carries the access token. */
  url: string
}

/** Local apps worth opening: live ones (a stopped or crashed app has nothing to show). */
const LOCAL_OPEN: ReadonlySet<LocalDeployment['status']> = new Set(['running', 'starting', 'restarting', 'unhealthy'])

/** A squad's openable apps, remote first, each sorted by name. */
export function squadApps(remote: readonly RemoteDeployment[], local: readonly LocalDeployment[]): FarmApp[] {
  const remotes = remote
    .filter((d) => !d.archivedAt && d.url)
    .map(
      (d): FarmApp => ({
        id: `remote:${d.id}`,
        squadId: d.squadId,
        name: d.name,
        kind: 'remote',
        where: `${d.provider} · ${d.environment}`,
        status: d.status,
        url: d.url!,
      })
    )
  const locals = local
    .filter((d) => !d.archivedAt && LOCAL_OPEN.has(d.status))
    .map(
      (d): FarmApp => ({
        id: `local:${d.id}`,
        squadId: d.squadId,
        name: d.name,
        kind: 'local',
        where: 'Sandbox',
        status: d.status,
        url: d.urlPathOrHost,
      })
    )
  const byName = (a: FarmApp, b: FarmApp) => a.name.localeCompare(b.name)
  return [...remotes.sort(byName), ...locals.sort(byName)]
}

/**
 * The URL to open an app at. A local app's URL is a path under the instance
 * (e.g. `/api/app/<id>/?<token>`), resolved against the instance's own base
 * (where the farm's `/farm` sits), exactly as the web app resolves it.
 */
export function appBrowserUrl(url: string, instanceBase: string, origin: string): string {
  if (/^https?:\/\//i.test(url)) return url
  const base = new URL(`${instanceBase.replace(/\/+$/, '')}/`, origin)
  return new URL(url.replace(/^\/+/, ''), base).toString()
}
