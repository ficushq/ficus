import { describe, expect, test } from 'bun:test'
import { resolveOAuthCallbackUrl } from './public-url'

describe('resolveOAuthCallbackUrl', () => {
  test('derives the authenticated web callback from configured APP_URL', () => {
    expect(resolveOAuthCallbackUrl('https://ficus.example', undefined)).toBe(
      'https://ficus.example/settings/integrations/oauth/callback'
    )
    expect(resolveOAuthCallbackUrl('https://ficus.example/ficus/', undefined)).toBe(
      'https://ficus.example/ficus/settings/integrations/oauth/callback'
    )
  })

  test('uses APP_BASE_PATH only when APP_URL has no configured path', () => {
    expect(resolveOAuthCallbackUrl('https://ficus.example', '/tenant/')).toBe(
      'https://ficus.example/tenant/settings/integrations/oauth/callback'
    )
    expect(resolveOAuthCallbackUrl('https://ficus.example/from-url', '/ignored')).toBe(
      'https://ficus.example/from-url/settings/integrations/oauth/callback'
    )
  })

  test('rejects a missing configured APP_URL', () => {
    const prior = process.env.APP_URL
    delete process.env.APP_URL
    try {
      expect(() => resolveOAuthCallbackUrl()).toThrow('Invalid public application URL')
    } finally {
      if (prior === undefined) delete process.env.APP_URL
      else process.env.APP_URL = prior
    }
  })

  test.each([
    '',
    'ftp://ficus.example',
    'https://user:password@ficus.example',
    'https://ficus.example?query=1',
    'https://ficus.example#fragment',
  ])('rejects missing or unsafe APP_URL %#', (appUrl) => {
    expect(() => resolveOAuthCallbackUrl(appUrl, undefined)).toThrow('Invalid public application URL')
  })

  test.each(['//evil.example', '/ficus?query=1', '/ficus#fragment', '/ficus\\escape', '/ficus/%0a'])(
    'rejects unsafe APP_BASE_PATH %#',
    (basePath) => {
      expect(() => resolveOAuthCallbackUrl('https://ficus.example', basePath)).toThrow('Invalid application base path')
    }
  )
})
