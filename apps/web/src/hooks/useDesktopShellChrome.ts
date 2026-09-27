import { useEffect } from 'react'
import { desktopShell } from '../lib/desktop'

/**
 * Marks the document while Ficus Desktop draws its window controls over the page
 * (an inset title bar), so the app header can become the window's title bar.
 * Fullscreen windows hide those controls, so the mark is removed there.
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
    // Windowed is the common case; start inset so the header never renders under the controls.
    apply(false)
    const unsubscribe = shell.onFullscreenChange((fullscreen) => {
      observedChange = true
      apply(fullscreen)
    })
    shell.fullscreen().then(
      // A change event is newer than the initial snapshot; never overwrite it.
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
