import { DEV_BACKEND_SHAPE_SCOPE_STORAGE_KEY, LOADING_SHAPE_STORAGE_PREFIX } from '@ficus/shared/browser-keys'
export { LOADING_SHAPE_STORAGE_PREFIX }
export const LOADING_SHAPE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEV_BACKEND_SHAPE_SCOPE_KEY = DEV_BACKEND_SHAPE_SCOPE_STORAGE_KEY

export interface LoadingShapeRecord {
  count: number
  updatedAt: number
}

export interface LoadingShapeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface EnumerableLoadingShapeStorage extends LoadingShapeStorage {
  readonly length: number
  key(index: number): string | null
}

export function loadingShapeStorageKey(scope: string, surfaceKey: string): string {
  return `${LOADING_SHAPE_STORAGE_PREFIX}.${encodeURIComponent(scope)}.${encodeURIComponent(surfaceKey)}`
}

export function clampLoadingShapeCount(count: number, fallbackCount: number, maxCount: number): number {
  if (!Number.isFinite(count)) return Math.min(Math.max(0, Math.round(fallbackCount)), maxCount)
  return Math.min(Math.max(0, Math.round(count)), maxCount)
}

export function readLoadingShapeCount(
  storage: LoadingShapeStorage,
  scope: string,
  surfaceKey: string,
  fallbackCount: number,
  maxCount: number,
  now = Date.now()
): number {
  const fallback = clampLoadingShapeCount(fallbackCount, fallbackCount, maxCount)
  try {
    const raw = storage.getItem(loadingShapeStorageKey(scope, surfaceKey))
    if (!raw) return fallback
    const value = JSON.parse(raw) as Partial<LoadingShapeRecord>
    if (
      typeof value.count !== 'number' ||
      typeof value.updatedAt !== 'number' ||
      now - value.updatedAt > LOADING_SHAPE_MAX_AGE_MS ||
      value.updatedAt > now
    ) {
      return fallback
    }
    return clampLoadingShapeCount(value.count, fallback, maxCount)
  } catch {
    return fallback
  }
}

/**
 * Reads the newest shape for this backend/surface before the authenticated
 * identity query resolves. Records remain identity-scoped; this first-paint
 * hint still contains no server response data.
 */
export function readRecentLoadingShapeCount(
  storage: EnumerableLoadingShapeStorage,
  backendScope: string,
  surfaceKey: string,
  fallbackCount: number,
  maxCount: number,
  now = Date.now()
): number {
  const fallback = clampLoadingShapeCount(fallbackCount, fallbackCount, maxCount)
  const keyPrefix = `${LOADING_SHAPE_STORAGE_PREFIX}.${encodeURIComponent(`${backendScope}|`)}`
  const keySuffix = `.${encodeURIComponent(surfaceKey)}`
  let newest: LoadingShapeRecord | null = null
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(keyPrefix) || !key.endsWith(keySuffix)) continue
      const raw = storage.getItem(key)
      if (!raw) continue
      const value = JSON.parse(raw) as Partial<LoadingShapeRecord>
      if (
        typeof value.count !== 'number' ||
        typeof value.updatedAt !== 'number' ||
        now - value.updatedAt > LOADING_SHAPE_MAX_AGE_MS ||
        value.updatedAt > now
      )
        continue
      if (!newest || value.updatedAt > newest.updatedAt) newest = value as LoadingShapeRecord
    }
  } catch {
    return fallback
  }
  return newest ? clampLoadingShapeCount(newest.count, fallback, maxCount) : fallback
}

export function writeLoadingShapeCount(
  storage: LoadingShapeStorage,
  scope: string,
  surfaceKey: string,
  count: number,
  maxCount: number,
  now = Date.now()
): void {
  try {
    const record: LoadingShapeRecord = {
      count: clampLoadingShapeCount(count, 0, maxCount),
      updatedAt: now,
    }
    storage.setItem(loadingShapeStorageKey(scope, surfaceKey), JSON.stringify(record))
  } catch {
    // Loading polish must never make the underlying surface fail when storage is unavailable.
  }
}
