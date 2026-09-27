import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { permissionMatches } from '@ficus/shared'
import type { AuthIdentity } from '@ficus/client-core'
import { useActionsApi } from './ActionsApiProvider'
import { actionQueries } from './queries'

export interface Permissions {
  identity?: AuthIdentity
  can: (permission: string) => boolean
  isLoading: boolean
}

/** The caller's permissions in a squad (mirrors apps/web/src/hooks/usePermissions.ts). */
export function usePermissions(squadId?: string): Permissions {
  const api = useActionsApi()
  const { data, isLoading } = useQuery(actionQueries.permissions(api, squadId))
  const held = useMemo(() => data?.permissions ?? [], [data])
  const can = useCallback((permission: string) => held.some((entry) => permissionMatches(entry, permission)), [held])
  return { identity: data?.identity, can, isLoading }
}
