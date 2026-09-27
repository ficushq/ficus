import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { nostalgicSkin } from './nostalgic'
import { futuristSkin } from './futurist'
import { blueprintSkin } from './blueprint'
import { sketchbookSkin } from './sketchbook'
import { useFuturistTheme } from './futurist/useFuturistTheme'
import type { FarmSkin, SkinId } from './types'
import { initialSkin, STORAGE_KEY, withoutStyle } from './choice'

export type { FarmSkin, SkinId } from './types'

export const SKINS: readonly FarmSkin[] = [nostalgicSkin, futuristSkin, blueprintSkin, sketchbookSkin]

const IDS = SKINS.map((s) => s.id)

function readSkinId(): SkinId {
  try {
    return initialSkin(window.location.search, localStorage.getItem(STORAGE_KEY), IDS, 'nostalgic')
  } catch {
    return 'nostalgic'
  }
}

/** Saves the choice for this browser, and takes any ?style= out of the address so it can't override it later. */
function remember(id: SkinId) {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Storage unavailable: the choice holds for this visit.
  }
  const { pathname, search, hash } = window.location
  const next = withoutStyle(search)
  if (next !== search) window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`)
}

interface SkinContextValue {
  skin: FarmSkin
  setSkin: (id: SkinId) => void
}

const SkinContext = createContext<SkinContextValue>({ skin: nostalgicSkin, setSkin: () => {} })

/** The chosen style, remembered per browser under the garden's own storage prefix (see choice.ts). */
export function SkinProvider({ children, initial }: { children: ReactNode; initial?: SkinId }) {
  const [id, setId] = useState<SkinId>(() => initial ?? readSkinId())
  // Every choice is saved, including one that arrived by ?style= link, whose parameter then goes.
  useEffect(() => {
    if (!initial) remember(id)
  }, [id, initial])
  const setSkin = useCallback((next: SkinId) => setId(next), [])
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
