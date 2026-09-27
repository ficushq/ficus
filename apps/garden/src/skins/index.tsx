import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { nostalgicSkin } from './nostalgic'
import { futuristSkin } from './futurist'
import { blueprintSkin } from './blueprint'
import { sketchbookSkin } from './sketchbook'
import { useFuturistTheme } from './futurist/useFuturistTheme'
import type { FarmSkin, SkinId } from './types'

export type { FarmSkin, SkinId } from './types'

export const SKINS: readonly FarmSkin[] = [nostalgicSkin, futuristSkin, blueprintSkin, sketchbookSkin]

const STORAGE_KEY = 'ficus-garden:skin'

/** Earlier names for the styles, so a saved choice or old link still works. */
const ALIASES: Record<string, SkinId> = { farm: 'nostalgic', grid: 'futurist' }

function known(value: string | null): SkinId | null {
  const id = value && (ALIASES[value] ?? value)
  return SKINS.some((s) => s.id === id) ? (id as SkinId) : null
}

function readSkinId(): SkinId {
  try {
    // ?style=futurist picks a style for this visit (handy for screenshots and sharing).
    return (
      known(new URLSearchParams(window.location.search).get('style')) ??
      known(localStorage.getItem(STORAGE_KEY)) ??
      'nostalgic'
    )
  } catch {
    return 'nostalgic'
  }
}

interface SkinContextValue {
  skin: FarmSkin
  setSkin: (id: SkinId) => void
}

const SkinContext = createContext<SkinContextValue>({ skin: nostalgicSkin, setSkin: () => {} })

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
  const value = useMemo(() => ({ skin: SKINS.find((s) => s.id === id) ?? nostalgicSkin, setSkin }), [id, setSkin])
  // The style's class on <html>, so everything (splash, cards, chat windows) reads its tokens.
  const className = value.skin.className
  useFuturistTheme(value.skin.id === 'futurist')
  useEffect(() => {
    const root = document.documentElement
    root.classList.add(className)
    return () => root.classList.remove(className)
  }, [className])
  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>
}

export function useSkin(): SkinContextValue {
  return useContext(SkinContext)
}
