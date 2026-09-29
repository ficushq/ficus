import { expect, test } from 'bun:test'
import {
  integrationAuthorizationReturnPath,
  integrationReturnPath,
  integrationSettingsPath,
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
