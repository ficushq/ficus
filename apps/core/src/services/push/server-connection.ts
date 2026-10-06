import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { relayInstanceTokenPattern } from '@ficus/shared/push-relay'
import { getSecretStore } from '../secrets'
import { pushRelayConfig, relayConnectionSecretKey, resolvePushRelayBaseUrl } from './relay'

const statusSchema = z.object({
  instanceId: z.string().uuid(),
  name: z.string(),
  origin: z.string().url(),
  instancePro: z.boolean(),
  allowance: z.number().int().nonnegative().nullable(),
  used: z.number().int().nonnegative(),
  registered: z.number().int().nonnegative(),
})
export class RelayConnectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429 | 503 = 503
  ) {
    super(message)
  }
}
function publicOrigin(raw: string | undefined) {
  try {
    const url = new URL(raw ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error()
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new RelayConnectionError('Set PUBLIC_URL to this server’s public HTTPS address before connecting.', 400)
  }
}
const unavailable = () => new RelayConnectionError('Could not reach Ficus Cloud. Try again shortly.')
const dependencies = {
  env: () => process.env,
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  now: () => Date.now(),
  config: () => pushRelayConfig(),
  save: (key: string, value: string, actor: string) => getSecretStore().set(key, value, actor),
  read: (key: string) => getSecretStore().get(key),
  remove: (key: string) => getSecretStore().delete(key),
}
const pendingKey = '__push-relay-pending'
const verifierKey = (id: string) => `__push-relay-verifier:${id}`
const pendingSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  origin: z.string(),
  baseUrl: z.string(),
  key: z.string(),
  expires: z.number(),
})
/** PKCE verifiers never leave the API process except in its direct token exchange. */
export class RelayServerConnection {
  private queue = Promise.resolve()
  constructor(private deps = dependencies) {}
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }
  private pending() {
    const raw = this.deps.read(pendingKey)
    if (!raw) return undefined
    try {
      return pendingSchema.parse(JSON.parse(raw))
    } catch {
      throw unavailable()
    }
  }
  private async clearPending(actor: string) {
    const previous = this.pending()
    // Clear authority first. Verifier cleanup can safely be retried or abandoned.
    await this.deps.save(pendingKey, '', actor)
    if (previous) await this.deps.remove(verifierKey(previous.id)).catch(() => {})
  }
  private assertSelfHosted() {
    if (this.deps.env().FICUS_MANAGED === '1')
      throw new RelayConnectionError('Ficus Cloud manages this connection automatically.', 403)
  }
  private async request(base: string, path: string, body?: unknown, token?: string) {
    try {
      const response = await this.deps.fetch(`${base}/api/relay-server/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401)
          throw new RelayConnectionError(
            'This server’s connection has expired or was revoked. Connect your Ficus account again.',
            409
          )
        if (response.status === 429)
          throw new RelayConnectionError('Too many connection attempts. Try again in a minute.', 429)
        throw unavailable()
      }
      return await response.json()
    } catch (error) {
      if (error instanceof RelayConnectionError) throw error
      throw unavailable()
    }
  }
  async status() {
    const env = this.deps.env()
    const baseUrl = resolvePushRelayBaseUrl(env)
    const common = { baseUrl, manageUrl: `${baseUrl}/account/push`, origin: env.PUBLIC_URL?.trim() ?? '' }
    if (env.FICUS_MANAGED === '1') return { ...common, managed: true, configured: true, connected: true }
    let configured = false
    let setupError: string | undefined
    try {
      publicOrigin(env.PUBLIC_URL)
    } catch (error) {
      setupError = (error as RelayConnectionError).message
    }
    try {
      const config = this.deps.config()
      configured = Boolean(config)
      if (!config) return { ...common, managed: false, configured, connected: false, setupError }
      const status = statusSchema.parse(await this.request(config.baseUrl, 'status', undefined, config.token))
      if (status.instanceId !== config.instanceId || publicOrigin(status.origin) !== publicOrigin(env.PUBLIC_URL))
        throw new RelayConnectionError(
          'This connection belongs to a different server address. Connect your Ficus account again.',
          409
        )
      return { ...common, managed: false, configured, connected: true, setupError, status }
    } catch (error) {
      return {
        ...common,
        managed: false,
        configured,
        connected: false,
        setupError,
        error: error instanceof RelayConnectionError ? error.message : unavailable().message,
      }
    }
  }
  start(userId: string, name: string) {
    return this.exclusive(async () => {
      this.assertSelfHosted()
      const env = this.deps.env()
      const origin = publicOrigin(env.PUBLIC_URL)
      const baseUrl = resolvePushRelayBaseUrl(env)
      const now = this.deps.now()
      const previous = this.pending()
      if (
        previous &&
        previous.expires > now &&
        previous.userId === userId &&
        previous.origin === origin &&
        previous.baseUrl === baseUrl &&
        this.deps.read(verifierKey(previous.id))
      )
        return {
          id: previous.id,
          approvalUrl: `${baseUrl}/connect/server?request=${previous.id}`,
          expiresIn: Math.ceil((previous.expires - now) / 1000),
        }
      if (previous && previous.userId !== userId && previous.expires > now + 570_000)
        throw new RelayConnectionError('Another administrator just started a connection. Try again shortly.', 429)
      const verifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256').update(verifier).digest('base64url')
      const result = z
        .object({ id: z.string().uuid(), expiresIn: z.number().positive().max(600) })
        .parse(await this.request(baseUrl, 'authorize', { name, origin, codeChallenge }))
      // Persist the raw verifier separately so Secret Store redaction recognizes it.
      // A crash before updating the pointer leaves the previous request recoverable.
      await this.deps.save(verifierKey(result.id), verifier, userId)
      await this.deps.save(
        pendingKey,
        JSON.stringify({
          id: result.id,
          userId,
          origin,
          baseUrl,
          key: relayConnectionSecretKey(env),
          expires: now + result.expiresIn * 1000,
        }),
        userId
      )
      if (previous && previous.id !== result.id) await this.deps.remove(verifierKey(previous.id)).catch(() => {})
      return {
        id: result.id,
        approvalUrl: `${baseUrl}/connect/server?request=${result.id}`,
        expiresIn: result.expiresIn,
      }
    })
  }
  poll(userId: string, id: string) {
    return this.exclusive(async () => {
      this.assertSelfHosted()
      const p = this.pending()
      if (!p || p.id !== id || p.userId !== userId || p.expires <= this.deps.now())
        throw new RelayConnectionError('This connection request expired. Start again.', 409)
      const env = this.deps.env()
      if (p.origin !== publicOrigin(env.PUBLIC_URL) || p.baseUrl !== resolvePushRelayBaseUrl(env)) {
        await this.clearPending(userId)
        throw new RelayConnectionError('The server address changed. Start the connection again.', 409)
      }
      const verifier = this.deps.read(verifierKey(id))
      if (!verifier) throw new RelayConnectionError('This connection request expired. Start again.', 409)
      const exchange = async (path: string, body?: unknown, token?: string) => {
        try {
          return await this.request(p.baseUrl, path, body, token)
        } catch (error) {
          // Revocation/expiry is definitive; resuming it would strand Connect for ten minutes.
          // Transient transport and persistence failures retain the recovery capability.
          if (error instanceof RelayConnectionError && error.status === 409) await this.clearPending(userId)
          throw error
        }
      }
      const result = z
        .union([
          z.object({ status: z.enum(['pending', 'denied']) }),
          z.object({ status: z.literal('connected'), token: z.string().regex(relayInstanceTokenPattern) }),
        ])
        .parse(await exchange('token', { id, codeVerifier: verifier }))
      if (result.status === 'denied') await this.clearPending(userId)
      if (result.status !== 'connected') return { status: result.status }
      const status = statusSchema.parse(await exchange('status', undefined, result.token))
      if (
        publicOrigin(status.origin) !== p.origin ||
        relayInstanceTokenPattern.exec(result.token)?.[1] !== status.instanceId
      ) {
        await this.clearPending(userId)
        throw new RelayConnectionError('The approved credential belongs to a different server. Start again.', 409)
      }
      await this.deps.save(p.key, result.token, userId)
      // Keep the request until token persistence succeeds, allowing recovery after a lost response/restart.
      await this.clearPending(userId)
      return { status: 'connected' as const }
    })
  }
  disconnect(userId: string) {
    return this.exclusive(async () => {
      this.assertSelfHosted()
      await this.clearPending(userId)
      await this.deps.save(relayConnectionSecretKey(this.deps.env()), '', userId)
      return { disconnected: true }
    })
  }
}
export const relayServerConnection = new RelayServerConnection()
