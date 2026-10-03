import { getSettingsStore } from '../settings'
import { readFileSync } from 'fs'
import { getSecretStore } from '../secrets'
import { createLogger } from '../../lib/infra/logger'
import {
  normalizePemKey,
  buildApnsPayload,
  buildLiveActivityPayload,
  dispatchApns,
  type ApnsConfig,
  type ApnsEnvironment,
  type ApnsAlertPayload,
  type ApnsSendResult,
  type LiveActivityPushInput,
} from '@ficus/shared/apns'
export {
  normalizePemKey,
  buildApnsHeaders,
  buildApnsJwt,
  buildApnsPayload,
  buildLiveActivityPayload,
} from '@ficus/shared/apns'
export type {
  ApnsConfig,
  ApnsEnvironment,
  ApnsAlertPayload,
  ApnsSendResult,
  LiveActivityEvent,
  LiveActivityPushInput,
} from '@ficus/shared/apns'
const log = createLogger('apns')

/** Ficus Mobile's app bundle id. Advisory only: a self-hosted instance is free to
 * configure another bundle, so a mismatch only warns, never fails. */
export const EXPECTED_APNS_BUNDLE_ID = 'sh.ficus.mobile'

/**
 * Resolve the APNs .p8 private key, in precedence order:
 *   1. APNS_KEY_P8   — the PEM inline (self-hosted store/env value).
 *   2. APNS_KEY_P8_FILE — a path to the PEM on disk. This is how the hosted
 *      platform delivers it: the .p8 lands as a FILE artifact under
 *      /etc/ficus/artifacts/ (a PEM has newlines, which managed.env env values may
 *      not span), and the path arrives as a managed env var. get() resolves that
 *      path from process.env without it ever becoming a store entry.
 *
 * Both are read through the secret store's get(), so a platform-managed instance
 * needs NO store entries and a self-hosted install behaves exactly as before.
 */
function resolveApnsKeyP8(s: ReturnType<typeof getSecretStore>): string | undefined {
  const inline = s.get('APNS_KEY_P8')
  if (inline) return normalizePemKey(inline)

  const p8Path = s.get('APNS_KEY_P8_FILE')
  if (p8Path) {
    try {
      return normalizePemKey(readFileSync(p8Path, 'utf8'))
    } catch (err) {
      log.error(`APNs: failed to read APNS_KEY_P8_FILE at '${p8Path}':`, err)
    }
  }
  return undefined
}

/**
 * APNs is configured only when all credentials resolve. Each value is read via
 * the secret store's get(), which returns platform-managed keys straight from
 * process.env (env-first, no store entry) and self-hosted keys from the store —
 * so both delivery models work through one code path.
 */
export function getApnsConfig(): ApnsConfig | null {
  if (getSettingsStore().getStoredValue('__integration-enabled:apple-push') === 'false') return null
  const s = getSecretStore()
  const keyP8 = resolveApnsKeyP8(s)
  const keyId = s.get('APNS_KEY_ID')
  const teamId = s.get('APNS_TEAM_ID')
  const bundleId = s.get('APNS_BUNDLE_ID')
  if (!keyP8 || !keyId || !teamId || !bundleId) return null
  const environment = s.get('APNS_ENV') === 'sandbox' ? 'sandbox' : 'production'
  if (bundleId !== EXPECTED_APNS_BUNDLE_ID) {
    log.warn(`APNS_BUNDLE_ID is '${bundleId}', expected '${EXPECTED_APNS_BUNDLE_ID}'`)
  }
  if (!keyP8.includes('-----BEGIN PRIVATE KEY-----') || !keyP8.includes('-----END PRIVATE KEY-----')) {
    log.warn('APNS_KEY_P8 does not look like a complete PEM private key')
  }
  return { keyP8, keyId, teamId, bundleId, environment }
}

export function isApnsConfigured(): boolean {
  return getApnsConfig() !== null
}

/**
 * Send a single APNs notification. No-op (logs) when APNs isn't configured,
 * so local deployments don't error.
 */
export async function sendApnsNotification(
  deviceToken: string,
  payload: ApnsAlertPayload,
  deviceEnvironment?: ApnsEnvironment
): Promise<ApnsSendResult> {
  const config = getApnsConfig()
  if (!config) {
    log.info('APNs not configured; skipping notification')
    return { ok: false, status: 0, reason: 'not-configured' }
  }

  return dispatchApns({
    config,
    deviceToken,
    body: JSON.stringify(buildApnsPayload(payload)),
    deviceEnvironment,
    pushType: 'alert',
    collapseId: payload.collapseId,
  })
}

/**
 * Send a Live Activity update/start/end.
 *
 * Separate entry point rather than a `pushType` argument on sendApnsNotification: that function
 * takes an ApnsAlertPayload and runs it through buildApnsPayload, while a Live Activity body is
 * already built by buildLiveActivityPayload. Widening the parameter to a union would put the
 * alert path one bad branch away from sending a malformed notification, so the two callers share
 * the transport (dispatchApns) instead of the signature.
 *
 * NOTE the token here is a LIVE ACTIVITY token from live_activity_tokens, never a device token —
 * they are different tokens and APNs rejects the wrong pairing.
 */
export async function sendApnsLiveActivity(
  liveActivityToken: string,
  payload: LiveActivityPushInput,
  deviceEnvironment?: ApnsEnvironment
): Promise<ApnsSendResult> {
  const config = getApnsConfig()
  if (!config) {
    log.info(`APNs not configured — would send live activity '${payload.event}'`)
    return { ok: false, status: 0, reason: 'not-configured' }
  }
  return dispatchApns({
    config,
    deviceToken: liveActivityToken,
    body: JSON.stringify(buildLiveActivityPayload(payload)),
    deviceEnvironment,
    pushType: 'liveactivity',
  })
}
