import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LocalEventTransport,
  INTERNAL_EVENTS_PATH,
  INTERNAL_EVENT_TOKEN_HEADER,
  LOCAL_EVENT_CHANNELS,
  workerEventPort,
  resolveInternalEventToken,
  isConnectionRefusedError,
  CONNECT_REFUSED_RETRY_DELAYS_MS,
} from './local-events'

const TOKEN = 'test-internal-event-token'

/** Collects logger output so best-effort failures can be asserted as "logged". */
function recordingLog() {
  const errors: string[] = []
  const warns: string[] = []
  return {
    errors,
    warns,
    log: {
      info: () => {},
      warn: (...args: unknown[]) => {
        warns.push(args.map(String).join(' '))
      },
      error: (...args: unknown[]) => {
        errors.push(args.map(String).join(' '))
      },
    },
  }
}

/** Bun's shape for "nothing is listening on that port". */
function connectionRefused() {
  return Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  })
}

/** Records the retry waits instead of sleeping so refused-peer tests stay instant. */
function recordingSleep() {
  const waits: number[] = []
  return { waits, sleepFn: async (ms: number) => void waits.push(ms) }
}

describe('local-events transport', () => {
  const open: LocalEventTransport[] = []

  function transport(opts: ConstructorParameters<typeof LocalEventTransport>[0] = {}) {
    const t = new LocalEventTransport(opts)
    open.push(t)
    return t
  }

  afterEach(async () => {
    for (const t of open) await t.close()
    open.length = 0
  })

  /**
   * Two transports in one test process stand in for the two systemd units:
   * `worker` serves the loopback listener, `api` posts to it.
   */
  function pair() {
    const worker = transport({ token: TOKEN })
    const server = worker.serve({ port: 0 })
    const api = transport({ token: TOKEN, peerUrl: `http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}` })
    return { worker, api, server }
  }

  function diagnostic(t: LocalEventTransport, channel: string) {
    return t.getDiagnostics().channels.find((entry) => entry.channel === channel)!
  }

  describe('round trip through the real transport', () => {
    test.each([...LOCAL_EVENT_CHANNELS])('delivers a %s payload to the peer', async (channel) => {
      const { worker, api } = pair()

      const received: string[] = []
      await worker.listen(channel, (payload) => {
        received.push(payload)
      })

      const sent = JSON.stringify({ action: 'stop', agentId: 'agent-1' })
      await api.notify(channel, sent)

      expect(received).toEqual([sent])
    })

    test('dispatches by channel — a listener only sees its own channel', async () => {
      const { worker, api } = pair()

      const control: string[] = []
      const secrets: string[] = []
      await worker.listen('agent_control', (p) => control.push(p))
      await worker.listen('secret_changed', (p) => secrets.push(p))

      await api.notify('agent_control', 'stop')
      await api.notify('secret_changed', 'GITHUB_TOKEN')

      expect(control).toEqual(['stop'])
      expect(secrets).toEqual(['GITHUB_TOKEN'])
    })

    test("delivers to the sender's own listeners too (pg NOTIFY parity)", async () => {
      // Under pg the notifier and listener were separate SESSIONS of the same
      // database, so a process received its OWN notifications. Call sites rely
      // on that (a worker-originated agent_control signal must reach the
      // worker's own handler), so the HTTP transport echoes locally.
      const { api } = pair()

      const received: string[] = []
      await api.listen('agent_control', (p) => received.push(p))

      await api.notify('agent_control', 'stop')
      await new Promise((r) => setTimeout(r, 10))

      expect(received).toEqual(['stop'])
    })

    test('does not deliver after unlisten', async () => {
      const { worker, api } = pair()

      const received: string[] = []
      const unlisten = await worker.listen('agent_control', (p) => received.push(p))
      await unlisten()

      await api.notify('agent_control', 'should_not_arrive')
      await new Promise((r) => setTimeout(r, 10))

      expect(received).toEqual([])
    })

    test('a handler that throws does not break delivery to the others', async () => {
      const { log, errors } = recordingLog()
      const worker = transport({ token: TOKEN, log })
      const server = worker.serve({ port: 0 })
      const api = transport({ token: TOKEN, peerUrl: `http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}` })

      const received: string[] = []
      await worker.listen('agent_control', () => {
        throw new Error('boom')
      })
      await worker.listen('agent_control', (p) => received.push(p))

      await api.notify('agent_control', 'stop')

      expect(received).toEqual(['stop'])
      expect(errors.join('\n')).toContain('boom')
    })
  })

  describe('best-effort delivery', () => {
    test('counts a successful configured-peer forwarding attempt', async () => {
      const { api } = pair()
      await api.notify('app_events', 'sensitive-payload')
      expect(diagnostic(api, 'app_events')).toMatchObject({
        attempts: 1,
        failures: { http_rejection: 0, network: 0, timeout: 0 },
        lastFailure: null,
      })
    })

    test('does not count local-only notifications as forwarding attempts', async () => {
      const solo = transport({ token: TOKEN })
      await solo.notify('app_events', 'sensitive-payload')
      expect(diagnostic(solo, 'app_events').attempts).toBe(0)
    })

    test('records HTTP rejections with status and preserves the latest failure after success', async () => {
      let reject = true
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => new Response(null, { status: reject ? 401 : 204 }),
        log: recordingLog().log,
      })
      await api.notify('agent_control', 'sensitive-payload')
      reject = false
      await api.notify('agent_control', 'sensitive-payload')
      expect(diagnostic(api, 'agent_control')).toMatchObject({
        attempts: 2,
        failures: { http_rejection: 1, network: 0, timeout: 0 },
        lastFailure: { at: expect.any(String), category: 'http_rejection', status: 401 },
      })
    })

    test('records network failures without retaining exception details', async () => {
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://sensitive-peer.invalid/internal/events',
        fetchFn: async () => {
          throw new Error('sensitive-network-error')
        },
        log: recordingLog().log,
      })
      await expect(api.notify('secret_changed', 'sensitive-payload')).resolves.toBeUndefined()
      expect(diagnostic(api, 'secret_changed')).toMatchObject({
        attempts: 1,
        failures: { http_rejection: 0, network: 1, timeout: 0 },
        lastFailure: { category: 'network', status: null },
      })
      expect(JSON.stringify(api.getDiagnostics())).not.toMatch(
        /sensitive-payload|test-internal-event-token|sensitive-peer|sensitive-network-error/
      )
    })

    test('classifies nested timeout-shaped fetch failures as timeouts', async () => {
      const timeout = Object.assign(new Error('sensitive-timeout-error'), {
        cause: Object.assign(new Error('nested'), { name: 'TimeoutError' }),
      })
      const api = transport({
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          throw timeout
        },
        log: recordingLog().log,
      })
      await api.notify('setting_changed', 'sensitive-payload')
      expect(diagnostic(api, 'setting_changed')).toMatchObject({
        failures: { http_rejection: 0, network: 0, timeout: 1 },
        lastFailure: { category: 'timeout', status: null },
      })
    })

    test('bounds unknown channel diagnostics in other without retaining the raw name', async () => {
      const api = transport({
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => new Response(null, { status: 500, statusText: 'sensitive-response-body' }),
        log: recordingLog().log,
      })
      await api.notify('sensitive-unknown-channel', 'sensitive-payload')
      const snapshot = api.getDiagnostics()
      expect(snapshot.channels).toHaveLength(8)
      expect(diagnostic(api, 'other')).toMatchObject({ attempts: 1, failures: { http_rejection: 1 } })
      expect(JSON.stringify(snapshot)).not.toMatch(
        /sensitive-unknown-channel|sensitive-payload|sensitive-response-body|peer\.invalid/
      )
    })

    test('close prevents an in-flight failure from repopulating reset diagnostics', async () => {
      let rejectFetch!: (error: Error) => void
      const fetchResult = new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject
      })
      const api = transport({
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: () => fetchResult,
        log: recordingLog().log,
      })

      const notification = api.notify('app_events', 'payload')
      await api.close()
      rejectFetch(new Error('late network failure'))
      await notification

      expect(diagnostic(api, 'app_events')).toMatchObject({
        attempts: 0,
        failures: { http_rejection: 0, network: 0, timeout: 0 },
        lastFailure: null,
      })
    })

    test('returns diagnostics snapshots by value', async () => {
      const { api } = pair()
      await api.notify('app_events', 'payload')
      const snapshot = api.getDiagnostics()
      snapshot.channels[0]!.attempts = 999
      snapshot.channels[0]!.failures.network = 999
      expect(diagnostic(api, 'app_events')).toMatchObject({ attempts: 1, failures: { network: 0 } })
    })

    test('a send with no peer listening logs and resolves — never throws', async () => {
      const { log, errors, warns } = recordingLog()
      const { waits, sleepFn } = recordingSleep()
      // Port 1 on loopback: nothing is listening, so the POST is refused (for real).
      const api = transport({ token: TOKEN, peerUrl: `http://127.0.0.1:1${INTERNAL_EVENTS_PATH}`, log, sleepFn })

      await expect(api.notify('agent_control', 'stop')).resolves.toBeUndefined()
      expect(waits).toEqual([...CONNECT_REFUSED_RETRY_DELAYS_MS])
      expect(errors).toEqual([])
      expect(warns.length).toBe(1)
      expect(warns[0]).toContain('agent_control')
      expect(warns[0]).toContain('connection refused')
      expect(diagnostic(api, 'agent_control')).toMatchObject({
        attempts: 1,
        failures: { http_rejection: 0, network: 1, timeout: 0 },
      })
    })

    test('a peer that rejects the post logs and resolves — never throws', async () => {
      const { log, errors } = recordingLog()
      const worker = transport({ token: 'a-different-token' })
      const server = worker.serve({ port: 0 })
      const api = transport({
        token: TOKEN,
        peerUrl: `http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`,
        log,
      })

      await expect(api.notify('agent_control', 'stop')).resolves.toBeUndefined()
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('401')
    })

    test('local listeners still fire when the peer is unreachable', async () => {
      const { log } = recordingLog()
      const api = transport({
        token: TOKEN,
        peerUrl: `http://127.0.0.1:1${INTERNAL_EVENTS_PATH}`,
        log,
        sleepFn: async () => {},
      })

      const received: string[] = []
      await api.listen('agent_control', (p) => received.push(p))
      await api.notify('agent_control', 'stop')
      await new Promise((r) => setTimeout(r, 10))

      expect(received).toEqual(['stop'])
    })

    test('a send with no peer configured is a silent local-only no-op', async () => {
      const { log, errors } = recordingLog()
      const solo = transport({ token: TOKEN, log })

      await expect(solo.notify('agent_control', 'stop')).resolves.toBeUndefined()
      expect(errors).toEqual([])
    })
  })

  describe('peer start-up race', () => {
    test('retries a refused connection and delivers once the peer listens', async () => {
      const { log, errors, warns } = recordingLog()
      const { waits, sleepFn } = recordingSleep()
      let calls = 0
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          calls += 1
          if (calls === 1) throw connectionRefused()
          return new Response(null, { status: 204 })
        },
        log,
        sleepFn,
      })

      await api.notify('app_events', 'payload')

      expect(calls).toBe(2)
      expect(waits).toEqual([CONNECT_REFUSED_RETRY_DELAYS_MS[0]!])
      expect(errors).toEqual([])
      expect(warns).toEqual([])
      expect(diagnostic(api, 'app_events')).toMatchObject({
        attempts: 1,
        failures: { http_rejection: 0, network: 0, timeout: 0 },
        lastFailure: null,
      })
    })

    test('gives up after the bounded schedule, logging once per outage and a summary on recovery', async () => {
      const { log, errors, warns } = recordingLog()
      let refuse = true
      let calls = 0
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          calls += 1
          if (refuse) throw connectionRefused()
          return new Response(null, { status: 204 })
        },
        log,
        sleepFn: async () => {},
      })

      await api.notify('app_events', 'one')
      await api.notify('agent_control', 'two')
      expect(calls).toBe(2 * (CONNECT_REFUSED_RETRY_DELAYS_MS.length + 1))
      expect(errors).toEqual([])
      // One line for the outage, not one per dropped event.
      expect(warns.length).toBe(1)
      expect(warns[0]).toContain('not listening')
      expect(warns[0]).toContain('app_events')
      expect(diagnostic(api, 'app_events')).toMatchObject({ attempts: 1, failures: { network: 1 } })
      expect(diagnostic(api, 'agent_control')).toMatchObject({ attempts: 1, failures: { network: 1 } })

      refuse = false
      await api.notify('app_events', 'three')
      expect(warns.length).toBe(2)
      expect(warns[1]).toContain('reachable again')
      expect(warns[1]).toContain('2 events dropped')

      // A later outage opens a fresh window and logs again.
      refuse = true
      await api.notify('app_events', 'four')
      expect(warns.length).toBe(3)
      expect(warns[2]).toContain('not listening')
    })

    test.each([
      ['a timeout', () => Object.assign(new Error('slow'), { name: 'TimeoutError' })],
      ['another network error', () => Object.assign(new Error('reset'), { code: 'ECONNRESET' })],
    ])('does not retry %s', async (_label, makeError) => {
      const { log, errors, warns } = recordingLog()
      const { waits, sleepFn } = recordingSleep()
      let calls = 0
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          calls += 1
          throw makeError()
        },
        log,
        sleepFn,
      })

      await api.notify('agent_control', 'stop')
      expect(calls).toBe(1)
      expect(waits).toEqual([])
      expect(errors.length).toBe(1)
      expect(warns).toEqual([])
    })

    test('does not retry an HTTP rejection', async () => {
      const { log, errors } = recordingLog()
      const { waits, sleepFn } = recordingSleep()
      let calls = 0
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          calls += 1
          return new Response(null, { status: 401 })
        },
        log,
        sleepFn,
      })

      await api.notify('agent_control', 'stop')
      expect(calls).toBe(1)
      expect(waits).toEqual([])
      expect(errors.length).toBe(1)
    })

    test('a non-refused failure closes an open outage window', async () => {
      const { log, warns } = recordingLog()
      let mode: 'refuse' | 'timeout' = 'refuse'
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          if (mode === 'refuse') throw connectionRefused()
          throw Object.assign(new Error('slow'), { name: 'TimeoutError' })
        },
        log,
        sleepFn: async () => {},
      })

      await api.notify('app_events', 'one')
      mode = 'timeout'
      await api.notify('app_events', 'two')
      expect(warns.length).toBe(2)
      expect(warns[1]).toContain('reachable again')
      expect(warns[1]).toContain('1 event dropped')
    })

    test('close stops a retry loop that is waiting to try again', async () => {
      const { log, warns } = recordingLog()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let calls = 0
      const api = transport({
        token: TOKEN,
        peerUrl: 'http://peer.invalid/internal/events',
        fetchFn: async () => {
          calls += 1
          throw connectionRefused()
        },
        log,
        sleepFn: () => gate,
      })

      const notification = api.notify('app_events', 'payload')
      await Promise.resolve()
      await api.close()
      release()
      await notification

      expect(calls).toBe(1)
      expect(warns).toEqual([])
      expect(diagnostic(api, 'app_events')).toMatchObject({
        attempts: 0,
        failures: { http_rejection: 0, network: 0, timeout: 0 },
      })
    })
  })

  describe('isConnectionRefusedError', () => {
    test('matches Bun and Node refused codes, including nested causes', () => {
      expect(isConnectionRefusedError(connectionRefused())).toBe(true)
      expect(isConnectionRefusedError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
      expect(isConnectionRefusedError(Object.assign(new Error('outer'), { cause: connectionRefused() }))).toBe(true)
    })

    test('does not match other errors', () => {
      expect(isConnectionRefusedError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false)
      expect(isConnectionRefusedError(new Error('plain'))).toBe(false)
      expect(isConnectionRefusedError(null)).toBe(false)
    })
  })

  describe('authentication', () => {
    async function post(url: string, headers: Record<string, string>) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ channel: 'agent_control', payload: 'stop' }),
      })
    }

    test('rejects a missing token', async () => {
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })
      const received: string[] = []
      await worker.listen('agent_control', (p) => received.push(p))

      const res = await post(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {})
      expect(res.status).toBe(401)
      expect(received).toEqual([])
    })

    test('rejects a wrong token of the same length', async () => {
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })
      const wrong = 'x'.repeat(TOKEN.length)

      const res = await post(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {
        'x-ficus-internal-token': wrong,
      })
      expect(res.status).toBe(401)
    })

    test('rejects a wrong token of a different length without throwing', async () => {
      // crypto.timingSafeEqual THROWS on unequal buffer lengths, which would
      // turn a bad token into a 500 (and leak the length). Digesting first
      // keeps both operands the same size.
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })

      const res = await post(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {
        'x-ficus-internal-token': 'short',
      })
      expect(res.status).toBe(401)
    })

    test('accepts the correct token', async () => {
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })
      const received: string[] = []
      await worker.listen('agent_control', (p) => received.push(p))

      const res = await post(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {
        'x-ficus-internal-token': TOKEN,
      })
      expect(res.status).toBe(204)
      expect(received).toEqual(['stop'])
    })

    test('reads the token from x-ficus-internal-token only', async () => {
      expect(INTERNAL_EVENT_TOKEN_HEADER).toBe('x-ficus-internal-token')
      // The api and the worker restart together from one release, so the
      // pre-Ficus header name is not read.
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })
      const received: string[] = []
      await worker.listen('agent_control', (p) => received.push(p))

      const res = await post(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {
        'x-old-internal-token': TOKEN, // D15
      })
      expect(res.status).toBe(401)
      expect(received).toEqual([])
    })

    test('rejects every request when no token is configured (fail closed)', async () => {
      const worker = transport({ token: null })
      const server = worker.serve({ port: 0 })

      const res = await post(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {})
      expect(res.status).toBe(401)
    })

    test('compares the token with a timing-safe comparison', () => {
      // Behavioural tests cannot observe timing safety, so pin the mechanism.
      const src = readFileSync(join(import.meta.dir, 'local-events.ts'), 'utf8')
      expect(src).toContain('timingSafeEqual')
      expect(src).not.toMatch(/token\s*===\s*/)
    })
  })

  describe('server binding', () => {
    test('binds loopback by default', async () => {
      // Split-namespace deployments may explicitly override this to a private,
      // authenticated interface; the safe default remains loopback.
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })
      expect(server.hostname).toBe('127.0.0.1')
    })

    test('rejects unknown paths and methods', async () => {
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })
      const base = `http://127.0.0.1:${server.port}`

      expect((await fetch(`${base}/nope`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${base}${INTERNAL_EVENTS_PATH}`)).status).toBe(404)
    })

    test('rejects a malformed body with 400', async () => {
      const worker = transport({ token: TOKEN })
      const server = worker.serve({ port: 0 })

      const res = await fetch(`http://127.0.0.1:${server.port}${INTERNAL_EVENTS_PATH}`, {
        method: 'POST',
        headers: { 'x-ficus-internal-token': TOKEN },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  describe('worker event port', () => {
    const original = process.env.FICUS_WORKER_EVENT_PORT

    afterEach(() => {
      if (original === undefined) delete process.env.FICUS_WORKER_EVENT_PORT
      else process.env.FICUS_WORKER_EVENT_PORT = original
    })

    test('defaults when unset and honours FICUS_WORKER_EVENT_PORT', () => {
      delete process.env.FICUS_WORKER_EVENT_PORT
      expect(workerEventPort()).toBe(3003)
      process.env.FICUS_WORKER_EVENT_PORT = '4111'
      expect(workerEventPort()).toBe(4111)
    })

    test('falls back to the default for a non-numeric value', () => {
      process.env.FICUS_WORKER_EVENT_PORT = 'nope'
      expect(workerEventPort()).toBe(3003)
    })
  })
})

describe('internal event token resolution', () => {
  test('an explicit FICUS_INTERNAL_EVENT_TOKEN wins', () => {
    const { token, source } = resolveInternalEventToken({
      FICUS_INTERNAL_EVENT_TOKEN: 'explicit',
      FICUS_ENCRYPTION_KEY: 'k',
    })
    expect(source).toBe('explicit')
    expect(token).toBe('explicit')
  })

  test('derives a STABLE token from FICUS_ENCRYPTION_KEY so both units agree without new config', () => {
    // This is the property that matters: two processes reading the same
    // environment must independently arrive at the same token, or every
    // cross-process post 401s and agent stop/abort silently stops working on
    // any instance predating FICUS_INTERNAL_EVENT_TOKEN.
    const env = { FICUS_ENCRYPTION_KEY: 'shared-master-key' }
    const a = resolveInternalEventToken(env)
    const b = resolveInternalEventToken({ ...env })
    expect(a.source).toBe('derived')
    expect(a.token).toBe(b.token)
  })

  test('the derived token does not leak the encryption key, and differs per key', () => {
    const key = 'shared-master-key'
    const { token } = resolveInternalEventToken({ FICUS_ENCRYPTION_KEY: key })
    expect(token).not.toContain(key)
    expect(token).not.toBe(resolveInternalEventToken({ FICUS_ENCRYPTION_KEY: 'other-key' }).token)
  })

  test('falls back to a random token that fails closed when neither is set', () => {
    const a = resolveInternalEventToken({})
    const b = resolveInternalEventToken({})
    expect(a.source).toBe('random')
    // Distinct per resolution => the peer can never match it => posts 401.
    expect(a.token).not.toBe(b.token)
  })
})
