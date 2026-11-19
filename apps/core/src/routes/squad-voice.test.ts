import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import * as derivation from '../services/public-voice/derive'
import * as operations from '../services/public-voice/operation'
import * as progressStreams from '../services/public-voice/progress-stream'
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

function request(user: TestUser, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api/squads/${squadId}/voice${path}`, {
    method,
    headers: { ...authHeaders(user.token), 'content-type': 'application/json', ...headers },
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

for (const code of [
  'derivation_github_unavailable',
  'derivation_login_not_visible',
  'derivation_too_few_samples',
  'derivation_invalid_output',
  'derivation_model_unavailable',
] as const) {
  test(`stream preserves ${code}, the last safe snapshot and no arbitrary exception fields`, async () => {
    const derive = spyOn(derivation, 'derivePublicVoice').mockImplementationOnce(async (input) => {
      await input.onProgress?.({ type: 'phase', phase: 'sampling' })
      throw new DerivationError(code, {
        reason: code === 'derivation_invalid_output' ? 'schema' : undefined,
        counts: { collected: 10, kept: 2 },
        minimum: 15,
        raw: 'SYNTHETIC_PRIVATE_SENTINEL',
      })
    })
    try {
      const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform')
      const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
      expect(events.map((event) => event.type)).toEqual(['started', 'phase', 'error'])
      expect(events.at(-1).error).toMatchObject({ code, counts: { collected: 10, kept: 2 }, minimum: 15 })
      expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL')
      expect(__derivationsInProgress.has(squadId)).toBe(false)
    } finally {
      derive.mockRestore()
    }
  })
}
test('stream negotiation does not turn permission and contention denials into successful streams', async () => {
  expect((await request(reader, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })).status).toBe(
    403
  )
  __derivationsInProgress.set(squadId, Symbol('fixture'))
  try {
    const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })
    expect(response.status).toBe(429)
    expect(response.headers.get('Content-Type')).toContain('application/json')
  } finally {
    __derivationsInProgress.delete(squadId)
  }
})

test('a real derivation result crosses the success writer schema and remains unsaved', async () => {
  const realDerive = derivation.derivePublicVoice
  const before = await Squad.find(squadId)
  const derive = spyOn(derivation, 'derivePublicVoice').mockImplementation((input) =>
    realDerive(input, {
      collect: async () => ({
        items: Array.from({ length: 20 }, (_, i) => ({
          surface: 'issue-comments' as const,
          text: `Synthetic candidate ${i} contains enough distinct writing for collection.`,
          repository: 'example/library',
          isPrivate: true,
          createdAt: '2026-01-01T00:00:00Z',
        })),
        pagingCapped: false,
        requests: 1,
        droppedByFilter: { date: 0, repository: 0 },
        filteredBySurface: {},
        unavailableRepositories: [],
        commitRepositoriesNotSampled: [],
      }),
      session: async () => JSON.stringify({ base: 'Lead with the result.', observations: ['Use complete sentences.'] }),
    })
  )
  try {
    const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events.at(-1).type).toBe('complete')
    expect(events.at(-1).result.sampling.counts.kept).toBe(20)
    expect(events.at(-1).result.sampling.breakdown.totals.seen).toBe(20)
    expect(events.at(-1).result.observations).toEqual(['Use complete sentences.'])
    expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1))
    expect((await Squad.find(squadId))?.publicVoice).toEqual(before?.publicVoice)
  } finally {
    derive.mockRestore()
  }
})
test('a rejected complete result logs a diagnostic and sends a contiguous terminal error', async () => {
  const derive = spyOn(derivation, 'derivePublicVoice').mockResolvedValue({
    privateField: 'SYNTHETIC_PRIVATE_SENTINEL',
  } as any)
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, 'started'],
      [2, 'error'],
    ])
    expect(events.at(-1).error.code).toBe('derivation_failed')
    expect(errorLog.mock.calls).toHaveLength(1)
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL')
  } finally {
    derive.mockRestore()
    errorLog.mockRestore()
  }
})
test('unexpected exceptions retain error-level names and stack locations without leaking messages', async () => {
  const derive = spyOn(derivation, 'derivePublicVoice').mockRejectedValue(new TypeError('SYNTHETIC_PRIVATE_SENTINEL'))
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await request(admin, 'POST', '/derive', { login: 'octo' })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'derivation_failed' })
    expect(errorLog.mock.calls).toHaveLength(1)
    const diagnostic = errorLog.mock.calls[0]!.at(-1) as any
    expect(diagnostic.name).toBe('TypeError')
    expect(diagnostic.stack).toContain('apps/core/src/routes/squad-voice.test.ts:')
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL')
  } finally {
    derive.mockRestore()
    errorLog.mockRestore()
  }
})

test('JSON disconnects are classified as cancellation, not an unknown derivation error', async () => {
  const controller = new AbortController()
  let entered!: () => void
  const pending = new Promise<void>((resolve) => {
    entered = resolve
  })
  const derive = spyOn(derivation, 'derivePublicVoice').mockImplementation(async () => {
    entered()
    return new Promise(() => {})
  })
  const info = spyOn(console, 'log').mockImplementation(() => {})
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = app.request(`/api/squads/${squadId}/voice/derive`, {
      method: 'POST',
      headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'octo' }),
      signal: controller.signal,
    })
    await pending
    controller.abort()
    expect((await response).status).toBe(499)
    const diagnostic = info.mock.calls.find((call) => call.includes('Voice derivation cancelled'))!.at(-1)
    expect(diagnostic).toMatchObject({ code: 'derivation_cancelled', source: 'client_disconnect' })
    expect(errors.mock.calls).toHaveLength(0)
    expect(__derivationsInProgress.has(squadId)).toBe(false)
  } finally {
    derive.mockRestore()
    info.mockRestore()
    errors.mockRestore()
  }
})
test('overall deadlines retain their typed timeout response and warning', async () => {
  const realAcquire = operations.acquireDerivation
  const acquire = spyOn(operations, 'acquireDerivation').mockImplementation((id, signal) => realAcquire(id, signal, 20))
  const derive = spyOn(derivation, 'derivePublicVoice').mockImplementation(async () => new Promise(() => {}))
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const accept of ['application/json', 'text/event-stream']) {
      const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: accept })
      if (accept === 'application/json') {
        expect(response.status).toBe(422)
        expect(await response.json()).toEqual({ error: 'derivation_timed_out' })
      } else {
        const frames = (await response.text())
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)))
        expect(frames.at(-1)).toMatchObject({ type: 'error', error: { code: 'derivation_timed_out' } })
      }
    }
    expect(warn.mock.calls.filter((call) => (call.at(-1) as any)?.code === 'derivation_timed_out')).toHaveLength(2)
    expect(errors.mock.calls).toHaveLength(0)
  } finally {
    acquire.mockRestore()
    derive.mockRestore()
    warn.mockRestore()
    errors.mockRestore()
  }
})

test('unsupported progress versions return JSON without a second derivation', async () => {
  const result = { login: 'octo', draft: { base: 'Synthetic draft.', surfaces: {} } }
  const derive = spyOn(derivation, 'derivePublicVoice').mockResolvedValue(result as any)
  try {
    const response = await request(
      admin,
      'POST',
      '/derive',
      { login: 'octo' },
      { Accept: 'text/event-stream; version=2' }
    )
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(await response.json()).toEqual(result)
    expect(derive).toHaveBeenCalledTimes(1)
  } finally {
    derive.mockRestore()
  }
})

for (const reason of ['schema', 'event_limit'] as const)
  test(`a rejected progress ${reason} remains diagnosable and terminates in sequence`, async () => {
    const derive = spyOn(derivation, 'derivePublicVoice').mockImplementation(async (input) => {
      if (reason === 'schema')
        await input.onProgress?.({ type: 'finding', index: 0, text: 'SYNTHETIC_PRIVATE_SENTINEL'.repeat(10) })
      else for (let i = 0; i < 511; i++) await input.onProgress?.({ type: 'phase', phase: 'collecting' })
      throw new Error('Unreachable after rejection')
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })
      const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
      expect(events.at(-1).type).toBe('error')
      expect(events.at(-1).error.code).toBe('derivation_failed')
      expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1))
      expect((errors.mock.calls[0]!.at(-1) as any).streamReason).toBe(reason)
      expect(JSON.stringify([events, errors.mock.calls])).not.toContain('SYNTHETIC_PRIVATE_SENTINEL')
    } finally {
      derive.mockRestore()
      errors.mockRestore()
    }
  })
test('an actual terminal write failure is logged even after computation ownership was released', async () => {
  const realWriter = progressStreams.createProgressWriter
  const writers = spyOn(progressStreams, 'createProgressWriter').mockImplementation((write, cancel, signal, options) =>
    realWriter(
      async (frame) => {
        if (frame.includes('"type":"complete"')) throw new TypeError('SYNTHETIC_PRIVATE_SENTINEL')
        return write(frame)
      },
      cancel,
      signal,
      options
    )
  )
  const result = {
    login: 'octo',
    draft: { base: 'Lead with the result.', surfaces: {} },
    observations: [],
    exemplars: [],
    sampling: {
      filters: {},
      counts: {
        collected: 20,
        kept: 20,
        droppedByFilter: { date: 0, repository: 0 },
        droppedAsToolAuthored: 0,
        droppedAsTemplate: 0,
      },
      dateRange: {},
      publicRepositories: [],
      privateRepositories: [],
      pagingCapped: false,
    },
    bytes: 20,
    maxBytes: 2000,
  }
  const derive = spyOn(derivation, 'derivePublicVoice').mockResolvedValue(result as any)
  let observed!: () => void
  const logged = new Promise<void>((resolve) => {
    observed = resolve
  })
  const errors = spyOn(console, 'error').mockImplementation(() => {
    observed()
  })
  try {
    const response = await request(admin, 'POST', '/derive', { login: 'octo' }, { Accept: 'text/event-stream' })
    const body = await response.text().catch(() => '')
    await logged
    const diagnostic = errors.mock.calls[0]!.at(-1) as any
    expect(diagnostic).toMatchObject({ name: 'TypeError', stage: 'terminal_publication' })
    expect(JSON.stringify(errors.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL')
    expect(body).not.toContain('"type":"complete"')
    expect(__derivationsInProgress.has(squadId)).toBe(false)
  } finally {
    writers.mockRestore()
    derive.mockRestore()
    errors.mockRestore()
  }
})
