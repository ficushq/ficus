import { expect, test } from 'bun:test'
import { moderateGitHubFeedbackSchema, githubAccountIdSchema } from './index'

// Use the public barrel: authority must not rely on a private client-only validator.
const selection = { revisionId: crypto.randomUUID(), contentHash: 'a'.repeat(64), decisionVersion: 0 }
const input = { requestId: crypto.randomUUID(), action: 'allow_once', selections: [selection] }

test('moderation accepts an explicit immutable content selection', () => {
  expect(moderateGitHubFeedbackSchema.safeParse(input).success).toBe(true)
})

test('review input cannot replace a stored author or body', () => {
  for (const extra of [{ authorId: '123' }, { body: 'replacement' }, { squadId: crypto.randomUUID() }]) {
    expect(moderateGitHubFeedbackSchema.safeParse({ ...input, ...extra }).success).toBe(false)
  }
})

test('moderation requires bounded distinct selections and strict version identifiers', () => {
  const invalid = [
    { ...input, selections: [] },
    { ...input, selections: Array.from({ length: 51 }, () => ({ ...selection, revisionId: crypto.randomUUID() })) },
    { ...input, selections: [selection, selection] },
    { ...input, selections: [{ ...selection, decisionVersion: -1 }] },
    { ...input, selections: [{ ...selection, contentHash: 'unbound' }] },
    { ...input, selections: [{ ...selection, authorId: '123' }] },
    { ...input, action: 'approve_all' },
  ]
  for (const candidate of invalid) {
    expect(moderateGitHubFeedbackSchema.safeParse(candidate).success).toBe(false)
  }
})

test('GitHub account IDs are canonical positive safe integers, not usernames or rounded IDs', () => {
  for (const accountId of ['1', '9007199254740991']) {
    expect(githubAccountIdSchema.safeParse(accountId).success).toBe(true)
  }
  for (const accountId of ['0', '-1', '01', '1e3', '9007199254740992', 'alice', 123]) {
    expect(githubAccountIdSchema.safeParse(accountId).success).toBe(false)
  }
})
