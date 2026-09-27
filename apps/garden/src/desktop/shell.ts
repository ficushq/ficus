import { useEffect } from 'react'

/**
 * The slice of Ficus Desktop's page bridge the garden uses: whether the window
 * draws its traffic lights over the page (an inset title bar) and whether
 * it's fullscreen. Mirrors apps/web/src/lib/desktop.ts; both the current
 * `tauDesktopApp` and a renamed `ficusDesktopApp` bridge are accepted.
 */
export interface DesktopShell {
  insetTitleBar: boolean
  fullscreen(): Promise<boolean>
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void
}

type Bridge = { version?: number; shell?: unknown }

export function desktopShell(
  w: unknown = typeof window === 'undefined' ? undefined : window
): DesktopShell | undefined {
  const host = w as { ficusDesktopApp?: Bridge; tauDesktopApp?: Bridge } | undefined
  const bridge = host?.ficusDesktopApp ?? host?.tauDesktopApp
  if (bridge?.version !== 1) return undefined
  const shell = bridge.shell as Partial<DesktopShell> | undefined
  return shell && typeof shell.fullscreen === 'function' && typeof shell.onFullscreenChange === 'function'
    ? (shell as DesktopShell)
    : undefined
}

/**
 * Marks <html data-desktop-shell="inset"> while Desktop's window controls sit
 * over the page, so the HUD clears them and the top strip drags the window.
 * Fullscreen hides the controls, so the mark comes off there.
 */
export function useDesktopShellChrome() {
  useEffect(() => {
    const shell = desktopShell()
    if (!shell?.insetTitleBar) return
    const root = document.documentElement
    let active = true
    let observedChange = false
    const apply = (fullscreen: boolean) => {
      if (!active) return
      if (fullscreen) delete root.dataset.desktopShell
      else root.dataset.desktopShell = 'inset'
    }
    apply(false)
    const unsubscribe = shell.onFullscreenChange((fullscreen) => {
      observedChange = true
      apply(fullscreen)
    })
    shell.fullscreen().then(
      (fullscreen) => !observedChange && apply(fullscreen),
      () => {}
    )
    return () => {
      active = false
      unsubscribe()
      delete root.dataset.desktopShell
    }
  }, [])
}
