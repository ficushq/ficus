import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { getPath as honoGetPath } from 'hono/utils/url'
import {
  basePathForOrigin,
  isStrippableBasePath,
  knownAppAddresses,
  normalizeBasePath,
  publicBasePath,
  resolveRequestBasePath,
  strippableBasePaths,
  stripKnownBasePath,
} from './app-base-path'

const PUBLIC = { url: 'https://team.example.com/ficus', localUrl: 'http://localhost:3000' }

function req(url: string, headers: Record<string, string> = {}) {
  return { url, header: (name: string) => headers[name.toLowerCase()] }
}

describe('normalizeBasePath', () => {
  test('root forms become empty, others gain one leading and no trailing slash', () => {
    expect(normalizeBasePath(undefined)).toBe('')
    expect(normalizeBasePath('')).toBe('')
    expect(normalizeBasePath('/')).toBe('')
    expect(normalizeBasePath('ficus')).toBe('/ficus')
    expect(normalizeBasePath('/ficus/')).toBe('/ficus')
    expect(normalizeBasePath(' /a/b// ')).toBe('/a/b')
  })
})

describe('resolveRequestBasePath', () => {
  test('resolves the public base by host when the proxy strips the prefix', () => {
    const request = req('http://127.0.0.1:3000/squads/1', { host: 'team.example.com' })
    expect(resolveRequestBasePath(request, PUBLIC, {})).toEqual({ basePath: '/ficus', matchedBy: 'host' })
  })

  test('resolves by path prefix when the proxy forwards it unchanged', () => {
    for (const host of ['team.example.com', 'localhost:3000', 'other.example.net']) {
      const request = req(`http://${host}/ficus/squads/1`, { host })
      expect(resolveRequestBasePath(request, PUBLIC, {})).toEqual({ basePath: '/ficus', matchedBy: 'path' })
    }
    expect(resolveRequestBasePath(req('http://localhost:3000/ficus'), PUBLIC, {}).basePath).toBe('/ficus')
  })

  test('the path rule is segment-aligned', () => {
    const request = req('http://localhost:3000/ficusx/a', { host: 'localhost:3000' })
    expect(resolveRequestBasePath(request, PUBLIC, {})).toEqual({ basePath: '', matchedBy: 'host' })
  })

  test('the local address gives the root', () => {
    const request = req('http://localhost:3000/squads/1', { host: 'localhost:3000' })
    expect(resolveRequestBasePath(request, PUBLIC, {})).toEqual({ basePath: '', matchedBy: 'host' })
  })

  test('x-forwarded-host wins over Host', () => {
    const request = req('http://127.0.0.1:3000/', { host: 'localhost:3000', 'x-forwarded-host': 'team.example.com' })
    expect(resolveRequestBasePath(request, PUBLIC, {})).toEqual({ basePath: '/ficus', matchedBy: 'host' })
    const local = req('http://127.0.0.1:3000/', {
      host: 'team.example.com',
      'x-forwarded-host': 'localhost:3000, team.example.com',
    })
    expect(resolveRequestBasePath(local, PUBLIC, {}).basePath).toBe('')
  })

  test('a default port in the Host header still matches', () => {
    const request = req('http://127.0.0.1:3000/', { host: 'TEAM.example.com:443' })
    expect(resolveRequestBasePath(request, PUBLIC, {}).basePath).toBe('/ficus')
  })

  test('unknown host falls back to APP_BASE_PATH, else root', () => {
    const request = req('http://127.0.0.1:3000/x', { host: 'evil.example.net' })
    expect(resolveRequestBasePath(request, PUBLIC, {})).toEqual({ basePath: '', matchedBy: 'fallback' })
    expect(resolveRequestBasePath(request, PUBLIC, { APP_BASE_PATH: '/tau/' })).toEqual({
      basePath: '/tau',
      matchedBy: 'fallback',
    })
  })

  test('a base that is a Core or web route segment is honored by host but never stripped', () => {
    const state = { url: 'https://team.example.com/settings', localUrl: 'http://localhost:3000' }
    expect(strippableBasePaths(state, {})).toEqual([])
    expect(publicBasePath(state, {})).toBe('/settings')
    expect(resolveRequestBasePath(req('http://x/', { host: 'team.example.com' }), state, {})).toEqual({
      basePath: '/settings',
      matchedBy: 'host',
    })
    expect(resolveRequestBasePath(req('http://x/settings', { host: 'localhost:3000' }), state, {})).toEqual({
      basePath: '',
      matchedBy: 'host',
    })
  })
})

describe('configured addresses', () => {
  test('known addresses are ordered public, local, explicit and deduplicated by origin', () => {
    const env = { FICUS_WEB_ORIGIN: 'https://team.example.com, https://alt.example.com', APP_BASE_PATH: '/tau' }
    expect(knownAppAddresses(PUBLIC, env)).toEqual([
      { origin: 'https://team.example.com', host: 'team.example.com', basePath: '/ficus', source: 'public' },
      { origin: 'http://localhost:3000', host: 'localhost:3000', basePath: '', source: 'local' },
      { origin: 'https://alt.example.com', host: 'alt.example.com', basePath: '/tau', source: 'explicit' },
    ])
  })

  test('explicit FICUS_WEB_ORIGIN origins use APP_BASE_PATH', () => {
    const env = { FICUS_WEB_ORIGIN: 'https://alt.example.com', APP_BASE_PATH: '/tau' }
    expect(basePathForOrigin('https://alt.example.com', PUBLIC, env)).toBe('/tau')
    expect(basePathForOrigin('https://team.example.com', PUBLIC, env)).toBe('/ficus')
    expect(basePathForOrigin('http://localhost:3000', PUBLIC, env)).toBe('')
    expect(basePathForOrigin('https://unknown.example.com', PUBLIC, env)).toBe('/tau')
    expect(basePathForOrigin('https://unknown.example.com', PUBLIC, {})).toBe('')
  })

  test('the public base is the address path, else APP_BASE_PATH, else root', () => {
    expect(publicBasePath(PUBLIC, { APP_BASE_PATH: '/tau' })).toBe('/ficus')
    expect(publicBasePath({ url: 'https://h', localUrl: undefined }, { APP_BASE_PATH: '/tau' })).toBe('/tau')
    expect(publicBasePath({ url: undefined, localUrl: undefined }, {})).toBe('')
  })

  test('strippable bases include APP_BASE_PATH and come longest first', () => {
    const state = { url: 'https://team.example.com/ficus/team', localUrl: 'http://localhost:3000' }
    expect(strippableBasePaths(state, { APP_BASE_PATH: '/ficus' })).toEqual(['/ficus/team', '/ficus'])
  })

  test('route segments are not strippable', () => {
    for (const base of ['/api', '/docs/x', '/squads', '/Settings', '/farm'])
      expect(isStrippableBasePath(base)).toBe(false)
    expect(isStrippableBasePath('/ficus')).toBe(true)
    expect(isStrippableBasePath('')).toBe(false)
  })
})

describe('stripKnownBasePath', () => {
  test('strips only configured, segment-aligned prefixes', () => {
    expect(stripKnownBasePath('/ficus', ['/ficus'])).toBe('/')
    expect(stripKnownBasePath('/ficus/', ['/ficus'])).toBe('/')
    expect(stripKnownBasePath('/ficus/api/x', ['/ficus'])).toBe('/api/x')
    expect(stripKnownBasePath('/ficusx/a', ['/ficus'])).toBe('/ficusx/a')
    expect(stripKnownBasePath('/api/x', ['/ficus'])).toBe('/api/x')
    expect(stripKnownBasePath('/a/b/c', ['/a/b', '/a'])).toBe('/c')
  })

  test('feeds Hono routing as getPath', async () => {
    const app = new Hono({ getPath: (request) => stripKnownBasePath(honoGetPath(request), ['/ficus']) })
    app.get('/api/health', (c) => c.text(c.req.path))
    const prefixed = await app.request('http://h/ficus/api/health')
    expect(prefixed.status).toBe(200)
    expect(await prefixed.text()).toBe('/api/health')
    expect((await app.request('http://h/api/health')).status).toBe(200)
  })
})
