import { expect, test } from 'bun:test'
import {
  githubOutputPass,
  withGitHubOutputPass,
  withGitHubCandidate,
  inGitHubCandidate,
  reserveGitHubLookahead,
} from './feedback-pass'

test('root work charges repeated cache-hit candidates, not distinct preparation IDs', async () => {
  await withGitHubOutputPass(async () => {
    let evaluated = 0
    for (let i = 0; i < 30; i++) {
      await withGitHubCandidate(async () => {
        evaluated++
        // Original-source and final authority checks belong to this charged candidate.
        await inGitHubCandidate(async () => {
          expect(githubOutputPass()!.work).toBe(i + 1)
        }, undefined)
      }, undefined)
    }
    expect(evaluated).toBe(25)
    expect(githubOutputPass()!.work).toBe(25)
  })
})

test('nested distinct effect candidates consume work while nested predicates do not', async () => {
  await withGitHubOutputPass(async () => {
    await withGitHubCandidate(async () => {
      await inGitHubCandidate(async () => {}, undefined)
      await withGitHubCandidate(async () => {}, undefined)
    }, undefined)
    expect(githubOutputPass()!.work).toBe(2)
  })
})

test('ID selection reserves aggregate rows and query work before issuing queries', async () => {
  await withGitHubOutputPass(async () => {
    expect(reserveGitHubLookahead(25)).toBe(25)
    expect(reserveGitHubLookahead(25)).toBe(25)
    expect(reserveGitHubLookahead(25)).toBe(25)
    expect(reserveGitHubLookahead(25)).toBe(25)
    expect(reserveGitHubLookahead(25)).toBe(0)
    expect(githubOutputPass()!.lookaheadRows).toBe(100)
  })
  await withGitHubOutputPass(async () => {
    for (let i = 0; i < 12; i++) expect(reserveGitHubLookahead(1)).toBe(1)
    expect(reserveGitHubLookahead(1)).toBe(0)
  })
  await withGitHubOutputPass(async () => {
    for (let i = 0; i < 25; i++) await withGitHubCandidate(async () => {}, undefined)
    expect(reserveGitHubLookahead(25)).toBe(0)
  })
})
