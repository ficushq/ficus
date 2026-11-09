/**
 * Path-mounted local apps (`/api/app/<id>/`) and the runtime base path.
 *
 * A path-mounted app is served under exactly one base, the public base
 * (`/ficus/api/app/<id>/`), on every listener: it is launched with that
 * FICUS_APP_BASE_PATH and its access cookie uses that Path. Two things keep
 * that true:
 *
 * - {@link decideLocalAppBase}: a request that reached the app through another
 *   base (the local root `http://localhost:3000/api/app/<id>/`) is redirected
 *   once to the public base on the same host.
 * - {@link reconcileLocalAppBasePath}: when the public base changes, every live
 *   managed app restarts so it emits URLs under the new base.
 */
import type { LocalDeployment } from '@ficus/shared'
import {
  isStrippableBasePath,
  publicBasePath,
  resolveRequestBasePath,
  type BasePathRequest,
} from '../../lib/app-base-path'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('local-deployment-base-path')

/**
 * Query parameter on the redirect this module issues. A request that carries it
 * already came from that redirect, so it is never redirected again.
 */
export const LOCAL_APP_BASE_REDIRECT_PARAM = '_ficus_base_redirect'

export type LocalAppBaseDecision =
  | {
      kind: 'proxy'
      /** The request carries the redirect marker: serve it without the marker. */
      stripMarker: boolean
      /** The redirect already happened once and the base still did not match (the proxy hides the prefix). */
      afterRedirect: boolean
    }
  | { kind: 'redirect'; location: string }
  | { kind: 'reject-upgrade' }

export interface LocalAppBaseRequest extends BasePathRequest {
  /** The routed path, with any base path prefix already stripped (`c.req.path`). */
  path: string
}

/**
 * Decide how to answer a request for a path-mounted local app:
 *
 * - hosted apps (per-app origins), a root public base, or a base Core never
 *   strips: serve in place;
 * - the request already used the public base: serve;
 * - a WebSocket upgrade under another base: refuse (an upgrade cannot follow a
 *   redirect; a page loaded under the public base opens its sockets there);
 * - otherwise: redirect once to the same path and query under the public base,
 *   adding {@link LOCAL_APP_BASE_REDIRECT_PARAM}.
 *
 * Loop safety: behind a proxy that strips the prefix and rewrites Host without
 * sending X-Forwarded-Host, the redirected request arrives looking like the
 * first one. The marker identifies it, and it is served in place: the browser
 * is then really at the public base, so the app's URLs and cookie Path match.
 */
export function decideLocalAppBase(
  req: LocalAppBaseRequest,
  opts: { hostedAppsDomain: boolean; publicBase?: string; requestBase?: string }
): LocalAppBaseDecision {
  const url = new URL(req.url)
  const marked = url.searchParams.has(LOCAL_APP_BASE_REDIRECT_PARAM)
  const serve = (afterRedirect = false): LocalAppBaseDecision => ({
    kind: 'proxy',
    stripMarker: marked,
    afterRedirect,
  })
  if (opts.hostedAppsDomain) return serve()
  const publicBase = opts.publicBase ?? publicBasePath()
  if (!publicBase || !isStrippableBasePath(publicBase)) return serve()
  const requestBase = opts.requestBase ?? resolveRequestBasePath(req).basePath
  if (requestBase === publicBase) return serve()
  if (marked) return serve(true)
  if (req.header('upgrade')?.toLowerCase() === 'websocket') return { kind: 'reject-upgrade' }
  url.searchParams.set(LOCAL_APP_BASE_REDIRECT_PARAM, '1')
  return { kind: 'redirect', location: `${publicBase}${req.path}${url.search}` }
}

/** The request without the redirect marker, so the app never sees it. */
export function withoutRedirectMarker(request: Request): Request {
  const url = new URL(request.url)
  url.searchParams.delete(LOCAL_APP_BASE_REDIRECT_PARAM)
  return new Request(url, request)
}

let warnedAfterRedirect = false

/** Log once per process that the proxy hides the prefix from Core. */
export function warnLocalAppServedAfterRedirect(localDeploymentId: string): void {
  if (warnedAfterRedirect) return
  warnedAfterRedirect = true
  log.warn(
    `Local app ${localDeploymentId} was requested under the public base path but Core could not tell: ` +
      'the reverse proxy removes the path prefix without preserving the Host header or sending X-Forwarded-Host. ' +
      'Serving it in place; configure the proxy to preserve Host (or send X-Forwarded-Host) so the base path is recognized.'
  )
}

/**
 * Setting that records which public base path the managed local apps were last
 * (re)started for, and which restarts for it failed: JSON
 * `{ "basePath": "/ficus", "failed": ["<deployment id>"] }`.
 */
export const LOCAL_APPS_BASE_PATH_SETTING_KEY = 'LOCAL_APPS_BASE_PATH'

interface LocalAppsBaseMarker {
  basePath: string
  failed: string[]
}

/**
 * A missing marker means the root base: before this setting existed every
 * path-mounted app was launched with the unprefixed `/api/app/<id>/`.
 */
export function parseLocalAppsBaseMarker(value: string | undefined): LocalAppsBaseMarker {
  if (!value) return { basePath: '', failed: [] }
  try {
    const parsed = JSON.parse(value) as Partial<LocalAppsBaseMarker>
    return {
      basePath: typeof parsed.basePath === 'string' ? parsed.basePath : '',
      failed: Array.isArray(parsed.failed) ? parsed.failed.filter((id) => typeof id === 'string') : [],
    }
  } catch {
    return { basePath: '', failed: [] }
  }
}

export interface ReconcileLocalAppBasePathDependencies {
  publicBasePath: () => string
  hostedAppsDomain: () => boolean
  listLive: () => Promise<LocalDeployment[]>
  restart: (localDeploymentId: string) => Promise<unknown>
  readMarker: () => string | undefined
  writeMarker: (value: string) => Promise<void>
}

export interface ReconcileLocalAppBasePathResult {
  basePath: string
  restarted: string[]
  failed: string[]
}

async function defaultDependencies(): Promise<ReconcileLocalAppBasePathDependencies> {
  const [{ getSettingsStore }, service, health] = await Promise.all([
    import('../settings/store'),
    import('./local-deployment-service'),
    import('./local-deployment-health'),
  ])
  const store = getSettingsStore()
  return {
    publicBasePath: () => publicBasePath(),
    hostedAppsDomain: () => !!service.getHostedAppsDomain(),
    listLive: service.listLiveLocalDeployments,
    restart: (id) => health.restartManagedLocalDeployment(id, { explicit: true }),
    readMarker: () => store.getStoredValue(LOCAL_APPS_BASE_PATH_SETTING_KEY),
    writeMarker: (value) => store.set(LOCAL_APPS_BASE_PATH_SETTING_KEY, value, 'system'),
  }
}

let reconcileChain: Promise<unknown> = Promise.resolve()

/**
 * Restart live managed path-mounted apps whose FICUS_APP_BASE_PATH no longer
 * matches the public base path. Runs on API startup and on every public address
 * change; calls are serialized.
 *
 * - Base changed since the marker: restart every live managed app.
 * - Base unchanged: retry only the apps whose restart failed last time, so a
 *   failed app is never left on the old base, and a successful one is never
 *   restarted twice.
 *
 * Each failure is logged with the deployment id and recorded in the marker.
 */
export function reconcileLocalAppBasePath(
  deps?: Partial<ReconcileLocalAppBasePathDependencies>
): Promise<ReconcileLocalAppBasePathResult> {
  const run = reconcileChain.then(async () => {
    const d = { ...(await defaultDependencies()), ...deps }
    return reconcileOnce(d)
  })
  reconcileChain = run.catch(() => undefined)
  return run
}

async function reconcileOnce(d: ReconcileLocalAppBasePathDependencies): Promise<ReconcileLocalAppBasePathResult> {
  const basePath = d.publicBasePath()
  const marker = parseLocalAppsBaseMarker(d.readMarker())
  const baseChanged = marker.basePath !== basePath
  if (!baseChanged && marker.failed.length === 0) return { basePath, restarted: [], failed: [] }

  let targets: LocalDeployment[] = []
  if (!d.hostedAppsDomain()) {
    const managed = (await d.listLive()).filter((deployment) => deployment.mode === 'managed')
    targets = baseChanged ? managed : managed.filter((deployment) => marker.failed.includes(deployment.id))
  }

  const restarted: string[] = []
  const failed: string[] = []
  for (const deployment of targets) {
    try {
      await d.restart(deployment.id)
      restarted.push(deployment.id)
    } catch (error) {
      failed.push(deployment.id)
      log.warn(`Failed to restart local app ${deployment.id} for base path "${basePath || '/'}":`, error)
    }
  }
  if (restarted.length || failed.length)
    log.info(
      `Local apps for base path "${basePath || '/'}": ${restarted.length} restarted, ${failed.length} failed` +
        (failed.length ? ' (retried on the next start or address change)' : '')
    )
  await d.writeMarker(JSON.stringify({ basePath, failed }))
  return { basePath, restarted, failed }
}
