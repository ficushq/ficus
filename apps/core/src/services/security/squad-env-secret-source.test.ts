import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ContentSafetyRegistry } from './content-safety-registry'
import { SquadEnvSecretSource, isSecretLikeSquadEnvValue } from './squad-env-secret-source'

const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'env-source-'))
  roots.push(root)
  const file = (id: string, content: string) => {
    const dot = join(root, id, '.ficus')
    mkdirSync(dot, { recursive: true })
    writeFileSync(join(dot, 'env.user'), content)
    return join(dot, 'env.user')
  }
  const source = new SquadEnvSecretSource(() => root)
  const registry = new ContentSafetyRegistry(
    {
      bindContentSafetyConsumer(c) {
        c.replace([])
        return () => {}
      },
    },
    source
  )
  return { root, file, source, registry }
}

describe('squad env heuristic', () => {
  test('matches secret suffixes only above the minimum, including quoted passwords', () => {
    for (const key of [
      'APP_TOKEN',
      'APP_KEY',
      'APP_SECRET',
      'APP_PASSWORD',
      'APP_CREDENTIALS',
      'TOKEN',
      'app_secret',
    ]) {
      expect(isSecretLikeSquadEnvValue(key, 'abcdefghijkl')).toBe(true)
      expect(isSecretLikeSquadEnvValue(key, 'production')).toBe(false)
      expect(isSecretLikeSquadEnvValue(key, '')).toBe(false)
    }
    expect(isSecretLikeSquadEnvValue('APP_PASSWORD', 'long password with spaces')).toBe(true)
  })
  test('requires long high entropy for other keys, excluding ordinary config', () => {
    expect(isSecretLikeSquadEnvValue('CUSTOM', 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ0cF1iL')).toBe(true)
    for (const value of [
      'production',
      'development',
      'abcdefghijklmnopqrstuvwxzyabcdefghij',
      'A'.repeat(64),
      'some ordinary configuration with spaces and words',
      '/opt/SomePathWithNumbers1234567890/foo',
      'https://example.com/SomeLongPathWithNumbers1234567890',
      '123e4567-e89b-12d3-a456-426614174000',
    ]) {
      expect(isSecretLikeSquadEnvValue('CUSTOM', value)).toBe(false)
    }
  })
})

test('loads existing env.user values from every squad, redacts only output, refreshes edits and deletions', () => {
  const f = fixture()
  const one = randomUUID(),
    two = randomUUID()
  const path = f.file(one, "export APP_TOKEN='synthetic-env-first'\nMODE=production\n")
  f.file(two, 'APP_PASSWORD="synthetic-env-second"')
  expect(f.registry.redactWithStoredKeys('synthetic-env-first synthetic-env-second production')).toEqual({
    value: expect.not.stringContaining('synthetic-env-'),
    storedKeys: [],
  })
  expect(f.registry.redact('production')).toBe('production')
  const cached = f.source.entries()
  expect(f.source.entries()).toBe(cached)
  writeFileSync(path, 'APP_TOKEN=synthetic-env-third')
  expect(f.registry.redact('synthetic-env-third')).not.toContain('synthetic-env-third')
  expect(f.registry.redact('synthetic-env-first')).toBe('synthetic-env-first')
  rmSync(join(f.root, two), { recursive: true })
  rmSync(path)
  expect(f.registry.redact('synthetic-env-third synthetic-env-second')).toBe('synthetic-env-third synthetic-env-second')
  f.registry.dispose()
})

test('parses literal quoted/multiline values without evaluating shell or scanning workspace app files', () => {
  const f = fixture()
  const id = randomUUID()
  const marker = join(f.root, 'must-not-execute')
  f.file(
    id,
    `APP_SECRET='synthetic secret with spaces'\nPRIVATE_KEY="line one\nline two synthetic"\nEXEC=$(touch ${marker})\n`
  )
  mkdirSync(join(f.root, id, 'app'))
  writeFileSync(join(f.root, id, 'app', '.env.local'), 'APP_TOKEN=synthetic-unregistered-app-token')
  expect(f.registry.redact('synthetic secret with spaces')).not.toContain('synthetic secret with spaces')
  expect(f.registry.redact('line one\nline two synthetic')).not.toContain('line one')
  expect(f.registry.redact('synthetic-unregistered-app-token')).toBe('synthetic-unregistered-app-token')
  expect(existsSync(marker)).toBe(false)
  f.registry.dispose()
})

test('never follows symlink files or settings directories or non-squad directories', () => {
  const f = fixture()
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'env.user'), 'APP_TOKEN=synthetic-outside-token')
  mkdirSync(join(f.root, randomUUID()))
  const symlinked = randomUUID()
  mkdirSync(join(f.root, symlinked))
  symlinkSync(outside, join(f.root, symlinked, '.ficus'))
  const other = randomUUID()
  const path = f.file(other, '')
  rmSync(path)
  symlinkSync(join(outside, 'env.user'), path)
  f.file('not-a-squad', 'APP_TOKEN=synthetic-outside-token')
  expect(f.registry.redact('synthetic-outside-token')).toBe('synthetic-outside-token')
  f.registry.dispose()
})
