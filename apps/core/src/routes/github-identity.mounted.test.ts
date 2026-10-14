import { expect, test } from 'bun:test'
import { app } from '../index'
import { authHeaders, createTestUser, cleanupTestRbac } from '../test-utils/rbac'
import { getGitHubPersonalIdentity } from '../services/integrations/github/personal-identity'
import * as runtime from '../services/integrations/runtime'

test('production self routes are mounted behind actual identity/authz and use owned purpose routing without integration permission', async () => {
  const prefix = `github-identity-mounted-${crypto.randomUUID()}`
  const human = await createTestUser({ prefix })
  try {
    const missing = await app.request('/api/github-identity')
    expect(missing.status).toBe(401)
    const response = await app.request('/api/github-identity', { headers: authHeaders(human.token) })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const status = await response.json()
    expect(status).toMatchObject({
      linked: null,
      confirmation: null,
      authorization: { authority: 'local', mode: 'device' },
    })
    expect(await getGitHubPersonalIdentity({ type: 'user', userId: human.id })).toBeNull()
    expect(runtime.githubIdentityRoutesService).toBeDefined()
    expect(runtime.integrationRoutesService.authorization?.resolvePurpose).toBeDefined()
    expect(
      await runtime.integrationRoutesService.authorization!.resolvePurpose!({
        providerKey: 'github',
        userId: human.id,
        source: { kind: 'device', id: crypto.randomUUID() },
      })
    ).toBeNull()
  } finally {
    await cleanupTestRbac(prefix)
  }
})
