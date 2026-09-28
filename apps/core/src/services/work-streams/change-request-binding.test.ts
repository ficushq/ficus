import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { resolveBranchChangeRequest, type BranchChangeRequestCandidate } from '@ficus/shared'
import { db, squads, workStreams } from '../../db'
import { recordChangeRequestBinding } from './change-request-binding'

const prefix = `change-request-binding-${randomUUID()}`
let squadId: string

const candidate = (changes: Partial<BranchChangeRequestCandidate> = {}): BranchChangeRequestCandidate => ({
  number: 42,
  merged: false,
  state: 'open',
  headBranch: 'work/x',
  baseBranch: 'main',
  headRepository: 'owner/repo',
  url: 'https://github.com/owner/repo/pull/42',
  ...changes,
})

beforeAll(async () => {
  squadId = (await db.insert(squads).values({ name: prefix, purpose: 'Binding fixtures' }).returning())[0]!.id
})
afterAll(async () => {
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

describe('branch change-request resolution', () => {
  const input = {
    branch: 'work/x',
    baseBranch: 'main',
    repository: 'owner/repo',
  }

  test('a branch without candidates, or a stream without a branch, stays unresolved', () => {
    expect(resolveBranchChangeRequest({ ...input, candidates: [] })).toEqual({ status: 'no-candidates' })
    expect(resolveBranchChangeRequest({ ...input, branch: undefined, candidates: [candidate()] })).toEqual({
      status: 'no-branch',
    })
    expect(resolveBranchChangeRequest({ ...input, candidates: null })).toEqual({ status: 'lookup-failed' })
  })

  test('exactly one usable candidate is chosen, and a merged candidate wins over an open one', () => {
    expect(resolveBranchChangeRequest({ ...input, candidates: [candidate()] })).toEqual({
      status: 'chosen',
      candidate: { number: 42, url: 'https://github.com/owner/repo/pull/42' },
    })
    expect(
      resolveBranchChangeRequest({
        ...input,
        candidates: [
          candidate({ number: 7, merged: true, state: 'closed', url: 'https://github.com/owner/repo/pull/7' }),
          candidate({ number: 8 }),
        ],
      })
    ).toEqual({ status: 'chosen', candidate: { number: 7, url: 'https://github.com/owner/repo/pull/7' } })
  })

  test('fork heads, wrong bases, wrong head branches, and closed-unmerged candidates never bind', () => {
    for (const changes of [
      { headRepository: 'someone/fork' },
      { baseBranch: 'release' },
      { headBranch: 'work/other' },
      { merged: false, state: 'closed' },
    ] as const) {
      expect(resolveBranchChangeRequest({ ...input, candidates: [candidate(changes)] })).toEqual({
        status: 'no-candidates',
      })
    }
  })

  test('ambiguous branches are reported, never guessed', () => {
    expect(
      resolveBranchChangeRequest({ ...input, candidates: [candidate({ number: 1 }), candidate({ number: 2 })] })
    ).toEqual({ status: 'unclear', candidates: ['#1', '#2'] })
    expect(
      resolveBranchChangeRequest({
        ...input,
        candidates: [
          candidate({ number: 3, merged: true, state: 'closed' }),
          candidate({ number: 4, merged: true, state: 'closed' }),
        ],
      })
    ).toEqual({ status: 'unclear', candidates: ['#3', '#4'] })
  })

  test('unknown base on the candidate or absent constraint does not exclude', () => {
    expect(resolveBranchChangeRequest({ ...input, candidates: [candidate({ baseBranch: '' })] })).toMatchObject({
      status: 'chosen',
    })
    expect(
      resolveBranchChangeRequest({
        ...input,
        baseBranch: undefined,
        candidates: [candidate({ baseBranch: 'release' })],
      })
    ).toMatchObject({ status: 'chosen' })
  })
})

describe('recording the resolved binding', () => {
  test('writes the canonical binding once and never overwrites a concurrent manual one', async () => {
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId,
        title: prefix,
        status: 'active',
        metadata: {
          github: { repo: 'owner/repo' },
          git: { branch: 'work/x', baseBranch: 'main' },
          nextSteps: 'Preserved',
        },
      })
      .returning()
    const id = stream!.id
    const reference = { integration: 'github', repository: 'owner/repo' }
    expect(await recordChangeRequestBinding(id, reference, { number: 42 })).toBe(true)
    const afterFirst = (await db.select().from(workStreams).where(eq(workStreams.id, id)))[0]!.metadata as Record<
      string,
      any
    >
    expect(afterFirst.github).toEqual({ repo: 'owner/repo' })
    expect(afterFirst.nextSteps).toBe('Preserved')
    expect(afterFirst.codeHost).toEqual({
      integration: 'github',
      repository: 'owner/repo',
      changeRequest: { number: 42, url: 'https://github.com/owner/repo/pull/42' },
    })
    // Same resolution again is a no-op; a different manual binding wins and is not overwritten.
    expect(await recordChangeRequestBinding(id, reference, { number: 42 })).toBe(true)
    await db
      .update(workStreams)
      .set({ metadata: { ...afterFirst, codeHost: { ...afterFirst.codeHost, changeRequest: { number: 7 } } } })
      .where(eq(workStreams.id, id))
    expect(await recordChangeRequestBinding(id, reference, { number: 42 })).toBe(false)
    const final = (await db.select().from(workStreams).where(eq(workStreams.id, id)))[0]!.metadata as Record<
      string,
      any
    >
    expect(final.codeHost.changeRequest).toEqual({ number: 7 })
  })

  test('terminal streams are never mutated', async () => {
    for (const status of ['done', 'canceled'] as const) {
      const [stream] = await db
        .insert(workStreams)
        .values({ squadId, title: `${prefix}-${status}`, status, metadata: {} })
        .returning()
      expect(
        await recordChangeRequestBinding(stream!.id, { integration: 'github', repository: 'o/r' }, { number: 1 })
      ).toBe(false)
      const row = (await db.select().from(workStreams).where(eq(workStreams.id, stream!.id)))[0]!
      expect((row.metadata as Record<string, unknown>).codeHost).toBeUndefined()
    }
  })
})
