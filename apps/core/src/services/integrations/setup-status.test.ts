import { expect, test } from 'bun:test'
import { credentialSetupStatus, connectionSetupStatus, withRoutingIssues } from './setup-status'
import { channelPlugins } from './channels/plugins'
import { deploymentPlugins } from './deployment/plugins'

const account = {
  credentialConfigured: true,
  enabled: true,
  authState: 'authenticated' as const,
  healthState: 'healthy' as const,
  materialRevision: 'one',
  validatedRevision: 'one',
}
test('account setup distinguishes missing accounts, disabled accounts, invalid credentials, health, and usable alternatives', () => {
  expect(connectionSetupStatus([{ ...account, credentialConfigured: false }]).state).toBe('needs_attention')
  expect(connectionSetupStatus([]).state).toBe('needs_setup')
  expect(connectionSetupStatus([{ ...account, enabled: false }]).issues).toEqual([
    'Enable at least one connected account.',
  ])
  expect(connectionSetupStatus([{ ...account, authState: 'reauthorization_required' }]).state).toBe('needs_attention')
  expect(connectionSetupStatus([{ ...account, validatedRevision: 'old' }]).state).toBe('needs_attention')
  expect(connectionSetupStatus([{ ...account, healthState: 'unreachable' }]).state).toBe('needs_attention')
  expect(connectionSetupStatus([{ ...account, authState: 'invalid' }, account])).toEqual({
    state: 'configured',
    issues: [],
  })
})
test('only missing required fields affect setup and messages contain labels rather than secret values', () => {
  expect(
    credentialSetupStatus([
      { label: 'Contact address', required: true, configured: false },
      { label: 'Optional setting', configured: false },
    ])
  ).toEqual({ state: 'needs_setup', issues: ['Contact address is required.'] })
  expect(credentialSetupStatus([{ label: 'Saved private key', required: true, configured: true }]).state).toBe(
    'configured'
  )
})
test('every channel declares required fields and deploy providers require a manual account token', () => {
  for (const plugin of Object.values(channelPlugins))
    expect(
      credentialSetupStatus(plugin.channel.credentialFields.map((field) => ({ ...field, configured: false }))).state
    ).toBe('needs_setup')
  for (const plugin of deploymentPlugins) {
    expect(plugin.authorization.kind).toBe('manual')
    expect(() => plugin.connection.credential.parse('')).toThrow()
  }
})

test('routing issues turn a configured integration into needs attention and keep worse states', () => {
  const issue = 'Squad Core routes Linear team T, which the Ficus app cannot access.'
  expect(withRoutingIssues(connectionSetupStatus([account]), [issue])).toEqual({
    state: 'needs_attention',
    issues: [issue],
  })
  expect(withRoutingIssues(connectionSetupStatus([account]), [])).toEqual({ state: 'configured', issues: [] })
  expect(withRoutingIssues(connectionSetupStatus([]), [issue])).toEqual({
    state: 'needs_setup',
    issues: ['Connect an account to finish setup.', issue],
  })
})
