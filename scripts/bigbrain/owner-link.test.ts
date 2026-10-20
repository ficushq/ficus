import { expect, test } from 'bun:test'
import { issueOwnerAppLink } from './owner-link'
const issuedAt = '2026-10-20T00:00:00.000Z'
const expiresAt = '2026-10-20T01:00:00.000Z'
const input = { membersPath: '/private/members.json', handle: 'ada', issuedAt, expiresAt }
const secret = 'a'.repeat(43)
test('minimal adapter uses only the pinned createAppLink export with immutable, nonfuture issuance', () => {
  const calls: unknown[][] = []
  const result = issueOwnerAppLink(
    input,
    (...args) => {
      calls.push(args)
      return { secret, expires: expiresAt }
    },
    Date.parse(issuedAt) + 500
  )
  expect(calls).toEqual([[input.membersPath, 'ada', new Date(issuedAt)]])
  expect(result).toEqual({ secret, expiresAt })
})
test('invalid, future, inverted, overlong and expired windows never invoke upstream', () => {
  let calls = 0
  const issue = () => {
    calls++
    return { secret, expires: expiresAt }
  }
  for (const [request, now] of [
    [input, Date.parse(issuedAt) - 1],
    [input, Date.parse(expiresAt)],
    [{ ...input, expiresAt: issuedAt }, Date.parse(issuedAt)],
    [{ ...input, expiresAt: '2026-10-21T01:00:00.000Z' }, Date.parse(issuedAt)],
    [{ ...input, token: 'PRIVATE' }, Date.parse(issuedAt)],
    [{ ...input, membersPath: '../members.json' }, Date.parse(issuedAt)],
    [{ ...input, handle: 'ficus-reader' }, Date.parse(issuedAt)],
  ] as const)
    expect(() => issueOwnerAppLink(request, issue, now)).toThrow()
  expect(calls).toBe(0)
})
test('reports only the expiry actually returned, refusing pin/protocol drift and invalid secrets', () => {
  for (const result of [
    { secret, expires: '2026-10-20T02:00:00.000Z' },
    { secret: 'PRIVATE', expires: expiresAt },
  ]) {
    expect(() => issueOwnerAppLink(input, () => result, Date.parse(issuedAt))).toThrow('upstream_protocol')
  }
})
