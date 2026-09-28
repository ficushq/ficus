import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { csrfProtection } from './csrf'

function app() {
  const a = new Hono()
  a.use('/api/*', csrfProtection)
  a.get('/api/thing', (c) => c.json({ ok: true }))
  a.post('/api/thing', (c) => c.json({ ok: true }))
  return a
}

describe('csrfProtection', () => {
  test('safe method (GET) is always allowed, even cookie-authed', async () => {
    const res = await app().request('/api/thing', { headers: { Cookie: 'ficus_session=t' } })
    expect(res.status).toBe(200)
  })

  test('cookie-authed mutation WITHOUT the CSRF header → 403', async () => {
    const res = await app().request('/api/thing', { method: 'POST', headers: { Cookie: 'ficus_session=t' } })
    expect(res.status).toBe(403)
  })

  test('cookie-authed mutation WITH the CSRF header → allowed', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'ficus_session=t', 'X-Ficus-Csrf': '1' },
    })
    expect(res.status).toBe(200)
  })

  test('the CSRF header is x-ficus-csrf', () => {
    expect(CSRF_HEADER).toBe('x-ficus-csrf')
  })

  // The web app and the server ship together, so the pre-Ficus spelling is not
  // read: a stale cached bundle fails one write, then reloads.
  test('cookie-authed mutation carrying only the pre-Ficus CSRF header spelling → 403', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'ficus_session=t', 'X-Tau-Csrf': '1' }, // D14
    })
    expect(res.status).toBe(403)
  })

  test('bearer-authed mutation is exempt (CLI/agents not cookie-driven)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ficus_agent_x' },
    })
    expect(res.status).toBe(200)
  })

  test('X-Auth-Token mutation is exempt', async () => {
    const res = await app().request('/api/thing', { method: 'POST', headers: { 'X-Auth-Token': 'tok' } })
    expect(res.status).toBe(200)
  })

  test('no cookie and no bearer → exempt (CSRF only guards ambient-cookie auth)', async () => {
    const res = await app().request('/api/thing', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('a bearer header bypasses the cookie path (no CSRF header needed)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'ficus_session=t', Authorization: 'Bearer ficus_agent_x' },
    })
    expect(res.status).toBe(200)
  })

  test('bearer with no Origin header → allowed (CLI/agent HTTP clients never send one)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ficus_agent_x' },
    })
    expect(res.status).toBe(200)
  })

  test('bearer with an allowlisted web Origin → allowed', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ficus_agent_x', Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
  })

  test('bearer with a foreign Origin → 403 (a shell-injected bearer riding an iframe post)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ficus_agent_x', Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Cross-origin request rejected' })
  })

  test('bearer with the opaque `Origin: null` (sandboxed iframe) → 403', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ficus_agent_x', Origin: 'null' },
    })
    expect(res.status).toBe(403)
  })

  test('X-Auth-Token with a foreign Origin → 403', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { 'X-Auth-Token': 'tok', Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  test('X-Auth-Token with an allowlisted Origin → allowed', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { 'X-Auth-Token': 'tok', Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(200)
  })

  test('GET with a foreign Origin and a bearer → allowed (safe method, untouched)', async () => {
    const res = await app().request('/api/thing', {
      method: 'GET',
      headers: { Authorization: 'Bearer ficus_agent_x', Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
  })

  test('cookie-authed mutation WITHOUT the CSRF header, with a foreign Origin → still 403 for the cookie reason', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'ficus_session=t', Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Missing CSRF token' })
  })

  test('cookie-authed mutation WITH the CSRF header, with a foreign Origin → allowed (cookie path unchanged)', async () => {
    const res = await app().request('/api/thing', {
      method: 'POST',
      headers: { Cookie: 'ficus_session=t', 'X-Ficus-Csrf': '1', Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
  })
})
