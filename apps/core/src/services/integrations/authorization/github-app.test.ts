import { expect, test } from 'bun:test'
import { configureGitHubApp, resolveGitHubAppCredentials } from './github-app'
import { FICUS_GITHUB_APP_CLIENT_ID } from '@ficus/shared/oauth-providers/github/app'

test('public device login needs no private credential and old grants retain their issuing app', async () => {
  const values = new Map<string, string>()
  const store = {
    get: (key: string) => values.get(key),
    set: async (key: string, value: string) => {
      values.set(key, value)
    },
  }
  expect(resolveGitHubAppCredentials(store)).toEqual({
    clientId: FICUS_GITHUB_APP_CLIENT_ID,
    clientSecret: '',
    clientBinding: { clientId: FICUS_GITHUB_APP_CLIENT_ID },
  })
  await configureGitHubApp(
    { clientId: 'custom-app', clientSecret: 'private', capabilitiesAcknowledged: true },
    store,
    'test'
  )
  const original = resolveGitHubAppCredentials(store)!
  await configureGitHubApp({ clientId: 'second-app', capabilitiesAcknowledged: true }, store, 'test')
  expect(resolveGitHubAppCredentials(store)?.clientSecret).toBe('')
  expect(resolveGitHubAppCredentials(store, original.clientBinding)).toEqual(original)
  await configureGitHubApp({ useDefault: true }, store, 'test')
  expect(resolveGitHubAppCredentials(store)?.clientId).toBe(FICUS_GITHUB_APP_CLIENT_ID)
  expect(resolveGitHubAppCredentials(store, original.clientBinding)?.clientSecret).toBe('private')
  values.delete(original.clientBinding.credentialRef!)
  expect(resolveGitHubAppCredentials(store, original.clientBinding)).toBeUndefined()
})
