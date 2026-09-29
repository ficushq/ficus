import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import http2 from 'http2'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateKeyPairSync, verify } from 'crypto'
import {
  EXPECTED_APNS_BUNDLE_ID,
  buildApnsHeaders,
  buildApnsJwt,
  buildApnsPayload,
  buildLiveActivityPayload,
  getApnsConfig,
  isApnsConfigured,
  sendApnsLiveActivity,
  sendApnsNotification,
} from './apns'
import { getSecretStore, isManagedSecretKey, resetSecretStore } from '../secrets'

const APNS_ENV_KEYS = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_ENV'] as const

function installApnsEnv(environment: 'production' | 'sandbox' = 'production') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  process.env.APNS_KEY_P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  process.env.APNS_KEY_ID = 'KID123'
  process.env.APNS_TEAM_ID = 'TEAM456'
  process.env.APNS_BUNDLE_ID = 'sh.ficus.mobile'
  process.env.APNS_ENV = environment
  resetSecretStore()
}

interface ApnsHttp2Call {
  authority: string
  headers: Record<string, unknown>
  body: string
}

/**
 * Fake node:http2 client for sendApnsNotification. Also guards against fetch:
 * APNs requires HTTP/2 and Bun's fetch is HTTP/1.1-only (its responses come
 * back as Malformed_HTTP_Response), so any fetch call here is a regression.
 */
function mockApnsHttp2(respond: () => { status: number; body?: string } | Error) {
  const originalFetch = globalThis.fetch
  const fetchGuard = mock(() => {
    throw new Error('sendApnsNotification must use node:http2, not fetch (APNs requires HTTP/2)')
  })
  globalThis.fetch = fetchGuard as unknown as typeof fetch

  const calls: ApnsHttp2Call[] = []
  const connectSpy = spyOn(http2, 'connect').mockImplementation(((authority: string | URL) => {
    const session = new EventEmitter() as EventEmitter & {
      request: (headers: Record<string, unknown>) => unknown
      close: () => void
    }
    session.close = () => {}
    session.request = (headers: Record<string, unknown>) => {
      const stream = new EventEmitter() as EventEmitter & {
        setEncoding: (enc: string) => void
        end: (body: string) => void
      }
      stream.setEncoding = () => {}
      stream.end = (body: string) => {
        calls.push({ authority: String(authority), headers, body })
        queueMicrotask(() => {
          const r = respond()
          if (r instanceof Error) {
            stream.emit('error', r)
            return
          }
          stream.emit('response', { ':status': r.status })
          if (r.body) stream.emit('data', r.body)
          stream.emit('end')
        })
      }
      return stream
    }
    return session
  }) as never)

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
      connectSpy.mockRestore()
    },
  }
}

describe('APNs', () => {
  beforeEach(() => {
    for (const key of APNS_ENV_KEYS) delete process.env[key]
    resetSecretStore()
  })

  afterEach(() => {
    for (const key of APNS_ENV_KEYS) delete process.env[key]
    resetSecretStore()
  })

  it('uses newly configured signing credentials immediately instead of the cached JWT', async () => {
    installApnsEnv()
    const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))
    try {
      await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })
      process.env.APNS_KEY_ID = 'NEWKEY1234'
      await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })
      const authorization = String(calls[1].headers.authorization).replace('bearer ', '')
      expect(JSON.parse(Buffer.from(authorization.split('.')[0], 'base64url').toString()).kid).toBe('NEWKEY1234')
      expect(calls[1].headers.authorization).not.toBe(calls[0].headers.authorization)
    } finally {
      restore()
    }
  })

  it('buildApnsJwt produces a verifiable ES256 token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

    const jwt = buildApnsJwt({ keyP8, keyId: 'KID123', teamId: 'TEAM456' }, 1_700_000_000)
    const [h, payload, sig] = jwt.split('.')

    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KID123' })
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: 1_700_000_000 })

    const valid = verify(
      'sha256',
      Buffer.from(`${h}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url')
    )
    expect(valid).toBe(true)
  })

  it('buildApnsJwt signs with a PEM whose newlines were flattened to spaces (observed paste corruption)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const flattened = keyP8.trim().replace(/\n/g, ' ')

    const jwt = buildApnsJwt({ keyP8: flattened, keyId: 'KID123', teamId: 'TEAM456' }, 1_700_000_000)
    const [h, payload, sig] = jwt.split('.')
    const valid = verify(
      'sha256',
      Buffer.from(`${h}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url')
    )
    expect(valid).toBe(true)
  })

  it('buildApnsJwt signs with a PEM pasted as literal backslash-n or with no separators at all', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const variants = [keyP8.trim().replace(/\n/g, '\\n'), keyP8.trim().replace(/\n/g, ''), `  ${keyP8.trim()}  `]

    for (const variant of variants) {
      const jwt = buildApnsJwt({ keyP8: variant, keyId: 'KID123', teamId: 'TEAM456' }, 1_700_000_000)
      const [h, payload, sig] = jwt.split('.')
      const valid = verify(
        'sha256',
        Buffer.from(`${h}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(sig, 'base64url')
      )
      expect(valid).toBe(true)
    }
  })

  it('buildApnsPayload wraps the aps envelope + custom data', () => {
    expect(buildApnsPayload({ title: 'T', body: 'B', data: { url: '/squads/x' }, badge: 3 })).toEqual({
      aps: { alert: { title: 'T', body: 'B' }, sound: 'default', badge: 3 },
      url: '/squads/x',
    })
  })

  it('buildApnsPayload carries subtitle, thread grouping, and interruption level; passive pushes are silent', () => {
    expect(
      buildApnsPayload({
        title: 'Completed: #197 · Validate deletion',
        body: 'Next steps: ship it',
        subtitle: 'Platform',
        threadId: 'squad:def',
        interruptionLevel: 'passive',
      })
    ).toEqual({
      aps: {
        alert: { title: 'Completed: #197 · Validate deletion', subtitle: 'Platform', body: 'Next steps: ship it' },
        'thread-id': 'squad:def',
        'interruption-level': 'passive',
      },
    })
    expect(buildApnsPayload({ title: 'T', body: 'B', interruptionLevel: 'time-sensitive' })).toEqual({
      aps: { alert: { title: 'T', body: 'B' }, sound: 'default', 'interruption-level': 'time-sensitive' },
    })
  })

  it('buildApnsHeaders sets the collapse id only when given', () => {
    expect(buildApnsHeaders({ jwt: 'j', topic: 'com.tau.app', pushType: 'alert', collapseId: 'ws:abc' })).toEqual({
      authorization: 'bearer j',
      'apns-topic': 'com.tau.app',
      'apns-push-type': 'alert',
      'apns-collapse-id': 'ws:abc',
      'content-type': 'application/json',
    })
    expect(buildApnsHeaders({ jwt: 'j', topic: 'com.tau.app', pushType: 'alert' })).not.toHaveProperty(
      'apns-collapse-id'
    )
  })

  it('is unconfigured (and a no-op send) when APNs secrets are absent', async () => {
    // Default test secret store has no APNS_* keys.
    expect(getApnsConfig()).toBeNull()
    expect(isApnsConfigured()).toBe(false)
    expect(await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })).toEqual({
      ok: false,
      status: 0,
      reason: 'not-configured',
    })
  })

  it('resolves a platform-managed config: .p8 from APNS_KEY_P8_FILE + identifiers from env, with no store entries', () => {
    // Simulate a hosted-platform instance: the .p8 is delivered as a FILE
    // artifact (a PEM has newlines, which managed.env env values may not span),
    // and its path + the identifiers arrive as managed env vars.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const dir = mkdtempSync(join(tmpdir(), 'apns-p8-'))
    const p8Path = join(dir, 'apns.p8')
    writeFileSync(p8Path, pem)

    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_P8_FILE,APNS_KEY_ID,APNS_TEAM_ID,APNS_BUNDLE_ID,APNS_ENV'
    process.env.APNS_KEY_P8_FILE = p8Path
    process.env.APNS_KEY_ID = 'KID123'
    process.env.APNS_TEAM_ID = 'TEAM456'
    process.env.APNS_BUNDLE_ID = 'sh.ficus.mobile'
    process.env.APNS_ENV = 'sandbox'
    resetSecretStore()

    try {
      const config = getApnsConfig()
      expect(config).not.toBeNull()
      expect(config?.keyP8).toContain('-----BEGIN PRIVATE KEY-----')
      expect(config?.keyId).toBe('KID123')
      expect(config?.teamId).toBe('TEAM456')
      expect(config?.bundleId).toBe('sh.ficus.mobile')
      expect(config?.environment).toBe('sandbox')
      expect(isApnsConfigured()).toBe(true)
    } finally {
      delete process.env.FICUS_MANAGED
      delete process.env.FICUS_MANAGED_SECRET_KEYS
      delete process.env.APNS_KEY_P8_FILE
      delete process.env.APNS_KEY_ID
      delete process.env.APNS_TEAM_ID
      delete process.env.APNS_BUNDLE_ID
      delete process.env.APNS_ENV
      rmSync(dir, { recursive: true, force: true })
      resetSecretStore()
    }
  })

  it('treats the inline APNS_KEY_P8 as managed when the FILE variant is, and still resolves the key from the file', () => {
    // The inline key SUPERSEDES the file at resolve time, so on a managed
    // instance it must itself be managed — a tenant-set value would otherwise
    // silently replace the platform's .p8. Managed keys are read env-first and
    // there is no APNS_KEY_P8 env value, so resolution falls through to the
    // file and push keeps working.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const dir = mkdtempSync(join(tmpdir(), 'apns-p8-'))
    const p8Path = join(dir, 'apns.p8')
    writeFileSync(p8Path, pem)

    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_MANAGED_SECRET_KEYS = 'APNS_KEY_P8_FILE,APNS_KEY_ID,APNS_TEAM_ID,APNS_BUNDLE_ID,APNS_ENV'
    process.env.APNS_KEY_P8_FILE = p8Path
    process.env.APNS_KEY_ID = 'KID123'
    process.env.APNS_TEAM_ID = 'TEAM456'
    process.env.APNS_BUNDLE_ID = 'sh.ficus.mobile'
    resetSecretStore()

    try {
      expect(isManagedSecretKey('APNS_KEY_P8')).toBe(true)
      expect(getSecretStore().get('APNS_KEY_P8')).toBeUndefined()
      expect(getApnsConfig()?.keyP8).toBe(pem)
    } finally {
      delete process.env.FICUS_MANAGED
      delete process.env.FICUS_MANAGED_SECRET_KEYS
      delete process.env.APNS_KEY_P8_FILE
      rmSync(dir, { recursive: true, force: true })
      resetSecretStore()
    }
  })

  it('is unconfigured when APNS_KEY_P8_FILE points at a missing file (no inline key)', () => {
    process.env.APNS_KEY_P8_FILE = join(tmpdir(), 'does-not-exist-apns.p8')
    process.env.APNS_KEY_ID = 'KID123'
    process.env.APNS_TEAM_ID = 'TEAM456'
    process.env.APNS_BUNDLE_ID = 'sh.ficus.mobile'
    resetSecretStore()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(getApnsConfig()).toBeNull()
    } finally {
      errSpy.mockRestore()
      delete process.env.APNS_KEY_P8_FILE
      delete process.env.APNS_KEY_ID
      delete process.env.APNS_TEAM_ID
      delete process.env.APNS_BUNDLE_ID
      resetSecretStore()
    }
  })

  it('normalizes escaped newlines in APNS_KEY_P8 config', () => {
    installApnsEnv('production')
    process.env.APNS_KEY_P8 = process.env.APNS_KEY_P8!.replace(/\n/g, '\\n')
    resetSecretStore()

    const config = getApnsConfig()

    expect(config?.keyP8).toContain('\n')
    expect(config?.keyP8).not.toContain('\\n')
    expect(config?.keyP8).toContain('-----BEGIN PRIVATE KEY-----')
  })

  it('warns when APNs config does not match the mobile bundle id or PEM shape', () => {
    installApnsEnv('production')
    process.env.APNS_BUNDLE_ID = 'example.wrong.bundle'
    process.env.APNS_KEY_P8 = 'not-a-pem-key'
    resetSecretStore()
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      getApnsConfig()

      const warnings = warnSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')
      expect(warnings).toContain("APNS_BUNDLE_ID is 'example.wrong.bundle', expected 'sh.ficus.mobile'")
      expect(warnings).toContain('APNS_KEY_P8 does not look like a complete PEM private key')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warns on the retired mobile bundle id but not on the current one — advisory only, never an error', () => {
    // installApnsEnv already configures APNS_BUNDLE_ID=sh.ficus.mobile.
    installApnsEnv('production')
    resetSecretStore()
    const okWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(getApnsConfig()).not.toBeNull()
      expect(okWarnSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')).not.toContain('APNS_BUNDLE_ID')
    } finally {
      okWarnSpy.mockRestore()
    }

    process.env.APNS_BUNDLE_ID = 'ai.hiretau.mobile'
    resetSecretStore()
    const staleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A self-hoster on the old bundle keeps working; the mismatch only warns.
      expect(getApnsConfig()).not.toBeNull()
      const warnings = staleWarnSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')
      expect(warnings).toContain(`APNS_BUNDLE_ID is 'ai.hiretau.mobile', expected '${EXPECTED_APNS_BUNDLE_ID}'`)
    } finally {
      staleWarnSpy.mockRestore()
    }
  })

  it('sends APNs notifications over node:http2 with the provider JWT and topic headers', async () => {
    installApnsEnv('production')
    const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))

    try {
      const result = await sendApnsNotification('devicetoken', {
        title: 'T',
        body: 'B',
        data: { url: '/squads/1' },
        badge: 2,
      })

      expect(result).toEqual({ ok: true, status: 200 })
      expect(calls).toHaveLength(1)
      expect(calls[0].authority).toBe('https://api.push.apple.com')
      expect(calls[0].headers).toMatchObject({
        ':method': 'POST',
        ':path': '/3/device/devicetoken',
        authorization: expect.stringContaining('bearer '),
        'apns-topic': 'sh.ficus.mobile',
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      })
      expect(JSON.parse(calls[0].body)).toEqual({
        aps: { alert: { title: 'T', body: 'B' }, sound: 'default', badge: 2 },
        url: '/squads/1',
      })
    } finally {
      restore()
    }
  })

  it('uses the explicit device environment instead of the global APNS_ENV when selecting the APNs host', async () => {
    installApnsEnv('production')
    const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))

    try {
      const result = await sendApnsNotification('devicetoken', { title: 'T', body: 'B' }, 'sandbox')

      expect(result).toEqual({ ok: true, status: 200 })
      expect(calls[0].authority).toBe('https://api.sandbox.push.apple.com')
    } finally {
      restore()
    }
  })

  it('falls back to the global APNS_ENV when no device environment is supplied', async () => {
    installApnsEnv('sandbox')
    const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))

    try {
      const result = await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })

      expect(result).toEqual({ ok: true, status: 200 })
      expect(calls[0].authority).toBe('https://api.sandbox.push.apple.com')
    } finally {
      restore()
    }
  })

  it('returns the APNs rejection reason from a failed response', async () => {
    installApnsEnv('production')
    const { restore } = mockApnsHttp2(() => ({ status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }))

    try {
      const result = await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })

      expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' })
    } finally {
      restore()
    }
  })

  it('returns an error result when the http2 stream errors', async () => {
    installApnsEnv('production')
    const { restore } = mockApnsHttp2(() => new Error('network down'))

    try {
      const result = await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })

      expect(result).toEqual({ ok: false, status: 0, reason: 'Error: network down' })
    } finally {
      restore()
    }
  })

  // ── Live Activity push path ────────────────────────────────────────────────
  describe('live activity pushes', () => {
    const contentState = { activeCount: 2, needsYouCount: 1, top: [] }

    it('uses the .push-type.liveactivity topic and push type — the plain bundle id is rejected by APNs', async () => {
      installApnsEnv('production')
      const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))
      try {
        const result = await sendApnsLiveActivity('latoken', { event: 'update', contentState, nowSec: 1_700_000_000 })
        expect(result).toEqual({ ok: true, status: 200 })
        expect(calls[0].headers).toMatchObject({
          ':path': '/3/device/latoken',
          'apns-topic': 'sh.ficus.mobile.push-type.liveactivity',
          'apns-push-type': 'liveactivity',
        })
      } finally {
        restore()
      }
    })

    it('honours the per-token environment when choosing the APNs host', async () => {
      installApnsEnv('production')
      const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))
      try {
        await sendApnsLiveActivity('latoken', { event: 'update', contentState }, 'sandbox')
        expect(calls[0].authority).toBe('https://api.sandbox.push.apple.com')
      } finally {
        restore()
      }
    })

    // Adding an alert/sound/badge key would post a user-visible notification on TOP of the
    // silent activity update — the card is supposed to change, not buzz.
    it('never carries alert, sound or badge keys', async () => {
      installApnsEnv('production')
      const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))
      try {
        await sendApnsLiveActivity('latoken', { event: 'update', contentState })
        const aps = JSON.parse(calls[0].body).aps
        expect(aps.alert).toBeUndefined()
        expect(aps.sound).toBeUndefined()
        expect(aps.badge).toBeUndefined()
      } finally {
        restore()
      }
    })

    it('keeps the alert path byte-identical — same topic, push type and body as before', async () => {
      installApnsEnv('production')
      const { calls, restore } = mockApnsHttp2(() => ({ status: 200 }))
      try {
        await sendApnsNotification('devicetoken', { title: 'T', body: 'B' })
        expect(calls[0].headers).toMatchObject({
          'apns-topic': 'sh.ficus.mobile',
          'apns-push-type': 'alert',
        })
        expect(JSON.parse(calls[0].body)).toEqual({
          aps: { alert: { title: 'T', body: 'B' }, sound: 'default' },
        })
      } finally {
        restore()
      }
    })
  })

  describe('buildLiveActivityPayload', () => {
    const contentState = { activeCount: 1, needsYouCount: 0, top: [] }

    it('always stamps a timestamp — APNs uses it to discard out-of-order updates', () => {
      const aps = buildLiveActivityPayload({ event: 'update', contentState, nowSec: 1_700_000_000 }).aps as Record<
        string,
        unknown
      >
      expect(aps.timestamp).toBe(1_700_000_000)
      expect(aps.event).toBe('update')
      expect(aps['content-state']).toEqual(contentState)
    })

    it('includes attributes ONLY on a start event (APNs rejects them on an update)', () => {
      const start = buildLiveActivityPayload({
        event: 'start',
        contentState,
        attributesType: 'TauWorkAttributes',
        attributes: { origin: 'https://demo.ficus.sh' },
      }).aps as Record<string, unknown>
      expect(start['attributes-type']).toBe('TauWorkAttributes')
      expect(start.attributes).toEqual({ origin: 'https://demo.ficus.sh' })

      const update = buildLiveActivityPayload({
        event: 'update',
        contentState,
        attributesType: 'TauWorkAttributes',
        attributes: { origin: 'https://demo.ficus.sh' },
      }).aps as Record<string, unknown>
      expect(update['attributes-type']).toBeUndefined()
      expect(update.attributes).toBeUndefined()
    })

    it('omits optional keys rather than emitting undefined ones', () => {
      const aps = buildLiveActivityPayload({ event: 'update', contentState }).aps as Record<string, unknown>
      expect(Object.keys(aps).sort()).toEqual(['content-state', 'event', 'timestamp'])
    })

    it('carries stale-date, and dismissal-date only when ending', () => {
      const stale = buildLiveActivityPayload({ event: 'update', contentState, staleDate: 42 }).aps as Record<
        string,
        unknown
      >
      expect(stale['stale-date']).toBe(42)

      const ended = buildLiveActivityPayload({ event: 'end', contentState, dismissalDate: 99 }).aps as Record<
        string,
        unknown
      >
      expect(ended['dismissal-date']).toBe(99)
      const notEnded = buildLiveActivityPayload({ event: 'update', contentState, dismissalDate: 99 }).aps as Record<
        string,
        unknown
      >
      expect(notEnded['dismissal-date']).toBeUndefined()
    })
  })
})
