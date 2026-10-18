import { describe, expect, it } from 'bun:test'
import {
  LocalDeploymentAliasError,
  RESERVED_LOCAL_DEPLOYMENT_ALIASES,
  isWellFormedLocalDeploymentAlias,
  normalizeLocalDeploymentAlias,
} from './local-deployment-alias'

function refusal(raw: unknown, tenant = 'noah'): string {
  try {
    normalizeLocalDeploymentAlias(raw, tenant)
  } catch (error) {
    expect(error).toBeInstanceOf(LocalDeploymentAliasError)
    expect((error as LocalDeploymentAliasError).kind).toBe('invalid')
    return (error as Error).message
  }
  throw new Error(`expected ${JSON.stringify(raw)} to be refused`)
}

describe('normalizeLocalDeploymentAlias', () => {
  it('accepts plain DNS-label aliases, trimming and lowering ASCII case', () => {
    expect(normalizeLocalDeploymentAlias('dashboard', 'noah')).toBe('dashboard')
    expect(normalizeLocalDeploymentAlias('  Dash-Board-2 ', 'noah')).toBe('dash-board-2')
    expect(normalizeLocalDeploymentAlias('a', 'noah')).toBe('a')
    // All-hex but not the 12-hex id form: fine (the route marks aliases with ~).
    expect(normalizeLocalDeploymentAlias('cafe', 'noah')).toBe('cafe')
    expect(normalizeLocalDeploymentAlias('deadbeefcafe0', 'noah')).toBe('deadbeefcafe0')
  })

  it('refuses the tenant delimiter, punycode and stray hyphens', () => {
    expect(refusal('my--app')).toContain('two hyphens')
    expect(refusal('xn--80ak6aa92e')).toContain('two hyphens')
    expect(refusal('-app')).toContain('start or end')
    expect(refusal('app-')).toContain('start or end')
  })

  it('refuses anything outside lowercase a-z, digits and hyphens, Unicode included', () => {
    for (const raw of ['my_app', 'my.app', 'my app', 'app/x', 'app%2e', 'app:1', '*']) {
      expect(refusal(raw)).toContain('a-z, digits and hyphens')
    }
    // Unicode is refused, never case-mapped: U+212A KELVIN SIGN lowers to ASCII "k".
    expect(refusal('\u212Aanban')).toContain('a-z, digits and hyphens')
    expect(refusal('dashboard\u200b')).toContain('a-z, digits and hyphens')
    expect(refusal('dаshboard')).toContain('a-z, digits and hyphens') // Cyrillic а
  })

  it('refuses empty and non-string input', () => {
    expect(refusal('')).toContain('empty')
    expect(refusal('   ')).toContain('empty')
    expect(refusal(42)).toContain('string')
    expect(refusal(null)).toContain('string')
  })

  it('refuses the 12-hex id form in either case', () => {
    expect(refusal('0123456789ab')).toContain('app id')
    expect(refusal('0123456789AB')).toContain('app id')
  })

  it('refuses reserved names', () => {
    for (const name of ['api', 'admin', 'www', 'app', 'apps', 'mail', 'status', 'API']) {
      expect(refusal(name)).toContain('reserved')
    }
    expect(RESERVED_LOCAL_DEPLOYMENT_ALIASES.has('dashboard')).toBe(false)
  })

  it('keeps <tenant>--<alias> within the 63-character DNS label limit', () => {
    const tenant = 'a'.repeat(49)
    const room = 63 - tenant.length - 2
    expect(normalizeLocalDeploymentAlias('z'.repeat(room), tenant)).toHaveLength(room)
    expect(refusal('z'.repeat(room + 1), tenant)).toContain(`at most ${room}`)
    expect(`${tenant}--${'z'.repeat(room)}`).toHaveLength(63)
  })
})

describe('isWellFormedLocalDeploymentAlias', () => {
  it('matches only stored-form aliases', () => {
    expect(isWellFormedLocalDeploymentAlias('dashboard')).toBe(true)
    for (const value of ['Dashboard', 'a--b', '-a', 'api', '0123456789ab', '', 'a'.repeat(64), '%', '~a']) {
      expect(isWellFormedLocalDeploymentAlias(value)).toBe(false)
    }
  })
})
