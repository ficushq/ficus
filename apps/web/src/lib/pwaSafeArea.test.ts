import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const webRoot = join(import.meta.dir, '..', '..')

function readWebFile(relativePath: string) {
  return readFileSync(join(webRoot, relativePath), 'utf8')
}

describe('PWA iOS top safe area', () => {
  test('uses the default status bar style (black-translucent is broken on iOS 26)', () => {
    const html = readWebFile('index.html')

    // Measured on device (session fa11af45): black-translucent shortens the
    // webview by the status-bar height at the bottom (innerHeight 812 on an
    // 874pt screen), double-reports env() insets, and overlays a gray
    // legibility scrim with a hairline edge. 'default' yields a full-height
    // webview and correct env(bottom).
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />')
    expect(html).not.toContain('black-translucent')
  })

  test('paints a contrast-safe scrim behind the iOS status bar without changing the header body surface', () => {
    const appNav = readWebFile('src/components/AppNav.tsx')
    const css = readWebFile('src/index.css')

    expect(appNav).toContain(
      'ficus-glass relative border-b border-panel-border shrink-0 z-10 safe-area-pt safe-area-status-bar-scrim'
    )
    expect(css).toContain('.safe-area-status-bar-scrim::before')
    expect(css).toContain('background: rgb(var(--color-status-bar-scrim));')
    expect(css).toContain('pointer-events: none;')
  })

  test('the scrim is the header surface itself in both themes so the status bar region is seamless', () => {
    const css = readWebFile('src/index.css')

    // Hardcoded or tinted scrims (violet in light mode) draw a visible colored
    // strip; the OS handles status-text contrast, so the strip should simply
    // be the header surface.
    const occurrences = css.split('--color-status-bar-scrim: var(--color-bg-surface);').length - 1
    expect(occurrences).toBe(2)
  })

  test('declares color-scheme per theme so browser/OS chrome (iOS glass, scrollbars) matches', () => {
    const css = readWebFile('src/index.css')

    expect(css).toContain('color-scheme: light;')
    expect(css).toContain('color-scheme: dark;')
  })

  test('theme-color meta is managed dynamically and matches the theme surface', () => {
    const themeProvider = readWebFile('src/providers/ThemeProvider.tsx')
    const html = readWebFile('index.html')

    // A static violet theme-color told Safari/iOS chrome the wrong tint for
    // both themes; the provider keeps it in sync with the resolved surface.
    expect(themeProvider).toContain("meta[name='theme-color']")
    expect(html).not.toContain('<meta name="theme-color" content="#7c3aed"')
    expect(html).toContain('<meta name="theme-color" content="#ffffff"')
  })

  test('safe-area sizing trusts env() with no magic minimum height', () => {
    const css = readWebFile('src/index.css')

    // env(safe-area-inset-top) is 0 exactly when the status bar is opaque and
    // sits outside the webview (browser tabs, legacy 'default'-style installs)
    // and the real inset when black-translucent is active. Forcing a minimum
    // (e.g. 47px) painted dead padding under the opaque bar on installs that
    // predate the black-translucent meta.
    expect(css).not.toContain('47px')
    expect(css).toContain('padding-top: env(safe-area-inset-top, 0px);')
    expect(css).toContain('height: env(safe-area-inset-top, 0px);')
  })
})
