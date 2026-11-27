import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { requirePermission } from '../middleware/require-permission'
import { auditActor, type Identity } from '../services/rbac'
import {
  previewPublicAppUrl,
  publicAppUrlRuntime,
  publicAppUrlStatus,
  PublicAppUrlError,
  setPublicAppUrl,
} from '../services/public-url/service'
import { MAX_PUBLIC_APP_URL_LENGTH } from '../lib/public-app-url-format'
import { apiBindHost } from '../lib/infra/bind-host'
import {
  checkAddress,
  matchesAddressProbe,
  phoneReachReport,
  type AddressCheckResult,
} from '../services/public-url/reachability'
import { parseJsonBody } from './json-body'

const urlField = z.string().max(MAX_PUBLIC_APP_URL_LENGTH).nullable()

/** Only signed-in people manage the address; agents and system tokens are refused even with settings authority. */
const USER_REQUIRED = { error: 'A user account is required.' }
const isUser = (c: Context) => c.get('identity')?.type === 'user'

async function respond(c: Context, produce: () => Promise<unknown> | unknown) {
  try {
    return c.json(await produce())
  } catch (error) {
    if (!(error instanceof PublicAppUrlError)) throw error
    return c.json(
      { error: error.message, ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}) },
      error.status
    )
  }
}

/**
 * `GET /health/address-check/:token`, beside `/health` and likewise open: 204 to this process's own probe
 * token, an empty 404 to anything else. It lets `checkAddress` tell this server from another site that answers.
 */
export function addressProbeHandler(c: Context) {
  return c.body(null, matchesAddressProbe(c.req.param('token') ?? '') ? 204 : 404)
}

/**
 * The server's canonical public address (see lib/public-app-url.ts).
 * Writes are CSRF-protected by the global `/api/*` middleware.
 */
export function createPublicUrlRouter(deps: { check?: (url: string) => Promise<AddressCheckResult> } = {}) {
  const router = new Hono()
  router.use('*', bodyLimit({ maxSize: 4096 }))
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })

  // Runtime config for every signed-in client (replaces the web build's compile-time APP_URL).
  router.get('/', async (c) => {
    c.set('authzChecked', true)
    return c.json(publicAppUrlRuntime())
  })

  router.get('/status', requirePermission('settings:read'), (c) =>
    isUser(c) ? respond(c, publicAppUrlStatus) : c.json(USER_REQUIRED, 403)
  )

  // What this machine could offer a mobile device: home-network addresses, Tailscale, and whether it is listening.
  router.get('/reach', requirePermission('settings:read'), (c) =>
    isUser(c)
      ? respond(c, () =>
          phoneReachReport({
            currentUrl: publicAppUrlRuntime().url ?? publicAppUrlRuntime().localUrl,
            bindHost: apiBindHost(process.env, !!process.env.KUBERNETES_SERVICE_HOST),
            port: Number(process.env.PORT) || 3000,
            desktopManaged: process.env.FICUS_DESKTOP_MANAGED === '1',
          })
        )
      : c.json(USER_REQUIRED, 403)
  )

  // Does this address lead back to this server? Tried from the server itself; see checkAddress.
  router.post('/check', requirePermission('settings:write'), async (c) => {
    if (!isUser(c)) return c.json(USER_REQUIRED, 403)
    const body = await parseJsonBody(c)
    const input = z
      .strictObject({ url: z.string().min(1).max(MAX_PUBLIC_APP_URL_LENGTH) })
      .safeParse(body.ok ? body.value : null)
    if (!input.success) return c.json({ error: 'Send { url }.' }, 400)
    return c.json(await (deps.check ?? checkAddress)(input.data.url))
  })

  router.post('/preview', requirePermission('settings:write'), async (c) => {
    if (!isUser(c)) return c.json(USER_REQUIRED, 403)
    const body = await parseJsonBody(c)
    const input = z.strictObject({ url: urlField }).safeParse(body.ok ? body.value : null)
    if (!input.success) return c.json({ error: 'Send { url } with a URL or null.' }, 400)
    return respond(c, () => previewPublicAppUrl(input.data.url))
  })

  router.put('/', requirePermission('settings:write'), async (c) => {
    if (!isUser(c)) return c.json(USER_REQUIRED, 403)
    const body = await parseJsonBody(c)
    const input = z
      .strictObject({ url: urlField, expectedVersion: z.string().min(1).max(64) })
      .safeParse(body.ok ? body.value : null)
    if (!input.success) return c.json({ error: 'Send { url, expectedVersion }.' }, 400)
    return respond(c, () => setPublicAppUrl({ ...input.data, actor: auditActor(c.get('identity') as Identity) }))
  })

  return router
}

export const publicUrlRouter = createPublicUrlRouter()
