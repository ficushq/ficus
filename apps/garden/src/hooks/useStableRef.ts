import { useLayoutEffect, useRef } from 'react'

/**
 * A ref that always holds the latest value, for reading changing props inside
 * callbacks and effects without re-subscribing. Mirrors apps/web's hook of the
 * same name (the garden doesn't import from apps/web).
 */
export function useStableRef<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
