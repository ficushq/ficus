import { describe, test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setSessionCookie, clearSessionCookie, extractSessionToken, SESSION_COOKIE_NAME } from './session-cookie'

const ENV_KEYS = ['FICUS_WEB_ORIGIN', 'WEBAUTHN_ORIGIN', 'APP_URL'] as const
const orig: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (orig[k] === undefined) delete process.env[k]
    else process.env[k] = orig[k]
  }
})

function app() {
  const a = new Hono()
  a.get('/set', (c) => {
    setSessionCookie(c, 'tok123')
    return c.json({ ok: true })
  })
  a.get('/clear', (c) => {
    clearSessionCookie(c)
    return c.json({ ok: true })
  })
  a.get('/read', (c) => c.json({ token: extractSessionToken(c) ?? null }))
  return a
}

async function setCookieHeader(url: string): Promise<string> {
  const res = await app().request(url)
  return res.headers.get('set-cookie') ?? ''
}

describe('session cookie', () => {
  test('the session cookie is ficus_session', () => {
    expect(SESSION_COOKIE_NAME).toBe('ficus_session')
  })

  test('extractSessionToken ignores an old_session cookie', async () => {
    const res = await app().request('http://localhost/read', { headers: { Cookie: 'old_session=old' } })
    expect((await res.json()).token).toBeNull()
  })

  test('the renamed cookie keeps HttpOnly, Secure and SameSite on an https deployment', async () => {
    process.env.FICUS_WEB_ORIGIN = 'https://demo.example.com'
    const sc = await setCookieHeader('https://demo.example.com/set')
    expect(sc.startsWith('ficus_session=tok123;')).toBe(true)
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Secure')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).toContain('Path=/')
    expect(sc).toContain(`Max-Age=${30 * 24 * 60 * 60}`)
  })

  test('sets an HttpOnly, Path=/ cookie carrying the token', async () => {
    const sc = await setCookieHeader('http://localhost/set')
    expect(sc).toContain(`${SESSION_COOKIE_NAME}=tok123`)
    expect(sc.toLowerCase()).toContain('httponly')
    expect(sc.toLowerCase()).toContain('path=/')
  })

  test('same-origin localhost (http) → SameSite=Lax, not Secure', async () => {
    process.env.FICUS_WEB_ORIGIN = 'http://localhost:5173'
    const sc = await setCookieHeader('http://localhost/set')
    expect(sc).toContain('SameSite=Lax')
    expect(sc.toLowerCase()).not.toContain('secure')
  })

  test('cross-subdomain, same site (noah / api-noah .ficus.sh) → SameSite=Lax; Secure', async () => {
    process.env.FICUS_WEB_ORIGIN = 'https://demo.ficus.sh'
    const sc = await setCookieHeader('https://api-demo.ficus.sh/set')
    expect(sc).toContain('SameSite=Lax')
    expect(sc.toLowerCase()).toContain('secure')
    // Separate registrable app domains are the boundary; host-only scope is defence in depth.
    expect(sc).not.toMatch(/;\s*Domain=/i)
  })

  test('genuinely cross-site → SameSite=None; Secure', async () => {
    process.env.FICUS_WEB_ORIGIN = 'https://app.example.com'
    const sc = await setCookieHeader('https://api.different.io/set')
    expect(sc).toContain('SameSite=None')
    expect(sc.toLowerCase()).toContain('secure')
    expect(sc).not.toMatch(/;\s*Domain=/i)
  })

  test.each([
    ['same-origin', 'http://localhost:5173', 'http://localhost/clear'],
    ['same-site cross-subdomain', 'https://demo.ficus.sh', 'https://api-demo.ficus.sh/clear'],
    ['cross-site', 'https://app.example.com', 'https://api.different.io/clear'],
  ])('clear re-issues a host-only cookie with Max-Age=0 for %s requests', async (_case, webOrigin, url) => {
    process.env.FICUS_WEB_ORIGIN = webOrigin
    const sc = await setCookieHeader(url)
    expect(sc).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(sc).toContain('Max-Age=0')
    expect(sc).not.toMatch(/;\s*Domain=/i)
  })

  test('extractSessionToken: bearer header wins over the cookie', async () => {
    const res = await app().request('http://localhost/read', {
      headers: { Authorization: 'Bearer hdr', Cookie: `${SESSION_COOKIE_NAME}=ck` },
    })
    expect((await res.json()).token).toBe('hdr')
  })

  test('extractSessionToken: falls back to the cookie when no header', async () => {
    const res = await app().request('http://localhost/read', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=ck` },
    })
    expect((await res.json()).token).toBe('ck')
  })
})
