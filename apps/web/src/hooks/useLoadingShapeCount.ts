import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react'
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
  // The backend scope is fixed for the life of the page, so read it once.
  const [backendScope] = useState(loadingShapeBackendScope)
  const scope = backendScope && owner ? `${backendScope}|${owner}` : null
  const source = `${scope ?? backendScope ?? ''}\n${surfaceKey}\n${fallbackCount}\n${maxCount}`
  const readRemembered = () => {
    if (!backendScope || typeof window === 'undefined') return Math.min(fallbackCount, maxCount)
    return scope
      ? readLoadingShapeCount(window.localStorage, scope, surfaceKey, fallbackCount, maxCount)
      : readRecentLoadingShapeCount(window.localStorage, backendScope, surfaceKey, fallbackCount, maxCount)
  }
  const [remembered, setRemembered] = useState(() => ({ source, count: readRemembered() }))
  const live =
    scope && liveCount !== undefined && typeof window !== 'undefined'
      ? Math.min(Math.max(0, Math.round(liveCount)), maxCount)
      : undefined
  // Adjust the remembered count while rendering rather than in an effect: re-read
  // it when the surface or its owner changes, and keep the latest live count so a
  // refetch with no data yet still renders the last known shape.
  if (remembered.source !== source) setRemembered({ source, count: readRemembered() })
  else if (live !== undefined && live !== remembered.count) setRemembered({ source, count: live })

  useEffect(() => {
    if (!scope || liveCount === undefined || typeof window === 'undefined') return
    writeLoadingShapeCount(window.localStorage, scope, surfaceKey, liveCount, maxCount)
  }, [liveCount, maxCount, scope, surfaceKey])

  return live ?? remembered.count
}
