import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FICUS_DARK_ICON_COLORS, THEME_ICON_TOKENS } from '@ficus/shared/theme-icon'
import type { DesktopAppIcon, DesktopBridge } from '../lib/desktop'
import { installDomHarness } from '../test/domHarness'
import { FAVICON_SVG, publishThemeIcon, resetPublishedThemeIcon, themedFaviconHref } from './appIcon'

const FICUS_LIGHT: Record<keyof typeof THEME_ICON_TOKENS, string> = {
  tile: '241 233 219',
  primary: '63 107 79',
  primaryHover: '74 126 93',
  primaryLight: '74 126 93',
  text: '41 36 30',
  secondary: '176 88 47',
  tertiary: '138 154 91',
}
const FICUS_LIGHT_COLORS = { tile: '#f1e9db', leaf: '#3f6b4f', pot: '#b0582f', sideLeaves: '#8a9a5b' }

const root = () => document.documentElement
function paint(tokens: Record<keyof typeof THEME_ICON_TOKENS, string>) {
  for (const [role, token] of Object.entries(THEME_ICON_TOKENS))
    root().style.setProperty(token, tokens[role as keyof typeof THEME_ICON_TOKENS])
}
function favicons() {
  return [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')]
}
function desktop(setAppIcon: (icon: DesktopAppIcon) => Promise<void>) {
  const bridge: DesktopBridge = {
    version: 1,
    notificationsEnabled: async () => false,
    deliverNotifications: async () => {},
    setAppIcon,
  }
  window.ficusDesktopApp = bridge
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let dom: ReturnType<typeof installDomHarness>
beforeEach(() => {
  dom = installDomHarness({ url: 'http://localhost/' })
  resetPublishedThemeIcon()
  document.head.innerHTML =
    '<link rel="icon" href="/icons/favicon-32x32.png" media="(prefers-color-scheme: light)">' +
    '<link rel="icon" href="/icons/dark/favicon-32x32.png" media="(prefers-color-scheme: dark)">' +
    '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">'
  paint(FICUS_LIGHT)
})
afterEach(async () => {
  delete window.ficusDesktopApp
  await dom.cleanup()
})

test('the inline favicon is the published favicon.svg', () => {
  expect(FAVICON_SVG).toBe(readFileSync(new URL('../../public/icons/favicon.svg', import.meta.url), 'utf8').trim())
})

describe('publishThemeIcon', () => {
  test('replaces the scheme-matched favicons with one SVG in the theme’s colors', () => {
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: false })
    expect(favicons().map((link) => link.getAttribute('href'))).toEqual([themedFaviconHref(FICUS_LIGHT_COLORS)])
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull()

    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'dark', custom: false })
    expect(favicons().map((link) => link.getAttribute('href'))).toEqual([themedFaviconHref(FICUS_DARK_ICON_COLORS)])
  })

  test('tells Desktop the theme once per change', async () => {
    const sent: DesktopAppIcon[] = []
    desktop(async (icon) => void sent.push(icon))
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: false })
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: false })
    await settle()
    expect(sent).toEqual([{ themeId: 'ficus', appearance: 'light', custom: false, colors: FICUS_LIGHT_COLORS }])

    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: true })
    await settle()
    expect(sent.at(-1)).toEqual({ themeId: 'ficus', appearance: 'light', custom: true, colors: FICUS_LIGHT_COLORS })
  })

  test('a custom theme on the Ficus dark base is drawn from its own colors, not the bundled dark icon', async () => {
    const sent: DesktopAppIcon[] = []
    desktop(async (icon) => void sent.push(icon))
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'dark', custom: true })
    await settle()
    expect(sent[0]?.colors).toEqual(FICUS_LIGHT_COLORS)
  })

  test('sends again after Desktop rejects an icon', async () => {
    let calls = 0
    desktop(async () => {
      calls++
      if (calls === 1) throw new Error('not now')
    })
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: false })
    await settle()
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: false })
    await settle()
    expect(calls).toBe(2)
  })

  test('leaves the favicon and Desktop alone when a token is missing', async () => {
    const sent: DesktopAppIcon[] = []
    desktop(async (icon) => void sent.push(icon))
    root().style.removeProperty(THEME_ICON_TOKENS.secondary)
    publishThemeIcon(root(), { themeId: 'ficus', appearance: 'light', custom: false })
    await settle()
    expect(favicons()).toHaveLength(2)
    expect(sent).toEqual([])
  })
})
