import { useState } from 'react'

/**
 * Adjusts state while rendering when inputs change, as React documents for "storing information from
 * previous renders" (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
 * Use it instead of an effect that only sets state when a prop or query result changes.
 *
 * `deps` works like an effect's dependency list: `onChange` runs during the render that first sees any
 * entry differ (by `Object.is`) from the last list it saw, and receives that previous list. It may
 * only set state of the calling component. By default the first render is the baseline; with
 * `onMount` the first render counts as a change too (and `previous` is undefined).
 */
export function useAdjustOnChange<const T extends readonly unknown[]>(
  deps: T,
  onChange: (previous: T | undefined) => void,
  { onMount = false }: { onMount?: boolean } = {}
): void {
  const [seen, setSeen] = useState<{ deps: T } | null>(() => (onMount ? null : { deps }))
  if (
    seen === null ||
    seen.deps.length !== deps.length ||
    deps.some((value, index) => !Object.is(value, seen.deps[index]))
  ) {
    setSeen({ deps })
    onChange(seen?.deps)
  }
}
