import { afterEach, describe, expect, test } from 'bun:test'
import {
  allSecretGroups,
  canListAnySecret,
  getSecretGroups,
  globToRegExp,
  resetSecretGroups,
  secretAccessible,
  secretPermissionCandidates,
} from './groups'
import { COPIED_LEGACY_SECRET_ROW_KEYS } from '../../db/legacy-secret-rows'

afterEach(() => resetSecretGroups())

describe('globToRegExp', () => {
  test('* matches any run, anchored', () => {
    expect(globToRegExp('GITHUB_*').test('GITHUB_TOKEN')).toBe(true)
    expect(globToRegExp('GITHUB_*').test('XGITHUB_TOKEN')).toBe(false)
    expect(globToRegExp('*ENCRYPTION_KEY').test('FICUS_ENCRYPTION_KEY')).toBe(true)
  })

  test('? matches exactly one char; regex specials are literal', () => {
    expect(globToRegExp('A?C').test('ABC')).toBe(true)
    expect(globToRegExp('A?C').test('AC')).toBe(false)
    expect(globToRegExp('A.C').test('AxC')).toBe(false)
  })
})

describe('getSecretGroups (default config)', () => {
  test('categorizes every current known key intentionally and non-overlapping', () => {
    const expected = new Map<string, string[]>([
      ['FICUS_PASSWORD', ['system']],
      // The retained TAU_ secret rows stay authorized until the bridge is removed (Task 36).
      ['TAU_PASSWORD', ['system']],
      ['VAPID_SUBJECT', ['notification']],
      ['OPENAI_API_KEY', ['provider']],
      ['GITHUB_TOKEN', ['integration']],
      ['GITHUB_USER', ['integration']],
      ['GITHUB_WEBHOOK_SECRET', ['integration']],
      ['GIT_USER_NAME', ['integration']],
      ['GIT_USER_EMAIL', ['integration']],
      ['LINEAR_API_KEY', ['integration']],
      ['LINEAR_WEBHOOK_SECRET', ['integration']],
      ['LINEAR_USER_ID', ['integration']],
      ['DISCORD_APPLICATION_ID', ['integration']],
      ['DISCORD_PUBLIC_KEY', ['integration']],
      ['DISCORD_BOT_TOKEN', ['integration']],
      ['DISCORD_GUILD_ID', ['integration']],
      ['SLACK_SIGNING_SECRET', ['integration']],
      ['SLACK_BOT_TOKEN', ['integration']],
      ['TELEGRAM_BOT_TOKEN', ['integration']],
      ['TELEGRAM_WEBHOOK_SECRET', ['integration']],
      ['TELEGRAM_BOT_ID', ['integration']],
      ['VAPID_PUBLIC_KEY', ['notification']],
      ['VAPID_PRIVATE_KEY', ['notification']],
      ['GOOGLE_SERVICE_ACCOUNT_JSON', ['provider']],
      ['DEPLOY_VERCEL_TOKEN', ['integration']],
      ['DEPLOY_NETLIFY_TOKEN', ['integration']],
      ['DEPLOY_CLOUDFLARE_TOKEN', ['integration']],
      ['DEPLOY_GITHUB_PAGES_TOKEN', ['integration']],
      ['DEPLOY_RAILWAY_TOKEN', ['integration']],
      ['DEPLOY_SUPABASE_TOKEN', ['integration']],
      ['DEPLOY_DIGITALOCEAN_TOKEN', ['integration']],
      ['PROVIDER_AUTH_DATA', ['provider']],
    ])

    for (const [key, groups] of expected) {
      expect(getSecretGroups(key), key).toEqual(groups)
    }
  })

  test('unmatched key -> [] (admin-only)', () => {
    expect(getSecretGroups('SOME_RANDOM_KEY')).toEqual([])
  })

  test('all four groups present', () => {
    expect(allSecretGroups().sort()).toEqual(['integration', 'notification', 'provider', 'system'])
  })
})

describe('secretAccessible / candidates', () => {
  test('candidates include bare + each group', () => {
    expect(secretPermissionCandidates('GITHUB_TOKEN', 'read')).toEqual(['secrets:read', 'secrets:read:integration'])
    expect(secretPermissionCandidates('SOME_RANDOM_KEY', 'write')).toEqual(['secrets:write'])
  })

  test('bare secrets:read reads everything incl. unmatched', () => {
    expect(secretAccessible(['secrets:read'], 'FICUS_PASSWORD', 'read')).toBe(true)
    expect(secretAccessible(['secrets:read'], 'SOME_RANDOM_KEY', 'read')).toBe(true)
  })

  test('wildcard admin reads everything', () => {
    expect(secretAccessible(['*'], 'SOME_RANDOM_KEY', 'read')).toBe(true)
    expect(secretAccessible(['secrets:*'], 'FICUS_PASSWORD', 'write')).toBe(true)
  })

  test('group-limited reads only its group, not others/unmatched', () => {
    const held = ['secrets:read:integration', 'secrets:write:integration']
    expect(secretAccessible(held, 'GITHUB_TOKEN', 'read')).toBe(true)
    expect(secretAccessible(held, 'GITHUB_TOKEN', 'write')).toBe(true)
    expect(secretAccessible(held, 'OPENAI_API_KEY', 'read')).toBe(false)
    expect(secretAccessible(held, 'FICUS_PASSWORD', 'read')).toBe(false)
    expect(secretAccessible(held, 'SOME_RANDOM_KEY', 'read')).toBe(false)
  })

  test('each FICUS_ row the rename migration copies is authorized exactly like its retained TAU_ source', () => {
    for (const legacy of COPIED_LEGACY_SECRET_ROW_KEYS) {
      const current = `FICUS_${legacy.slice('TAU_'.length)}`
      expect(getSecretGroups(current), current).toEqual(['system'])
      expect(getSecretGroups(legacy), legacy).toEqual(['system'])
      for (const action of ['read', 'write'] as const) {
        expect(secretPermissionCandidates(current, action)).toEqual(secretPermissionCandidates(legacy, action))
        for (const key of [current, legacy]) {
          expect(secretAccessible([`secrets:${action}:system`], key, action), key).toBe(true)
          expect(
            secretAccessible(
              [`secrets:${action}:integration`, `secrets:${action}:provider`, `secrets:${action}:notification`],
              key,
              action
            ),
            key
          ).toBe(false)
        }
      }
    }
  })

  test('read grant does not imply write', () => {
    expect(secretAccessible(['secrets:read:integration'], 'GITHUB_TOKEN', 'write')).toBe(false)
  })

  test('canListAnySecret', () => {
    expect(canListAnySecret(['secrets:read:integration'])).toBe(true)
    expect(canListAnySecret(['secrets:read'])).toBe(true)
    expect(canListAnySecret(['*'])).toBe(true)
    expect(canListAnySecret(['agents:read'])).toBe(false)
  })
})
