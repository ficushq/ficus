import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import * as derivation from '../services/public-voice/derive'
import { DerivationError } from '../services/public-voice/github-activity'
import { Hono } from 'hono'
import { inArray, like } from 'drizzle-orm'
import { db, publicVoices, squads } from '../db'
import { PublicVoice } from '../entities/PublicVoice'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { publicVoiceSync } from '../services/config-sync'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { __derivationsInProgress, squadVoiceRouter } from './squad-voice'
import { Agent } from '../entities/Agent'
import { RoleSync } from '../services/config-sync/role-sync'
import { agents } from '../db'
import { eq } from 'drizzle-orm'
import { createTestAgentToken } from '../test-utils'
import { AgentType } from '../entities/AgentType'
import { agentTypeSync, sharedPromptSync } from '../services/config-sync'
import { composeAgentTypePrompt } from '../services/agent-types/compose-prompt'
import { interpolateTemplate } from '../lib/prompts/prompt-builder'
import { buildPublicVoicePrompt } from '../lib/prompts/public-voice-prompt'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadVoiceRouter)

const prefix = `squad-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const teamId = `${prefix}-team`
let admin: TestUser
let reader: TestUser
let updaterWithoutIntegrations: TestUser
let squadId: string
const squadIds: string[] = []

beforeAll(async () => {
  await publicVoiceSync.sync()
  await PublicVoice.upsert({ id: teamId, name: 'Team', base: 'Team voice.' })
  admin = await createTestAdmin({ prefix })
  const squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'voice' })
  squadId = squad.id
  squadIds.push(squad.id)

  reader = await createTestUser({ prefix })
  const readRole = await createTestRole({ prefix, permissions: ['squads:read'] })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'squad', squadId })

  updaterWithoutIntegrations = await createTestUser({ prefix })
  const updateRole = await createTestRole({ prefix, permissions: ['squads:read', 'squads:update'] })
  await assignRole({ userId: updaterWithoutIntegrations.id, roleId: updateRole.id, scope: 'squad', squadId })
})

afterAll(async () => {
  await db.delete(squads).where(inArray(squads.id, squadIds))
  await db.delete(publicVoices).where(like(publicVoices.id, `${prefix}%`))
  await PublicVoice.setDisabled('default', false)
  await cleanupTestRbac(prefix)
})

function request(user: TestUser, method: string, path: string, body?: unknown) {
  return app.request(`/api/squads/${squadId}/voice${path}`, {
    method,
    headers: { ...authHeaders(user.token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('squad voice routes', () => {
  test('a fresh squad uses the instance default and lists the profiles it may choose', async () => {
    const res = await request(reader, 'GET', '')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.voiceId).toBeNull()
    expect(body.resolved.baseSource).toBe('instance')
    expect(body.profile.id).toBe('default')
    expect(body.availableVoices.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining(['default', teamId]))
    expect(body.availableVoices[0]).not.toHaveProperty('base')
    expect(body.resolved.rendered).toStartWith('### Voice')
    expect(body.resolved.maxBytes).toBe(2000)
    expect(body.linkedGitHubLogin).toBeNull()
  })

  test('assigning a profile, then a custom base, then a profile again keeps one base source', async () => {
    let body = await (await request(admin, 'PATCH', '', { voiceId: teamId })).json()
    expect(body.resolved.baseSource).toBe('profile')
    expect(body.voiceId).toBe(teamId)

    body = await (await request(admin, 'PATCH', '', { base: 'Ours.' })).json()
    expect(body.voiceId).toBeNull()
    expect(body.resolved.baseSource).toBe('squad')
    expect(body.resolved.base).toBe('Ours.')

    body = await (await request(admin, 'PATCH', '', { voiceId: teamId })).json()
    expect(body.local.base).toBeNull()
    expect(body.resolved.baseSource).toBe('profile')
  })

  test('refuses a base with a voice id, an unknown profile, and an over-cap voice', async () => {
    let res = await request(admin, 'PATCH', '', { base: 'x', voiceId: teamId })
    expect(res.status).toBe(400)
    res = await request(admin, 'PATCH', '', { voiceId: 'no-such-voice' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown_voice' })
    res = await request(admin, 'PATCH', '', {
      surfaces: { commits: { mode: 'add', text: 'a'.repeat(1000) }, channels: { mode: 'add', text: 'b'.repeat(1000) } },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'public_voice_too_long', maxBytes: 2000 })
  })

  test('surface entries merge, shadow the profile, and delete with null', async () => {
    await request(admin, 'PATCH', '', { voiceId: teamId })
    let body = await (
      await request(admin, 'PATCH', '', { surfaces: { commits: { mode: 'override', text: 'Subject.' } } })
    ).json()
    expect(body.voiceId).toBe(teamId)
    expect(body.resolved.entrySources.commits).toBe('squad')
    expect(body.resolved.perSurface.commits).toBe('Subject.')

    body = await (await request(admin, 'PATCH', '', { surfaces: { channels: { mode: 'add', text: 'Short.' } } })).json()
    expect(Object.keys(body.local.surfaces).sort()).toEqual(['channels', 'commits'])

    body = await (await request(admin, 'PATCH', '', { surfaces: { commits: null } })).json()
    expect(Object.keys(body.local.surfaces)).toEqual(['channels'])
  })

  test('choosing the instance default replaces a custom base', async () => {
    await request(admin, 'PATCH', '', { base: 'Ours.' })
    const body = await (await request(admin, 'PATCH', '', { voiceId: null })).json()
    expect(body.local.base).toBeNull()
    expect(body.resolved.baseSource).toBe('instance')
  })

  test('a disabled assigned profile falls back to the instance default', async () => {
    await request(admin, 'PATCH', '', { voiceId: teamId })
    await PublicVoice.setDisabled(teamId, true)
    try {
      const body = await (await request(admin, 'GET', '')).json()
      expect(body.fallback).toBe('assigned_disabled')
      expect(body.resolved.baseSource).toBe('instance')
    } finally {
      await PublicVoice.setDisabled(teamId, false)
    }
  })

  test('DELETE clears the assignment and the squad layer', async () => {
    expect((await request(admin, 'DELETE', '')).status).toBe(200)
    const squad = (await Squad.find(squadId))!
    expect(squad.publicVoiceId).toBeNull()
    expect(squad.publicVoice).toBeNull()
  })

  test('squads:read cannot change the voice', async () => {
    expect((await request(reader, 'PATCH', '', { voiceId: teamId })).status).toBe(403)
    expect((await request(reader, 'DELETE', '')).status).toBe(403)
    expect((await request(reader, 'POST', '/preview', { surface: 'commits' })).status).toBe(403)
  })

  test('derive logs only bounded diagnostic codes and reasons, never private content', async () => {
    const privateFixture = 'SYNTHETIC_PRIVATE_CONTENT'
    const cases: Array<readonly [DerivationError['code'], unknown, string, number]> = [
      ...['not_json', 'schema', 'unsafe_base', 'private_text_in_base', 'too_long'].map(
        (reason) => ['derivation_invalid_output', reason, reason, 422] as const
      ),
      ...['timeout', 'empty_output'].map((reason) => ['derivation_model_unavailable', reason, reason, 422] as const),
      ...['no_token', 'network', 'invalid_body', 'rate_limited', 'http_401', 'http_429', 'http_503'].map(
        (reason) => ['derivation_github_unavailable', reason, reason, 422] as const
      ),
      ['derivation_login_not_visible', undefined, 'unspecified', 422],
      ['derivation_too_few_samples', undefined, 'unspecified', 422],
      ['derivation_model_unavailable', undefined, 'unspecified', 422],
      ...[privateFixture, 'schema\nforged log', 'http_503\n', 'x'.repeat(10000), { text: privateFixture }].map(
        (reason) => ['derivation_invalid_output', reason, 'unknown', 422] as const
      ),
      ['derivation_github_unavailable', 'http_503\n', 'unknown', 422],
    ]
    const derive = spyOn(derivation, 'derivePublicVoice')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const [code, reason, expectedReason, status] of cases) {
        warn.mockClear()
        const details = {
          reason,
          samples: [privateFixture],
          draft: privateFixture,
          modelOutput: privateFixture,
          login: 'private-login',
          credential: privateFixture,
          counts: { collected: 10, kept: 2 },
          minimum: 8,
        }
        derive.mockRejectedValueOnce(new DerivationError(code, details))
        const res = await request(admin, 'POST', '/derive', { login: 'octocat' })
        expect(res.status).toBe(status)
        expect(await res.json()).toMatchObject({ error: code, counts: details.counts })
        const diagnostic = warn.mock.calls.find((args) => args.includes('Voice derivation failed'))
        expect(diagnostic).toBeDefined()
        expect(diagnostic!.at(-1)).toEqual({ squadId, code, reason: expectedReason })
        expect(JSON.stringify(warn.mock.calls)).not.toContain(privateFixture)
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-login')
      }
    } finally {
      derive.mockRestore()
      warn.mockRestore()
    }
  })

  test('a person can derive another visible login immediately without saving', async () => {
    const result = { login: 'another-login', draft: { base: 'Synthetic draft.', surfaces: {} } }
    const derive = spyOn(derivation, 'derivePublicVoice').mockResolvedValue(result as any)
    const before = await Squad.find(squadId)
    try {
      const res = await request(admin, 'POST', '/derive', { login: result.login })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(result)
      const after = await Squad.find(squadId)
      expect(after?.publicVoice).toEqual(before?.publicVoice)
      expect(after?.publicVoiceId).toBe(before?.publicVoiceId)
    } finally {
      derive.mockRestore()
    }
  })

  test('derive needs integrations:use and one run per squad', async () => {
    expect((await request(updaterWithoutIntegrations, 'POST', '/derive', { login: 'octocat' })).status).toBe(403)

    expect(
      (await request(admin, 'POST', '/derive', { login: 'octocat', filters: { before: 'yesterday' } })).status
    ).toBe(400)

    __derivationsInProgress.set(squadId, Symbol('fixture'))
    try {
      const busy = await request(admin, 'POST', '/derive', { login: 'octocat' })
      expect(busy.status).toBe(429)
    } finally {
      __derivationsInProgress.delete(squadId)
    }
  })
})

describe('one profile shared by two squads', () => {
  test("both squads' composed engineer prompts carry the profile's voice exactly once", async () => {
    await sharedPromptSync.sync()
    await agentTypeSync.sync()
    AgentType.invalidateCache()
    const second = await Squad.create({ name: `${prefix}-second`, purpose: 'voice' })
    squadIds.push(second.id)
    await PublicVoice.upsert({ id: teamId, name: 'Team', base: 'SHARED-TEAM-VOICE.' })
    for (const id of [squadId, second.id]) await Squad.setPublicVoice(id, { publicVoiceId: teamId, publicVoice: null })

    const engineerPrompt = await composeAgentTypePrompt((await AgentType.find('engineer'))!)
    expect(engineerPrompt.split('{{squad.publicVoice}}')).toHaveLength(2)
    for (const id of [squadId, second.id]) {
      const squad = (await Squad.find(id))!
      const prompt = interpolateTemplate(engineerPrompt, { 'squad.publicVoice': await buildPublicVoicePrompt(squad) })
      expect(prompt.split('SHARED-TEAM-VOICE.')).toHaveLength(2)
      expect(prompt.split('### Voice')).toHaveLength(2)
      expect(prompt).toContain('## Public text')
    }
  })
})

describe('derivation needs a person', () => {
  test('a manager agent holding squads:update and integrations:use is refused', async () => {
    await new RoleSync().sync()
    const agent = await Agent.create({ agentTypeId: 'manager', squadId })
    try {
      const { token } = await createTestAgentToken({ agentId: agent.id, squadId })
      const headers = { ...authHeaders(token), 'content-type': 'application/json' }
      // The agent can read and change the voice, so the refusal below is about who is calling.
      expect((await app.request(`/api/squads/${squadId}/voice`, { headers })).status).toBe(200)
      const res = await app.request(`/api/squads/${squadId}/voice/derive`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ login: 'octocat' }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'derivation_requires_person' })
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })
})
