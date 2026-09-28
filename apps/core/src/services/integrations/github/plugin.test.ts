import { describe, expect, test } from 'bun:test'
import type { GitHubConnectionConfiguration } from '@ficus/shared/oauth-providers/github/config'
import { createGitHubPlugin } from './plugin'
import type { OAuthCredentialBundleV1 } from '../authorization/credential-bundle'

const stored: GitHubConnectionConfiguration = { version: 1, userId: 42, login: 'tauagent' }
const credential = { accessToken: 'token' } as OAuthCredentialBundleV1

function validateAs(actual: GitHubConnectionConfiguration) {
  const plugin = createGitHubPlugin({ currentUser: async () => actual }, async () => undefined)
  return plugin.authorization.validate({ configuration: stored, credential })
}

describe('GitHub plugin validation', () => {
  test('an unchanged account validates without refreshing configuration', async () => {
    expect(await validateAs(stored)).toEqual({ ok: true, grantedScopes: [] })
  })

  test('a renamed account refreshes its login under the same account id', async () => {
    const renamed = { version: 1 as const, userId: 42, login: 'ficusagent' }
    expect(await validateAs(renamed)).toEqual({ ok: true, grantedScopes: [], configuration: renamed })
  })

  test('a different account id still fails as an identity mismatch', async () => {
    expect(await validateAs({ version: 1, userId: 7, login: 'tauagent' })).toEqual({
      ok: false,
      code: 'account_identity_mismatch',
    })
  })
})
