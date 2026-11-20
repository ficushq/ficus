import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { IntegrationOutputFact } from '@ficus/shared'
import { db, githubWriteWindows, integrationConnections, settings, squads } from '../../../db'
import {
  annotateGitHubWriteAttribution,
  closeGitHubWriteWindow,
  githubWriteWindowMatch,
  openGitHubWriteWindow,
  GITHUB_WRITE_WINDOW_MAX_OPEN_MS,
  GITHUB_WRITE_WINDOW_RETENTION_MS,
  GITHUB_WRITE_WINDOWS_SINCE_KEY,
} from './write-windows'

const prefix = `write-windows-${randomUUID()}`
// Unique per run: windows are matched by login across every squad.
const login = `owner-${randomUUID().slice(0, 8)}`
let squadId: string
let otherSquadId: string
let connectionId: string
let previousSince: string | undefined

const minute = 60_000
const base = new Date('2026-11-20T12:00:00.000Z')
const at = (minutes: number) => new Date(base.getTime() + minutes * minute)

beforeAll(async () => {
  ;[squadId, otherSquadId] = await Promise.all(
    ['a', 'b'].map(
      async (suffix) =>
        (
          await db
            .insert(squads)
            .values({ name: `${prefix}-${suffix}`, purpose: 'Write window fixtures' })
            .returning()
        )[0]!.id
    )
  )
  const revision = randomUUID()
  connectionId = (
    await db
      .insert(integrationConnections)
      .values({
        providerKey: 'github',
        adapterVersion: 1,
        displayName: prefix,
        configuration: { login: login.toUpperCase() },
        credentialRef: `fixture:${prefix}`,
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        materialRevision: revision,
        validatedRevision: revision,
      })
      .returning()
  )[0]!.id
  previousSince = (
    await db.select({ value: settings.value }).from(settings).where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
  )[0]?.value
})

beforeEach(async () => {
  // Coverage began well before every fixture time.
  await db.delete(settings).where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
  await db.insert(settings).values({ key: GITHUB_WRITE_WINDOWS_SINCE_KEY, value: at(-24 * 60).toISOString() })
})

afterEach(async () => {
  await db.delete(githubWriteWindows).where(inArray(githubWriteWindows.squadId, [squadId, otherSquadId]))
})

afterAll(async () => {
  await db.delete(settings).where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
  if (previousSince !== undefined)
    await db.insert(settings).values({ key: GITHUB_WRITE_WINDOWS_SINCE_KEY, value: previousSince })
  await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
})

const match = (minutes: number, now = at(minutes + 1)) =>
  githubWriteWindowMatch({ login, occurredAt: at(minutes), now })

describe('GitHub write windows', () => {
  test('a write inside a closed window is Ficus; before or after it is not', async () => {
    const id = (await openGitHubWriteWindow({ squadId, login, now: at(0) }))!
    expect(await closeGitHubWriteWindow({ squadId, windowId: id, now: at(1) })).toBe(true)
    expect(await match(0.5)).toBe('inside')
    expect(await match(-2)).toBe('outside')
    expect(await match(3)).toBe('outside')
    // The login is matched case-insensitively.
    expect(await githubWriteWindowMatch({ login: login.toUpperCase(), occurredAt: at(0.5), now: at(2) })).toBe('inside')
    // Another account is never inside this account's window.
    expect(await githubWriteWindowMatch({ login: 'someone-else', occurredAt: at(0.5), now: at(2) })).toBe('outside')
  })

  test('a webhook that arrives while the command is still running is Ficus (the window opens before the token leaves)', async () => {
    await openGitHubWriteWindow({ squadId, login, now: at(0) })
    expect(await match(0.2, at(0.3))).toBe('inside')
  })

  test('a window whose close never arrives stops covering writes after the bounded time', async () => {
    await openGitHubWriteWindow({ squadId, login, now: at(0) })
    const capMinutes = GITHUB_WRITE_WINDOW_MAX_OPEN_MS / minute
    expect(await match(capMinutes - 1)).toBe('inside')
    expect(await match(capMinutes + 1)).toBe('outside')
  })

  test("a window of the same account in another squad still marks Ficus's write", async () => {
    await openGitHubWriteWindow({ squadId: otherSquadId, login, now: at(0) })
    expect(await match(0.5)).toBe('inside')
  })

  test('only the opening squad can close a window, and only once', async () => {
    const id = (await openGitHubWriteWindow({ squadId, login, now: at(0) }))!
    expect(await closeGitHubWriteWindow({ squadId: otherSquadId, windowId: id, now: at(0.1) })).toBe(false)
    expect(await closeGitHubWriteWindow({ squadId, windowId: id, now: at(1) })).toBe(true)
    expect(await closeGitHubWriteWindow({ squadId, windowId: id, now: at(2) })).toBe(false)
    const [row] = await db.select().from(githubWriteWindows).where(eq(githubWriteWindows.id, id))
    expect(row!.closedAt).toEqual(at(1))
  })

  test('writes the windows cannot answer for keep the login rule', async () => {
    // Before this instance began recording windows.
    await db
      .update(settings)
      .set({ value: at(10).toISOString() })
      .where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
    expect(await match(5)).toBeUndefined()
    expect(await match(11)).toBe('outside')
    // Recording never began.
    await db.delete(settings).where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
    expect(await match(11)).toBeUndefined()
    // Older than the retained windows.
    await db.insert(settings).values({ key: GITHUB_WRITE_WINDOWS_SINCE_KEY, value: at(-100_000).toISOString() })
    expect(await match(0, new Date(at(0).getTime() + GITHUB_WRITE_WINDOW_RETENTION_MS))).toBeUndefined()
  })

  test('opening the first window records when coverage began, and never moves it', async () => {
    await db.delete(settings).where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
    await openGitHubWriteWindow({ squadId, login, now: at(0) })
    await openGitHubWriteWindow({ squadId, login, now: at(5) })
    const [since] = await db.select().from(settings).where(eq(settings.key, GITHUB_WRITE_WINDOWS_SINCE_KEY))
    expect(since!.value).toBe(at(0).toISOString())
  })

  test('windows past retention are pruned when a new one opens', async () => {
    const old = (await openGitHubWriteWindow({ squadId, login, now: at(0) }))!
    await openGitHubWriteWindow({ squadId, login, now: new Date(at(1).getTime() + GITHUB_WRITE_WINDOW_RETENTION_MS) })
    expect(await db.select().from(githubWriteWindows).where(eq(githubWriteWindows.id, old))).toEqual([])
  })
})

describe('annotateGitHubWriteAttribution', () => {
  const authority = () => ({ kind: 'connection' as const, connectionId, squadId })
  const feedback = (output: string, data: Record<string, unknown>, minutes = 0.5): IntegrationOutputFact => ({
    output,
    version: 1,
    eventKey: randomUUID(),
    resourceKey: 'acme/app#1',
    occurredAt: at(minutes).toISOString(),
    data: { repository: 'acme/app', pullRequest: { number: 1 }, ...data },
    subject: 'Feedback',
    body: 'Body',
  })
  const annotate = (fact: IntegrationOutputFact, appClientId?: string) =>
    annotateGitHubWriteAttribution(fact, authority(), { now: at(2), appClientId: async () => appClientId })

  test('reviews and review comments by the connected account are decided by the windows', async () => {
    const id = (await openGitHubWriteWindow({ squadId, login, now: at(0) }))!
    await closeGitHubWriteWindow({ squadId, windowId: id, now: at(1) })
    for (const output of ['pull_request.reviewed', 'pull_request.review_comment']) {
      expect((await annotate(feedback(output, { actor: login }))).data.ficusWriteWindow).toBe('inside')
      expect((await annotate(feedback(output, { actor: login }, 1.5))).data.ficusWriteWindow).toBe('outside')
      // Other accounts are left alone: they were never the connection's echo.
      expect((await annotate(feedback(output, { actor: 'reviewer' }))).data).not.toHaveProperty('ficusWriteWindow')
    }
  })

  test('comments GitHub attributes are left to their attribution', async () => {
    await openGitHubWriteWindow({ squadId, login, now: at(0) })
    for (const viaApp of ['none', 'ficus']) {
      const fact = feedback('pull_request.comment', { actor: login, viaApp })
      expect(await annotate(fact)).toBe(fact)
    }
  })

  test("a comment through the app the connection itself was authorized with is Ficus's own", async () => {
    const id = (await openGitHubWriteWindow({ squadId, login, now: at(0) }))!
    await closeGitHubWriteWindow({ squadId, windowId: id, now: at(1) })
    // For example a connection still bound to an earlier custom app, outside any window.
    const comment = feedback('issue.comment', { actor: login, viaApp: 'other', viaAppClientId: 'Iv23older' }, 30)
    expect((await annotate(comment, 'Iv23older')).data).toMatchObject({ viaApp: 'ficus' })
    // An unknown app is decided by the windows: outside every window it is the person's.
    expect((await annotate(comment, 'Iv23current')).data).toMatchObject({
      viaApp: 'other',
      ficusWriteWindow: 'outside',
    })
    // A missing client ID cannot match the binding, so the windows decide too.
    const anonymous = feedback('issue.comment', { actor: login, viaApp: 'other' })
    expect((await annotate(anonymous, 'Iv23older')).data).toMatchObject({ viaApp: 'other', ficusWriteWindow: 'inside' })
  })

  test('a decision already stored with the event is kept', async () => {
    const fact = feedback('pull_request.reviewed', { actor: login, ficusWriteWindow: 'inside' })
    expect(await annotate(fact)).toBe(fact)
  })
})
