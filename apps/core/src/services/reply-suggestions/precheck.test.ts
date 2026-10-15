import { describe, expect, test } from 'bun:test'
import { REPLY_SUGGESTION_FIXTURES } from './fixtures'
import { likelyAsksHuman, questionTail, stripNonQuestionText } from './precheck'

describe('likelyAsksHuman on the audit fixtures', () => {
  for (const fixture of REPLY_SUGGESTION_FIXTURES) {
    test(`${fixture.precheck ? 'passes' : 'skips'}: ${fixture.name}`, () => {
      expect(likelyAsksHuman(fixture.agent)).toBe(fixture.precheck)
    })
  }
})

describe('likelyAsksHuman', () => {
  test.each([
    'Want me to start it',
    'I can take this on. Should I go ahead',
    'Shall I merge it now.',
    'Let me know if you want the longer version.',
    'Either works; your call.',
    'Which do you prefer: the table or the list.',
    'Would you like a summary as well.',
  ])('asking phrase without a question mark: %s', (text) => {
    expect(likelyAsksHuman(text)).toBe(true)
  })

  test('only the last three paragraphs count', () => {
    expect(likelyAsksHuman('Ready to merge?\n\nI checked CI.\n\nThe PR is up.\n\nAll green.')).toBe(false)
    expect(likelyAsksHuman('Ready to merge?\n\nI checked CI.\n\nAll green.')).toBe(true)
  })

  test('a trailing options list does not push the question out of view', () => {
    const options = '\n\n**A.** Patch the prompt.\n\n**B.** Rewrite tool names.\n\n**C.** Leave it.'
    expect(likelyAsksHuman(`I looked at both.\n\nWhich approach do you prefer?${options}\n\nI checked CI.`)).toBe(false)
    expect(likelyAsksHuman(`I looked at both.\n\nWhich approach do you prefer?\n\nI checked CI.${options}`)).toBe(true)
    for (const list of ['- one\n\n- two\n\n- three', '1) one\n\n2) two\n\n3) three', 'A) one\n\nB) two\n\nC) three']) {
      expect(likelyAsksHuman(`Pick one?\n\nNotes.\n\nMore notes.\n\n${list}`)).toBe(true)
    }
  })

  test('a bold question as the final line is still a question', () => {
    expect(likelyAsksHuman('Everything is staged.\n\n**Want me to ship it?**')).toBe(true)
  })

  test('a bold-only heading line above the end is not', () => {
    expect(likelyAsksHuman('**Why did it fail?**\nThe token expired, so I rotated it.')).toBe(false)
  })

  test('a bold question on its own line is kept wherever it sits', () => {
    expect(likelyAsksHuman('**Want me to start it?**\n\nCI is still running.')).toBe(true)
    expect(likelyAsksHuman('The fix is ready.\n**Want me to start it?**\n\nCI is still running.')).toBe(true)
  })

  test('bold-only lines that are not questions are still headings', () => {
    expect(likelyAsksHuman('**Should I worry about it**\n\nNo, it is fixed.')).toBe(false)
    expect(likelyAsksHuman('**Up to you**\n\nThat was the old wording; I settled it.')).toBe(false)
  })

  test('an unterminated code fence hides what follows it', () => {
    expect(likelyAsksHuman('Here is the start:\n\n```\nconst x = a ? b : c')).toBe(false)
  })

  test('markdown links keep their label but lose the target', () => {
    expect(stripNonQuestionText('See [the run](https://ci.example.test/run?id=1).')).toBe('See the run.')
    expect(likelyAsksHuman('See [is it green?](https://ci.example.test/run?id=1)')).toBe(true)
  })

  test('empty text asks nothing', () => {
    expect(likelyAsksHuman('')).toBe(false)
    expect(questionTail('   \n\n  ')).toBe('')
  })
})

describe('likelyAsksHuman: wordings that ask without a question mark', () => {
  test.each([
    // A real miss: an offer at the very end, after a recommendation.
    "It's harmless and seems rare, so I'd leave it unless you see it again. If you want the prompt-line fix, I can open a small low-priority work stream for it.",
    'If you want the fix, I can open a small work stream for it.',
    'Happy to open a work stream for this if you’d like.',
    'Happy to open a work stream for this.',
    'I can add a test too, if you like.',
    'Say the word and I’ll start it.',
    'Should we ship it now or wait for CI',
    'Shall we go with option B.',
    'Two options: A or B. Up to you.',
    "I'd leave it as is, or I can file a follow-up.",
    "Option A is cheaper. I recommend A; I'll go ahead once you confirm.",
    'The branch is ready and I will merge when you confirm.',
    'I will rotate the key tonight, if that works for you.',
    'I will rotate the key tonight if that works.',
    'Plan: retry once, then merge. Let me run it if that sounds good.',
    'Want to proceed with the fix\n\nCI is green.\n\nPR is up.',
    'Which approach do you prefer?\n\n**A.** Patch the prompt.\n\n**B.** Rewrite tool names.',
    '**Want me to start it?**\n\nCI is still running.',
  ])('%s', (text) => {
    expect(likelyAsksHuman(text)).toBe(true)
  })
})

describe('likelyAsksHuman: status, recaps and prose stay filtered', () => {
  test.each([
    'CI is green. The PR is up.',
    'Done: merged the fix and closed the stream.',
    'The release PR is up. It needs your approval in the review step before it ships.',
    'Still waiting on you:\n- the region for the new database\n- approval on PR 12',
    'I can see the logs now, and I can confirm the retry fixed it.',
    'I can reproduce it locally; the fix is in the PR.',
    'Done, the PR is merged. Happy to help!',
    'If you want to see the run, it is in the CI tab.',
    'I will retry once; if that works, I will merge it.',
    'I want to note that the cache is now warm.',
    'Fixed everything up to your last message.',
    'The stream is open at https://example.test/work?ws=42 and running.',
    'Opened it (see /work?ws=42). The first step is running.',
    'I added a guard:\n\n```ts\n// if you want the fix, should we ship?\nconst x = a ?? b\n```\n\nTests pass.',
    'I renamed `shouldWeRetry` and `ifYouWant` to clearer names.',
    'The reviewer wrote:\n\n> If you want, I can split this. Should we?\n\nI split it and pushed.',
    '## Up to you?\n\nThat was settled; I used the default.',
    '**Should we ship?** Yes. CI is green and I shipped it.',
  ])('%s', (text) => {
    expect(likelyAsksHuman(text)).toBe(false)
  })
})
