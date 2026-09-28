import { Hono } from 'hono'
import { getSettingsStore } from '../services/settings'
import {
  DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS,
  DirtyWorktreeError,
  localUpdateManager,
  MANUAL_UPDATE_TARGETS,
  UnsupportedDeploymentError,
  UpdateLockedError,
} from '../services/updates'
import type { LocalAutoUpdateSettings, ManualUpdateTarget } from '../services/updates'
import { requirePermission } from '../middleware/require-permission'
import { isPlatformManaged } from '../services/secrets/managed'

const KEYS = {
  enabled: 'LOCAL_AUTO_UPDATE_ENABLED',
  intervalMinutes: 'LOCAL_AUTO_UPDATE_INTERVAL_MINUTES',
  remote: 'LOCAL_AUTO_UPDATE_REMOTE',
  branch: 'LOCAL_AUTO_UPDATE_BRANCH',
  githubConnectionId: 'LOCAL_AUTO_UPDATE_GITHUB_CONNECTION_ID',
} as const

type Store = { getTyped(key: string): unknown; set(key: string, value: string, updatedBy?: string): Promise<unknown> }
type Updater = typeof localUpdateManager

function readSettings(store: Store): LocalAutoUpdateSettings {
  const enabled = store.getTyped(KEYS.enabled)
  return {
    enabled: enabled === true || enabled === 'true',
    intervalMinutes: Number(store.getTyped(KEYS.intervalMinutes) ?? DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.intervalMinutes),
    remote: String(store.getTyped(KEYS.remote) ?? DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.remote),
    branch: String(store.getTyped(KEYS.branch) ?? DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.branch),
    ...(store.getTyped(KEYS.githubConnectionId)
      ? { githubConnectionId: String(store.getTyped(KEYS.githubConnectionId)) }
      : {}),
  }
}

export function createUpdatesRouter(deps: { store?: Store; updater?: Updater } = {}) {
  const app = new Hono()
  const store = deps.store ?? getSettingsStore()
  const updater = deps.updater ?? localUpdateManager

  // `managed`: on a platform-managed tenant (FICUS_MANAGED=1) self-updates can't
  // work — the checkout has no GitHub credentials by design (the setup toolkit
  // scrubs the clone token) and the hosting platform's upgrade job owns the
  // lifecycle (backup, migrations, artifact verify). The web hides the whole
  // Updates surface off this flag.
  app.get('/settings', requirePermission('updates:read'), (c) =>
    c.json({ settings: readSettings(store), status: updater.status(), managed: isPlatformManaged() })
  )
  app.patch('/settings', requirePermission('updates:write'), async (c) => {
    const body = await c.req.json<Partial<LocalAutoUpdateSettings>>()
    if (body.githubConnectionId !== undefined) {
      if (
        typeof body.githubConnectionId !== 'string' ||
        (body.githubConnectionId !== '' &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.githubConnectionId))
      )
        return c.json({ error: 'githubConnectionId must be a connection UUID or empty string' }, 400)
      await store.set(KEYS.githubConnectionId, body.githubConnectionId, 'admin')
    }
    if (body.enabled !== undefined) await store.set(KEYS.enabled, String(Boolean(body.enabled)), 'admin')
    if (body.intervalMinutes !== undefined) {
      const n = Number(body.intervalMinutes)
      if (!Number.isFinite(n) || n < 1) return c.json({ error: 'intervalMinutes must be a positive number' }, 400)
      await store.set(KEYS.intervalMinutes, String(n), 'admin')
    }
    if (body.remote !== undefined) await store.set(KEYS.remote, String(body.remote), 'admin')
    if (body.branch !== undefined) await store.set(KEYS.branch, String(body.branch), 'admin')
    return c.json({ settings: readSettings(store), status: updater.status() })
  })
  app.post('/check', requirePermission('updates:read'), async (c) => {
    try {
      return c.json(await updater.check(readSettings(store)))
    } catch (err) {
      const status = updater.status()
      if (err instanceof UpdateLockedError) return c.json({ error: err.message, status }, 409)
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message, status }, 500)
    }
  })
  app.post('/apply', requirePermission('updates:write'), async (c) => {
    try {
      return c.json(updater.applyInBackground({ manual: true, settings: readSettings(store) }))
    } catch (err) {
      const status = updater.status()
      if (
        err instanceof UpdateLockedError ||
        err instanceof DirtyWorktreeError ||
        err instanceof UnsupportedDeploymentError
      )
        return c.json({ error: err.message, status }, 409)
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message, status }, 500)
    }
  })
  app.post('/apply-target', requirePermission('updates:write'), async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const rawTargets = (body as { targets?: unknown }).targets
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      return c.json({ error: 'targets must be a non-empty array' }, 400)
    }

    const allowedTargets = new Set<string>(MANUAL_UPDATE_TARGETS)
    for (const target of rawTargets) {
      if (typeof target !== 'string' || !allowedTargets.has(target)) {
        return c.json({ error: `Unsupported target: ${String(target)}` }, 400)
      }
    }

    const tasks = rawTargets as ManualUpdateTarget[]
    try {
      return c.json(updater.applyInBackground({ manual: true, tasks, settings: readSettings(store) }))
    } catch (err) {
      const status = updater.status()
      if (err instanceof UpdateLockedError || err instanceof UnsupportedDeploymentError)
        return c.json({ error: err.message, status }, 409)
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message, status }, 500)
    }
  })
  app.get('/status', requirePermission('updates:read'), (c) => c.json(updater.status()))
  return app
}

export default createUpdatesRouter()
