import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { like, inArray, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, memoryChunks, memoryDocuments, squads, squadMemoryGrants, agents, agentTypes, agentTokens } from '../db'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { SquadMemoryGrant } from '../entities/SquadMemoryGrant'
import { ExternalSourceReindexService, IndexingService, SearchService } from '../services/memory'
import { identityMiddleware } from '../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { WorkspaceFileSource } from '../services/memory/sources/WorkspaceFileSource'
import { memoryRouter } from './memory'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/memory', memoryRouter)

const rbacPrefix = `memory-routes-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('memory routes', () => {
  let testPrefix: string
  let callerSquadId: string
  let targetSquadId: string
  let forgedSquadId: string

  beforeEach(async () => {
    testPrefix = `memory-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const rows = await db
      .insert(squads)
      .values([
        { name: `${testPrefix} Caller`, purpose: 'caller', status: 'active' },
        { name: `${testPrefix} Target`, purpose: 'target', status: 'active' },
        { name: `${testPrefix} Forged`, purpose: 'forged', status: 'active' },
      ])
      .returning()

    callerSquadId = rows[0].id
    targetSquadId = rows[1].id
    forgedSquadId = rows[2].id
  })

  afterEach(async () => {
    await db.delete(memoryChunks).where(inArray(memoryChunks.squadId, [callerSquadId, targetSquadId, forgedSquadId]))
    await db
      .delete(memoryDocuments)
      .where(inArray(memoryDocuments.squadId, [callerSquadId, targetSquadId, forgedSquadId]))
    await db
      .delete(squadMemoryGrants)
      .where(inArray(squadMemoryGrants.sourceSquadId, [callerSquadId, targetSquadId, forgedSquadId]))
    await db
      .delete(squadMemoryGrants)
      .where(inArray(squadMemoryGrants.granteeSquadId, [callerSquadId, targetSquadId, forgedSquadId]))
    await db.delete(agentTokens).where(eq(agentTokens.squadId, callerSquadId))
    await db.delete(agents).where(eq(agents.squadId, callerSquadId))
    await db.delete(agentTypes).where(like(agentTypes.id, `${testPrefix}%`))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  it('returns 400 for unknown search sourceTypes instead of broadening search', async () => {
    await IndexingService.instance().indexFile({
      squadId: targetSquadId,
      path: '/memory/secret.md',
      content: '---\ntitle: Secret\n---\n\nneedle-invalid-source-type-broadening\n',
    })

    const res = await app.request(
      `/api/memory/${targetSquadId}/search?query=needle-invalid-source-type-broadening&sourceTypes=not_a_source`,
      { headers: authHeaders(admin.token) }
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Unknown sourceTypes')
  })

  it('strips disabled agent_thread from HTTP search sourceTypes', async () => {
    const service = SearchService.instance()
    const originalSearch = service.search
    let receivedSourceTypes: unknown
    service.search = (async (_squadId, _query, options) => {
      receivedSourceTypes = options?.sourceTypes
      return []
    }) as typeof service.search

    try {
      const res = await app.request(
        `/api/memory/${targetSquadId}/search?query=needle&sourceTypes=agent_thread,memory_file`,
        { headers: authHeaders(admin.token) }
      )

      expect(res.status).toBe(200)
      expect(receivedSourceTypes).toEqual(['memory_file'])
    } finally {
      service.search = originalSearch
    }
  })

  it('returns empty search results without searching when only agent_thread is requested', async () => {
    const service = SearchService.instance()
    const originalSearch = service.search
    let called = false
    service.search = (async () => {
      called = true
      return []
    }) as typeof service.search

    try {
      const res = await app.request(`/api/memory/${targetSquadId}/search?query=needle&sourceTypes=agent_thread`, {
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
      expect(called).toBe(false)
    } finally {
      service.search = originalSearch
    }
  })

  it('rejects manual agent_thread reindexing', async () => {
    const res = await app.request(`/api/memory/${targetSquadId}/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ source: 'agent_thread' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('not user-reindexable')
  })

  it('reindexes requested external source', async () => {
    const service = ExternalSourceReindexService.instance()
    const originalReindexSquad = service.reindexSquad
    let receivedSourceTypes: unknown
    service.reindexSquad = (async (_squadId, options) => {
      receivedSourceTypes = options?.sourceTypes
      return {
        slack_thread: { indexed: 2, skipped: 0, failed: 0, disabled: false, errors: [] },
      } satisfies Awaited<ReturnType<typeof service.reindexSquad>>
    }) as typeof service.reindexSquad

    try {
      const res = await app.request(`/api/memory/${targetSquadId}/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ source: 'slack_thread' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(receivedSourceTypes).toEqual(['slack_thread'])
      expect(body.externalSources.slack_thread.indexed).toBe(2)
      expect(body.threadsIndexed).toBeUndefined()
    } finally {
      service.reindexSquad = originalReindexSquad
    }
  })

  it('reindexes external sources when source=all', async () => {
    const service = ExternalSourceReindexService.instance()
    const originalReindexSquad = service.reindexSquad
    let receivedSourceTypes: unknown = 'not-called'
    service.reindexSquad = (async (_squadId, options) => {
      receivedSourceTypes = options?.sourceTypes
      return {
        slack_thread: { indexed: 1, skipped: 0, failed: 0, disabled: false, errors: [] },
        slack_canvas: { indexed: 2, skipped: 0, failed: 0, disabled: false, errors: [] },
        github_issue: { indexed: 3, skipped: 0, failed: 0, disabled: false, errors: [] },
      } as Awaited<ReturnType<typeof service.reindexSquad>>
    }) as typeof service.reindexSquad

    try {
      const res = await app.request(`/api/memory/${targetSquadId}/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ source: 'all' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(receivedSourceTypes).toBeUndefined()
      expect(body.externalSources.slack_thread.indexed).toBe(1)
      expect(body.externalSources.slack_canvas.indexed).toBe(2)
      expect(body.externalSources.github_issue.indexed).toBe(3)
      expect(body.threadsIndexed).toBeUndefined()
    } finally {
      service.reindexSquad = originalReindexSquad
    }
  })

  it('returns 401 for unauthenticated memory reads', async () => {
    const res = await app.request(`/api/memory/${targetSquadId}/file?path=${encodeURIComponent('/memory/context.md')}`)

    expect(res.status).toBe(401)
  })

  it('returns 403 when a user lacks memory write permission for the squad', async () => {
    const user = await createTestUser({ prefix: `${rbacPrefix}-denied` })
    const role = await createTestRole({ prefix: `${rbacPrefix}-denied`, permissions: ['memory:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: targetSquadId })

    const res = await app.request(`/api/memory/${targetSquadId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(user.token) },
      body: JSON.stringify({ path: '/memory/notes/denied.md', content: '# denied\n' }),
    })

    expect(res.status).toBe(403)
  })

  it('derives cross-squad memory writer identity from the authenticated agent instead of callerSquadId', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: forgedSquadId,
      policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/notes/**'] } },
    })

    const agentTypeId = `${testPrefix}-agent-type`
    await AgentType.create({
      id: agentTypeId,
      name: 'Memory Test Agent',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    // ownerUserId on the ROW: since #1223 agent permissions resolve via the root
    // agent's ownerUserId, not the token's userId — without it this agent holds
    // nothing and the request dies at the generic permission gate instead of
    // reaching the forged-caller check this test pins.
    const agent = await Agent.create({ agentTypeId, squadId: callerSquadId, ownerUserId: admin.id })
    const token = await createTestAgentToken({ agentId: agent.id, squadId: callerSquadId, userId: admin.id })

    try {
      const res = await app.request(`/api/memory/${targetSquadId}/write?callerSquadId=${forgedSquadId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token.token) },
        body: JSON.stringify({ path: '/memory/notes/forged.md', content: '# forged\n' }),
      })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error.code).toBe('MEMORY_FORBIDDEN')
    } finally {
      await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, forgedSquadId))
      await db.delete(agentTokens).where(eq(agentTokens.agentId, agent.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    }
  })
})

describe('memory git sync webhook signature', () => {
  async function seedGitSyncSquad(name: string, webhookSecret: string) {
    const [squad] = await db
      .insert(squads)
      .values({
        name,
        purpose: 'test',
        metadata: {
          memory: {
            enabled: true,
            sync: {
              providers: [
                {
                  type: 'git',
                  repoUrl: 'git@example.com:x/y.git',
                  branch: 'main',
                  sshKeyName: 'k',
                  autoPull: true,
                  autoPush: false,
                  webhookSecret,
                },
              ],
              conflictPolicy: 'manual',
            },
          },
        },
      })
      .returning()
    return squad
  }

  it('rejects a git sync webhook with an invalid signature and does not pull', async () => {
    const squad = await seedGitSyncSquad(`mem-webhook-bad-${Date.now()}`, 'shhh')
    const { SyncService } = await import('../services/memory')
    const sync = SyncService.instance()
    const originalPull = sync.pull
    let pulled = false
    sync.pull = (async () => {
      pulled = true
      return { success: true, filesChanged: 0, conflicts: [] }
    }) as typeof sync.pull
    try {
      const res = await app.request(`/api/memory/${squad.id}/sync/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': 'sha256=deadbeef',
          ...authHeaders(admin.token),
        },
        body: JSON.stringify({ ref: 'refs/heads/main' }),
      })
      expect(res.status).toBe(401)
      expect(pulled).toBe(false)
    } finally {
      sync.pull = originalPull
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('accepts a git sync webhook with a valid HMAC signature and pulls', async () => {
    const secret = 'shhh'
    const squad = await seedGitSyncSquad(`mem-webhook-ok-${Date.now()}`, secret)
    const { SyncService } = await import('../services/memory')
    const { createHmac } = await import('crypto')
    const sync = SyncService.instance()
    const originalPull = sync.pull
    let pulled = false
    sync.pull = (async () => {
      pulled = true
      return { success: true, filesChanged: 0, conflicts: [] }
    }) as typeof sync.pull
    try {
      const body = JSON.stringify({ ref: 'refs/heads/main' })
      const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
      const res = await app.request(`/api/memory/${squad.id}/sync/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': sig,
          ...authHeaders(admin.token),
        },
        body,
      })
      expect(res.status).toBe(200)
      expect(pulled).toBe(true)
    } finally {
      sync.pull = originalPull
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('memory workspace-files sandbox callback auth', () => {
  it('authenticates by SANDBOX_CALLBACK_SECRET regardless of admin users', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ws-files-${Date.now()}`, purpose: 't' })
      .returning()
    const original = process.env.SANDBOX_CALLBACK_SECRET
    const sandboxSecret = `sandbox-secret-${Date.now()}`
    process.env.SANDBOX_CALLBACK_SECRET = sandboxSecret
    try {
      const store = getSecretStore()
      try {
        await store.initialize()
        await store.set('SANDBOX_CALLBACK_SECRET', sandboxSecret, 'test')
      } catch {
        // Env-fallback mode has no writable DB-backed secret store; the env var above is enough.
        resetSecretStore()
      }

      // Correct secret -> 200 (even though a canonical admin exists, which would
      // disable legacy FICUS_PASSWORD auth).
      const ok = await app.request(`/api/memory/${squad.id}/workspace-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sandboxSecret}` },
        body: JSON.stringify({ files: [] }),
      })
      expect(ok.status).toBe(200)

      const bad = await app.request(`/api/memory/${squad.id}/workspace-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
        body: JSON.stringify({ files: [] }),
      })
      expect(bad.status).toBe(401)

      const none = await app.request(`/api/memory/${squad.id}/workspace-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [] }),
      })
      expect(none.status).toBe(401)
    } finally {
      const store = getSecretStore()
      try {
        await store.initialize()
        await store.delete('SANDBOX_CALLBACK_SECRET')
      } catch {
        // Env-fallback mode has no DB-backed secret to clear.
      } finally {
        resetSecretStore()
      }
      if (original !== undefined) process.env.SANDBOX_CALLBACK_SECRET = original
      else delete process.env.SANDBOX_CALLBACK_SECRET
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('workspace-files uses namespaced mount path', () => {
  it('indexContent receives /workspace/<squadId>/<file.path>', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ws-ns-${Date.now()}`, purpose: 't' })
      .returning()

    const sandboxSecret = `sandbox-secret-ns-${Date.now()}`
    const original = process.env.SANDBOX_CALLBACK_SECRET
    process.env.SANDBOX_CALLBACK_SECRET = sandboxSecret

    const source = WorkspaceFileSource.instance()
    const capturedArgs: { squadId: string; path: string; content: string }[] = []
    const originalIndexContent = source.indexContent.bind(source)
    source.indexContent = async (args) => {
      capturedArgs.push(args)
      return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    }

    try {
      const store = getSecretStore()
      try {
        await store.initialize()
        await store.set('SANDBOX_CALLBACK_SECRET', sandboxSecret, 'test')
      } catch {
        resetSecretStore()
      }

      const filePath = 'src/app.ts'
      const res = await app.request(`/api/memory/${squad.id}/workspace-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sandboxSecret}` },
        body: JSON.stringify({ files: [{ event: 'change', path: filePath, content: 'const x = 1' }] }),
      })
      expect(res.status).toBe(200)
      expect(capturedArgs.length).toBeGreaterThan(0)
      expect(capturedArgs[0].path).toBe(`/workspace/${squad.id}/${filePath}`)
    } finally {
      source.indexContent = originalIndexContent
      const store = getSecretStore()
      try {
        await store.initialize()
        await store.delete('SANDBOX_CALLBACK_SECRET')
      } catch {
        // env-fallback mode has no DB-backed secret to clear
      } finally {
        resetSecretStore()
      }
      if (original !== undefined) process.env.SANDBOX_CALLBACK_SECRET = original
      else delete process.env.SANDBOX_CALLBACK_SECRET
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})
