import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads, integrationConnections, integrationConnectionAssignments } from '../../../db'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { gitHubAccountEmails, gitHubAuthorFromProfile, getGitHubAuthorDefaults } from './author-defaults'
import { resolveGitHubConnection } from './resolve-connection'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { resolveOAuthAuthority } from '../authorization/authority'
useEnabledIntegrationFixtures('github')

test('profile defaults respect private emails and reject mismatched or malformed profiles', () => {
  const account = { version: 1 as const, userId: 123, login: 'tester' }
  const fallback = { login: 'tester', gitUserName: 'tester', gitUserEmail: '123+tester@users.noreply.github.com' }
  expect(gitHubAuthorFromProfile(account)).toEqual(fallback)
  expect(gitHubAuthorFromProfile(account, { id: 123, name: ' Test Person ', email: 'test@example.com' })).toEqual({
    ...fallback,
    gitUserName: 'Test Person',
    gitUserEmail: 'test@example.com',
  })
  expect(gitHubAuthorFromProfile(account, { id: 999, name: 'Other Person', email: 'other@example.com' })).toEqual(
    fallback
  )
  expect(gitHubAuthorFromProfile(account, { id: 123, name: 'Bad\nName', email: 'not an email' })).toEqual(fallback)
})

test('squad defaults use the assigned account and cached profiles cannot bypass disabled authorization', async () => {
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: 'Author defaults', purpose: 'test' })
  const account = await createTestGitHubConnection({ squadId, login: 'selected' })
  let calls = 0
  const request = (async (_url: unknown, init?: RequestInit) => {
    calls++
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer test-access-${account.id}`)
    return Response.json({ id: 123, name: 'Selected Person', email: null })
  }) as typeof fetch
  try {
    expect(await getGitHubAuthorDefaults(squadId, request)).toEqual({
      login: 'selected',
      gitUserName: 'Selected Person',
      gitUserEmail: '123+selected@users.noreply.github.com',
    })
    expect((await getGitHubAuthorDefaults(squadId, request))?.gitUserName).toBe('Selected Person')
    expect(calls).toBe(1)
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, account.id))
    expect(await getGitHubAuthorDefaults(squadId, request)).toBeUndefined()
    expect(calls).toBe(1)
  } finally {
    await account.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

async function authorFixture(login: string) {
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: `Author ${login}`, purpose: 'test' })
  const account = await createTestGitHubConnection({ squadId, login })
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, account.id))
  let calls = 0
  let failing = false
  const request = (async () => {
    calls++
    if (failing) throw new Error('synthetic GitHub outage')
    return Response.json({ id: 123, name: 'Profile Person', email: 'profile@example.com' })
  }) as unknown as typeof fetch
  return {
    squadId,
    account,
    materialRevision: row!.materialRevision,
    request,
    calls: () => calls,
    fail: (value: boolean) => void (failing = value),
    async dispose() {
      await account.dispose()
      await db.delete(squads).where(eq(squads.id, squadId))
    },
  }
}

const loadedDefaults = (login: string) => ({
  login,
  gitUserName: 'Profile Person',
  gitUserEmail: 'profile@example.com',
})

test('author defaults are unchanged while the token is refresh-pending, degraded or past its validation window', async () => {
  const fixture = await authorFixture('steady')
  const repository = new DbIntegrationConnectionRepository()
  try {
    const before = await getGitHubAuthorDefaults(fixture.squadId, fixture.request)
    expect(before).toEqual(loadedDefaults('steady'))

    // Exactly what the refresh service records before validating a rotated GitHub token.
    expect(
      await repository.recordRefreshFailure({
        id: fixture.account.id,
        materialRevision: fixture.materialRevision,
        code: 'refresh_validation_pending',
        invalidateAuthentication: true,
      })
    ).toBe(true)
    // The credential itself stays withheld: only the author attribution survives.
    expect(await resolveGitHubConnection(fixture.squadId)).toBeUndefined()
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request)).toEqual(before)

    // A periodic validation that could not reach GitHub: degraded, validation cleared.
    const now = new Date()
    await repository.recordValidation({
      id: fixture.account.id,
      materialRevision: fixture.materialRevision,
      validation: { ok: false, code: 'provider_unavailable' },
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    expect(await resolveGitHubConnection(fixture.squadId)).toBeUndefined()
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request)).toEqual(before)

    // Healthy but past the 15 minute validation window.
    await db
      .update(integrationConnections)
      .set({
        authState: 'authenticated',
        healthState: 'healthy',
        validatedRevision: fixture.materialRevision,
        validationExpiresAt: new Date(Date.now() - 1000),
      })
      .where(eq(integrationConnections.id, fixture.account.id))
    expect(await resolveGitHubConnection(fixture.squadId)).toBeUndefined()
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request)).toEqual(before)
    expect(fixture.calls()).toBe(1)
  } finally {
    await fixture.dispose()
  }
})

test('a refresh-pending connection resolves the same account without a network call when nothing is cached', async () => {
  const fixture = await authorFixture('coldstart')
  try {
    await new DbIntegrationConnectionRepository().recordRefreshFailure({
      id: fixture.account.id,
      materialRevision: fixture.materialRevision,
      code: 'refresh_validation_pending',
      invalidateAuthentication: true,
    })
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request)).toEqual({
      login: 'coldstart',
      gitUserName: 'coldstart',
      gitUserEmail: '123+coldstart@users.noreply.github.com',
    })
    // The withheld token was not used to ask GitHub for the profile.
    expect(fixture.calls()).toBe(0)
  } finally {
    await fixture.dispose()
  }
})

for (const [label, change] of [
  ['disabled', () => ({ enabled: false })],
  [
    'reauthorization-required',
    () => ({ authState: 'reauthorization_required' as const, healthState: 'degraded' as const }),
  ],
  ['rejected by GitHub', () => ({ authState: 'invalid' as const, healthState: 'unreachable' as const })],
  ['never authorized', () => ({ authState: 'pending' as const, healthState: 'unknown' as const })],
  [
    'owned by another client authority',
    () => ({ clientAuthority: resolveOAuthAuthority() === 'local' ? 'platform_broker' : 'local' }),
  ],
] as const) {
  test(`no author defaults when the connection is ${label}, even with a loaded profile`, async () => {
    const fixture = await authorFixture(`gone-${label.replace(/[^a-z]/g, '').slice(0, 12)}`)
    try {
      expect((await getGitHubAuthorDefaults(fixture.squadId, fixture.request))?.gitUserName).toBe('Profile Person')
      await db.update(integrationConnections).set(change()).where(eq(integrationConnections.id, fixture.account.id))
      expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request)).toBeUndefined()
      expect(fixture.calls()).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })
}

test('no author defaults once the connection is unassigned, and another squad never inherits it', async () => {
  const fixture = await authorFixture('unassigned')
  const otherSquad = crypto.randomUUID()
  await db.insert(squads).values({ id: otherSquad, name: 'Unrelated', purpose: 'test' })
  try {
    expect((await getGitHubAuthorDefaults(fixture.squadId, fixture.request))?.gitUserName).toBe('Profile Person')
    expect(await getGitHubAuthorDefaults(otherSquad, fixture.request)).toBeUndefined()
    await db
      .delete(integrationConnectionAssignments)
      .where(eq(integrationConnectionAssignments.connectionId, fixture.account.id))
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request)).toBeUndefined()
  } finally {
    await fixture.dispose()
    await db.delete(squads).where(eq(squads.id, otherSquad))
  }
})

test('a failed profile fetch keeps the loaded profile instead of downgrading to the login', async () => {
  const fixture = await authorFixture('blip')
  let clock = Date.now()
  const now = () => clock
  try {
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request, now)).toEqual(loadedDefaults('blip'))
    // Past the five minute freshness window, with GitHub unreachable.
    clock += 301_000
    fixture.fail(true)
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request, now)).toEqual(loadedDefaults('blip'))
    expect(fixture.calls()).toBe(2)
    // The failure is retried later rather than on every ensure.
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request, now)).toEqual(loadedDefaults('blip'))
    expect(fixture.calls()).toBe(2)
    clock += 16_000
    fixture.fail(false)
    expect(await getGitHubAuthorDefaults(fixture.squadId, fixture.request, now)).toEqual(loadedDefaults('blip'))
    expect(fixture.calls()).toBe(3)
  } finally {
    await fixture.dispose()
  }
})

test('account emails are the noreply address plus the public profile email of that same account', async () => {
  const connection = (id: string) => ({
    id: `emails-${id}-${crypto.randomUUID()}`,
    configuration: { version: 1 as const, userId: 42, login: 'octo' },
  })
  const profile = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch
  const noreply = '42+octo@users.noreply.github.com'

  expect(
    await gitHubAccountEmails(connection('public'), async () => 'token', profile({ id: 42, email: 'octo@example.com' }))
  ).toEqual([noreply, 'octo@example.com'])
  // A private profile, a profile of another account, and an unusable token add nothing.
  expect(
    await gitHubAccountEmails(connection('private'), async () => 'token', profile({ id: 42, email: null }))
  ).toEqual([noreply])
  expect(
    await gitHubAccountEmails(connection('other'), async () => 'token', profile({ id: 7, email: 'other@example.com' }))
  ).toEqual([noreply])
  let asked = 0
  const never = (async () => {
    asked++
    return Response.json({ id: 42, email: 'octo@example.com' })
  }) as unknown as typeof fetch
  expect(await gitHubAccountEmails(connection('no-token'), async () => undefined, never)).toEqual([noreply])
  expect(asked).toBe(0)
})
