import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ContentSafetyRegistry } from './content-safety-registry'
import { SquadEnvSecretSource, isSecretLikeSquadEnvValue } from './squad-env-secret-source'
import type { SquadEnvDetectionRepository, SquadEnvSnapshot } from './squad-env-detection-repository'

const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true })
})
class MemoryRepository implements SquadEnvDetectionRepository {
  readonly marked = new Set<string>()
  readonly snapshots = new Map<string, SquadEnvSnapshot | undefined>()
  bootstrapWrites = 0
  async pendingSquads() {
    return [...this.snapshots.keys()].filter((id) => !this.marked.has(id))
  }
  async bootstrap(id: string, snapshot: SquadEnvSnapshot) {
    if (this.marked.has(id)) return
    this.bootstrapWrites++
    await this.save(id, snapshot)
  }
  async save(id: string, snapshot: SquadEnvSnapshot, write?: () => void) {
    write?.()
    this.marked.add(id)
    this.snapshots.set(id, structuredClone(snapshot))
  }
  async list() {
    return [...this.snapshots].map(([squadId, snapshot]) => ({ squadId, snapshot }))
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'env-source-'))
  roots.push(root)
  const repository = new MemoryRepository()
  let now = 10_000
  const warnings: string[] = []
  const file = (id: string, content: string) => {
    const dot = join(root, id, '.ficus')
    mkdirSync(dot, { recursive: true })
    writeFileSync(join(dot, 'env.user'), content)
    if (!repository.snapshots.has(id)) repository.snapshots.set(id, undefined)
    return join(dot, 'env.user')
  }
  const makeSource = () =>
    new SquadEnvSecretSource(() => root, {
      repository,
      now: () => now,
      warn: (message) => {
        warnings.push(message)
      },
    })
  const source = makeSource()
  const registry = new ContentSafetyRegistry(
    {
      bindContentSafetyConsumer(c) {
        c.replace([])
        return () => {}
      },
    },
    source
  )
  return {
    root,
    file,
    source,
    registry,
    repository,
    warnings,
    makeSource,
    tick: () => {
      now += 1000
    },
  }
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

test('loads legacy env once, ignores direct edits, accepts service updates and observes deletion', async () => {
  const f = fixture()
  const one = randomUUID(),
    two = randomUUID()
  const path = f.file(one, "export APP_TOKEN='synthetic-env-first'\nMODE=production\n")
  f.file(two, 'APP_PASSWORD="synthetic-env-second"')
  await f.source.initialize()
  expect(f.registry.redactWithStoredKeys('synthetic-env-first synthetic-env-second production')).toEqual({
    value: expect.not.stringContaining('synthetic-env-'),
    storedKeys: [],
  })
  expect(f.registry.redact('production')).toBe('production')
  const cached = f.source.entries()
  expect(f.source.entries()).toBe(cached)
  writeFileSync(path, 'APP_TOKEN=synthetic-env-third')
  f.tick()
  expect(f.registry.redact('synthetic-env-third')).toBe('synthetic-env-third')
  await f.source.recordWrite(one, 'APP_TOKEN=synthetic-env-third')
  expect(f.registry.redact('synthetic-env-third')).not.toContain('synthetic-env-third')
  expect(f.registry.redact('synthetic-env-first')).toBe('synthetic-env-first')
  rmSync(join(f.root, two), { recursive: true })
  rmSync(path)
  f.tick()
  expect(f.registry.redact('synthetic-env-third synthetic-env-second')).toBe('synthetic-env-third synthetic-env-second')
  f.registry.dispose()
})

test('parses literal quoted/multiline values without evaluating shell or scanning workspace app files', async () => {
  const f = fixture()
  const id = randomUUID()
  const marker = join(f.root, 'must-not-execute')
  f.file(
    id,
    `APP_SECRET='synthetic secret with spaces'\nPRIVATE_KEY="line one\nline two synthetic"\nEXEC=$(touch ${marker})\n`
  )
  mkdirSync(join(f.root, id, 'app'))
  writeFileSync(join(f.root, id, 'app', '.env.local'), 'APP_TOKEN=synthetic-unregistered-app-token')
  await f.source.initialize()
  expect(f.registry.redact('synthetic secret with spaces')).not.toContain('synthetic secret with spaces')
  expect(f.registry.redact('line one\nline two synthetic')).not.toContain('line one')
  expect(f.registry.redact('synthetic-unregistered-app-token')).toBe('synthetic-unregistered-app-token')
  expect(existsSync(marker)).toBe(false)
  f.registry.dispose()
})

test('never follows symlink files or settings directories or non-squad directories', async () => {
  const f = fixture()
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'env.user'), 'APP_TOKEN=synthetic-outside-token')
  mkdirSync(join(f.root, randomUUID()))
  const symlinked = randomUUID()
  f.file(symlinked, '')
  rmSync(join(f.root, symlinked, '.ficus'), { recursive: true })
  symlinkSync(outside, join(f.root, symlinked, '.ficus'))
  const other = randomUUID()
  const path = f.file(other, '')
  rmSync(path)
  symlinkSync(join(outside, 'env.user'), path)
  f.file('not-a-squad', 'APP_TOKEN=synthetic-outside-token')
  await f.source.initialize()
  expect(f.registry.redact('synthetic-outside-token')).toBe('synthetic-outside-token')
  f.registry.dispose()
})

// Bash is an independent oracle for FIXED synthetic literal fixtures only. The
// production detector must never source user input or spawn a shell.
const shellLiteralCases = [
  ['embedded unquoted hash', 'APP_TOKEN=abc123#SyntheticSecret456'],
  ['literal dollar before closing double quote', 'APP_TOKEN="SyntheticLiteralSecret123$"'],
  ['line continuation in assignment name', 'APP_TO\\\nKEN=synthetic-continued-key-value'],
  ['double quoted escaped dollar', String.raw`APP_TOKEN="Synthetic\$LiteralSecret123"`],
  ['concatenated single/double quote segments', `APP_TOKEN='Synthetic'"'"'Secret123'`],
  ['unquoted escapes', String.raw`export APP_TOKEN=Synthetic\ Secret\ \#123456`],
  ['double quoted non-special escape', String.raw`APP_TOKEN="Synthetic\qSecret123"`],
  ['double quoted backslash-n stays literal', String.raw`APP_TOKEN="Synthetic\nSecret123"`],
  ['double quoted backslash and escaped quote', String.raw`APP_TOKEN="Synthetic\\Secret\"123456"`],
  ['single quoted special characters', String.raw`APP_TOKEN='Synthetic$Literal\Secret#123'`],
  ['multiline quoted literal', 'APP_TOKEN="Synthetic\nLiteralSecret123"'],
  ['unquoted line continuation', 'APP_TOKEN=Synthetic\\\nLiteralSecret123'],
  ['double quoted line continuation', 'APP_TOKEN="Synthetic\\\nLiteralSecret123"'],
  ['single quoted backslash-newline remains literal', "APP_TOKEN='Synthetic\\\nLiteralSecret123'"],
  ['trailing comment', 'APP_TOKEN=synthetic-literal-value # ignored comment'],
  ['concatenated empty fragments and equals', `APP_TOKEN=''Synthetic""Secret=123456`],
  ['Bash ANSI-C escapes', String.raw`APP_TOKEN=$'Synthetic\x24Literal\u0024Secret\n123'`],
  ['Bash ANSI-C octal/backslash/quote', String.raw`APP_TOKEN=$'Synthetic\044Literal\\Secret\'123'`],
  ['Bash ANSI-C NUL truncation within a fragment', String.raw`APP_TOKEN=$'SyntheticSecret123\0ignored''Tail'`],
  ['Bash ANSI-C Unicode in default C locale', String.raw`APP_TOKEN=$'Synthetic\u00e9Secret\U0001f600123'`],
  ['Bash ANSI-C UTF8 across fragments', String.raw`APP_TOKEN=$'Synthetic\xc3'$'\xa9Secret123'`],
] as const

for (const [label, content] of shellLiteralCases) {
  test(`redacts the actual Bash literal value: ${label}`, async () => {
    const f = fixture()
    f.file(randomUUID(), content)
    const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', `${content}\nprintf %s "$APP_TOKEN"`], {
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(actual.error).toBeUndefined()
    expect(actual.status).toBe(0)
    expect(actual.stdout.length).toBeGreaterThanOrEqual(12)
    await f.source.initialize()
    expect(f.source.entries().map((entry) => entry.value)).toContain(actual.stdout)
    expect(f.registry.redact(actual.stdout)).not.toContain(actual.stdout)
    expect(f.registry.redactWithStoredKeys(actual.stdout).storedKeys).toEqual([])
    f.registry.dispose()
  })
}

test('does not execute or infer dynamic expressions, or treat command arguments as env assignments', async () => {
  const f = fixture()
  const marker = join(f.root, 'must-not-execute')
  f.file(
    randomUUID(),
    [
      'APP_TOKEN="synthetic-$DYNAMIC-value"',
      'APP_SECRET=${OTHER:-synthetic-parameter-value}',
      `APP_PASSWORD=$(touch ${marker})`,
      'APP_KEY=`printf synthetic-backtick-value`',
      'OTHER_TOKEN=$((1234567890123456 + 1))',
      'OLD_ARITHMETIC_TOKEN=$[1234567890123456 + 1]',
      'LOCALE_SECRET=$"synthetic-locale-dependent-value"',
      'PROCESS_SECRET=<(printf synthetic-process-value)',
      "printf '%s' 'COMMAND_TOKEN=synthetic-command-argument'",
      '# COMMENT_TOKEN=synthetic-comment-value',
      'SIMPLE_SECRET=synthetic-known-literal; export NEXT_TOKEN=synthetic-second-literal',
      'export THIRD_TOKEN=synthetic-third-literal FOURTH_TOKEN=synthetic-fourth-literal',
    ].join('\n')
  )
  await f.source.initialize()
  const entries = f.source.entries()
  expect(entries.map((e) => e.value).sort()).toEqual(
    [
      'synthetic-known-literal',
      'synthetic-second-literal',
      'synthetic-third-literal',
      'synthetic-fourth-literal',
    ].sort()
  )
  expect(existsSync(marker)).toBe(false)
  f.registry.dispose()
})

test('skips nested multiline substitutions and malformed literals without registering inner text', async () => {
  const f = fixture()
  f.file(
    randomUUID(),
    [
      'APP_TOKEN=$(printf "%s" "$(printf nested)"',
      'INNER_TOKEN=synthetic-not-an-env-value',
      ')',
      'export REAL_TOKEN=synthetic-valid-after-expression',
      'BROKEN_SECRET="synthetic-unclosed-value',
    ].join('\n')
  )
  await f.source.initialize()
  expect(f.source.entries().map((e) => e.value)).toEqual(['synthetic-valid-after-expression'])
  f.registry.dispose()
})

test('export identifiers do not hide subsequent literal assignments, and later dynamic assignments replace old coverage', async () => {
  const f = fixture()
  f.file(
    randomUUID(),
    [
      'export EXISTING APP_TOKEN=synthetic-exported-token',
      'OLD_TOKEN=synthetic-old-then-dynamic',
      'OLD_TOKEN=$UNKNOWN',
      'OTHER_SECRET=synthetic-first-assignment',
      'OTHER_SECRET=synthetic-second-assignment',
    ].join('\n')
  )
  await f.source.initialize()
  expect(f.source.entries().map((entry) => entry.value)).toEqual([
    'synthetic-exported-token',
    'synthetic-second-assignment',
  ])
  f.registry.dispose()
})

test('heredoc data is not interpreted as environment assignments', async () => {
  const f = fixture()
  f.file(
    randomUUID(),
    ["cat <<'EOF'", 'APP_TOKEN=synthetic-heredoc-not-an-env-value', 'EOF', 'REAL_TOKEN=synthetic-after-heredoc'].join(
      '\n'
    )
  )
  await f.source.initialize()
  expect(f.source.entries().map((entry) => entry.value)).toEqual(['synthetic-after-heredoc'])
  f.registry.dispose()
})

test('covers the UTF-8 interpretation of ANSI-C Unicode escapes without reading shell locale or env', async () => {
  const f = fixture()
  const content = String.raw`APP_TOKEN=$'Synthetic\u00e9Secret\U0001f600123'`
  f.file(randomUUID(), content)
  const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', `${content}\nprintf %s "$APP_TOKEN"`], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  })
  expect(actual.status).toBe(0)
  await f.source.initialize()
  expect(f.source.entries().map((entry) => entry.value)).toContain(actual.stdout)
  expect(f.registry.redact(actual.stdout)).not.toContain(actual.stdout)
  expect(f.registry.redactWithStoredKeys(actual.stdout).storedKeys).toEqual([])
  f.registry.dispose()
})

test('public/browser-exposed keys do not match even on the secret-name path', async () => {
  for (const key of [
    'STRIPE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_API_KEY',
    'SSH_PUBLIC_KEY',
    'VITE_APP_TOKEN',
    'REACT_APP_SECRET',
    'public_token',
  ]) {
    expect(isSecretLikeSquadEnvValue(key, 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ0cF1iL')).toBe(false)
  }
  expect(isSecretLikeSquadEnvValue('PORT', '3000')).toBe(false)
})

test('a later direct on-disk edit cannot register a process-wide output scrubber', async () => {
  const f = fixture()
  const path = f.file(randomUUID(), 'APP_TOKEN=synthetic-trusted-env-value')
  await f.source.initialize()
  expect(f.registry.redact('synthetic-trusted-env-value')).not.toContain('synthetic-trusted-env-value')
  writeFileSync(path, "APP_TOKEN='import React from synthetic'\n")
  f.tick()
  expect(f.registry.redact('import React from synthetic')).toBe('import React from synthetic')
  f.registry.dispose()
})

test('oversized legacy env files are not parsed or registered', async () => {
  const f = fixture()
  f.file(randomUUID(), 'APP_TOKEN=synthetic-oversized-env-value\n#' + 'x'.repeat(256 * 1024))
  await f.source.initialize()
  expect(f.source.entries()).toEqual([])
  expect(f.registry.redact('synthetic-oversized-env-value')).toBe('synthetic-oversized-env-value')
  f.registry.dispose()
})

test('bootstrap marker survives source restart and a missing row never authorizes another disk snapshot', async () => {
  const f = fixture()
  const id = randomUUID()
  const path = f.file(id, 'APP_TOKEN=synthetic-legacy-env-token')
  await f.source.initialize()
  expect(f.repository.bootstrapWrites).toBe(1)
  writeFileSync(path, 'APP_TOKEN=synthetic-untrusted-new-token')
  const restarted = f.makeSource()
  await restarted.initialize()
  expect(restarted.entries()).toEqual([])
  expect(f.repository.bootstrapWrites).toBe(1)
  f.repository.snapshots.set(id, undefined)
  await restarted.initialize()
  expect(restarted.entries()).toEqual([])
  expect(f.repository.bootstrapWrites).toBe(1)
  await restarted.recordWrite(id, 'APP_TOKEN=synthetic-untrusted-new-token')
  expect(restarted.entries().map(({ value }) => value)).toContain('synthetic-untrusted-new-token')
  expect(restarted.notice(id)).toBeUndefined()
  f.registry.dispose()
})

test('throttles disk checks, warns once per squad and never refreshes authority from direct edits', async () => {
  const f = fixture()
  const id = randomUUID()
  const path = f.file(id, 'APP_TOKEN=synthetic-env-stable-token')
  await f.source.initialize()
  const cached = f.source.entries()
  writeFileSync(path, 'APP_TOKEN=synthetic-env-untrusted-token')
  for (let n = 0; n < 1000; n++) expect(f.source.entries()).toBe(cached)
  f.tick()
  expect(f.source.entries()).toEqual([])
  expect(f.source.notice(id)).toContain('outside Settings')
  expect(f.warnings).toHaveLength(1)
  for (let n = 0; n < 3; n++) {
    f.tick()
    f.source.entries()
  }
  expect(f.warnings).toHaveLength(1)
  expect(f.warnings.join('')).not.toContain('synthetic-env-')
  f.registry.dispose()
})

test('a new disk-only environment after upgrade cannot create a trusted record', async () => {
  const f = fixture()
  await f.source.initialize()
  const id = randomUUID()
  f.file(id, 'APP_TOKEN=synthetic-new-disk-env-token')
  // New real squads are marked already bootstrapped by Squad.create.
  f.repository.marked.add(id)
  await f.source.refresh()
  f.tick()
  expect(f.source.entries()).toEqual([])
  expect(f.source.notice(id)).toBeDefined()
  expect(f.repository.bootstrapWrites).toBe(0)
  f.registry.dispose()
})

test('a warning sanitized by the same registry cannot recursively rescan', async () => {
  const f = fixture()
  const id = randomUUID()
  f.file(id, 'APP_TOKEN=synthetic-env-recursion-token')
  const source = new SquadEnvSecretSource(() => f.root, {
    repository: f.repository,
    warn: () => {
      source.entries()
    },
  })
  await source.initialize()
  f.repository.snapshots.set(id, undefined)
  await source.refresh()
  // A newly constructed instance has no throttle state or mutable disk authority.
  const restarted = new SquadEnvSecretSource(() => f.root, {
    repository: f.repository,
    warn: () => {
      restarted.entries()
    },
  })
  await restarted.initialize()
  expect(restarted.entries()).toEqual([])
  f.registry.dispose()
})

test('an in-flight peer refresh cannot overwrite a concurrent same-process API update', async () => {
  const f = fixture()
  const id = randomUUID()
  const path = f.file(id, 'APP_TOKEN=synthetic-old-refresh-token')
  await f.source.initialize()
  const originalList = f.repository.list.bind(f.repository)
  let release!: () => void
  let notifyStarted!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  f.repository.list = async () => {
    const rows = await originalList()
    notifyStarted()
    await gate
    return rows
  }
  const refreshing = f.source.refresh()
  try {
    await started
    await f.source.recordWrite(id, 'APP_TOKEN=synthetic-new-api-race-token', () =>
      writeFileSync(path, 'APP_TOKEN=synthetic-new-api-race-token')
    )
  } finally {
    release()
    await refreshing
    f.repository.list = originalList
  }
  expect(f.source.entries().map(({ value }) => value)).toContain('synthetic-new-api-race-token')
  f.registry.dispose()
})
