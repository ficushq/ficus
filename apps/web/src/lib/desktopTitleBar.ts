/*
 * The band at the top of a Ficus Desktop window that the page keeps clear for the title bar. While the
 * window has an inset title bar (html[data-desktop-shell='inset'], set by useDesktopShellChrome only
 * inside Desktop and only while windowed), macOS draws the window buttons natively over the top-left of
 * the page, above every web layer, so nothing in HTML can cover them. Overlays keep out of the band
 * instead: dialogs through CSS (--modal-top-reserve in ResponsiveChat.css), and floating windows through
 * this height, which their geometry treats as the top of the usable screen.
 *
 * The height comes from the --desktop-titlebar-height CSS variable (index.css), so CSS and script share
 * one value. In a browser, on mobile and in a fullscreen Desktop window it is 0.
 */

const SHELL_ATTRIBUTE = 'data-desktop-shell'

/** The height (px) kept clear at the top of the window for Desktop's title bar, or 0 where there is none. */
export function desktopTitleBarReserve(): number {
  if (typeof document === 'undefined') return 0
  const root = document.documentElement
  if (root.getAttribute(SHELL_ATTRIBUTE) !== 'inset') return 0
  const style = document.defaultView?.getComputedStyle(root)
  const height = Number.parseFloat(style?.getPropertyValue('--desktop-titlebar-height') ?? '')
  return Number.isFinite(height) && height > 0 ? height : 0
}

/**
 * Calls `listener` whenever the title bar comes or goes (entering or leaving fullscreen), which can land
 * after the window's own resize event. Returns the unsubscribe function.
 */
export function onDesktopTitleBarChange(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [SHELL_ATTRIBUTE] })
  return () => observer.disconnect()
}
