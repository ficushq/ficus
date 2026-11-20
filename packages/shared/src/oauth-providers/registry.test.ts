import { describe, expect, test } from 'bun:test'
import { createFakeAdapter } from './fake/adapter'
import { getOAuthProviderAdapter, oauthProviderKeys, registerOAuthProviderAdapterForTest } from './registry'

describe('oauth provider registry', () => {
  test('resolves first-party OAuth providers', () => {
    expect(getOAuthProviderAdapter('notion')?.key).toBe('notion')
    expect(getOAuthProviderAdapter('nope')).toBeUndefined()
    expect(oauthProviderKeys()).toEqual(['github', 'linear', 'notion', 'slack'])
  })

  test('prototype keys do not resolve an adapter', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(getOAuthProviderAdapter(key)).toBeUndefined()
    }
  })

  test('temporarily registers and restores a fake adapter in tests', () => {
    const fake = createFakeAdapter({ responses: [], revoked: [], calls: [] }, 'fake')
    const restore = registerOAuthProviderAdapterForTest(fake)
    try {
      expect(getOAuthProviderAdapter('fake')).toBe(fake)
      expect(oauthProviderKeys()).toEqual(['fake', 'github', 'linear', 'notion', 'slack'])
    } finally {
      restore()
    }
    expect(getOAuthProviderAdapter('fake')).toBeUndefined()
  })

  test('restores prototype-named fake keys without corrupting the registry', () => {
    const fake = createFakeAdapter({ responses: [], revoked: [], calls: [] }, 'constructor')
    const restore = registerOAuthProviderAdapterForTest(fake)
    expect(getOAuthProviderAdapter('constructor')).toBe(fake)
    restore()
    expect(getOAuthProviderAdapter('constructor')).toBeUndefined()
    expect(oauthProviderKeys()).toEqual(['github', 'linear', 'notion', 'slack'])
  })

  test('notion declares its authorize host and builds a url only on that host', () => {
    const adapter = getOAuthProviderAdapter('notion')!
    expect(adapter.authorizeHosts).toEqual(['api.notion.com'])
    const url = adapter.buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://app.example/cb',
      state: 'S'.repeat(43),
    })
    expect(url.host).toBe('api.notion.com')
    expect(url.searchParams.get('state')).toBe('S'.repeat(43))
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb')
    expect(url.toString()).not.toContain('client_secret')
  })

  test('linear declares its authorize host and installs the app for the workspace', () => {
    const adapter = getOAuthProviderAdapter('linear')!
    expect(adapter.authorizeHosts).toEqual(['linear.app'])
    const url = adapter.buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://app.example/cb',
      state: 'S'.repeat(43),
    })
    expect(url.host).toBe('linear.app')
    expect(url.searchParams.get('actor')).toBe('app')
    expect(url.searchParams.get('state')).toBe('S'.repeat(43))
    expect(url.toString()).not.toContain('client_secret')
  })

  test('slack declares its authorize host and builds a url only on that host', () => {
    const adapter = getOAuthProviderAdapter('slack')!
    expect(adapter.authorizeHosts).toEqual(['slack.com'])
    const url = adapter.buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://app.example/cb',
      state: 'S'.repeat(43),
    })
    expect(url.host).toBe('slack.com')
    expect(url.searchParams.get('state')).toBe('S'.repeat(43))
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb')
    expect(url.toString()).not.toContain('client_secret')
  })
})
