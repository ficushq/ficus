import { describe, expect, test } from 'bun:test'
import {
  DEV_BACKEND_SHAPE_SCOPE_KEY,
  LOADING_SHAPE_MAX_AGE_MS,
  LOADING_SHAPE_STORAGE_PREFIX,
  loadingShapeStorageKey,
  readLoadingShapeCount,
  readRecentLoadingShapeCount,
  writeLoadingShapeCount,
} from './loadingShapeStorage'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    values,
  }
}

test('loading-shape storage keys are the ficus names', () => {
  expect(LOADING_SHAPE_STORAGE_PREFIX).toBe('ficus.loadingShape.v1')
  expect(DEV_BACKEND_SHAPE_SCOPE_KEY).toBe('ficus.devBackend.shapeScope')
  expect(loadingShapeStorageKey('scope', 'surface').startsWith('ficus.loadingShape.v1')).toBe(true)
})

describe('loadingShapeStorage', () => {
  test('stores only a bounded count and timestamp in a scoped key', () => {
    const storage = memoryStorage()
    writeLoadingShapeCount(storage, 'https://tau.test|user:one', 'squads', 99, 8, 1_000)

    expect(storage.values.get(loadingShapeStorageKey('https://tau.test|user:one', 'squads'))).toBe(
      '{"count":8,"updatedAt":1000}'
    )
    expect(readLoadingShapeCount(storage, 'https://tau.test|user:one', 'squads', 4, 8, 2_000)).toBe(8)
  })

  test('falls back for missing, corrupt, expired, or future records', () => {
    const storage = memoryStorage()
    expect(readLoadingShapeCount(storage, 'scope', 'rows', 5, 12, 2_000)).toBe(5)

    storage.values.set(loadingShapeStorageKey('scope', 'rows'), 'nope')
    expect(readLoadingShapeCount(storage, 'scope', 'rows', 5, 12, 2_000)).toBe(5)

    storage.values.set(
      loadingShapeStorageKey('scope', 'rows'),
      JSON.stringify({ count: 7, updatedAt: 2_000 - LOADING_SHAPE_MAX_AGE_MS - 1 })
    )
    expect(readLoadingShapeCount(storage, 'scope', 'rows', 5, 12, 2_000)).toBe(5)

    storage.values.set(loadingShapeStorageKey('scope', 'rows'), JSON.stringify({ count: 7, updatedAt: 2_001 }))
    expect(readLoadingShapeCount(storage, 'scope', 'rows', 5, 12, 2_000)).toBe(5)
  })

  test('can synchronously reuse the newest backend shape before identity resolves', () => {
    const storage = memoryStorage()
    writeLoadingShapeCount(storage, 'https://tau.test|cloud|user:old', 'squads:list', 3, 8, 1_000)
    writeLoadingShapeCount(storage, 'https://tau.test|cloud|user:current', 'squads:list', 6, 8, 2_000)
    writeLoadingShapeCount(storage, 'https://other.test|cloud|user:current', 'squads:list', 8, 8, 3_000)

    expect(readRecentLoadingShapeCount(storage, 'https://tau.test|cloud', 'squads:list', 4, 8, 4_000)).toBe(6)
  })
})
