import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { db } from '../db'
import { agents, squads } from '../db/schema'
import { identityMiddleware } from '../middleware'
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
import { agentPrivateRouter } from './agent-private'

// Local-disk runtime (docker): the private area is <HOME_DIR>/private/agent_<id>,
// which the box sees at /private. No real sandbox is started by these tests.
const prefix = `agent-private-${crypto.randomUUID().slice(0, 8)}`
const squadId = crypto.randomUUID()
const otherSquadId = crypto.randomUUID()
let admin: TestUser
let agentId: string
let otherAgentId: string
let otherSquadAgentId: string
let home: string
const originalHome = process.env.HOME_DIR
const originalRuntime = process.env.FICUS_SANDBOX_RUNTIME

function app() {
  const hono = new Hono()
  hono.use('/api/*', identityMiddleware)
  hono.route('/api/agents', agentPrivateRouter)
  return hono
}

function get(path: string, token?: string) {
  return app().request(path, { headers: token ? authHeaders(token) : {} })
}

function upload(id: string, files: Record<string, string>, token: string, query = '') {
  const form = new FormData()
  Object.entries(files).forEach(([path, content], index) => {
    form.append(`file_${index}`, new File([content], path.split('/').pop()!))
    form.append(`path_file_${index}`, path)
  })
  return app().request(`/api/agents/${id}/private/upload${query}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  })
}

const privateDir = (id: string) => join(home, 'private', `agent_${id}`)

async function userWith(permissions: string[], scopeSquadId = squadId): Promise<TestUser> {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: scopeSquadId })
  return user
}

beforeAll(async () => {
  await db
    .insert(squads)
    .values([squadId, otherSquadId].map((id) => ({ id, name: `${prefix}-${id}`, purpose: 'agent private area' })))
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-private-route-'))
  process.env.HOME_DIR = home
  process.env.FICUS_SANDBOX_RUNTIME = 'docker-sysbox'
  const rows = await db
    .insert(agents)
    .values([
      { agentTypeId: 'engineer', squadId },
      { agentTypeId: 'engineer', squadId },
      { agentTypeId: 'engineer', squadId: otherSquadId },
    ])
    .returning({ id: agents.id })
  ;[agentId, otherAgentId, otherSquadAgentId] = rows.map((row) => row.id)
})

afterEach(async () => {
  await db.delete(agents).where(inArray(agents.squadId, [squadId, otherSquadId]))
  await rm(home, { recursive: true, force: true })
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  if (originalRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = originalRuntime
  await cleanupTestRbac(prefix)
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
})

describe('agent private area authorization', () => {
  test('requires an identity', async () => {
    expect((await get(`/api/agents/${agentId}/private/tree`)).status).toBe(401)
  })

  test('denies every kind of miss with the same 403', async () => {
    const workspaceOnly = await userWith(['workspace:*', 'terminal:*', 'agents:read'])
    const otherSquadOperator = await userWith(['agents:private-access', 'terminal:access'], otherSquadId)
    const [subagent] = await db
      .insert(agents)
      .values({ agentTypeId: 'engineer', squadId, parentAgentId: agentId })
      .returning({ id: agents.id })
    const [consultant] = await db
      .insert(agents)
      .values({ agentTypeId: 'consultant', squadId })
      .returning({ id: agents.id })
    const agentToken = await createTestAgentToken({ agentId: otherAgentId, squadId })

    const denials = [
      await get(`/api/agents/${agentId}/private/tree`, workspaceOnly.token),
      await get(`/api/agents/${agentId}/private/tree`, otherSquadOperator.token),
      await get(`/api/agents/${crypto.randomUUID()}/private/tree`, admin.token),
      await get(`/api/agents/not-a-uuid/private/tree`, admin.token),
      await get(`/api/agents/${subagent!.id}/private/tree`, admin.token),
      await get(`/api/agents/${consultant!.id}/private/tree`, admin.token),
      await get(`/api/agents/${agentId}/private/tree`, agentToken.token),
    ]
    for (const response of denials) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Forbidden' })
    }
  })

  test('an operator of the agent’s squad gets files but no terminal without terminal:access', async () => {
    const operator = await userWith(['agents:private-access'])
    const status = await get(`/api/agents/${agentId}/private/status`, operator.token)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      agentId,
      sandboxId: `agent_${agentId}`,
      privateRoot: '/private',
      live: true,
      filesAvailable: true,
      canUseTerminal: false,
    })
    const withTerminal = await userWith(['agents:private-access', 'terminal:access'])
    expect(await (await get(`/api/agents/${agentId}/private/status`, withTerminal.token)).json()).toMatchObject({
      canUseTerminal: true,
    })
    // The other squad's agent stays out of reach for this squad's operator.
    expect((await get(`/api/agents/${otherSquadAgentId}/private/status`, withTerminal.token)).status).toBe(403)
  })
})

describe('agent private files', () => {
  test('upload lands only in that agent’s private dir and returns the path the agent sees', async () => {
    const response = await upload(agentId, { 'creds/token.txt': 'fake-token-123' }, admin.token)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      uploaded: 1,
      results: [{ path: 'creds/token.txt', status: 'created', agentPath: '/private/creds/token.txt' }],
    })
    const written = join(privateDir(agentId), 'creds', 'token.txt')
    expect(await readFile(written, 'utf8')).toBe('fake-token-123')
    expect((await stat(written)).mode & 0o777).toBe(0o600)
    // Not in another agent's private area, not in the shared squad workspace.
    expect(existsSync(join(privateDir(otherAgentId), 'creds', 'token.txt'))).toBe(false)
    expect(existsSync(join(home, 'workspaces', 'squads', squadId, 'creds'))).toBe(false)

    const tree = await (await get(`/api/agents/${agentId}/private/tree?path=creds`, admin.token)).json()
    expect(tree.children).toEqual([{ name: 'token.txt', type: 'file', size: 14 }])
    const file = await (await get(`/api/agents/${agentId}/private/file?path=creds/token.txt`, admin.token)).json()
    expect(file).toMatchObject({ content: 'fake-token-123', agentPath: '/private/creds/token.txt', binary: false })
    const otherTree = await (await get(`/api/agents/${otherAgentId}/private/tree`, admin.token)).json()
    expect(otherTree.children).toEqual([])
  })

  test('the upload dir may be the agent-visible absolute path', async () => {
    const response = await (await upload(agentId, { 'token.txt': 'abc' }, admin.token, '?dir=/private/creds')).json()
    expect(response.results).toEqual([
      { path: 'creds/token.txt', status: 'created', agentPath: '/private/creds/token.txt' },
    ])
    expect(await readFile(join(privateDir(agentId), 'creds', 'token.txt'), 'utf8')).toBe('abc')
  })

  test('existing files are skipped unless overwrite is requested', async () => {
    await upload(agentId, { 'a.txt': 'one' }, admin.token)
    const skipped = await (await upload(agentId, { 'a.txt': 'two' }, admin.token)).json()
    expect(skipped.results[0].status).toBe('skipped')
    const replaced = await (await upload(agentId, { 'a.txt': 'two' }, admin.token, '?overwrite=true')).json()
    expect(replaced.results[0].status).toBe('overwritten')
    expect(await readFile(join(privateDir(agentId), 'a.txt'), 'utf8')).toBe('two')
  })

  test('download is an opaque attachment', async () => {
    await upload(agentId, { 'page.html': '<script>alert(1)</script>' }, admin.token)
    const response = await get(`/api/agents/${agentId}/private/download?path=page.html`, admin.token)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('<script>alert(1)</script>')
  })

  test('confines every path to the private root', async () => {
    await mkdir(join(home, 'workspaces', 'squads', squadId), { recursive: true })
    await writeFile(join(home, 'outside.txt'), 'core host file')
    const cases = [
      `/api/agents/${agentId}/private/tree?path=..`,
      `/api/agents/${agentId}/private/tree?path=../agent_${otherAgentId}`,
      `/api/agents/${agentId}/private/file?path=../../outside.txt`,
      `/api/agents/${agentId}/private/file?path=/etc/passwd`,
      `/api/agents/${agentId}/private/download?path=/private/../../outside.txt`,
    ]
    for (const path of cases) expect((await get(path, admin.token)).status).toBe(400)

    const escapes = await (
      await upload(
        agentId,
        { [`../../workspaces/squads/${squadId}/evil.txt`]: 'x', [`../agent_${otherAgentId}/evil.txt`]: 'x' },
        admin.token
      )
    ).json()
    expect(escapes.results.map((result: { status: string }) => result.status)).toEqual(['error', 'error'])
    expect((await upload(agentId, { 'evil.txt': 'x' }, admin.token, '?dir=../..')).status).toBe(400)
    expect((await upload(agentId, { 'evil.txt': 'x' }, admin.token, '?dir=/workspace')).status).toBe(400)
    expect(existsSync(join(home, 'workspaces', 'squads', squadId, 'evil.txt'))).toBe(false)
    expect(existsSync(join(home, 'evil.txt'))).toBe(false)
  })

  test('never follows a symlink the agent planted', async () => {
    await mkdir(privateDir(agentId), { recursive: true })
    await writeFile(join(home, 'core-secret.txt'), 'core secret')
    await symlink(join(home, 'core-secret.txt'), join(privateDir(agentId), 'looks-innocent.txt'))
    await symlink(home, join(privateDir(agentId), 'escape'))

    const tree = await (await get(`/api/agents/${agentId}/private/tree`, admin.token)).json()
    expect(tree.children).toEqual([
      { name: 'escape', type: 'file', symlink: true },
      { name: 'looks-innocent.txt', type: 'file', symlink: true },
    ])
    const read = await get(`/api/agents/${agentId}/private/file?path=looks-innocent.txt`, admin.token)
    expect(read.status).toBe(400)
    expect(await read.json()).toMatchObject({ code: 'symlink' })
    expect((await get(`/api/agents/${agentId}/private/file?path=escape/core-secret.txt`, admin.token)).status).toBe(400)
    expect((await get(`/api/agents/${agentId}/private/tree?path=escape`, admin.token)).status).toBe(400)

    const overwrite = await (
      await upload(
        agentId,
        { 'looks-innocent.txt': 'pwned', 'escape/new.txt': 'pwned' },
        admin.token,
        '?overwrite=true'
      )
    ).json()
    expect(overwrite.results.map((result: { status: string }) => result.status)).toEqual(['error', 'error'])
    expect(await readFile(join(home, 'core-secret.txt'), 'utf8')).toBe('core secret')
    expect(existsSync(join(home, 'new.txt'))).toBe(false)
  })

  test('hides platform custody files and keeps chat attachments read-only', async () => {
    await mkdir(join(privateDir(agentId), '.ficus'), { recursive: true })
    await writeFile(join(privateDir(agentId), '.ficus', 'identity.pem'), 'FAKE KEY')
    // Per-agent Secret Store values (agent-secrets-file.ts) live here too.
    await writeFile(join(privateDir(agentId), '.ficus', 'agent-secrets.env'), 'export FAKE_TOKEN=not-a-real-value')
    await writeFile(join(privateDir(agentId), 'identity.pem'), 'FAKE KEY')
    await mkdir(join(privateDir(agentId), 'chat-attachments'), { recursive: true })
    await writeFile(join(privateDir(agentId), 'notes.md'), '# notes')

    const tree = await (await get(`/api/agents/${agentId}/private/tree`, admin.token)).json()
    expect(tree.children.map((child: { name: string }) => child.name)).toEqual(['chat-attachments', 'notes.md'])
    for (const path of ['.ficus/identity.pem', '.ficus/agent-secrets.env', 'identity.pem', '/private/identity.pem']) {
      expect((await get(`/api/agents/${agentId}/private/file?path=${path}`, admin.token)).status).toBe(404)
      expect((await get(`/api/agents/${agentId}/private/download?path=${path}`, admin.token)).status).toBe(404)
    }
    expect((await get(`/api/agents/${agentId}/private/tree?path=.ficus`, admin.token)).status).toBe(404)

    const refused = await (
      await upload(
        agentId,
        { 'chat-attachments/x.txt': 'x', '.ficus/identity.pem': 'x', 'identity.pem': 'x' },
        admin.token,
        '?overwrite=true'
      )
    ).json()
    expect(refused.results.map((result: { status: string }) => result.status)).toEqual(['error', 'error', 'error'])
    expect(await readFile(join(privateDir(agentId), 'identity.pem'), 'utf8')).toBe('FAKE KEY')
  })

  test('a dormant agent’s files stay browsable on local storage but its box is not started', async () => {
    await upload(agentId, { 'kept.txt': 'kept' }, admin.token)
    await db
      .update(agents)
      .set({ status: 'dormant' })
      .where(inArray(agents.id, [agentId]))
    const status = await (await get(`/api/agents/${agentId}/private/status`, admin.token)).json()
    expect(status).toMatchObject({ live: false, canStart: false, canUseTerminal: false, filesAvailable: true })
    const file = await (await get(`/api/agents/${agentId}/private/file?path=kept.txt`, admin.token)).json()
    expect(file.content).toBe('kept')
    const start = await app().request(`/api/agents/${agentId}/private/start`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(start.status).toBe(409)
    expect(await start.json()).toMatchObject({ reason: 'dormant' })
  })
})
