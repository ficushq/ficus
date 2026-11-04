/**
 * The Viewer and Demo Reviewer default roles hold no permission that opens a
 * terminal or controls a box. Each role is built from its exact permission
 * list in config/roles/defaults.yaml and granted instance-wide (the broadest
 * scope), then every terminal, session and box-control route is called with
 * it: the terminal WebSocket handshake, the terminal session routes, and the
 * squad box and agent box stop, restart, process and container controls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { parse } from 'yaml'
import { Permissions, permissionMatches } from '@ficus/shared'
import { authorizeTerminalRequest } from './index'
import { agents, db, squads } from './db'
import { CONFIG_DIR } from './lib/paths'
import { identityMiddleware } from './middleware/identity'
import { agentsRouter } from './routes/agents'
import { squadsRouter } from './routes/squads'
import { terminalRouter } from './routes/terminal'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from './test-utils'

const defaults = parse(readFileSync(join(CONFIG_DIR, 'roles', 'defaults.yaml'), 'utf-8')) as {
  roles: Array<{ slug: string; permissions: string[] }>
}
const rolePermissions = (slug: string) => {
  const role = defaults.roles.find((candidate) => candidate.slug === slug)
  if (!role) throw new Error(`default role ${slug} is missing`)
  return role.permissions
}

/** What each terminal or box-control route actually checks (traced in the route code). */
const TERMINAL_AND_BOX_CONTROL_PERMISSIONS = [
  Permissions.TERMINAL_ACCESS, // /ws/terminal and /api/terminal/sessions (services/sandbox/terminal-access.ts)
  'terminal:read', // GET /api/squads/:id/terminal/sessions and /workspace/sessions
  'terminal:write', // DELETE /api/squads/:id/terminal/sessions/:sessionId
  Permissions.AGENTS_PRIVATE_ACCESS, // an agent box terminal also needs the private-area rule
  'squads:update', // squad box stop, restart, processes and containers
  'agents:update', // agent box stop, restart, processes and containers
]

const ROLES = ['viewer', 'demo-reviewer'] as const

describe('default role permissions', () => {
  for (const slug of ROLES) {
    it(`${slug} holds nothing that grants a terminal or box control`, () => {
      const held = rolePermissions(slug)
      for (const requested of TERMINAL_AND_BOX_CONTROL_PERMISSIONS) {
        expect([requested, held.filter((permission) => permissionMatches(permission, requested))]).toEqual([
          requested,
          [],
        ])
      }
    })
  }
})

const prefix = `viewer-terminal-${crypto.randomUUID()}`
const squadId = crypto.randomUUID()
let agentId: string
const users: Partial<Record<(typeof ROLES)[number], TestUser>> = {}

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)
app.route('/api/agents', agentsRouter)
app.route('/api/terminal', terminalRouter)

beforeAll(async () => {
  await db.insert(squads).values({ id: squadId, name: `${prefix}-squad`, purpose: 'RBAC scope' })
  const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId }).returning()
  agentId = agent!.id
  for (const slug of ROLES) {
    const role = await createTestRole({ prefix, slug: `${prefix}-${slug}`, permissions: rolePermissions(slug) })
    const user = await createTestUser({ prefix })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
    users[slug] = user
  }
})

afterAll(async () => {
  await db.delete(agents).where(inArray(agents.squadId, [squadId]))
  await cleanupTestRbac(prefix)
  await db.delete(squads).where(inArray(squads.id, [squadId]))
})

function routes(): Array<[method: 'GET' | 'POST' | 'DELETE', path: string]> {
  return [
    ['GET', `/api/terminal/sessions?sandboxId=squad_${squadId}`],
    ['GET', `/api/terminal/sessions?sandboxId=agent_${agentId}`],
    ['GET', `/api/squads/${squadId}/terminal/sessions`],
    ['DELETE', `/api/squads/${squadId}/terminal/sessions/any-session`],
    ['GET', `/api/squads/${squadId}/workspace/sessions`],
    ['POST', `/api/squads/${squadId}/sandbox/stop`],
    ['POST', `/api/squads/${squadId}/sandbox/restart`],
    ['GET', `/api/squads/${squadId}/sandbox/processes`],
    ['POST', `/api/squads/${squadId}/sandbox/processes/4242/signal`],
    ['POST', `/api/squads/${squadId}/sandbox/containers/abc123/stop`],
    ['POST', `/api/agents/${agentId}/sandbox/stop`],
    ['POST', `/api/agents/${agentId}/sandbox/restart`],
    ['GET', `/api/agents/${agentId}/sandbox/processes`],
    ['POST', `/api/agents/${agentId}/sandbox/processes/4242/signal`],
    ['POST', `/api/agents/${agentId}/sandbox/containers/abc123/stop`],
  ]
}

describe('Viewer and Demo Reviewer are refused every terminal and box-control route', () => {
  for (const slug of ROLES) {
    it(`${slug} cannot open the terminal WebSocket for the squad box or an agent box`, async () => {
      const token = users[slug]!.token
      for (const query of [`squadId=${squadId}`, `sandboxId=squad_${squadId}`, `sandboxId=agent_${agentId}`]) {
        expect([query, await authorizeTerminalRequest(`http://localhost/ws/terminal?${query}&token=${token}`)]).toEqual(
          [query, { ok: false, status: 403 }]
        )
      }
    })

    it(`${slug} is refused on every terminal session and box-control route`, async () => {
      const token = users[slug]!.token
      for (const [method, path] of routes()) {
        const res = await app.request(path, {
          method,
          headers: { ...authHeaders(token), 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
        expect([method, path, res.status]).toEqual([method, path, 403])
      }
    })
  }
})
