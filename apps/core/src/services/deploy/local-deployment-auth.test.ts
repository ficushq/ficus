import { describe, expect, it } from 'bun:test'
import {
  isValidLocalDeploymentRouteParameter,
  localDeploymentCookieHeader,
  localDeploymentCookieName,
  localDeploymentProxyPath,
  presentedLocalDeploymentToken,
  readCookie,
} from './local-deployment-auth'

const ID = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

describe('local deployment browser auth', () => {
  it('accepts only lowercase canonical UUID prefixes at the database boundary', () => {
    for (const valid of ['1', '11111111', '11111111-', '11111111-2222', ID]) {
      expect(isValidLocalDeploymentRouteParameter(valid)).toBe(true)
    }
    for (const invalid of ['', '_', '%', 'ABC', '111111112222', '11111111-22222', '-1111111', '-'.repeat(36)]) {
      expect(isValidLocalDeploymentRouteParameter(invalid)).toBe(false)
    }
  })

  it('names the per-deployment cookie ficus_app_<id>', () => {
    expect(localDeploymentCookieName(ID)).toBe(`ficus_app_${ID}`)
  })

  it('never reads the pre-rename tau_app_<id> cookie', () => {
    const request = new Request(`https://t.example/api/app/${ID}/assets/index-abc.js`, {
      headers: { cookie: `tau_app_${ID}=abc` },
    })
    expect(presentedLocalDeploymentToken(request, ID).token).toBeNull()
  })

  it('prefers the URL token and reports that a cookie must be set', () => {
    const request = new Request(`https://t.example/api/app/${ID}/?_tau_token=abc`)
    expect(presentedLocalDeploymentToken(request, ID)).toEqual({ token: 'abc', fromQuery: true })
  })

  it('falls back to the path-scoped cookie for subresource requests', () => {
    // This is the whole point: the browser sends no query string of its own for
    // `/assets/index-*.js`, so before the cookie every asset came back 401.
    const request = new Request(`https://t.example/api/app/${ID}/assets/index-abc.js`, {
      headers: { cookie: `${localDeploymentCookieName(ID)}=abc` },
    })
    expect(presentedLocalDeploymentToken(request, ID)).toEqual({ token: 'abc', fromQuery: false })
  })

  it('never reads another deployment cookie', () => {
    const request = new Request(`https://t.example/api/app/${ID}/x`, {
      headers: { cookie: `${localDeploymentCookieName(OTHER)}=other-token` },
    })
    expect(presentedLocalDeploymentToken(request, ID).token).toBeNull()
  })

  it('ignores the Tau session cookie riding the same request', () => {
    // ficus_session is Path=/ so it IS sent here. It must never be mistaken for a
    // deployment credential.
    const request = new Request(`https://t.example/api/app/${ID}/x`, {
      headers: { cookie: 'ficus_session=a-real-session' },
    })
    expect(presentedLocalDeploymentToken(request, ID).token).toBeNull()
  })

  it('scopes the cookie to exactly one deployment prefix', () => {
    const header = localDeploymentCookieHeader({
      localDeploymentId: ID,
      token: 'abc',
      requestUrl: `https://t.example/api/app/${ID}/`,
    })
    expect(header).toContain(`Path=${localDeploymentProxyPath(ID)}`)
    // Path scoping is the security boundary: it is what keeps this credential
    // off Tau's own API and off other deployments.
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Secure')
    expect(header).not.toMatch(/(?:^|;)\s*Domain=/i)
  })

  it('omits Secure over plain http so a localhost self-host still works', () => {
    // A Secure cookie is silently dropped on http, which presents as "assets
    // 401 on localhost only".
    const header = localDeploymentCookieHeader({
      localDeploymentId: ID,
      token: 'abc',
      requestUrl: `http://localhost:3000/api/app/${ID}/`,
    })
    expect(header).not.toContain('Secure')
  })

  it('parses a cookie surrounded by others and by whitespace', () => {
    const header = `ficus_session=x; ${localDeploymentCookieName(ID)}=abc ; other=y`
    expect(readCookie(header, localDeploymentCookieName(ID))).toBe('abc')
    expect(readCookie(null, 'anything')).toBeNull()
    expect(readCookie('malformed', 'anything')).toBeNull()
  })
})
