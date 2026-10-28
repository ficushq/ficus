import { getSecretStore } from '../services/secrets'
import { getSquadWorkspacePath } from '../services/squad/workspace'
import { WORKSPACE_DOT_DIR } from '../services/workspace/dot-dir'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { squadEnvRouter } from './squad-env'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler } from '../middleware/json-body-errors'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { db, squads, secrets } from '../db'
import { RESERVED_SQUAD_ENV_KEYS } from '../services/squad/env'

const app = new Hono()
app.use('*', identityMiddleware)
app.onError(jsonBodyErrorHandler)
app.route('/api/squads/workspace', squadEnvRouter)

const rbacPrefix = `squad-env-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  await getSecretStore().initialize()
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('squad-env routes', () => {
  describe('RBAC guards', () => {
    it('returns 401 without identity', async () => {
      const res = await app.request(`/api/squads/workspace/${squadId}/env`)
      expect(res.status).toBe(401)
    })

    it('denies users without env permission', async () => {
      const user = await createTestUser({ prefix: rbacPrefix })
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
        headers: authHeaders(user.token),
      })
      expect(res.status).toBe(403)
    })

    it('denies squad env access outside the assigned squad scope', async () => {
      const user = await createTestUser({ prefix: rbacPrefix })
      const role = await createTestRole({ prefix: rbacPrefix, permissions: ['env:read'] })
      const [otherSquad] = await db
        .insert(squads)
        .values({ name: `${testPrefix} other`, purpose: 'RBAC scope' })
        .returning()
      await assignRole({
        userId: user.id,
        roleId: role.id,
        scope: 'squad',
        squadId: otherSquad.id,
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
        headers: authHeaders(user.token),
      })
      expect(res.status).toBe(403)
    })

    /**
     * A squad-scoped role REPLACES the `squad_default` tier, so this user must be denied on this
     * squad even though their default grants `env:read`. The guard has to resolve the short id
     * first: a raw prefix matches no `squad_id`, which hides the override and (before that
     * resolution existed) turned the prefix form of this URL into a GRANT while the full-uuid form
     * was correctly denied.
     */
    it('denies a squad override that withholds env:read, by full id and by short prefix alike', async () => {
      const user = await createTestUser({ prefix: rbacPrefix })
      const defaultRole = await createTestRole({ prefix: rbacPrefix, permissions: ['env:read'] })
      const withholdingRole = await createTestRole({ prefix: rbacPrefix, permissions: ['squads:read'] })
      await assignRole({ userId: user.id, roleId: defaultRole.id, scope: 'squad_default' })
      await assignRole({ userId: user.id, roleId: withholdingRole.id, scope: 'squad', squadId })

      for (const id of [squadId, squadId.slice(0, 8)]) {
        const res = await app.request(`/api/squads/workspace/${id}/env`, { headers: authHeaders(user.token) })
        expect(res.status).toBe(403)
      }

      // The default still applies to a squad the user has no override on.
      const [other] = await db
        .insert(squads)
        .values({ name: `${testPrefix} other squad`, purpose: 'override scope', status: 'active' })
        .returning()
      const allowed = await app.request(`/api/squads/workspace/${other.id}/env`, { headers: authHeaders(user.token) })
      expect(allowed.status).toBe(200)
    })

    it('allows system settings readers to view global exposed secret keys', async () => {
      const user = await createTestUser({ prefix: rbacPrefix })
      const role = await createTestRole({ prefix: rbacPrefix, permissions: ['settings:read'] })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

      const res = await app.request('/api/squads/workspace/env/global-secrets', {
        headers: authHeaders(user.token),
      })
      expect(res.status).toBe(200)
    })
  })
  let testPrefix: string
  let squadId: string

  beforeEach(async () => {
    testPrefix = `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Generic exposure fixtures, not the six retired deployment credential names.
    for (const key of [
      'DEPLOY_TEST_VERCEL_TOKEN',
      'DEPLOY_TEST_NETLIFY_TOKEN',
      'DEPLOY_TEST_RAILWAY_TOKEN',
      'DEPLOY_TEST_DIGITALOCEAN_TOKEN',
    ])
      await getSecretStore().set(key, '', 'test')

    // Create a test squad
    const [squad] = await db
      .insert(squads)
      .values({
        name: `${testPrefix} Test Squad`,
        purpose: 'Test squad for env routes',
        status: 'active',
      })
      .returning()

    squadId = squad.id
  })

  afterEach(async () => {
    await getSecretStore().delete('DEPLOY_TEST_VERCEL_TOKEN')
    await getSecretStore().delete('DEPLOY_TEST_NETLIFY_TOKEN')
    await getSecretStore().delete('DEPLOY_TEST_RAILWAY_TOKEN')
    await getSecretStore().delete('DEPLOY_TEST_DIGITALOCEAN_TOKEN')
    await app.request('/api/squads/workspace/env/global-secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ keys: [] }),
    })
    await db.delete(secrets).where(like(secrets.key, `DEPLOY_${testPrefix}%`))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  describe('GET /api/squads/workspace/:squadId/env', () => {
    it('returns empty content for new squad', async () => {
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.content).toBe('')
      expect(data.exposedSecretKeys).toEqual([])
    })

    it('resolves squad UUID prefixes to the full squad UUID', async () => {
      const content = 'PREFIX_SECRET=value123'
      const prefix = squadId.slice(0, 8)

      await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content }),
      })

      const res = await app.request(`/api/squads/workspace/${prefix}/env`, { headers: authHeaders(admin.token) })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.content).toBe(content)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/workspace/00000000-0000-0000-0000-000000000000/env', {
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(404)
    })

    it('returns content after setting', async () => {
      const content = 'MY_SECRET=value123'

      // Set the env first
      await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content }),
      })

      // Then get it
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.content).toBe(content)
    })
  })

  describe('PUT /api/squads/workspace/:squadId/env', () => {
    it('sets env content', async () => {
      const content = 'API_KEY=secret\nDATABASE_URL=postgres://localhost/db'

      const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/workspace/00000000-0000-0000-0000-000000000000/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: 'TEST=value' }),
      })

      expect(res.status).toBe(404)
    })

    it('overwrites existing content', async () => {
      // Set initial content
      await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: 'FIRST=1' }),
      })

      // Overwrite
      await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: 'SECOND=2' }),
      })

      // Verify
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      const data = await res.json()
      expect(data.content).toBe('SECOND=2')
    })

    it('refuses every reserved key, naming it and why', async () => {
      for (const [key, reason] of Object.entries(RESERVED_SQUAD_ENV_KEYS)) {
        const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: JSON.stringify({ content: `KEEP=1\nexport ${key}=whatever\n` }),
        })

        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toContain(key)
        expect(data.error).toContain(reason)
      }
      // PATH is deliberately NOT reserved: adding to it is legitimate, and the host
      // preamble re-prepends the shim dir after the squad env is sourced.
      expect(RESERVED_SQUAD_ENV_KEYS.PATH).toBeUndefined()
      expect(Object.keys(RESERVED_SQUAD_ENV_KEYS).every((key) => key.startsWith('FICUS_'))).toBe(true)

      // Nothing was persisted by the rejected writes.
      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      expect((await getRes.json()).content).toBe('')
    })

    it('still saves an ordinary key', async () => {
      const content = 'FICUS_SQUAD_ID_LOOKALIKE=1\nORDINARY=2\nPATH=$PATH:/opt/toolchain'
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content }),
      })

      expect(res.status).toBe(200)
      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      expect((await getRes.json()).content).toBe(content)
    })

    it('writes the env under the workspace .ficus dir as real canonical settings', async () => {
      const content = 'ON_DISK=1'
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content }),
      })

      expect(res.status).toBe(200)
      const root = getSquadWorkspacePath(squadId)
      expect(readFileSync(join(root, WORKSPACE_DOT_DIR, 'env.user'), 'utf8')).toBe(content)
      expect(readFileSync(join(root, WORKSPACE_DOT_DIR, '.env'), 'utf8')).toContain(content)
      expect(lstatSync(join(root, WORKSPACE_DOT_DIR)).isDirectory()).toBe(true)
    })

    it('answers 409 with the actionable message when the workspace settings dir needs a manual fix', async () => {
      const root = getSquadWorkspacePath(squadId)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, WORKSPACE_DOT_DIR), 'preserved invalid settings')

      for (const init of [
        undefined,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'NEW=1' }),
        },
      ]) {
        const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
          ...init,
          headers: { ...(init?.headers ?? {}), ...authHeaders(admin.token) },
        })
        expect(res.status).toBe(409)
        const data = await res.json()
        expect(data.code).toBe('workspace_dot_dir_conflict')
        expect(data.error).toStartWith(`Workspace ${squadId} needs a manual fix to its settings dir:`)
        expect(data.error).not.toContain(root)
      }
      // Fail closed: invalid canonical settings remain untouched.
      expect(readFileSync(join(root, WORKSPACE_DOT_DIR), 'utf8')).toBe('preserved invalid settings')
      expect(existsSync(join(root, WORKSPACE_DOT_DIR, 'env.user'))).toBe(false)
      rmSync(root, { recursive: true, force: true })
    })

    it('handles empty content', async () => {
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ content: '' }),
      })

      expect(res.status).toBe(200)

      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      const data = await getRes.json()
      expect(data.content).toBe('')
    })
  })

  describe('squad secret exposure allowlist', () => {
    async function getListedSecret(key: string): Promise<any> {
      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      return data.secrets.find((secret: any) => secret.key === key)
    }

    it('lists selectable secret names without plaintext values', async () => {
      await getSecretStore().set('DEPLOY_TEST_VERCEL_TOKEN', 'vercel-secret', 'test')

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(JSON.stringify(data)).toContain('DEPLOY_TEST_VERCEL_TOKEN')
      expect(JSON.stringify(data)).not.toContain('vercel-secret')
    })

    it('returns selected secret names without plaintext values', async () => {
      await getSecretStore().set('DEPLOY_TEST_VERCEL_TOKEN', 'vercel-secret', 'test')

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_TEST_VERCEL_TOKEN'])
      expect(JSON.stringify(data)).not.toContain('vercel-secret')

      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      const getData = await getRes.json()
      expect(getData.content).not.toContain('vercel-secret')
      expect(getData.exposedSecretKeys).toEqual(['DEPLOY_TEST_VERCEL_TOKEN'])
    })

    it('resolves squad UUID prefixes when exposing secrets', async () => {
      await getSecretStore().set('DEPLOY_TEST_NETLIFY_TOKEN', 'netlify-secret', 'test')
      const prefix = squadId.slice(0, 8)

      const res = await app.request(`/api/squads/workspace/${prefix}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_NETLIFY_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_TEST_NETLIFY_TOKEN'])

      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      const getData = await getRes.json()
      expect(getData.exposedSecretKeys).toEqual(['DEPLOY_TEST_NETLIFY_TOKEN'])
    })

    it('overrides exposed secrets on POST so the UI can unexpose unchecked secrets', async () => {
      await getSecretStore().set('DEPLOY_TEST_VERCEL_TOKEN', 'vercel-secret', 'test')
      await getSecretStore().set('DEPLOY_TEST_NETLIFY_TOKEN', 'netlify-secret', 'test')

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN', 'DEPLOY_TEST_NETLIFY_TOKEN'] }),
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_NETLIFY_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_TEST_NETLIFY_TOKEN'])
    })

    it('appends exposed secrets on PUT instead of replacing existing exposed secrets', async () => {
      await getSecretStore().set('DEPLOY_TEST_VERCEL_TOKEN', 'vercel-secret', 'test')
      await getSecretStore().set('DEPLOY_TEST_NETLIFY_TOKEN', 'netlify-secret', 'test')

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN'] }),
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_NETLIFY_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_TEST_VERCEL_TOKEN', 'DEPLOY_TEST_NETLIFY_TOKEN'])
    })

    it('removes exposed secrets on DELETE', async () => {
      await getSecretStore().set('DEPLOY_TEST_VERCEL_TOKEN', 'vercel-secret', 'test')
      await getSecretStore().set('DEPLOY_TEST_NETLIFY_TOKEN', 'netlify-secret', 'test')

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN', 'DEPLOY_TEST_NETLIFY_TOKEN'] }),
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_TEST_NETLIFY_TOKEN'])
    })

    it('reports effective exposure for global-only, squad-only, both, and neither exposure states', async () => {
      await getSecretStore().set('DEPLOY_TEST_VERCEL_TOKEN', 'global-vercel-secret', 'test')
      await getSecretStore().set('DEPLOY_TEST_NETLIFY_TOKEN', 'squad-netlify-secret', 'test')

      const globalRes = await app.request('/api/squads/workspace/env/global-secrets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN', 'DEPLOY_TEST_RAILWAY_TOKEN'] }),
      })
      expect(globalRes.status).toBe(200)
      const globalData = await globalRes.json()
      expect(globalData.globallyExposedSecretKeys).toEqual(['DEPLOY_TEST_RAILWAY_TOKEN', 'DEPLOY_TEST_VERCEL_TOKEN'])
      expect(JSON.stringify(globalData)).not.toContain('global-vercel-secret')

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_NETLIFY_TOKEN', 'DEPLOY_TEST_RAILWAY_TOKEN'] }),
      })

      const globalOnly = await getListedSecret('DEPLOY_TEST_VERCEL_TOKEN')
      expect(globalOnly.exposed).toBe(true)
      expect(globalOnly.squadExposed).toBe(false)
      expect(globalOnly.globallyExposed).toBe(true)

      const squadOnly = await getListedSecret('DEPLOY_TEST_NETLIFY_TOKEN')
      expect(squadOnly.exposed).toBe(true)
      expect(squadOnly.squadExposed).toBe(true)
      expect(squadOnly.globallyExposed).toBe(false)

      const both = await getListedSecret('DEPLOY_TEST_RAILWAY_TOKEN')
      expect(both.exposed).toBe(true)
      expect(both.squadExposed).toBe(true)
      expect(both.globallyExposed).toBe(true)

      const neither = await getListedSecret('DEPLOY_TEST_DIGITALOCEAN_TOKEN')
      expect(neither.exposed).toBe(false)
      expect(neither.squadExposed).toBe(false)
      expect(neither.globallyExposed).toBe(false)
    })

    it('rejects secret keys that are not valid environment variable names', async () => {
      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_TEST_VERCEL_TOKEN; echo leaked'] }),
      })

      expect(res.status).toBe(400)
    })
  })

  /**
   * Adding a key to an exposure needs read access to that key in the Secret Store, on top of
   * env:write / settings:write. Synthetic key names only: exposure stores names, never values, and
   * these keys are never set in the store. `DEPLOY_*` is in the `integration` group and `OPENAI_*`
   * in `provider` (config/secrets/groups.yaml).
   */
  describe('exposing a key requires Secret Store read access to it', () => {
    const INTEGRATION_KEY = 'DEPLOY_SYNTH_EXPOSE_TEST_TOKEN'
    const PROVIDER_KEY = 'OPENAI_SYNTH_EXPOSE_TEST_KEY'
    const UNKNOWN_PROVIDER_KEY = 'OPENAI_SYNTH_NEVER_STORED_KEY'

    async function userWith(permissions: string[]): Promise<TestUser> {
      const user = await createTestUser({ prefix: rbacPrefix })
      const role = await createTestRole({ prefix: rbacPrefix, permissions })
      await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
      return user
    }

    function send(user: TestUser, method: string, path: string, keys: string[]) {
      return app.request(`/api/squads/workspace${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders(user.token) },
        body: JSON.stringify({ keys }),
      })
    }

    async function squadExposure(): Promise<string[]> {
      const res = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      return (await res.json()).exposedSecretKeys
    }

    async function globalExposure(): Promise<string[]> {
      const res = await app.request('/api/squads/workspace/env/global-secrets', { headers: authHeaders(admin.token) })
      return (await res.json()).globallyExposedSecretKeys
    }

    it('refuses env:write without read access on both squad add paths, storing nothing', async () => {
      const writer = await userWith(['env:read', 'env:write'])
      for (const method of ['PUT', 'POST']) {
        const res = await send(writer, method, `/${squadId}/env/secrets`, [INTEGRATION_KEY])
        expect(res.status).toBe(403)
        expect((await res.json()).error).toContain(INTEGRATION_KEY)
      }
      expect(await squadExposure()).toEqual([])
    })

    it('answers an unreadable key the same whether or not it exists in the store', async () => {
      const operator = await userWith(['env:read', 'env:write', 'secrets:read:integration'])
      const listed = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        headers: authHeaders(admin.token),
      })
      const existing = (await listed.json()).secrets.find((secret: any) => secret.key.startsWith('OPENAI_'))
      expect(existing).toBeDefined()

      const known = await send(operator, 'PUT', `/${squadId}/env/secrets`, [existing.key])
      const unknown = await send(operator, 'PUT', `/${squadId}/env/secrets`, [UNKNOWN_PROVIDER_KEY])
      expect(known.status).toBe(403)
      expect(unknown.status).toBe(403)
      const knownBody = JSON.stringify(await known.json()).replace(existing.key, 'KEY')
      const unknownBody = JSON.stringify(await unknown.json()).replace(UNKNOWN_PROVIDER_KEY, 'KEY')
      expect(knownBody).toBe(unknownBody)
    })

    it("lets a group reader add only its group's keys, and refuses a mixed change whole", async () => {
      const operator = await userWith(['env:read', 'env:write', 'secrets:read:integration'])

      expect((await send(operator, 'PUT', `/${squadId}/env/secrets`, [PROVIDER_KEY])).status).toBe(403)
      expect((await send(operator, 'POST', `/${squadId}/env/secrets`, [INTEGRATION_KEY, PROVIDER_KEY])).status).toBe(
        403
      )
      expect(await squadExposure()).toEqual([])

      const res = await send(operator, 'PUT', `/${squadId}/env/secrets`, [INTEGRATION_KEY])
      expect(res.status).toBe(200)
      expect((await res.json()).exposedSecretKeys).toEqual([INTEGRATION_KEY])
    })

    it('always allows removal, and does not re-check keys that are already exposed', async () => {
      expect((await send(admin, 'POST', `/${squadId}/env/secrets`, [PROVIDER_KEY])).status).toBe(200)
      const operator = await userWith(['env:read', 'env:write', 'secrets:read:integration'])

      // The unreadable key stays exposed while the operator adds a readable one, by append or replace.
      expect((await send(operator, 'PUT', `/${squadId}/env/secrets`, [INTEGRATION_KEY])).status).toBe(200)
      expect((await squadExposure()).sort()).toEqual([INTEGRATION_KEY, PROVIDER_KEY].sort())
      expect((await send(operator, 'POST', `/${squadId}/env/secrets`, [PROVIDER_KEY, INTEGRATION_KEY])).status).toBe(
        200
      )

      // A writer with no Secret Store read access at all can still remove, by DELETE or by replace.
      const writer = await userWith(['env:read', 'env:write'])
      expect((await send(writer, 'POST', `/${squadId}/env/secrets`, [PROVIDER_KEY])).status).toBe(200)
      expect(await squadExposure()).toEqual([PROVIDER_KEY])
      expect((await send(writer, 'DELETE', `/${squadId}/env/secrets`, [PROVIDER_KEY])).status).toBe(200)
      expect(await squadExposure()).toEqual([])
    })

    it('lists only keys the caller may read, plus keys already exposed to the squad, marking which it may add', async () => {
      const operator = await userWith(['env:read', 'env:write', 'secrets:read:integration'])
      const list = async (user: TestUser): Promise<any[]> => {
        const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
          headers: authHeaders(user.token),
        })
        expect(res.status).toBe(200)
        return (await res.json()).secrets
      }

      const all = await list(admin)
      const provider = all.find((secret) => secret.key.startsWith('OPENAI_'))
      const otherProvider = all.find((secret) => secret.key === 'APNS_KEY_ID')
      expect(provider).toBeDefined()
      expect(otherProvider).toBeDefined()

      let listed = await list(operator)
      const integration = listed.find((secret) => secret.key.startsWith('DEPLOY_'))
      expect(integration.canExpose).toBe(true)
      // No unreadable (non-integration) key name is listed while none is exposed.
      expect(listed.every((secret) => secret.canExpose)).toBe(true)
      expect(listed.some((secret) => secret.key === provider.key)).toBe(false)

      // Exposed unreadable keys stay listed (squad: so they can be removed; global: already in the env).
      expect((await send(admin, 'PUT', `/${squadId}/env/secrets`, [provider.key])).status).toBe(200)
      expect((await send(admin, 'PUT', '/env/global-secrets', [otherProvider.key])).status).toBe(200)
      listed = await list(operator)
      const squadExposed = listed.find((secret) => secret.key === provider.key)
      expect(squadExposed).toMatchObject({ squadExposed: true, canExpose: false })
      const globallyExposed = listed.find((secret) => secret.key === otherProvider.key)
      expect(globallyExposed).toMatchObject({ globallyExposed: true, canExpose: false })
      expect(
        listed
          .filter((secret) => !secret.canExpose)
          .map((secret) => secret.key)
          .sort()
      ).toEqual([provider.key, otherProvider.key].sort())
    })

    it('applies the same rule to global exposure', async () => {
      const settingsWriter = await userWith(['settings:read', 'settings:write'])
      for (const method of ['PUT', 'POST']) {
        expect((await send(settingsWriter, method, '/env/global-secrets', [INTEGRATION_KEY])).status).toBe(403)
      }
      expect(await globalExposure()).toEqual([])

      const operator = await userWith(['settings:read', 'settings:write', 'secrets:read:integration'])
      expect((await send(operator, 'PUT', '/env/global-secrets', [PROVIDER_KEY])).status).toBe(403)
      expect((await send(operator, 'POST', '/env/global-secrets', [INTEGRATION_KEY, PROVIDER_KEY])).status).toBe(403)
      expect(await globalExposure()).toEqual([])
      expect((await send(operator, 'PUT', '/env/global-secrets', [INTEGRATION_KEY])).status).toBe(200)

      // Already-exposed keys are not re-checked, and removal needs no read access.
      expect((await send(admin, 'PUT', '/env/global-secrets', [PROVIDER_KEY])).status).toBe(200)
      expect((await send(operator, 'POST', '/env/global-secrets', [PROVIDER_KEY, INTEGRATION_KEY])).status).toBe(200)
      expect((await send(settingsWriter, 'DELETE', '/env/global-secrets', [PROVIDER_KEY])).status).toBe(200)
      expect((await send(settingsWriter, 'POST', '/env/global-secrets', [])).status).toBe(200)
      expect(await globalExposure()).toEqual([])
    })
  })
})
