import { expect, test } from 'bun:test'
import { integrationCredentialEntries } from './integration-credential-entries'
import { ContentSafety } from './content-safety'

test('short legacy integration leaves never mangle prose or refuse ordinary calls', () => {
  const entries = integrationCredentialEntries(
    '__integration-credential:test',
    JSON.stringify({ botToken: 'x', webhookSecret: '1234567', secret: '12abcdef' })
  )
  expect(entries).toEqual([{ key: '__integration-credential:test.secret', value: '12abcdef' }])
  const safety = ContentSafety.fromSecretEntries(entries)
  expect(safety.redactWithStoredKeys('exec example 1234567')).toEqual({ value: 'exec example 1234567', storedKeys: [] })
  expect(safety.redactWithStoredKeys('12abcdef').storedKeys).not.toHaveLength(0)
})

test('opaque manual values match the trimmed token actually delivered by providers, including legacy padding', () => {
  const key = '__integration-credential:padded'
  expect(integrationCredentialEntries(key, ' \t synthetic-effective-manual-token \n')).toEqual([
    { key, value: 'synthetic-effective-manual-token' },
  ])
  expect(integrationCredentialEntries(key, '     1234567     ')).toEqual([])
  expect(integrationCredentialEntries(key, '        ')).toEqual([])
  const channel = { signingSecret: '  synthetic-channel-secret  ' }
  expect(integrationCredentialEntries(key, JSON.stringify(channel))).toEqual([
    { key: `${key}.signingSecret`, value: channel.signingSecret },
  ])
  const oauth = {
    version: 1,
    tokenRevision: 1,
    accessToken: '  synthetic-oauth-access  ',
    refreshToken: '  synthetic-oauth-refresh  ',
    expiresAt: null,
  }
  expect(integrationCredentialEntries(key, JSON.stringify(oauth)).map(({ value }) => value)).toEqual([
    oauth.accessToken,
    oauth.refreshToken,
  ])
})

test('legacy OAuth app envelopes register only secret leaves using integration credential labels', () => {
  for (const key of [
    '__integration-oauth-app:notion',
    '__integration-oauth-app:github:client:00000000-0000-4000-8000-000000000000',
  ]) {
    const raw = JSON.stringify({
      version: 1,
      clientId: 'public-client-id',
      clientSecret: '  synthetic-client-secret  ',
      capabilitiesAcknowledged: true,
    })
    expect(integrationCredentialEntries(key, raw)).toEqual([
      { key: `__integration-credential:${key.slice(2)}.clientSecret`, value: '  synthetic-client-secret  ' },
    ])
    expect(
      integrationCredentialEntries(key, JSON.stringify({ clientId: 'public-client-id', clientSecret: 'short' }))
    ).toEqual([])
    expect(integrationCredentialEntries(key, 'malformed-envelope')).toEqual([])
  }
})
