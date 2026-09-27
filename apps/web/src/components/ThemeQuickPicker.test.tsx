import { afterEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom'
import type { ThemePreset } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { useHoverTimer } from '../test/hoverTimer'
import { ThemeProvider, useTheme, useThemeSyncStore } from '../providers/ThemeProvider'
import type { ThemeSyncStore } from '../theme/sync'
import { ThemeQuickPicker } from './ThemeQuickPicker'
import { palettes, resolveToken } from '../theme/test/builtins'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const midnight: ThemePreset = {
  id: 'preset-midnight',
  document: {
    format: 'tau-custom-theme',
    version: 2,
    name: 'Midnight',
    base: 'harbor',
    variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
  },
  visibility: 'private',
  ownerUserId: 'u1',
  owner: { id: 'u1', displayName: 'Owner' },
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function Harness({
  enabled = true,
  presets = [],
  storeRef,
}: {
  enabled?: boolean
  presets?: ThemePreset[]
  storeRef?: { current: ThemeSyncStore | null }
}) {
  const value = useTheme()
  const store = useThemeSyncStore()
  if (storeRef) storeRef.current = store
  return <ThemeQuickPicker value={value} enabled={enabled} presets={presets} />
}

async function renderPicker({
  enabled = true,
  presets,
  themeId,
  appearance,
  dark = false,
  presetId,
  presetOwnerId,
  activePreset,
}: {
  enabled?: boolean
  presets?: ThemePreset[]
  themeId?: string
  appearance?: string
  dark?: boolean
  presetId?: string
  presetOwnerId?: string
  /** Used when the applied preset isn't in the caller's own `presets` list —
   * a foreign/shared preset in use, exactly the Phase 2 quick-picker case. */
  activePreset?: ThemePreset
} = {}) {
  const dom = await acquireDomHarness({
    url: 'https://tau.test',
    configureWindow: (window) => {
      window.matchMedia = (() => ({
        matches: dark,
        addEventListener() {},
        removeEventListener() {},
      })) as typeof window.matchMedia
    },
  })
  cleanup = () => dom.cleanup()
  if (themeId) localStorage.setItem('ficus-theme-id', themeId)
  if (appearance) localStorage.setItem('ficus-appearance', appearance)
  if (presetId) {
    const preset = activePreset ?? (presets ?? []).find((p) => p.id === presetId)!
    localStorage.setItem('ficus-custom-theme', JSON.stringify(preset.document))
    localStorage.setItem('ficus-theme-preset-id', presetId)
  }
  if (presetOwnerId) localStorage.setItem('ficus-theme-preset-owner-id', presetOwnerId)
  // Real per-theme cascade: mirrors the shipped selectors (:root and
  // [data-theme-scope]) so the circle swatches resolve genuine tokens, not a
  // synthetic stand-in.
  const sheet = document.createElement('style')
  sheet.textContent = palettes
    .map((p) => {
      const attrs = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
      return `:root${attrs}, [data-theme-scope]${attrs} { ${Object.entries(p.tokens)
        .map(([key]) => `${key}: ${resolveToken(p.tokens, key)};`)
        .join(' ')} }`
    })
    .join('\n')
  document.head.append(sheet)
  const storeRef: { current: ThemeSyncStore | null } = { current: null }
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <ThemeProvider>
        <Harness enabled={enabled} presets={presets} storeRef={storeRef} />
      </ThemeProvider>
    )
  )
  return { dom, container, storeRef: storeRef as { current: ThemeSyncStore } }
}

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button[title="Theme"]')!
}

async function open(container: HTMLElement) {
  await act(async () => fireEvent.click(trigger(container)))
}

// React's onMouseEnter/onMouseLeave are synthesized from native
// mouseover/mouseout (enter/leave do not reliably bubble to the delegated
// root listener), so tests dispatch those, matching EntityReferenceLink's
// hover fixture.
function hoverEnter(element: Element) {
  return act(async () => element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
}
function hoverLeave(element: Element) {
  return act(async () => element.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })))
}
/** The pointer moves directly from one element to another, as it does between touching circles. */
function moveBetween(from: Element, to: Element) {
  return act(async () => {
    from.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))
    to.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
  })
}

test('hides the trigger entirely when disabled, without touching the DOM otherwise', async () => {
  const { container } = await renderPicker({ enabled: false })
  expect(trigger(container)).toBeNull()
  expect(container.querySelector('button')).toBeNull()
})

test('trigger exposes aria-haspopup/aria-expanded and opens a labelled dialog', async () => {
  const { container } = await renderPicker()
  const button = trigger(container)
  expect(button.getAttribute('aria-haspopup')).toBe('dialog')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  await open(container)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const dialog = getByRole(container, 'dialog', { name: 'Theme' })
  expect(dialog).not.toBeNull()
})

test('lists all four built-ins with the stored theme checked, none other', async () => {
  const { container } = await renderPicker({ themeId: 'harbor' })
  await open(container)
  const circles = getAllByRole(container, 'radio', { name: /Tau|Harbor|Ember|High contrast/ })
  expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual(['Tau', 'Harbor', 'Ember', 'High contrast'])
  expect(circles.map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
  circles.forEach((c) => expect(c.getAttribute('role')).toBe('radio'))
})

test('adds a circle per saved preset, selected instead of its base built-in when active; High contrast stays last', async () => {
  const { container } = await renderPicker({ presets: [midnight], presetId: midnight.id })
  await open(container)
  const circles = getAllByRole(container, 'radio', { name: /Tau|Harbor|Ember|High contrast|Midnight/ })
  expect(circles.map((c) => c.getAttribute('aria-label'))).toEqual([
    'Tau',
    'Harbor',
    'Ember',
    'Midnight',
    'High contrast',
  ])
  const harborCircle = getByRole(container, 'radio', { name: 'Harbor' })
  const presetCircle = getByRole(container, 'radio', { name: 'Midnight' })
  expect(harborCircle.getAttribute('aria-checked')).toBe('false')
  expect(presetCircle.getAttribute('aria-checked')).toBe('true')
})

test('preset circle swatch resolves the compiled override, not the plain harbor token', async () => {
  const { container } = await renderPicker({ presets: [midnight], presetId: midnight.id, appearance: 'dark' })
  await open(container)
  const presetCircle = getByRole(container, 'radio', { name: 'Midnight' })
  const swatch = presetCircle.querySelector('[data-theme-scope]')!
  const style = window.getComputedStyle(swatch)
  // The preset document overrides --color-primary to #0ea5e9 = rgb(14 165 233) on dark.
  expect(style.getPropertyValue('--color-primary').trim()).toBe('14 165 233')
  expect(swatch.getAttribute('data-theme')).toBe('harbor')
  expect(swatch.getAttribute('data-appearance')).toBe('dark')
})

test('each built-in circle resolves its own real --color-primary token under the current appearance', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const values = new Map<string, string>()
  for (const label of ['Tau', 'Harbor', 'Ember', 'High contrast']) {
    const circle = getByRole(container, 'radio', { name: label })
    const swatch = circle.querySelector('[data-theme-scope]')!
    values.set(label, window.getComputedStyle(swatch).getPropertyValue('--color-primary').trim())
  }
  // Every theme's swatch resolves a distinct, non-empty accent token.
  expect(values.get('Tau')).toBe('91 33 182')
  expect(values.get('Harbor')).toBe('14 95 109')
  expect(values.get('Ember')).toBe('151 55 29')
  expect(values.get('High contrast')).toBe('0 0 0')
  expect(new Set(values.values()).size).toBe(4)
})

test('clicking a circle swaps the palette only, preserving the stored appearance', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'dark' })
  await open(container)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Ember' })))
  expect(localStorage.getItem('ficus-theme-id')).toBe('ember')
  expect(localStorage.getItem('ficus-appearance')).toBe('dark')
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
})

test('clicking a preset circle applies it via applyPreset and rings it as active', async () => {
  const { container } = await renderPicker({ presets: [midnight], themeId: 'tau', appearance: 'dark' })
  await open(container)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Midnight' })))
  expect(localStorage.getItem('ficus-theme-id')).toBe('harbor')
  expect(localStorage.getItem('ficus-theme-preset-id')).toBe('preset-midnight')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('14 165 233')
})

test('the active shared (foreign) preset gets its own circle even though it is not in the caller’s own presets list', async () => {
  const teamTheme: ThemePreset = {
    id: 'shared-1',
    document: {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Team theme',
      base: 'harbor',
      variants: { light: {}, dark: {} },
    },
    visibility: 'instance',
    ownerUserId: 'author',
    owner: { id: 'author', displayName: 'Author' },
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const { container } = await renderPicker({
    presets: [midnight], // the caller's own library — does NOT include the foreign shared preset
    presetId: 'shared-1',
    presetOwnerId: 'author',
    activePreset: teamTheme,
  })
  await open(container)
  const circle = getByRole(container, 'radio', { name: 'Team theme' })
  expect(circle.getAttribute('aria-checked')).toBe('true')
  // The caller's own preset circle is NOT checked while a foreign preset is active.
  expect(getByRole(container, 'radio', { name: 'Midnight' }).getAttribute('aria-checked')).toBe('false')
})

test('a foreign preset already present in the caller’s own presets list is not duplicated into a second circle', async () => {
  // midnight IS in the caller's own list, so applying it should render exactly one circle for it.
  const { container } = await renderPicker({ presets: [midnight], presetId: 'preset-midnight' })
  await open(container)
  expect(getAllByRole(container, 'radio', { name: 'Midnight' })).toHaveLength(1)
})

test('Enter and Space activate a circle exactly like a click', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const harbor = getByRole(container, 'radio', { name: 'Harbor' })
  await act(async () => fireEvent.keyDown(harbor, { key: 'Enter' }))
  expect(localStorage.getItem('ficus-theme-id')).toBe('harbor')
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Tau' })))
  expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
  await act(async () => fireEvent.keyDown(getByRole(container, 'radio', { name: 'Ember' }), { key: ' ' }))
  expect(localStorage.getItem('ficus-theme-id')).toBe('ember')
})

test('appearance toggle applies light/dark/system and stays wired to the existing setAppearance', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Dark' })))
  expect(localStorage.getItem('ficus-appearance')).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'System' })))
  expect(localStorage.getItem('ficus-appearance')).toBe('system')
})

test('a one-appearance theme hides the appearance control, which shows while a light/dark theme is previewed', async () => {
  const { container } = await renderPicker({ themeId: 'high-contrast', appearance: 'dark' })
  await open(container)
  expect(queryByRole(container, 'radiogroup', { name: 'Appearance' })).toBeNull()
  expect(container.textContent).not.toContain('has one appearance')
  const hover = useHoverTimer()
  try {
    await hoverEnter(getByRole(container, 'radio', { name: 'Harbor' }))
    await hover.advance(100)
    // The preview uses the kept appearance setting (Dark), not High contrast's own light appearance.
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
    const appearance = getByRole(container, 'radiogroup', { name: 'Appearance' })
    expect(getByRole(appearance, 'radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
    await moveBetween(
      getByRole(container, 'radio', { name: 'Harbor' }),
      getByRole(container, 'radio', { name: 'nurebairo' })
    )
    await hover.advance(100)
    expect(queryByRole(container, 'radiogroup', { name: 'Appearance' })).toBeNull()
    await hoverLeave(getByRole(container, 'radio', { name: 'nurebairo' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('high-contrast')
    expect(queryByRole(container, 'radiogroup', { name: 'Appearance' })).toBeNull()
  } finally {
    hover.restore()
  }
})

test('shows no account-sync notice or button once synced', async () => {
  const { container, storeRef } = await renderPicker()
  await act(async () => {
    storeRef.current.connect({
      getMine: async () => ({
        userId: 'u1',
        theme: { themeId: 'tau', appearance: 'light', customTheme: null, presetId: null },
      }),
      updateMine: async (input) => ({ userId: 'u1', theme: input.theme }),
    })
    await storeRef.current.refresh()
  })
  await open(container)
  expect(container.textContent).not.toMatch(/sync/i)
  expect(queryByRole(container, 'button', { name: /synced theme/i })).toBeNull()
})

// --- Hover preview -----------------------------------------------------

test('hovering a circle previews the whole app after the intent delay, pure DOM only', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const ember = getByRole(container, 'radio', { name: 'Ember' })
    await hoverEnter(ember)
    // Not yet: the debounce has not elapsed.
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    // Zero persistence during preview.
    expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('previewing a one-appearance dark theme from a light theme paints it dark, like selecting it', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  try {
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    await hoverEnter(getByRole(container, 'radio', { name: 'adzukiiro' }))
    await hover.advance(100)
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('adzukiiro')
    // Its only variant is constant dark: `dark:` styles (e.g. markdown's dark:prose-invert) must apply.
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.hasAttribute('data-appearance')).toBe(false)
  } finally {
    hover.restore()
  }
})

test('sweeping quickly across circles cancels the pending preview (no strobe)', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    const ember = getByRole(container, 'radio', { name: 'Ember' })
    await hoverEnter(harbor)
    await hoverLeave(harbor)
    await hoverEnter(ember)
    expect(hover.pending()).toBe(1)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('moving straight from one circle to the next swaps the preview without restoring in between', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const tau = getByRole(container, 'radio', { name: 'Tau' })
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    const ember = getByRole(container, 'radio', { name: 'Ember' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await moveBetween(harbor, ember)
    // Still Harbor, never the stored Tau, until Ember's own preview lands.
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    // The ring follows the previewed circle; the stored selection's ring dims.
    expect(ember.querySelector('[data-ring="on"]')).not.toBeNull()
    expect(harbor.querySelector('[data-ring="on"]')).toBeNull()
    expect(tau.querySelector('[data-ring="on"]')).toBeNull()
    expect(tau.querySelector('[data-ring="dim"]')).not.toBeNull()
    expect(tau.getAttribute('aria-checked')).toBe('true')
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    await hoverLeave(ember)
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(tau.querySelector('[data-ring="on"]')).not.toBeNull()
    expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('leaving a circle after the preview committed fully restores the stored selection', async () => {
  const { container } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  const setItem = spyOn(window.localStorage, 'setItem')
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await hoverLeave(harbor)
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
    // No store/localStorage write happened anywhere in the preview+restore cycle.
    expect(setItem).not.toHaveBeenCalled()
  } finally {
    setItem.mockRestore()
    hover.restore()
  }
})

test('keyboard focus never triggers the live preview', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await act(async () => harbor.focus())
    await hover.advance(1000)
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
  } finally {
    hover.restore()
  }
})

test('Escape closes the flyout, restores any live preview, and returns focus to the trigger', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await act(async () => fireEvent.keyDown(document, { key: 'Escape', bubbles: true }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(queryByRole(container, 'dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger(container))
  } finally {
    hover.restore()
  }
})

test('restore re-reads the store at leave time, reflecting a selection changed during preview', async () => {
  const { container, storeRef } = await renderPicker({ themeId: 'tau', appearance: 'light' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    // Selection changes elsewhere (e.g. Settings, another tab) while hovering.
    await act(async () =>
      storeRef.current.change({ themeId: 'ember', appearance: 'light', customTheme: null, presetId: null })
    )
    await hoverLeave(harbor)
    // Restores to the NEW stored selection, not the pre-hover one.
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  } finally {
    hover.restore()
  }
})

test('click-outside closes the flyout and restores any live preview', async () => {
  const { container } = await renderPicker({ themeId: 'tau' })
  await open(container)
  const hover = useHoverTimer()
  try {
    const harbor = getByRole(container, 'radio', { name: 'Harbor' })
    await hoverEnter(harbor)
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })))
    expect(document.documentElement.getAttribute('data-theme')).toBe('tau')
    expect(queryByRole(container, 'dialog')).toBeNull()
  } finally {
    hover.restore()
  }
})

test('a palette-only preset circle resolves a real derived color, not an empty/unstyled swatch', async () => {
  const paletteOnly: ThemePreset = {
    id: 'preset-palette',
    document: {
      format: 'tau-custom-theme',
      version: 2,
      name: 'Palette only',
      base: 'harbor',
      palette: { primary: '#0ea5e9' },
      variants: { light: {}, dark: {} },
    },
    visibility: 'private',
    ownerUserId: 'u1',
    owner: { id: 'u1', displayName: 'Owner' },
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const { container } = await renderPicker({ presets: [paletteOnly], themeId: 'tau', appearance: 'light' })
  await open(container)
  const circle = getByRole(container, 'radio', { name: 'Palette only' })
  const swatch = circle.querySelector('[data-theme-scope]')!
  const resolvedPrimary = window.getComputedStyle(swatch).getPropertyValue('--color-primary').trim()
  expect(resolvedPrimary).not.toBe('')
  expect(resolvedPrimary).not.toBe('14 95 109') // not the plain Harbor base primary
  const { srgbToOklch } = await import('@ficus/shared/color-oklch')
  const [r, g, b] = resolvedPrimary.split(/\s+/).map(Number)
  const oklch = srgbToOklch([r!, g!, b!])
  expect(oklch.h).toBeGreaterThan(200)
  expect(oklch.h).toBeLessThan(260)
  expect(oklch.c).toBeGreaterThan(0.05)
})
