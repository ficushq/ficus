import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { squadEnvRouter } from './squad-env'
import { identityMiddleware } from '../middleware/identity'
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
app.route('/api/squads/workspace', squadEnvRouter)

const rbacPrefix = `squad-env-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
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
    delete process.env.DEPLOY_VERCEL_TOKEN
    delete process.env.DEPLOY_NETLIFY_TOKEN
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
      // One release (Ficus rename): the legacy identity spellings stay reserved too.
      expect(RESERVED_SQUAD_ENV_KEYS.TAU_TOKEN).toBeDefined()
      expect(RESERVED_SQUAD_ENV_KEYS.TAU_PASSWORD).toBeDefined()

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
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(JSON.stringify(data)).toContain('DEPLOY_VERCEL_TOKEN')
      expect(JSON.stringify(data)).not.toContain('vercel-secret')
    })

    it('returns selected secret names without plaintext values', async () => {
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_VERCEL_TOKEN'])
      expect(JSON.stringify(data)).not.toContain('vercel-secret')

      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      const getData = await getRes.json()
      expect(getData.content).not.toContain('vercel-secret')
      expect(getData.exposedSecretKeys).toEqual(['DEPLOY_VERCEL_TOKEN'])
    })

    it('resolves squad UUID prefixes when exposing secrets', async () => {
      process.env.DEPLOY_NETLIFY_TOKEN = 'netlify-secret'
      const prefix = squadId.slice(0, 8)

      const res = await app.request(`/api/squads/workspace/${prefix}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_NETLIFY_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_NETLIFY_TOKEN'])

      const getRes = await app.request(`/api/squads/workspace/${squadId}/env`, { headers: authHeaders(admin.token) })
      const getData = await getRes.json()
      expect(getData.exposedSecretKeys).toEqual(['DEPLOY_NETLIFY_TOKEN'])
    })

    it('overrides exposed secrets on POST so the UI can unexpose unchecked secrets', async () => {
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'
      process.env.DEPLOY_NETLIFY_TOKEN = 'netlify-secret'

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN', 'DEPLOY_NETLIFY_TOKEN'] }),
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_NETLIFY_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_NETLIFY_TOKEN'])
    })

    it('appends exposed secrets on PUT instead of replacing existing exposed secrets', async () => {
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'
      process.env.DEPLOY_NETLIFY_TOKEN = 'netlify-secret'

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN'] }),
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_NETLIFY_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_VERCEL_TOKEN', 'DEPLOY_NETLIFY_TOKEN'])
    })

    it('removes exposed secrets on DELETE', async () => {
      process.env.DEPLOY_VERCEL_TOKEN = 'vercel-secret'
      process.env.DEPLOY_NETLIFY_TOKEN = 'netlify-secret'

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN', 'DEPLOY_NETLIFY_TOKEN'] }),
      })

      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN'] }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.exposedSecretKeys).toEqual(['DEPLOY_NETLIFY_TOKEN'])
    })

    it('reports effective exposure for global-only, squad-only, both, and neither exposure states', async () => {
      process.env.DEPLOY_VERCEL_TOKEN = 'global-vercel-secret'
      process.env.DEPLOY_NETLIFY_TOKEN = 'squad-netlify-secret'

      const globalRes = await app.request('/api/squads/workspace/env/global-secrets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN', 'DEPLOY_RAILWAY_TOKEN'] }),
      })
      expect(globalRes.status).toBe(200)
      const globalData = await globalRes.json()
      expect(globalData.globallyExposedSecretKeys).toEqual(['DEPLOY_RAILWAY_TOKEN', 'DEPLOY_VERCEL_TOKEN'])
      expect(JSON.stringify(globalData)).not.toContain('global-vercel-secret')

      await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_NETLIFY_TOKEN', 'DEPLOY_RAILWAY_TOKEN'] }),
      })

      const globalOnly = await getListedSecret('DEPLOY_VERCEL_TOKEN')
      expect(globalOnly.exposed).toBe(true)
      expect(globalOnly.squadExposed).toBe(false)
      expect(globalOnly.globallyExposed).toBe(true)

      const squadOnly = await getListedSecret('DEPLOY_NETLIFY_TOKEN')
      expect(squadOnly.exposed).toBe(true)
      expect(squadOnly.squadExposed).toBe(true)
      expect(squadOnly.globallyExposed).toBe(false)

      const both = await getListedSecret('DEPLOY_RAILWAY_TOKEN')
      expect(both.exposed).toBe(true)
      expect(both.squadExposed).toBe(true)
      expect(both.globallyExposed).toBe(true)

      const neither = await getListedSecret('DEPLOY_DIGITALOCEAN_TOKEN')
      expect(neither.exposed).toBe(false)
      expect(neither.squadExposed).toBe(false)
      expect(neither.globallyExposed).toBe(false)
    })

    it('rejects secret keys that are not valid environment variable names', async () => {
      const res = await app.request(`/api/squads/workspace/${squadId}/env/secrets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ keys: ['DEPLOY_VERCEL_TOKEN; echo leaked'] }),
      })

      expect(res.status).toBe(400)
    })
  })
})
