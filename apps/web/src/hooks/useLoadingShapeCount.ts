import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AuthIdentity } from '@ficus/client-core'
import { getApiUrl } from '../api/client'
import { usePermissions } from './usePermissions'
import {
  DEV_BACKEND_SHAPE_SCOPE_KEY,
  readLoadingShapeCount,
  readRecentLoadingShapeCount,
  writeLoadingShapeCount,
} from '../lib/loadingShapeStorage'

interface LoadingShapeCountOptions {
  fallbackCount?: number
  maxCount?: number
}

function identityScope(identity: AuthIdentity | undefined): string | null {
  if (!identity) return null
  if (identity.type === 'user') return `user:${identity.userId}`
  if (identity.type === 'agent') return identity.userId ? `user:${identity.userId}` : `agent:${identity.agentId}`
  if (identity.type === 'system') return `system:${identity.systemTokenId}`
  return 'legacy'
}

const LoadingShapeOwnerContext = createContext<string | null>(null)

export function LoadingShapeScopeProvider({ children }: { children: ReactNode }) {
  const { identity } = usePermissions()
  return createElement(LoadingShapeOwnerContext.Provider, { value: identityScope(identity) }, children)
}

function loadingShapeBackendScope(): string | null {
  if (typeof window === 'undefined') return null
  let devBackend: string | null = null
  try {
    devBackend = window.localStorage.getItem(DEV_BACKEND_SHAPE_SCOPE_KEY)
  } catch {
    // Storage can be disabled even when window.localStorage exists.
  }
  return `${getApiUrl()}|${devBackend ?? 'default'}`
}

/**
 * Remembers only a bounded item count for a loading surface. Server response data
 * remains exclusively in React Query; this count is safe layout metadata used to
 * choose how many skeleton rows/cards to render on a later cold load.
 */
export function useLoadingShapeCount(
  surfaceKey: string,
  liveCount: number | undefined,
  { fallbackCount = 5, maxCount = 12 }: LoadingShapeCountOptions = {}
): number {
  const owner = useContext(LoadingShapeOwnerContext)
  const backendScope = useMemo(loadingShapeBackendScope, [])
  const scope = backendScope && owner ? `${backendScope}|${owner}` : null
  const [count, setCount] = useState(() => {
    if (!backendScope || typeof window === 'undefined') return Math.min(fallbackCount, maxCount)
    return readRecentLoadingShapeCount(window.localStorage, backendScope, surfaceKey, fallbackCount, maxCount)
  })

  useEffect(() => {
    if (!backendScope || typeof window === 'undefined') {
      setCount(Math.min(fallbackCount, maxCount))
      return
    }
    setCount(
      scope
        ? readLoadingShapeCount(window.localStorage, scope, surfaceKey, fallbackCount, maxCount)
        : readRecentLoadingShapeCount(window.localStorage, backendScope, surfaceKey, fallbackCount, maxCount)
    )
  }, [backendScope, fallbackCount, maxCount, scope, surfaceKey])

  useEffect(() => {
    if (!scope || liveCount === undefined || typeof window === 'undefined') return
    const bounded = Math.min(Math.max(0, Math.round(liveCount)), maxCount)
    setCount(bounded)
    writeLoadingShapeCount(window.localStorage, scope, surfaceKey, liveCount, maxCount)
  }, [liveCount, maxCount, scope, surfaceKey])

  return count
}
