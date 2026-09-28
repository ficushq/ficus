import { afterEach, describe, expect, test } from 'bun:test'
import type { OAuthTransport } from './transport'
import { createRuntimeOAuthTransport } from './runtime-transport'

const originalManaged = process.env.FICUS_MANAGED

afterEach(() => {
  if (originalManaged === undefined) delete process.env.FICUS_MANAGED
  else process.env.FICUS_MANAGED = originalManaged
})

function fakeTransport(authority: OAuthTransport['authority']): OAuthTransport {
  return {
    authority,
    authorizationUrl: async () => ({ authorizationUrl: 'https://api.notion.com', expiresAt: new Date().toISOString() }),
    completeAuthorization: async () => {
      throw new Error('unused')
    },
    refresh: async () => {
      throw new Error('unused')
    },
    revoke: async () => {},
  }
}

describe('createRuntimeOAuthTransport', () => {
  test('self-hosted selects only the local transport', () => {
    delete process.env.FICUS_MANAGED
    const calls: string[] = []
    const result = createRuntimeOAuthTransport({
      local: () => {
        calls.push('local')
        return fakeTransport('local')
      },
      broker: () => {
        calls.push('broker')
        return fakeTransport('platform_broker')
      },
    })
    expect(result.authority).toBe('local')
    expect(calls).toEqual(['local'])
  })

  test('managed selects only the broker transport and never constructs a local fallback', () => {
    process.env.FICUS_MANAGED = '1'
    const calls: string[] = []
    const result = createRuntimeOAuthTransport({
      local: () => {
        calls.push('local')
        return fakeTransport('local')
      },
      broker: () => {
        calls.push('broker')
        return fakeTransport('platform_broker')
      },
    })
    expect(result.authority).toBe('platform_broker')
    expect(calls).toEqual(['broker'])
  })
})
