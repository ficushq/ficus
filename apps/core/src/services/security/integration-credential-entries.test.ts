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
