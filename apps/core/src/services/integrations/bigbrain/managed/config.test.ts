import { expect, test } from 'bun:test'
import { MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import { BigbrainConfigSchema } from '../local-bindings'
import {
  ManagedSharedConfigSchema,
  credentialMatchesConfiguration,
  isManagedSharedConfig,
  parseBigbrainConfiguration,
  parseBigbrainCredential,
} from './config'

const managedConfig = {
  version: 2,
  mode: 'managed_shared',
  vaultId: '22222222-2222-4222-8222-222222222222',
  upstreamVaultId: '33333333-3333-4333-8333-333333333333',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
} as const
const localConfigFixture = {
  version: 2,
  bindingId: 'personal',
  bindingFingerprint: 'a'.repeat(64),
  vaultPath: '/vault',
  executablePath: '/usr/local/bin/bigbrain',
} as const
const readToken = `sv_0123abcd_${'A'.repeat(43)}`

test('exactly one strict variant accepts each stored configuration', () => {
  expect(BigbrainConfigSchema.safeParse(localConfigFixture).success).toBe(true)
  expect(BigbrainConfigSchema.safeParse(managedConfig).success).toBe(false)
  expect(ManagedSharedConfigSchema.safeParse(localConfigFixture).success).toBe(false)
  expect(parseBigbrainConfiguration(managedConfig)).toEqual(managedConfig)
  expect(parseBigbrainConfiguration(localConfigFixture)).toEqual(localConfigFixture)
  expect(isManagedSharedConfig(managedConfig)).toBe(true)
  expect(isManagedSharedConfig(localConfigFixture)).toBe(false)
})

test('a managed row with a path, port, endpoint or another pin is not managed and not local', () => {
  for (const extra of [
    { vaultPath: '/vault' },
    { endpoint: 'http://127.0.0.1:1' },
    { port: 34792 },
    { bindingId: 'personal' },
  ]) {
    expect(() => parseBigbrainConfiguration({ ...managedConfig, ...extra })).toThrow()
  }
  expect(() => parseBigbrainConfiguration({ ...managedConfig, upstreamCommit: 'f'.repeat(40) })).toThrow()
  expect(() => parseBigbrainConfiguration({ ...managedConfig, version: 1 })).toThrow()
  expect(() => parseBigbrainConfiguration({ ...managedConfig, vaultId: 'not-a-uuid' })).toThrow()
})

test('credentials parse by syntax and only match their own variant', () => {
  expect(parseBigbrainCredential('0123abcd')).toBe('0123abcd')
  expect(parseBigbrainCredential(readToken)).toBe(readToken)
  for (const bad of ['', 'sv_', `sv_0123abcd_${'A'.repeat(42)}`, 'ABCDEF01', 42, null]) {
    expect(() => parseBigbrainCredential(bad)).toThrow('Invalid credential')
  }
  expect(credentialMatchesConfiguration(parseBigbrainConfiguration(managedConfig), readToken)).toBe(true)
  expect(credentialMatchesConfiguration(parseBigbrainConfiguration(managedConfig), '0123abcd')).toBe(false)
  expect(credentialMatchesConfiguration(parseBigbrainConfiguration(localConfigFixture), readToken)).toBe(false)
  expect(credentialMatchesConfiguration(parseBigbrainConfiguration(localConfigFixture), '0123abcd')).toBe(true)
})
