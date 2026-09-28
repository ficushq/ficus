import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Permissions } from '@ficus/shared'
import { CONFIG_DIR } from '../../lib/paths'

const AGENT_TYPES_DIR = join(CONFIG_DIR, 'agent-types')
const ALL_PERMISSIONS = new Set<string>(Object.values(Permissions))

function scopesOf(file: string): string[] {
  const doc = parse(readFileSync(join(AGENT_TYPES_DIR, file), 'utf-8')) as { scopes?: string[] }
  return doc.scopes ?? []
}

function rolePermissions(slug: string): string[] {
  const doc = parse(readFileSync(join(CONFIG_DIR, 'roles', 'defaults.yaml'), 'utf-8')) as {
    roles: { slug: string; permissions: string[] }[]
  }
  return doc.roles.find((r) => r.slug === slug)?.permissions ?? []
}

// Agent federation grants live on the per-agent-type ROLES (roleSlugForAgentType maps
// manager/consultant -> default-manager, everything else
// -> default-worker), NOT on per-agent-type extra scopes. This keeps engineer/worker (which
// share default-worker) federation-free without a leaky role grant.
describe('amtp grants (D6)', () => {
  test('default-manager role grants amtp read + register + send', () => {
    const perms = rolePermissions('default-manager')
    expect(perms).toContain('amtp:read')
    expect(perms).toContain('amtp:register')
    expect(perms).toContain('amtp:send')
  })

  test('default-worker role (engineer/worker map here) grants NO amtp scopes', () => {
    expect(rolePermissions('default-worker').filter((p) => p.startsWith('amtp:'))).toEqual([])
  })

  test('the Operator user role grants amtp:register (alongside read + write)', () => {
    const perms = rolePermissions('operator')
    expect(perms).toContain('amtp:register')
    expect(perms).toContain('amtp:read')
    expect(perms).toContain('amtp:write')
  })

  test('agent-type YAMLs carry NO amtp extra scopes (moved to roles)', () => {
    // manager/consultant federate via their roles; engineer (default-worker) does not.
    for (const file of ['manager.yaml', 'engineer.yaml', 'consultant.yaml']) {
      expect(scopesOf(file).filter((s) => s.startsWith('amtp:'))).toEqual([])
    }
  })

  test('all amtp permissions granted in roles are valid Permissions constants', () => {
    for (const slug of ['default-manager', 'operator']) {
      for (const p of rolePermissions(slug).filter((s) => s.startsWith('amtp:'))) {
        expect(ALL_PERMISSIONS).toContain(p)
      }
    }
  })
})
