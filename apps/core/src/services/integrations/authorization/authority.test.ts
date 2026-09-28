import { afterEach, describe, expect, test } from 'bun:test'
import { BrokerUnconfiguredError, requireBrokerConfig, resolveOAuthAuthority } from './authority'

const KEYS = ['FICUS_MANAGED', 'FICUS_PLATFORM_BASE_URL', 'FICUS_PLATFORM_INSTANCE_TOKEN'] as const
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('OAuth authority', () => {
  test('a self-hosted instance is local', () => {
    delete process.env.FICUS_MANAGED
    expect(resolveOAuthAuthority()).toBe('local')
  })

  test('a managed instance is platform_broker', () => {
    process.env.FICUS_MANAGED = '1'
    expect(resolveOAuthAuthority()).toBe('platform_broker')
  })

  test('a managed instance missing its token fails closed instead of falling back to local', () => {
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_PLATFORM_BASE_URL = 'https://app.example'
    delete process.env.FICUS_PLATFORM_INSTANCE_TOKEN

    expect(resolveOAuthAuthority()).toBe('platform_broker')
    expect(() => requireBrokerConfig()).toThrow(BrokerUnconfiguredError)
  })

  test('a managed instance missing its base URL fails closed too', () => {
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_PLATFORM_INSTANCE_TOKEN = 'instance-token'
    delete process.env.FICUS_PLATFORM_BASE_URL

    expect(resolveOAuthAuthority()).toBe('platform_broker')
    expect(() => requireBrokerConfig()).toThrow(BrokerUnconfiguredError)
  })
})
