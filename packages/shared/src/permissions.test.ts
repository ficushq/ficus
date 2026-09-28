import { describe, it, expect, test } from 'bun:test'
import { Permissions, isGrantablePermission, permissionMatches } from './permissions'

describe('isGrantablePermission', () => {
  test.each([
    [Permissions.SQUADS_READ, true],
    [Permissions.AGENTS_SCOPES_READ, true],
    ['agents:*', true],
    ['secrets:*', true],
    [Permissions.WILDCARD, false],
    ['legacy:manage', false],
    ['legacy:*', false],
  ] as const)('%s => %s', (permission, expected) => {
    expect(isGrantablePermission(permission)).toBe(expected)
  })
})

describe('slot permissions', () => {
  it('declares use and write as separately grantable sibling actions', () => {
    expect(Permissions.SLOTS_USE).toBe('slots:use')
    expect(Permissions.SLOTS_WRITE).toBe('slots:write')
    expect(isGrantablePermission(Permissions.SLOTS_USE)).toBe(true)
    expect(isGrantablePermission(Permissions.SLOTS_WRITE)).toBe(true)
    expect(permissionMatches(Permissions.SLOTS_WRITE, Permissions.SLOTS_USE)).toBe(false)
  })
})

describe('farm chat room management permission', () => {
  it('declares a dedicated permission that chat:* (Operator) covers and chat:send does not', () => {
    expect(Permissions.CHAT_MANAGE_ROOMS).toBe('chat:manage-rooms')
    expect(isGrantablePermission(Permissions.CHAT_MANAGE_ROOMS)).toBe(true)
    // Operators hold chat:*, which covers it.
    expect(permissionMatches('chat:*', Permissions.CHAT_MANAGE_ROOMS)).toBe(true)
    expect(permissionMatches(Permissions.CHAT_SEND, Permissions.CHAT_MANAGE_ROOMS)).toBe(false)
  })
})

describe('theme preset moderation permission', () => {
  it('declares a dedicated moderation permission distinct from settings/users management', () => {
    expect(Permissions.THEME_PRESETS_MODERATE).toBe('theme-presets:moderate')
    expect(isGrantablePermission(Permissions.THEME_PRESETS_MODERATE)).toBe(true)
    expect(permissionMatches(Permissions.SETTINGS_WRITE, Permissions.THEME_PRESETS_MODERATE)).toBe(false)
    expect(permissionMatches('theme-presets:*', Permissions.THEME_PRESETS_MODERATE)).toBe(true)
  })
})

describe('permissionMatches', () => {
  it('registers the dedicated forced-migration permission', () => {
    expect(Permissions.MACHINES_FORCE_MIGRATE).toBe('machines:force-migrate')
    expect(permissionMatches('machines:*', Permissions.MACHINES_FORCE_MIGRATE)).toBe(true)
    expect(permissionMatches(Permissions.MACHINES_WRITE, Permissions.MACHINES_FORCE_MIGRATE)).toBe(false)
  })
  it('exact match', () => expect(permissionMatches('agents:read', 'agents:read')).toBe(true))
  it('wildcard *', () => expect(permissionMatches('*', 'anything:here')).toBe(true))
  it('resource wildcard', () => expect(permissionMatches('secrets:*', 'secrets:read')).toBe(true))
  it('bare grants qualified', () => expect(permissionMatches('secrets:read', 'secrets:read:integration')).toBe(true))
  it('qualified does NOT grant bare', () =>
    expect(permissionMatches('secrets:read:integration', 'secrets:read')).toBe(false))
  it('bare resource string does NOT grant an action', () => {
    expect(permissionMatches('secrets', 'secrets:read')).toBe(false)
    expect(permissionMatches('agents', 'agents:read')).toBe(false)
  })
  it('no cross-resource', () => expect(permissionMatches('agents:read', 'squads:read')).toBe(false))
  test.each([
    ['integrations:write', 'integrations:write:bigbrain', true],
    ['integrations:write:*', 'integrations:write:bigbrain', true],
    ['integrations:write:bigbrain', 'integrations:write:bigbrain', true],
    ['integrations:write:bigbrain', 'integrations:write:github', false],
    ['integrations:write:github', 'integrations:write:bigbrain', false],
  ] as const)('%s requesting %s => %s', (held, requested, allowed) => {
    expect(permissionMatches(held, requested)).toBe(allowed)
  })
  it('keeps squad inbox reads distinct from regular inbox reads', () => {
    expect(Permissions.INBOX_READ_SQUAD).toBe('inbox:read-squad')
    expect(permissionMatches(Permissions.INBOX_READ, Permissions.INBOX_READ_SQUAD)).toBe(false)
    expect(permissionMatches('inbox:*', Permissions.INBOX_READ_SQUAD)).toBe(true)
  })
  it('sandbox:logs permission exists and is covered by wildcard', () => {
    expect(Permissions.SANDBOX_LOGS).toBe('sandbox:logs')
    expect(permissionMatches('*', Permissions.SANDBOX_LOGS)).toBe(true)
    expect(permissionMatches('sandbox:logs', 'sandbox:logs')).toBe(true)
    expect(permissionMatches('terminal:access', 'sandbox:logs')).toBe(false)
  })
  it('system:pause is distinct from other system actions', () => {
    expect(Permissions.SYSTEM_PAUSE).toBe('system:pause')
    expect(permissionMatches(Permissions.SYSTEM_PAUSE, Permissions.SYSTEM_RESTART)).toBe(false)
  })
  it('system:logs permission exists and is covered by wildcard', () => {
    expect(Permissions.SYSTEM_LOGS).toBe('system:logs')
    expect(permissionMatches('*', Permissions.SYSTEM_LOGS)).toBe(true)
    expect(permissionMatches('system:logs', 'system:logs')).toBe(true)
    expect(permissionMatches('sandbox:logs', 'system:logs')).toBe(false)
    expect(permissionMatches('system:restart', 'system:logs')).toBe(false)
  })
})

test('operations recommendation scopes are defined', () => {
  expect(Permissions.RECOMMENDATIONS_READ).toBe('recommendations:read')
  expect(Permissions.RECOMMENDATIONS_UPDATE).toBe('recommendations:update')
})

test('amtp scopes are defined', () => {
  expect(Permissions.AMTP_READ).toBe('amtp:read')
  expect(Permissions.AMTP_WRITE).toBe('amtp:write')
  expect(Permissions.AMTP_SEND).toBe('amtp:send')
})

describe('amtp:send matching', () => {
  it('granted by global wildcard', () => expect(permissionMatches('*', Permissions.AMTP_SEND)).toBe(true))
  it('granted by amtp resource wildcard', () => expect(permissionMatches('amtp:*', Permissions.AMTP_SEND)).toBe(true))
  it('granted by exact amtp:send', () => expect(permissionMatches(Permissions.AMTP_SEND, 'amtp:send')).toBe(true))
  it('NOT granted by amtp:write', () => expect(permissionMatches('amtp:write', Permissions.AMTP_SEND)).toBe(false))
  it('NOT granted by amtp:read', () => expect(permissionMatches('amtp:read', Permissions.AMTP_SEND)).toBe(false))
})
