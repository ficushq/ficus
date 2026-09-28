import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { farmQueries } from '../../api/queries'
import { tripleFor } from './themeTriples'

function usePrefersDark(): boolean {
  const query = typeof window === 'undefined' ? null : window.matchMedia?.('(prefers-color-scheme: dark)')
  const [dark, setDark] = useState(() => query?.matches ?? false)
  useEffect(() => {
    if (!query) return
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [query])
  return dark
}

/** While the Futurist style is on, paint it in the user's web-app theme's three colours. */
export function useFuturistTheme(active: boolean) {
  const preference = useQuery({ ...farmQueries.themePreference(), enabled: active })
  const prefersDark = usePrefersDark()
  const triple = tripleFor(preference.data?.theme, prefersDark)
  useEffect(() => {
    if (!active) return
    const root = document.documentElement.style
    root.setProperty('--fu-bg', triple.background)
    root.setProperty('--fu-fg', triple.foreground)
    root.setProperty('--fu-accent', triple.accent)
    return () => {
      root.removeProperty('--fu-bg')
      root.removeProperty('--fu-fg')
      root.removeProperty('--fu-accent')
    }
  }, [active, triple.background, triple.foreground, triple.accent])
}
