/* eslint-disable react-refresh/only-export-components -- hook providers intentionally colocate their matching hooks */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { permissionMatches } from '@ficus/shared'
import { queries } from '../queryOptions'
import type { AuthIdentity } from '@ficus/client-core'

export type PermissionsResult = {
  permissions: string[]
  identity?: AuthIdentity
  can: (requested: string) => boolean
  isLoading: boolean
  isError: boolean
}

type UsePermissions = (squadId?: string) => PermissionsResult

function useActualPermissions(squadId?: string): PermissionsResult {
  const { data, isLoading, isError } = useQuery(queries.auth.permissions(squadId))
  const permissions = useMemo(() => data?.permissions ?? [], [data])
  const can = useCallback(
    (requested: string): boolean => permissions.some((held) => permissionMatches(held, requested)),
    [permissions]
  )

  return { permissions, identity: data?.identity, can, isLoading, isError }
}

const PermissionsHookContext = createContext<UsePermissions>(useActualPermissions)

export function PermissionsProvider({
  usePermissions,
  children,
}: {
  usePermissions: UsePermissions
  children: ReactNode
}) {
  return <PermissionsHookContext.Provider value={usePermissions}>{children}</PermissionsHookContext.Provider>
}

export function usePermissions(squadId?: string) {
  return useContext(PermissionsHookContext)(squadId)
}
