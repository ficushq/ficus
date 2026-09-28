import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { permissionMatches } from '@ficus/shared'
import { parse } from 'yaml'
import { CONFIG_DIR } from '../../lib/paths'

export type SecretAction = 'read' | 'write'

interface GroupsFile {
  groups?: Record<string, string[]>
}

let groupsCache: Record<string, RegExp[]> | null = null

/** Translate a key-glob ('*' any, '?' one) to an anchored, case-sensitive RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

function load(): Record<string, RegExp[]> {
  if (groupsCache) return groupsCache

  let parsed: GroupsFile = {}
  try {
    parsed = (parse(readFileSync(join(CONFIG_DIR, 'secrets', 'groups.yaml'), 'utf-8')) as GroupsFile) ?? {}
  } catch {
    parsed = {}
  }

  const compiled: Record<string, RegExp[]> = {}
  for (const [group, patterns] of Object.entries(parsed.groups ?? {})) {
    compiled[group] = (patterns ?? []).map(globToRegExp)
  }

  groupsCache = compiled
  return compiled
}

/** Reset the cached config (tests / config reload). */
export function resetSecretGroups(): void {
  groupsCache = null
}

/** All configured group names. */
export function allSecretGroups(): string[] {
  return Object.keys(load())
}

/** Every group whose any pattern matches `key` (union membership; [] if none). */
export function getSecretGroups(key: string): string[] {
  const groups = load()
  return Object.keys(groups).filter((group) => groups[group].some((re) => re.test(key)))
}

/** Candidate permission strings that would grant `action` on `key`. */
export function secretPermissionCandidates(key: string, action: SecretAction): string[] {
  const base = `secrets:${action}`
  return [base, ...getSecretGroups(key).map((group) => `${base}:${group}`)]
}

/** Pure check: does a held-permission set grant `action` on `key`? */
export function secretAccessible(held: string[], key: string, action: SecretAction): boolean {
  return secretPermissionCandidates(key, action).some((required) =>
    held.some((permission) => permissionMatches(permission, required))
  )
}

/** Pure check: may this held set list ANY secret (bare or any group)? Used by the list guard. */
export function canListAnySecret(held: string[]): boolean {
  const candidates = ['secrets:read', ...allSecretGroups().map((group) => `secrets:read:${group}`)]
  return candidates.some((required) => held.some((permission) => permissionMatches(permission, required)))
}
