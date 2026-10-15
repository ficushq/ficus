import { describe, expect, test } from 'bun:test'
import type { Account, AccountStoreV1 } from '../agent/account-store'
import { accountForProvider, classifyBilling } from './billing'

const account = (id: string, extra: Partial<Account>): Account =>
  ({ id, enabled: true, credential: { type: 'api_key', key: 'k' }, ...extra }) as Account

const store: AccountStoreV1 = {
  version: 1,
  accounts: {
    anthropic: [
      account('cc', { kind: 'claude-code', credential: { type: 'api_key', key: 'claude-code' } as never }),
      account('key', {}),
    ],
    'openai-codex': [account('oauth', { credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } })],
    local: [account('compat', { kind: 'openai-compatible' })],
  },
}

describe('classifyBilling', () => {
  const classify = (provider: string, accountId: string | null, hasListPrice = true) =>
    classifyBilling({ provider, accountId, hasListPrice }, { store })

  test('classifies stored accounts by kind and credential', () => {
    expect(classify('anthropic', 'cc')).toBe('subscription')
    expect(classify('anthropic', 'key')).toBe('api')
    expect(classify('openai-codex', 'oauth')).toBe('subscription')
    expect(classify('local', 'compat')).toBe('self-hosted')
  })

  test('without a stored account: api when priced, unknown when not', () => {
    expect(classify('openai', null, true)).toBe('api')
    expect(classify('openai', null, false)).toBe('unknown')
    expect(classify('anthropic', 'gone', true)).toBe('api')
  })
})

describe('accountForProvider', () => {
  test('returns the first usable account, else the first', () => {
    expect(accountForProvider('anthropic', store, (a) => a.id === 'key')?.id).toBe('key')
    expect(accountForProvider('anthropic', store, () => false)?.id).toBe('cc')
    expect(accountForProvider('none', store, () => true)).toBeUndefined()
  })
})
