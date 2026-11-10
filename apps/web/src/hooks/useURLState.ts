import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

export interface UseURLStateOptions<T> {
  /** Query param name */
  param: string
  /** Default value (not stored in URL when value equals this) */
  defaultValue: T
  /** Convert value to URL string. Return null/undefined to remove param. */
  serialize?: (value: T) => string | null | undefined
  /** Parse URL string to value. Called with null when param not present. */
  deserialize?: (value: string | null) => T
  /** Validate and sanitize the deserialized value. Invalid values should return defaultValue. */
  validate?: (value: T) => T
}

/**
 * Hook to sync state with URL query parameters.
 *
 * - Reads initial value from URL on mount
 * - Updates URL when value changes (using replace to avoid history pollution)
 * - When value equals default, removes param from URL (keeps URLs clean)
 * - Supports validation with fallback to defaults
 */
export function useURLState<T>(options: UseURLStateOptions<T>): [T, (value: T) => void] {
  const { param, defaultValue, serialize, deserialize, validate } = options
  const [searchParams, setSearchParams] = useSearchParams()

  // Deserialize current value from URL
  const rawValue = searchParams.get(param)
  let value: T

  if (deserialize) {
    value = deserialize(rawValue)
  } else {
    // Default deserialization: string or default
    value = (rawValue !== null ? rawValue : defaultValue) as T
  }

  // Validate if validator provided
  if (validate) {
    value = validate(value)
  }

  // Setter that updates URL
  const setValue = useCallback(
    (newValue: T) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)

          // Serialize the value
          let serialized: string | null | undefined
          if (serialize) {
            serialized = serialize(newValue)
          } else {
            // Default serialization: convert to string
            serialized = String(newValue)
          }

          // Check if this is the default value
          const isDefault = serialize ? serialize(defaultValue) === serialized : newValue === defaultValue

          if (isDefault || serialized === null || serialized === undefined) {
            // Remove param when value is default (keeps URLs clean)
            next.delete(param)
          } else {
            next.set(param, serialized)
          }

          return next
        },
        { replace: true }
      )
    },
    [param, defaultValue, serialize, setSearchParams]
  )

  return [value, setValue]
}

/**
 * Convenience hook for string values with validation against allowed values.
 */
export function useURLStringState<T extends string>(
  param: string,
  defaultValue: T,
  allowedValues?: readonly T[]
): [T, (value: T) => void] {
  return useURLState<T>({
    param,
    defaultValue,
    validate: allowedValues ? (value) => (allowedValues.includes(value) ? value : defaultValue) : undefined,
  })
}

/**
 * Convenience hook for a set of string filters stored as a comma-separated
 * URL value. An empty array is the special "All" state and is omitted from
 * the URL. The legacy literal `all` is also normalized back to that state.
 */
export function useURLStringArrayState<T extends string>(
  param: string,
  allowedValues?: readonly T[]
): [T[], (value: T[]) => void] {
  const normalize = useCallback(
    (values: string[]): T[] => {
      const unique = [...new Set(values.filter((value) => value && value !== 'all'))]
      const valid: T[] = allowedValues
        ? unique.filter((value): value is T => allowedValues.includes(value as T))
        : (unique as T[])
      return valid.sort((a, b) => {
        if (!allowedValues) return a.localeCompare(b)
        return allowedValues.indexOf(a) - allowedValues.indexOf(b)
      }) as T[]
    },
    [allowedValues]
  )

  return useURLState<T[]>({
    param,
    defaultValue: [],
    serialize: (values) => normalize(values).join(','),
    deserialize: (value) => normalize(value?.split(',') ?? []),
  })
}

/**
 * Convenience hook for boolean values stored as "1" in URL.
 * When true, param is set to "1". When false, param is removed.
 */
export function useURLBooleanState(param: string, defaultValue: boolean = false): [boolean, (value: boolean) => void] {
  return useURLState<boolean>({
    param,
    defaultValue,
    serialize: (value) => (value ? '1' : defaultValue ? '0' : null),
    deserialize: (value) => (value === null ? defaultValue : value === '1'),
  })
}
