import { DrizzleQueryError } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { ContentSafety } from './content-safety'

describe('ContentSafety', () => {
  test('returns only matching stored key names with the redacted value', () => {
    const first = `CANARY_${randomUUID()}`
    const second = `CANARY_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTHETIC_A', value: first },
      { key: 'SYNTHETIC_B', value: second },
    ])

    const inspected = safety.redactWithStoredKeys({ command: `${first}:${second}:${first}` })

    expect(inspected.value).toEqual({
      command: '[REDACTED_SECRET_ENV:SYNTHETIC_A]:[REDACTED_SECRET_ENV:SYNTHETIC_B]:[REDACTED_SECRET_ENV:SYNTHETIC_A]',
    })
    expect(inspected.storedKeys).toEqual(['SYNTHETIC_A', 'SYNTHETIC_B'])
    expect(JSON.stringify(inspected)).not.toContain(first)
    expect(JSON.stringify(inspected)).not.toContain(second)
  })

  test('reports no stored keys for heuristic-only credential redaction', () => {
    const credential = `ghp_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`

    const inspected = ContentSafety.fromSecretEntries([]).redactWithStoredKeys(credential)

    expect(inspected.value).toBe('[REDACTED_CREDENTIAL]')
    expect(inspected.storedKeys).toEqual([])
    expect(JSON.stringify(inspected)).not.toContain(credential)
  })

  test('reports every stored key whose exact bytes appear, even when a longer value absorbs the marker', () => {
    const short = `CANARY_${randomUUID()}`
    const longest = `${short}_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SHORT', value: short },
      { key: 'LONG', value: longest },
    ])

    const inspected = safety.redactWithStoredKeys(longest)

    // Marker emission keeps only the longest overlapping span, but key
    // reporting is byte-presence truth: SHORT's exact bytes did appear in the
    // payload, so the containment boundary must still see that key.
    expect(inspected.value).toBe('[REDACTED_SECRET_ENV:LONG]')
    expect(inspected.storedKeys).toEqual(['LONG', 'SHORT'])
    expect(JSON.stringify(inspected)).not.toContain(short)
    expect(JSON.stringify(inspected)).not.toContain(longest)
  })

  test('redacts an exact stored value without returning it in metadata', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])

    const result = safety.redact({ command: `echo ${canary}` })

    expect(result).toEqual({ command: 'echo [REDACTED_SECRET_ENV:TEST_KEY]' })
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('recursively redacts nested objects and arrays without mutating input', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const input = { tool: { arguments: [canary, { error: `failed: ${canary}` }] } }
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])

    const result = safety.redact(input)

    expect(result).toEqual({
      tool: {
        arguments: ['[REDACTED_SECRET_ENV:TEST_KEY]', { error: 'failed: [REDACTED_SECRET_ENV:TEST_KEY]' }],
      },
    })
    expect(input.tool.arguments[0]).toBe(canary)
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('redacts exact values in tool output and error strings', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])

    expect(safety.redact(`stdout=${canary}`)).toBe('stdout=[REDACTED_SECRET_ENV:TEST_KEY]')
    expect(safety.redact(new Error(`tool failed: ${canary}`))).toEqual(
      new Error('tool failed: [REDACTED_SECRET_ENV:TEST_KEY]')
    )
  })

  test.each([
    '0123456789abcdef0123456789abcdef01234567',
    'https://example.com/path?query=value',
    randomUUID(),
    'ordinary diagnostic prose with punctuation',
    'Enter your password: (input hidden)',
    'staging-api.us-east-1.amazonaws.com',
    '@earendil-works/pi-coding-agent.session_state.snapshot',
    'Add GITHUB_TOKEN=<paste yours> to .env',
    'Cookie: sid=abc; Path=/',
    'This is a SECRET: do not tell anyone',
    'password: /usr/local/bin/generated-tool',
    'token = v1.2.3-alpha-build-release',
    'my_secret_note: generated-config-value-1234',
    'Cookie: theme=generated-preference-value-1234',
    'secret: k8s.io/api/core/v1.SecretTypeOpaque',
    'secret: packages.example.com/generated/module-v123',
  ])('preserves common non-secret diagnostic text: %s', (value) => {
    const safety = ContentSafety.fromSecretEntries([])

    expect(safety.redact(value)).toBe(value)
  })

  test('classifies the credential and false-positive corpus in both directions', () => {
    const generated = randomUUID().replaceAll('-', '')
    const cases: Array<{ name: string; input: string; redacted: boolean }> = [
      { name: 'AWS key containing slash', input: `AWS_SECRET_ACCESS_KEY=AbCd12/${generated}EfGh34`, redacted: true },
      { name: 'padded base64 API token', input: `API_TOKEN=AbCd12/${generated}+EfGh34==`, redacted: true },
      { name: 'dotted opaque token', input: `API_TOKEN=AbCd12.${generated}.EfGh34`, redacted: true },
      { name: 'PASETO token', input: `API_TOKEN=v4.public.AbCd12/${generated}EfGh34`, redacted: true },
      { name: 'dotted client secret', input: `CLIENT_SECRET=AbCd12.${generated}.EfGh34`, redacted: true },
      { name: 'dotted bearer', input: `Authorization: Bearer AbCd12.${generated}.EfGh34`, redacted: true },
      { name: 'slash bearer', input: `Authorization: Bearer AbCd12/${generated}+EfGh34`, redacted: true },
      { name: 'database URL', input: `postgres://generated:AbCd12${generated}@db.example.test/app`, redacted: true },
      { name: 'slash cookie', input: `Cookie: session=AbCd12/${generated}+EfGh34`, redacted: true },
      { name: 'mixed-case hex token', input: `API_TOKEN=aB12${generated}Cd34`, redacted: true },
      { name: 'filesystem path', input: 'password: /usr/local/bin/generated-tool', redacted: false },
      { name: 'version string', input: 'token = v1.2.3-alpha-build-release', redacted: false },
      { name: 'kebab identifier', input: 'my_secret_note: generated-config-value-1234', redacted: false },
      { name: 'cookie preference', input: 'Cookie: theme=generated-preference-value-1234', redacted: false },
      { name: 'Kubernetes type', input: 'secret: k8s.io/api/core/v1.SecretTypeOpaque', redacted: false },
    ]
    for (const item of cases) {
      const result = ContentSafety.fromSecretEntries([]).redact(item.input)
      if (item.redacted) {
        expect(result, item.name).toContain('[REDACTED_CREDENTIAL]')
        expect(result, item.name).not.toBe(item.input)
      } else {
        expect(result, item.name).toBe(item.input)
      }
    }
  })

  test('redacts bounded assignment values before comma and semicolon separators', () => {
    const value = `Generated-${randomUUID()}`
    for (const separator of [',', ';']) {
      const result = ContentSafety.fromSecretEntries([]).redact(`API_TOKEN=${value}${separator} next`)
      expect(result).toBe(`[REDACTED_CREDENTIAL]${separator} next`)
      expect(result).not.toContain(value)
    }
  })

  test('redacts an entire stored entry when a credential pattern matches only its proper substring', () => {
    const credential = `sk-proj-${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
    const stored = `outer-prefix-${credential}-outer-suffix`
    const safety = ContentSafety.fromSecretEntries([{ key: 'WHOLE_KEY', value: stored }])
    expect(safety.redact(stored)).toBe('[REDACTED_SECRET_ENV:WHOLE_KEY]')
  })

  test('redacts runtime-generated recognized credential formats', () => {
    const body = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
    const credentials = [`ghp_${body}`, `github_pat_${body}_${body}`, `sk-proj-${body}`, `xoxb-${body}`]

    for (const credential of credentials) {
      const result = ContentSafety.fromSecretEntries([]).redact(credential)
      expect(result).toBe('[REDACTED_CREDENTIAL]')
      expect(JSON.stringify(result)).not.toContain(credential)
    }
  })

  test('redacts runtime-generated contextual credential material', () => {
    const opaque = `generated-${randomUUID()}`
    const basic = Buffer.from(`generated:${randomUUID()}`).toString('base64')
    const jwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(randomUUID()).toString('base64url'),
      Buffer.from(randomUUID()).toString('base64url'),
    ].join('.')
    const pemBody = Buffer.from(randomUUID()).toString('base64')
    const password = `password-${randomUUID()}`
    const credentials = [
      `Authorization: Bearer ${opaque}`,
      `Authorization: Basic ${basic}`,
      `Cookie: session=${opaque}; theme=dark`,
      jwt,
      `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`,
      `https://generated-user:${password}@example.test/path`,
    ]

    for (const credential of credentials) {
      const result = ContentSafety.fromSecretEntries([]).redact(credential)
      expect(result).toContain('[REDACTED_CREDENTIAL]')
      expect(result).not.toContain(opaque)
      expect(result).not.toContain(password)
      expect(result).not.toContain(pemBody)
    }
    for (const quote of ['"', "'"]) {
      for (const whitespace of [' ', '\t']) {
        const value = `${opaque}${whitespace}tail with whitespace`
        const result = ContentSafety.fromSecretEntries([]).redact(`API_TOKEN=${quote}${value}${quote}`)
        expect(result).toBe('[REDACTED_CREDENTIAL]')
        expect(JSON.stringify(result)).not.toContain('tail with whitespace')
      }
    }
  })

  test('preserves URL and byte-array runtime types while redacting', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])
    const password = `generated-${randomUUID()}`
    const url = new URL(`https://generated-user:${password}@example.test/${canary}`)
    const bytes = new TextEncoder().encode(canary)

    const safeUrl = safety.redact(url)
    const safeBytes = safety.redact(bytes)

    expect(safeUrl).toBeInstanceOf(URL)
    expect(safeUrl.toString()).not.toContain(canary)
    expect(safeUrl.toString()).not.toContain(password)
    expect(safeBytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(safeBytes)).not.toContain(canary)
  })

  test('redacts error names and structured object property keys', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])
    const error = new Error('safe message')
    error.name = `Failure_${canary}`

    const result = safety.redact({ [canary]: 'value', error })

    expect(Object.keys(result)[0]).toBe('[REDACTED_SECRET_ENV:TEST_KEY]')
    expect(result.error.name).toBe('Failure_[REDACTED_SECRET_ENV:TEST_KEY]')
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('sanitizes URLs, maps, sets, boxed strings, bytes, and custom instances', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])
    class CustomPayload {
      constructor(readonly content: string) {}
    }
    const input = {
      url: new URL(`https://example.test/${canary}`),
      map: new Map([[canary, new CustomPayload(canary)]]),
      set: new Set([canary]),
      boxed: new String(canary),
      bytes: new TextEncoder().encode(canary),
    }

    const result = safety.redact(input)
    const collected = [
      result.url.toString(),
      ...result.map.keys(),
      ...Array.from(result.map.values(), (value) => value.content),
      ...result.set,
      result.boxed.toString(),
      typeof result.bytes === 'string' ? result.bytes : new TextDecoder().decode(result.bytes),
    ]

    expect(collected.join('|')).not.toContain(canary)
    expect(JSON.stringify(result)).not.toContain(canary)
    expect(collected.join('|')).toContain('[REDACTED_SECRET_ENV:TEST_KEY]')
  })

  test('sanitizes regular-expression internals and preserves repeated aliases', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'TEST_KEY', value: canary }])
    const shared = { value: canary }

    const result = safety.redact({ expression: new RegExp(canary), first: shared, second: shared })

    expect(result.expression.source).not.toContain(canary)
    expect(result.expression.source).toContain('[REDACTED_SECRET_ENV:TEST_KEY]')
    expect(result.first).toBe(result.second)
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('detects and replaces secret material in symbol-keyed special-object properties', () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'PAYMENT_API_KEY', value: canary }])
    const symbol = Symbol(canary)
    const value = new Map<string, string>([['safe', 'value']])
    Object.defineProperty(value, symbol, { value: canary, enumerable: false })

    const sanitized = safety.redact(value)
    expect(
      Reflect.ownKeys(sanitized)
        .map((key) => String(Object.getOwnPropertyDescriptor(sanitized, key)?.value))
        .join('|')
    ).toContain('[REDACTED_SECRET_ENV:PAYMENT_API_KEY]')
    const serializedKeys = Reflect.ownKeys(sanitized).map((key) => String(key))
    expect(JSON.stringify(serializedKeys)).not.toContain(canary)
    const ownValues = Reflect.ownKeys(sanitized).map((key) => Object.getOwnPropertyDescriptor(sanitized, key)?.value)
    expect(JSON.stringify(ownValues)).not.toContain(canary)
    expect(JSON.stringify([...sanitized.values()])).not.toContain(canary)
  })

  test('fails closed for accessors and non-enumerable opaque containers', () => {
    const safety = ContentSafety.fromSecretEntries([])
    const accessor = Object.defineProperty({}, 'value', { get: () => 'untrusted' })

    expect(() => safety.redact(accessor)).toThrow('content_safety_unsafe_accessor')
    expect(() => safety.redact(new WeakMap())).toThrow('content_safety_unsupported_container')
    expect(() => safety.redact(Promise.resolve())).toThrow('content_safety_unsupported_container')
  })

  test('keeps bigint-containing sanitized graphs JSON serializable', () => {
    const result = ContentSafety.fromSecretEntries([]).redact({ count: 10n })
    expect(result as unknown).toEqual({ count: '10n' })
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  test('replaces cycles with a serialization-safe marker', () => {
    const input: { self?: unknown } = {}
    input.self = input

    const result = ContentSafety.fromSecretEntries([]).redact(input)

    expect(result).toEqual({ self: '[REDACTED_CIRCULAR]' })
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  test('prefers the longest stored value and its key', () => {
    const short = `CANARY_SECRET_${randomUUID()}`
    const longest = `${short}_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SHORT', value: short },
      { key: 'LONG', value: longest },
    ])

    expect(safety.redact(longest)).toBe('[REDACTED_SECRET_ENV:LONG]')
  })
})

test('discards query error SQL, parameters, driver details and stack at the content boundary', () => {
  const error = new DrizzleQueryError(
    'insert into private_table values ($1)',
    ['private-value'],
    Object.assign(new Error('private driver detail'), { code: '23505', detail: 'private-detail' })
  )
  const safe = ContentSafety.fromSecretEntries([]).redact({ error })
  expect(safe.error.message).toBe('Database query failed')
  expect(safe.error.cause).toBeUndefined()
  expect(JSON.stringify(safe)).not.toContain('private')
  expect(safe.error.stack).not.toContain('private')
})

test('interpolated query error messages do not leak SQL or parameters into logs', () => {
  const error = new DrizzleQueryError('insert into private_table values ($1)', ['private-value'], new Error('driver'))
  const safe = ContentSafety.fromSecretEntries([]).redact(`Operation failed: ${error.message}`)
  expect(safe).toBe('Operation failed: Database query failed')
})

test('dropping query payloads preserves matching stored-key audit metadata', () => {
  const safety = ContentSafety.fromSecretEntries([
    { key: 'PARAMETER_SECRET', value: 'canary-query-parameter' },
    { key: 'DRIVER_SECRET', value: 'canary-driver-detail' },
  ])
  const error = new DrizzleQueryError(
    'insert into private_table values ($1)',
    ['canary-query-parameter'],
    new Error('canary-driver-detail')
  )
  const inspected = safety.redactWithStoredKeys(error)
  expect(inspected.storedKeys).toEqual(['DRIVER_SECRET', 'PARAMETER_SECRET'])
  expect(inspected.value.message).toBe('Database query failed')
  const interpolated = safety.redactWithStoredKeys(`Operation failed: ${error.message}`)
  expect(interpolated.storedKeys).toEqual(['PARAMETER_SECRET'])
  expect(interpolated.value).toBe('Operation failed: Database query failed')
})
