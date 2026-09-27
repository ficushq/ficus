import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { farmSkin } from './farm'
import type { FarmSkin, SkinId } from './types'

export type { FarmSkin, SkinId } from './types'

export const SKINS: readonly FarmSkin[] = [farmSkin]

const STORAGE_KEY = 'ficus-garden:skin'

function readSkinId(): SkinId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return SKINS.some((s) => s.id === stored) ? (stored as SkinId) : 'farm'
  } catch {
    return 'farm'
  }
}

interface SkinContextValue {
  skin: FarmSkin
  setSkin: (id: SkinId) => void
}

const SkinContext = createContext<SkinContextValue>({ skin: farmSkin, setSkin: () => {} })

/** The chosen style, remembered per browser under the garden's own storage prefix. */
export function SkinProvider({ children, initial }: { children: ReactNode; initial?: SkinId }) {
  const [id, setId] = useState<SkinId>(() => initial ?? readSkinId())
  const setSkin = useCallback((next: SkinId) => {
    setId(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage unavailable: the choice holds for this visit.
    }
  }, [])
  const value = useMemo(() => ({ skin: SKINS.find((s) => s.id === id) ?? farmSkin, setSkin }), [id, setSkin])
  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>
}

export function useSkin(): SkinContextValue {
  return useContext(SkinContext)
}
