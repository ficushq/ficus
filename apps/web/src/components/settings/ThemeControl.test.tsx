import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getAllByRole, getByRole, queryAllByRole } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ThemePreset } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { useHoverTimer } from '../../test/hoverTimer'
import { ThemeProvider, useTheme } from '../../providers/ThemeProvider'
import { ThemeControl } from './ThemeControl'
import { palettes, resolveToken } from '../../theme/test/builtins'
import { BUILT_IN_THEMES } from '../../theme/registry'
import { themePresetQueryKeys } from '../../queryKeys'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
function Control({ enabled }: { enabled: boolean }) {
  return <ThemeControl value={useTheme()} enabled={enabled} />
}
function presetFixture(id: string, name: string, base: string, ownerId: string): ThemePreset {
  return {
    id,
    document: {
      format: 'ficus-custom-theme',
      version: 2,
      name,
      base,
      variants: { light: {}, dark: {} },
    },
    visibility: 'private',
    ownerUserId: ownerId,
    owner: { id: ownerId, displayName: ownerId },
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
async function renderControl(
  themeId = 'iris',
  appearance = 'light',
  dark = false,
  enabled = true,
  custom: {
    customTheme?: { name: string; base: string }
    presetId?: string
    presetOwnerId?: string
    /** `'loading'` leaves the caller's own library query pending. */
    minePresets?: ThemePreset[] | 'loading'
  } = {}
) {
  const dom = await acquireDomHarness({
    configureWindow: (window) => {
      window.matchMedia = (() => ({
        matches: dark,
        addEventListener() {},
        removeEventListener() {},
      })) as typeof window.matchMedia
    },
  })
  cleanup = () => dom.cleanup()
  localStorage.setItem('ficus-theme-id', themeId)
  localStorage.setItem('ficus-appearance', appearance)
  if (custom.customTheme) {
    localStorage.setItem(
      'ficus-custom-theme',
      JSON.stringify({
        format: 'ficus-custom-theme',
        version: 2,
        name: custom.customTheme.name,
        base: custom.customTheme.base,
        variants: { light: {}, dark: {} },
      })
    )
  }
  if (custom.presetId) localStorage.setItem('ficus-theme-preset-id', custom.presetId)
  if (custom.presetOwnerId) localStorage.setItem('ficus-theme-preset-owner-id', custom.presetOwnerId)
  const sheet = document.createElement('style')
  sheet.textContent = palettes
    .map((p) => {
      const attrs = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
      return `:root${attrs}, [data-theme-scope]${attrs} { --color-bg-surface: ${resolveToken(p.tokens, '--color-bg-surface')}; }`
    })
    .join('\n')
  document.head.appendChild(sheet)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (custom.minePresets === 'loading')
    void queryClient.prefetchQuery({
      queryKey: themePresetQueryKeys.list('mine'),
      queryFn: () => new Promise(() => {}),
    })
  else queryClient.setQueryData(themePresetQueryKeys.list('mine'), custom.minePresets ?? [])
  const { root, container } = dom.createRoot()
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Control enabled={enabled} />
        </ThemeProvider>
      </QueryClientProvider>
    )
  })
  return container
}

test('no Color theme/Appearance dropdowns remain: the theme grid and appearance segmented control replace them', async () => {
  const container = await renderControl('harbor', 'light')
  // The library's own "New theme base" select is unrelated and stays.
  expect(container.querySelector('select[aria-label="Color theme"]')).toBeNull()
  expect(container.querySelector('select[aria-label="Appearance"]')).toBeNull()
  expect(getByRole(container, 'radiogroup', { name: 'Color theme' })).not.toBeNull()
  expect(getByRole(container, 'radiogroup', { name: 'Appearance' })).not.toBeNull()
})

test('the grid has one labelled, checkable dot per built-in, named after the theme', async () => {
  const container = await renderControl('harbor', 'light')
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const dots = getAllByRole(grid, 'radio')
  expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual(BUILT_IN_THEMES.map((t) => t.label))
  for (const dot of dots) expect(dot.textContent).toContain(dot.getAttribute('aria-label'))
})

test('a built-in dot is checked and ringed for the active plain theme; others are not', async () => {
  const container = await renderControl('harbor', 'light')
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const harbor = getByRole(grid, 'radio', { name: 'Harbor' })
  expect(harbor.getAttribute('aria-checked')).toBe('true')
  expect(harbor.querySelector('[data-ring="on"]')).not.toBeNull()
  for (const other of getAllByRole(grid, 'radio').filter((dot) => dot !== harbor)) {
    expect(other.getAttribute('aria-checked')).toBe('false')
    expect(other.querySelector('[data-ring="on"]')).toBeNull()
  }
})

test('clicking a built-in dot while a preset is active deactivates it (setThemeId) without deleting it from the library', async () => {
  const container = await renderControl('harbor', 'light', false, true, {
    customTheme: { name: 'Midnight', base: 'harbor' },
    presetId: 'p1',
    presetOwnerId: 'u1',
    minePresets: [presetFixture('p1', 'Midnight', 'harbor', 'u1')],
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  // The active own preset shows its own dot, checked — not its base built-in.
  expect(getByRole(grid, 'radio', { name: 'Midnight' }).getAttribute('aria-checked')).toBe('true')
  expect(getByRole(grid, 'radio', { name: 'Harbor' }).getAttribute('aria-checked')).toBe('false')

  await act(async () => fireEvent.click(getByRole(grid, 'radio', { name: 'Ember' })))

  expect(localStorage.getItem('ficus-theme-id')).toBe('ember')
  expect(localStorage.getItem('ficus-custom-theme')).toBeNull()
  expect(localStorage.getItem('ficus-theme-preset-id')).toBeNull()
  expect(getByRole(grid, 'radio', { name: 'Ember' }).getAttribute('aria-checked')).toBe('true')
  // The library itself is untouched: no delete call is ever made from here,
  // this only clears the active selection (same as the quick picker).
})

test('an own preset dot applies it via applyPreset (same path as the quick picker/library Use)', async () => {
  const container = await renderControl('harbor', 'light', false, true, {
    minePresets: [presetFixture('p1', 'Midnight', 'harbor', 'u1')],
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  await act(async () => fireEvent.click(getByRole(grid, 'radio', { name: 'Midnight' })))
  expect(localStorage.getItem('ficus-theme-preset-id')).toBe('p1')
  expect(localStorage.getItem('ficus-theme-id')).toBe('harbor')
})

test('Enter and Space activate a dot exactly like a click', async () => {
  const container = await renderControl('iris', 'light', false, true, {
    minePresets: [presetFixture('p1', 'Midnight', 'harbor', 'u1')],
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const dot = getByRole(grid, 'radio', { name: 'Midnight' })
  await act(async () => fireEvent.keyDown(dot, { key: 'Enter' }))
  expect(localStorage.getItem('ficus-theme-preset-id')).toBe('p1')
  localStorage.removeItem('ficus-theme-preset-id')
  await act(async () => fireEvent.keyDown(getByRole(grid, 'radio', { name: 'Ember' }), { key: ' ' }))
  expect(localStorage.getItem('ficus-theme-id')).toBe('ember')
})

test('arrow keys rove within the grid, wrapping at both ends, and select as they move', async () => {
  const container = await renderControl('ficus', 'light')
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const ficus = getByRole(grid, 'radio', { name: 'Ficus' })
  const iris = getByRole(grid, 'radio', { name: 'Iris' })
  // Wrapping lands on the last dot: High contrast, which every picker lists
  // last (see registry.ts's highContrastLast).
  const last = getByRole(grid, 'radio', { name: 'High contrast' })
  expect(ficus.tabIndex).toBe(0)
  await act(async () => fireEvent.keyDown(ficus, { key: 'ArrowRight' }))
  expect(document.activeElement).toBe(iris)
  expect(iris.getAttribute('aria-checked')).toBe('true')
  expect(iris.tabIndex).toBe(0)
  expect(ficus.tabIndex).toBe(-1)
  await act(async () => fireEvent.keyDown(iris, { key: 'ArrowLeft' }))
  expect(document.activeElement).toBe(ficus)
  expect(localStorage.getItem('ficus-theme-id')).toBe('ficus')
  // Wraps from the first dot backward to the last.
  await act(async () => fireEvent.keyDown(ficus, { key: 'ArrowLeft' }))
  expect(document.activeElement).toBe(last)
  expect(localStorage.getItem('ficus-theme-id')).toBe('high-contrast')
})

function pointer(type: 'mouseover' | 'mouseout', element: Element, relatedTarget: Element | null = null) {
  return act(async () => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget })))
}

test('hovering a dot previews the whole app without saving; sweeping to the next never restores in between', async () => {
  const container = await renderControl('iris', 'light')
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const iris = getByRole(grid, 'radio', { name: 'Iris' })
  const harbor = getByRole(grid, 'radio', { name: 'Harbor' })
  const ember = getByRole(grid, 'radio', { name: 'Ember' })
  const hover = useHoverTimer()
  try {
    await pointer('mouseover', harbor)
    expect(document.documentElement.getAttribute('data-theme')).toBe('iris')
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    await pointer('mouseout', harbor, ember)
    await pointer('mouseover', ember, harbor)
    expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
    expect(ember.querySelector('[data-ring="on"]')).not.toBeNull()
    expect(iris.querySelector('[data-ring="on"]')).toBeNull()
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    // Leaving the grid restores the stored selection; nothing was saved.
    await pointer('mouseout', ember)
    expect(document.documentElement.getAttribute('data-theme')).toBe('iris')
    expect(iris.querySelector('[data-ring="on"]')).not.toBeNull()
    expect(localStorage.getItem('ficus-theme-id')).toBe('iris')
  } finally {
    hover.restore()
  }
})

test('clicking the previewed dot ends the preview and saves that theme', async () => {
  const container = await renderControl('iris', 'light')
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const ember = getByRole(grid, 'radio', { name: 'Ember' })
  const hover = useHoverTimer()
  try {
    await pointer('mouseover', ember)
    await hover.advance(100)
    await act(async () => fireEvent.click(ember))
    expect(hover.pending()).toBe(0)
    expect(localStorage.getItem('ficus-theme-id')).toBe('ember')
    expect(ember.getAttribute('aria-checked')).toBe('true')
    await pointer('mouseout', ember)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  } finally {
    hover.restore()
  }
})

test('High contrast is the last dot, after the caller’s own presets', async () => {
  const container = await renderControl('iris', 'light', false, true, {
    minePresets: [presetFixture('p1', 'Mine', 'harbor', 'me')],
  })
  const labels = getAllByRole(getByRole(container, 'radiogroup', { name: 'Color theme' }), 'radio').map((dot) =>
    dot.getAttribute('aria-label')
  )
  expect(labels.at(-2)).toBe('Mine')
  expect(labels.at(-1)).toBe('High contrast')
})

test('the active shared (foreign) preset gets its own dot, labelled "(shared)"', async () => {
  const container = await renderControl('ember', 'light', false, true, {
    customTheme: { name: 'Solstice', base: 'ember' },
    presetId: 'p2',
    presetOwnerId: 'other-user',
    minePresets: [],
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  const dot = getByRole(grid, 'radio', { name: 'Solstice (shared)' })
  expect(dot.getAttribute('aria-checked')).toBe('true')
})

test('an own preset is not labelled "(shared)" and no foreign dot is added while the library is still loading', async () => {
  const container = await renderControl('harbor', 'light', false, true, {
    customTheme: { name: 'Midnight', base: 'harbor' },
    presetId: 'p1',
    presetOwnerId: 'u1',
    minePresets: 'loading',
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  expect(queryAllByRole(grid, 'radio', { name: 'Midnight (shared)' })).toHaveLength(0)
  expect(queryAllByRole(grid, 'radio', { name: 'Midnight' })).toHaveLength(0)
})

test('a foreign preset already present in the caller’s own presets list is not duplicated into a second dot', async () => {
  const container = await renderControl('harbor', 'light', false, true, {
    customTheme: { name: 'Midnight', base: 'harbor' },
    presetId: 'p1',
    presetOwnerId: 'u1',
    minePresets: [presetFixture('p1', 'Midnight', 'harbor', 'u1')],
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  expect(getAllByRole(grid, 'radio', { name: 'Midnight' })).toHaveLength(1)
})

test('a detached custom theme (no presetId) has no matching dot: none show as checked', async () => {
  const container = await renderControl('iris', 'light', false, true, {
    customTheme: { name: 'One-off', base: 'iris' },
  })
  const grid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  for (const dot of getAllByRole(grid, 'radio')) expect(dot.getAttribute('aria-checked')).toBe('false')
})

test('the appearance control applies light/dark/system, and is hidden while a one-appearance theme is selected', async () => {
  const container = await renderControl('harbor', 'system')
  const appearanceGroup = getByRole(container, 'radiogroup', { name: 'Appearance' })
  expect(getByRole(appearanceGroup, 'radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true')

  await act(async () => fireEvent.click(getByRole(appearanceGroup, 'radio', { name: 'Dark' })))
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(localStorage.getItem('ficus-appearance')).toBe('dark')
  expect(localStorage.getItem('ficus-theme-id')).toBe('harbor')

  const colorGrid = getByRole(container, 'radiogroup', { name: 'Color theme' })
  await act(async () => fireEvent.click(getByRole(colorGrid, 'radio', { name: 'High contrast' })))
  expect(queryAllByRole(container, 'radiogroup', { name: 'Appearance' })).toHaveLength(0)
  expect(document.documentElement.getAttribute('data-appearance')).toBeNull()
  expect(container.textContent).not.toContain('has one appearance')
  // The setting is kept: previewing a light/dark theme shows the control again and paints with Dark.
  const hover = useHoverTimer()
  try {
    await pointer('mouseover', getByRole(colorGrid, 'radio', { name: 'Ember' }))
    await hover.advance(100)
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
    expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
    const shown = getByRole(container, 'radiogroup', { name: 'Appearance' })
    expect(getByRole(shown, 'radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
    await pointer('mouseout', getByRole(colorGrid, 'radio', { name: 'Ember' }))
    expect(queryAllByRole(container, 'radiogroup', { name: 'Appearance' })).toHaveLength(0)
  } finally {
    hover.restore()
  }
})

for (const theme of BUILT_IN_THEMES)
  for (const appearance of ['light', 'dark', 'system'])
    for (const dark of [false, true]) {
      test(`${theme.id}/${appearance}/OS-dark=${dark}: provider surface, snapshot and meta sync before paint`, async () => {
        await renderControl(theme.id, appearance, dark)
        const resolved =
          theme.kind === 'unified' ? 'constant' : appearance === 'system' ? (dark ? 'dark' : 'light') : appearance
        const palette = palettes.find((p) => p.id === theme.id && p.appearance === resolved)!
        const surface = `rgb(${resolveToken(palette.tokens, '--color-bg-surface').split(/\s+/).join(', ')})`
        expect(document.documentElement.style.backgroundColor).toBe(surface)
        expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe(surface)
        expect(JSON.parse(localStorage.getItem('ficus-theme-surface')!)).toEqual({
          theme: theme.id,
          appearance: resolved,
          surface,
        })
      })
    }

test('the "My themes" library section renders (Phase 1: owner-only, own presets)', async () => {
  const container = await renderControl('iris', 'light')
  expect(container.textContent).toContain('My themes')
  expect(getByRole(container, 'button', { name: 'New theme' })).not.toBeNull()
})

test('release flag rollback keeps a working legacy appearance toggle', async () => {
  const container = await renderControl('iris', 'light', false, false)
  expect(container.querySelector('select')).toBeNull()
  expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(0)
  const button = container.querySelector('button')!
  expect(button.textContent).toBe('Dark Mode')
  await act(async () => {
    fireEvent.click(button)
  })
  expect(button.textContent).toBe('Light Mode')
  expect(localStorage.getItem('ficus-appearance')).toBe('dark')
})
