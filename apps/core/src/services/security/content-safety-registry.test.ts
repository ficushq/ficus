import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { SecretValueConsumer } from '../secrets/store'
import { ContentSafetyRegistry, type ContentSafetySecretSource } from './content-safety-registry'

class GeneratedSecretSource implements ContentSafetySecretSource {
  readonly #entries = new Map<string, string>()
  #consumer?: SecretValueConsumer

  bindContentSafetyConsumer(consumer: SecretValueConsumer): () => void {
    this.#consumer = consumer
    consumer.replace(Array.from(this.#entries, ([key, value]) => ({ key, value })))
    return () => {
      this.#consumer = undefined
    }
  }

  set(key: string, value: string): void {
    this.#entries.set(key, value)
    this.#consumer?.update(key, value)
  }

  delete(key: string): void {
    this.#entries.delete(key)
    this.#consumer?.update(key, undefined)
  }
}

describe('ContentSafetyRegistry', () => {
  test('redacts a stored generated canary and never echoes it back', () => {
    const source = new GeneratedSecretSource()
    const canary = `CANARY_SECRET_${randomUUID()}`
    source.set('TEST_KEY', canary)
    const registry = new ContentSafetyRegistry(source)

    const result = registry.redact({ command: `echo ${canary}` })

    expect(result).toEqual({ command: 'echo [REDACTED_SECRET_ENV:TEST_KEY]' })
    expect(JSON.stringify([result, registry])).not.toContain(canary)
    registry.dispose()
  })

  test('delegates stored-key inspection without exposing the stored value', () => {
    const source = new GeneratedSecretSource()
    const canary = `CANARY_SECRET_${randomUUID()}`
    source.set('SYNTHETIC_KEY', canary)
    const registry = new ContentSafetyRegistry(source)

    const inspected = registry.redactWithStoredKeys({ command: canary })

    expect(inspected).toEqual({
      value: { command: '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]' },
      storedKeys: ['SYNTHETIC_KEY'],
    })
    expect(JSON.stringify(inspected)).not.toContain(canary)
    registry.dispose()
  })

  test('tracks values added and removed after binding', () => {
    const source = new GeneratedSecretSource()
    const registry = new ContentSafetyRegistry(source)
    const canary = `CANARY_SECRET_${randomUUID()}`

    expect(registry.redact(canary)).toBe(canary)
    source.set('LATE_KEY', canary)
    expect(registry.redact(canary)).toBe('[REDACTED_SECRET_ENV:LATE_KEY]')
    source.delete('LATE_KEY')
    expect(registry.redact(canary)).toBe(canary)
    registry.dispose()
  })

  test('does not expose match details that can be used as an oracle', () => {
    const source = new GeneratedSecretSource()
    const registry = new ContentSafetyRegistry(source)
    const canary = `CANARY_SECRET_${randomUUID()}`
    source.set('TEST_KEY', canary)

    const serialized = JSON.stringify(registry.redact(`prefix ${canary} suffix`))

    expect(serialized).toBe(JSON.stringify('prefix [REDACTED_SECRET_ENV:TEST_KEY] suffix'))
    expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain(String(canary.length))
    registry.dispose()
  })
})

describe('mixed detection policies', () => {
  test('preserves duplicate-key transition values when a later update arrives', () => {
    let consumer!: SecretValueConsumer
    const registry = new ContentSafetyRegistry({
      bindContentSafetyConsumer(value) {
        consumer = value
        value.replace([])
        return () => undefined
      },
    })
    consumer.replace([
      { key: 'ROTATING', value: 'synthetic-old-value' },
      { key: 'ROTATING', value: 'synthetic-new-value' },
    ])
    consumer.update('OTHER', 'synthetic-other-value')
    expect(registry.redact('synthetic-old-value synthetic-new-value')).not.toContain('synthetic-')
    registry.dispose()
  })
})
