import { openBrowser } from './open-browser'

/** Fallback poll cadence when the server supplies no usable interval. Mirrors core's default. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

interface DeviceLoginResult {
  token: string
  deviceId: string
  user: { id: string; email: string; displayName?: string | null }
}

function validateApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('HTTPS is required for non-loopback Ficus API URLs')
  }
  return apiUrl.replace(/\/+$/, '')
}

export async function loginWithDeviceAuthorization(options: {
  apiUrl: string
  name: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  open?: (url: string) => Promise<boolean>
  signal?: AbortSignal
  onVerification?: (url: string, opened: boolean) => void
}): Promise<DeviceLoginResult> {
  const apiUrl = validateApiUrl(options.apiUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const start = await fetchImpl(`${apiUrl}/api/auth/device/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: options.name }),
    signal: options.signal,
  })
  if (!start.ok) throw new Error(`Could not start device login (${start.status})`)
  const grant = (await start.json()) as {
    deviceCode: string
    verificationUri: string
    expiresAt: string
    interval: number
  }
  const opened = await (options.open ?? openBrowser)(grant.verificationUri)
  options.onVerification?.(grant.verificationUri, opened)
  let interval = Math.max(1, Number.isFinite(grant.interval) ? grant.interval : DEFAULT_POLL_INTERVAL_SECONDS) * 1000
  while (Date.now() < new Date(grant.expiresAt).getTime()) {
    if (options.signal?.aborted) throw new Error('Login cancelled')
    const response = await fetchImpl(`${apiUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
      signal: options.signal,
    })
    if (response.status === 200) return (await response.json()) as DeviceLoginResult
    const body = (await response.json().catch(() => ({}))) as { error?: string; interval?: number }
    if (response.status === 401) throw new Error('Device authorization expired or was already used')
    if (response.status !== 202 && response.status !== 429) throw new Error(`Device login failed (${response.status})`)
    // Retry-After may be an HTTP-date rather than seconds, and the body may omit `interval`
    // entirely. Anything non-finite must fall back to the previous interval — NaN would sleep
    // for zero and hot-loop the poll endpoint until the grant expires.
    const retryAfter = Number(response.headers.get('retry-after'))
    const seconds = [body.interval, retryAfter, interval / 1000].find(
      (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
    )
    interval = Math.max(1, seconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000
    await sleep(interval)
  }
  throw new Error('Device authorization expired')
}

export async function revokeDeviceAuthorization(options: {
  apiUrl: string
  password: string
  deviceId: string
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const response = await (options.fetchImpl ?? fetch)(
    `${options.apiUrl.replace(/\/+$/, '')}/api/auth/devices/${encodeURIComponent(options.deviceId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${options.password}` } }
  )
  if (response.ok || response.status === 401 || response.status === 404) return true
  throw new Error(`Could not revoke paired device (${response.status})`)
}
