import { expect, test } from 'bun:test'
import {
  githubIdentityAuthorizationReturnPath,
  integrationAuthorizationReturnPath,
  integrationReturnPath,
  integrationSettingsPath,
  isSameOriginReturnPath,
} from './integrationReturnPath'

for (const provider of ['github', 'notion', 'slack'] as const) {
  test(`${provider} authorization opens its integration card at root and mounted deployments`, () => {
    for (const base of ['/', '/ficus-gh-smoke/']) {
      const destination = `${base}settings?section=integrations&setting=integration-${provider}`
      const returnTo = integrationAuthorizationReturnPath(base)
      expect(returnTo).toBe(`${base}settings`)
      expect(integrationReturnPath(returnTo, provider, base)).toBe(destination)
      expect(integrationSettingsPath(provider, base)).toBe(destination)
      expect(integrationReturnPath('/settings', provider, base)).toBe(destination)
      expect(integrationReturnPath(`${base}settings/`, provider, base)).toBe(destination)
      expect(integrationReturnPath(destination, provider, base)).toBe(destination)
    }
  })
}

test('GitHub callback opens repository-access setup during onboarding', () => {
  for (const base of ['/', '/ficus/']) {
    expect(integrationReturnPath(`${base}onboarding`, 'github', base)).toBe(`${base}onboarding?setup=github`)
    expect(integrationReturnPath(`${base}onboarding`, 'notion', base)).toBe(`${base}onboarding`)
  }
})

test('callback preserves custom return destinations', () => {
  for (const destination of ['/squads/test?tab=settings', '/settings-other']) {
    expect(integrationReturnPath(destination, 'github', '/ficus/')).toBe(destination)
  }
  expect(integrationReturnPath('/settings?section=account&setting=old&other=value#anchor', 'notion')).toBe(
    '/settings?section=integrations&setting=integration-notion&other=value#anchor'
  )
})

test('personal GitHub link returns to the linked-account setting, not the integration card', () => {
  for (const base of ['/', '/ficus/']) {
    const returnTo = githubIdentityAuthorizationReturnPath(base)
    // The server accepts return targets without a query string only.
    expect(returnTo).not.toContain('?')
    expect(integrationReturnPath(returnTo, 'github', base)).toBe(
      `${base}settings?section=account&setting=github-identity`
    )
  }
})

const UNSAFE_RETURN_TARGETS = [
  'https://evil.example/settings',
  'http://evil.example',
  'HTTPS://evil.example/settings',
  '//evil.example/settings',
  '///evil.example',
  '/\\evil.example',
  '\\\\evil.example',
  '\\/evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  ' /settings',
  'javascript:alert(1)',
  'JavaScript:alert(1)//',
  'data:text/html,<script>alert(1)</script>',
  'settings',
  '',
  '/%2F/evil.example',
  '/%2f%2fevil.example',
  '/%5Cevil.example',
  '/%5cevil.example',
  '/%09/evil.example',
  '/%E0%A4%A',
]

test('only same-origin paths count as return paths', () => {
  for (const value of UNSAFE_RETURN_TARGETS) expect([value, isSameOriginReturnPath(value)]).toEqual([value, false])
  for (const value of [undefined, null, 42, { toString: () => '/settings' }])
    expect(isSameOriginReturnPath(value)).toBe(false)
  for (const value of [
    '/',
    '/settings',
    '/ficus/settings?section=integrations&setting=integration-github#anchor',
    '/squads/test?tab=settings',
    '/onboarding',
    '/docs/a%20b',
    '/search?q=https://example.com',
  ])
    expect([value, isSameOriginReturnPath(value)]).toEqual([value, true])
})

test('callback falls back to the provider settings for a return target that is not a same-origin path', () => {
  for (const base of ['/', '/ficus/']) {
    for (const provider of ['github', 'linear', 'notion', 'slack'] as const) {
      for (const value of UNSAFE_RETURN_TARGETS)
        expect([value, integrationReturnPath(value, provider, base)]).toEqual([
          value,
          integrationSettingsPath(provider, base),
        ])
    }
  }
})

test('callback still maps and preserves same-origin return paths', () => {
  expect(integrationReturnPath('/ficus/settings', 'slack', '/ficus/')).toBe(
    '/ficus/settings?section=integrations&setting=integration-slack'
  )
  expect(integrationReturnPath('/ficus/settings/linear-identity', 'linear', '/ficus/')).toBe(
    '/ficus/settings?section=account&setting=linear-account'
  )
  expect(integrationReturnPath('/squads/test?tab=settings', 'notion')).toBe('/squads/test?tab=settings')
})
