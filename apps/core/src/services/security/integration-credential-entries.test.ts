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
