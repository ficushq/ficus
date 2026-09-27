import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { ThemeProvider, useTheme, useThemePreview } from './ThemeProvider'
import { acquireDomHarness } from '../test/domHarness'

// Provider-level coverage for phase 0: <html> data-theme/data-appearance
// application (keeping the .dark migration class), localStorage migration of
// the legacy 'ficus-theme' key, and the live system-preference listener.

let cleanupDom: (() => Promise<void>) | null = null

function ThemeProbe({ onToggle }: { onToggle?: () => void }) {
  const { themeId, appearance, theme, toggleTheme } = useTheme()
  return (
    <div>
      <output data-testid="probe" data-theme-id={themeId} data-appearance={appearance} data-resolved={theme} />
      {onToggle ? <button data-testid="toggle" onClick={() => onToggle()} /> : null}
      <button data-testid="toggle-theme" onClick={toggleTheme} />
    </div>
  )
}

/** Installs the DOM harness with a controllable prefers-color-scheme stub. */
async function installThemeDom() {
  let systemMatches = false
  let listeners: Array<(event: { matches: boolean }) => void> = []
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    configureWindow: (window) => {
      const matchMedia = (query: string): MediaQueryList =>
        ({
          media: query,
          get matches() {
            return systemMatches
          },
          addEventListener: (_type: string, listener: unknown) => {
            listeners.push(listener as (event: { matches: boolean }) => void)
          },
          removeEventListener: (_type: string, listener: unknown) => {
            listeners = listeners.filter((entry) => entry !== listener)
          },
        }) as MediaQueryList
      ;(window as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia
      ;(globalThis as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia
    },
  })
  const setSystemPrefersDark = async (matches: boolean) => {
    systemMatches = matches
    await act(async () => {
      for (const listener of [...listeners]) listener({ matches })
    })
  }
  cleanupDom = () => dom.cleanup()
  return { dom, setSystemPrefersDark }
}

beforeEach(() => {
  cleanupDom = null
})

afterEach(async () => {
  await cleanupDom?.()
})

describe('ThemeProvider (themeId × appearance application)', () => {
  test('applies data-theme/data-appearance and the .dark class for a stored dark choice', async () => {
    const { dom } = await installThemeDom()
    localStorage.setItem('ficus-theme', 'dark')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })

    const rootEl = document.documentElement
    expect(rootEl.getAttribute('data-theme')).toBe('tau')
    expect(rootEl.getAttribute('data-appearance')).toBe('dark')
    expect(rootEl.classList.contains('dark')).toBe(true)

    const probe = document.querySelector('[data-testid="probe"]')!
    expect(probe.getAttribute('data-theme-id')).toBe('tau')
    expect(probe.getAttribute('data-appearance')).toBe('dark')
    expect(probe.getAttribute('data-resolved')).toBe('dark')
  })

  test('legacy tau-theme values migrate to the new keys and clear the legacy key', async () => {
    const { dom } = await installThemeDom()
    localStorage.setItem('ficus-theme', 'dark')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })

    expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
    expect(localStorage.getItem('ficus-appearance')).toBe('dark')
    expect(localStorage.getItem('ficus-theme')).toBeNull()
  })

  test('unreadable stored values fall back to the default light pair', async () => {
    const { dom } = await installThemeDom()
    localStorage.setItem('ficus-theme', 'mauve')
    localStorage.setItem('ficus-theme-id', 'atlantis')
    localStorage.setItem('ficus-appearance', 'solarized')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })

    expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    // The normalized selection is persisted back, repairing the storage.
    expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
    expect(localStorage.getItem('ficus-appearance')).toBe('light')
  })

  test('toggleTheme flips the resolved appearance and the .dark class', async () => {
    const { dom } = await installThemeDom()
    const { root } = dom.createRoot()
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await act(async () => {
      ;(document.querySelector('[data-testid="toggle-theme"]') as HTMLElement).click()
    })
    expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('ficus-appearance')).toBe('dark')

    await act(async () => {
      ;(document.querySelector('[data-testid="toggle-theme"]') as HTMLElement).click()
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('ficus-appearance')).toBe('light')
  })

  test("a 'system' appearance follows live OS scheme changes without a reload", async () => {
    const { dom, setSystemPrefersDark } = await installThemeDom()
    localStorage.setItem('ficus-theme-id', 'tau')
    localStorage.setItem('ficus-appearance', 'system')
    const { root } = dom.createRoot()

    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeProbe />
        </ThemeProvider>
      )
    })
    // OS preference is light: resolved light, no dark class.
    expect(document.documentElement.getAttribute('data-appearance')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // The OS flips to dark while the app is open.
    await setSystemPrefersDark(true)
    expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    const probe = document.querySelector('[data-testid="probe"]')!
    expect(probe.getAttribute('data-resolved')).toBe('dark')
    expect(probe.getAttribute('data-appearance')).toBe('system')

    // And back to light.
    await setSystemPrefersDark(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // The stored setting stays 'system' — only the resolution follows the OS.
    expect(localStorage.getItem('ficus-appearance')).toBe('system')
  })
})

test('custom brand tile updates the OS tile metadata, not only the logo', async () => {
  const { dom } = await installThemeDom()
  document.head.innerHTML = '<meta name="msapplication-TileColor" content="#7c3aed" />'
  localStorage.setItem(
    'ficus-custom-theme',
    JSON.stringify({
      format: 'tau-custom-theme',
      version: 2,
      name: 'Tile',
      base: 'tau',
      variants: { light: { '--brand-tile': '#123456' }, dark: {} },
    })
  )
  const { root } = dom.createRoot()
  await act(async () => {
    root.render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    )
  })
  expect(document.querySelector('meta[name="msapplication-TileColor"]')?.getAttribute('content')).toBe(
    'rgb(18, 52, 86)'
  )
})

test('a storage-driven rerender never writes an older selection over another tab update', async () => {
  const { dom } = await installThemeDom()
  localStorage.setItem('ficus-theme-id', 'high-contrast')
  localStorage.setItem('ficus-appearance', 'light')
  localStorage.setItem('ficus-theme-local-override', '0')
  const { root } = dom.createRoot()
  await act(async () => {
    root.render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    )
  })
  await act(async () => {
    // Another tab writes its override flag before its selection. This document
    // receives that first event while a later selection write is already queued.
    localStorage.setItem('ficus-theme-local-override', '1')
    dom.window.dispatchEvent(
      new dom.window.StorageEvent('storage', { key: 'ficus-theme-local-override', newValue: '1' })
    )
    localStorage.setItem('ficus-theme-id', 'tau')
  })
  expect(localStorage.getItem('ficus-theme-id')).toBe('tau')
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'ficus-theme-id', newValue: 'tau' }))
  })
  expect(document.documentElement.dataset.theme).toBe('tau')
})

test('live custom surface alpha is serialized consistently for root, metadata and reload snapshot', async () => {
  const { dom } = await installThemeDom()
  const sheet = document.createElement('style')
  sheet.textContent = ':root { --color-bg-surface: 255 255 255; }'
  document.head.append(sheet)
  let theme!: ReturnType<typeof useTheme>
  function Controls() {
    theme = useTheme()
    return null
  }
  const { root } = dom.createRoot()
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>
    )
  })
  for (const alpha of ['0.0000001', '0.5', '0.0000002']) {
    await act(async () => {
      theme.applyCustom({
        format: 'tau-custom-theme',
        version: 2,
        name: 'Surface',
        base: 'tau',
        variants: { light: { '--color-bg-surface': `rgba(10,20,30,${alpha})` }, dark: {} },
      })
    })
    const expected = `rgba(10, 20, 30, ${alpha})`
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(expected)
    expect(JSON.parse(localStorage.getItem('ficus-theme-surface')!).surface).toBe(expected)
    expect(document.documentElement.style.backgroundColor).not.toBe('rgb(255, 255, 255)')
  }
  await act(async () => {
    // `resetTheme` was removed with the Settings "Reset to default" button —
    // selecting the Tau built-in (setThemeId) covers the same "return to
    // default" surface path this test exercises.
    theme.setThemeId('tau')
  })
  expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('rgb(255, 255, 255)')
  expect(JSON.parse(localStorage.getItem('ficus-theme-surface')!).surface).toBe('rgb(255, 255, 255)')
  expect(localStorage.getItem('ficus-custom-theme')).toBeNull()
})

test('setAppearance and toggleTheme keep the active custom theme and preset, resolving the other variant', async () => {
  const { dom } = await installThemeDom()
  const { root } = dom.createRoot()
  let theme!: ReturnType<typeof useTheme>
  function Controls() {
    theme = useTheme()
    return null
  }
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>
    )
  })
  await act(async () => {
    theme.applyPreset({
      id: 'preset-1',
      owner: { id: 'owner-1' },
      document: {
        format: 'tau-custom-theme',
        version: 2,
        name: 'Pair',
        base: 'tau',
        variants: { light: { '--color-primary': '#111111' }, dark: { '--color-primary': '#eeeeee' } },
      },
    })
  })
  expect(theme.presetId).toBe('preset-1')
  expect(theme.presetOwnerId).toBe('owner-1')
  expect(theme.customTheme?.name).toBe('Pair')
  await act(async () => {
    theme.setAppearance('dark')
  })
  // The preset and its document are still active; only the resolved variant changed.
  expect(theme.presetId).toBe('preset-1')
  expect(theme.presetOwnerId).toBe('owner-1')
  expect(theme.customTheme?.name).toBe('Pair')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('238 238 238')
  await act(async () => {
    theme.toggleTheme()
  })
  expect(theme.presetId).toBe('preset-1')
  expect(theme.presetOwnerId).toBe('owner-1')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('17 17 17')
})

test('setThemeId deactivates the custom theme/preset ring without deleting anything from the library', async () => {
  const { dom } = await installThemeDom()
  const { root } = dom.createRoot()
  let theme!: ReturnType<typeof useTheme>
  function Controls() {
    theme = useTheme()
    return null
  }
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>
    )
  })
  await act(async () => {
    theme.applyPreset({
      id: 'preset-1',
      owner: { id: 'owner-1' },
      document: {
        format: 'tau-custom-theme',
        version: 2,
        name: 'Pair',
        base: 'tau',
        variants: { light: {}, dark: {} },
      },
    })
  })
  expect(theme.presetId).toBe('preset-1')
  expect(theme.presetOwnerId).toBe('owner-1')
  await act(async () => {
    theme.setThemeId('harbor')
  })
  expect(theme.presetId).toBeNull()
  expect(theme.presetOwnerId).toBeNull()
  expect(theme.customTheme).toBeNull()
  expect(theme.themeId).toBe('harbor')
})

test('a real root paint persists a resolved pre-paint snapshot matching the applied document/appearance; deactivating clears it', async () => {
  const { dom } = await installThemeDom()
  const { root } = dom.createRoot()
  let theme!: ReturnType<typeof useTheme>
  function Controls() {
    theme = useTheme()
    return null
  }
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>
    )
  })
  const doc = {
    format: 'tau-custom-theme' as const,
    version: 2 as const,
    name: 'Pair',
    base: 'tau',
    variants: { light: { '--color-primary': '#123456' }, dark: {} },
  }
  await act(async () => {
    theme.applyCustom(doc)
  })
  const { hashCustomThemeDocument } = await import('../theme/custom')
  const stored = JSON.parse(localStorage.getItem('ficus-custom-theme-resolved')!)
  expect(stored.docHash).toBe(hashCustomThemeDocument(doc))
  // No palette here (explicit-only document): only the visible side is
  // snapshotted, not the other (see the 'system'-appearance both-sides test below).
  expect(Object.keys(stored.sides)).toEqual(['light'])
  expect(stored.sides.light['--color-primary']).toBe('18 52 86')

  await act(async () => {
    theme.setThemeId('harbor')
  })
  expect(localStorage.getItem('ficus-custom-theme-resolved')).toBeNull()
})

test("the preview slot: last registrant wins, and a superseded registrant's clear never clobbers the current one", async () => {
  const { dom } = await installThemeDom()
  localStorage.setItem('ficus-theme-id', 'harbor')
  localStorage.setItem('ficus-appearance', 'dark')
  let api: ReturnType<typeof useThemePreview> | undefined
  function PreviewProbe() {
    api = useThemePreview()
    return null
  }
  const { root } = dom.createRoot()
  await act(async () => {
    root.render(
      <ThemeProvider>
        <ThemeProbe />
        <PreviewProbe />
      </ThemeProvider>
    )
  })
  const el = document.documentElement

  // Registrant A (e.g. a quick-picker hover preview) takes the slot.
  let clearA: (() => void) | undefined
  await act(async () => {
    clearA = api!.setPreview(() => el.style.setProperty('--color-text-primary', '1 1 1'))
  })
  expect(el.style.getPropertyValue('--color-text-primary')).toBe('1 1 1')

  // Registrant B (e.g. the editor opening) takes over — only one preview is
  // ever active, and the newest registration wins.
  let clearB: (() => void) | undefined
  await act(async () => {
    clearB = api!.setPreview(() => el.style.setProperty('--color-text-primary', '2 2 2'))
  })
  expect(el.style.getPropertyValue('--color-text-primary')).toBe('2 2 2')

  // A's stale clear (e.g. the hover ending AFTER the editor already opened)
  // must not clobber B's still-active preview.
  await act(async () => clearA!())
  expect(el.style.getPropertyValue('--color-text-primary')).toBe('2 2 2')

  // B's own clear (e.g. the editor closing) DOES restore the real selection
  // — no custom document is applied here, so the inline override is removed
  // entirely, falling back to harbor/dark's own CSS-cascade value.
  await act(async () => clearB!())
  expect(el.style.getPropertyValue('--color-text-primary')).toBe('')
})

test('a system-appearance palette preset snapshots BOTH resolved sides, not just the visible one', async () => {
  const { dom, setSystemPrefersDark } = await installThemeDom()
  // A minimal but real, correctly-scoped stylesheet: the visible root uses
  // the plain :root[data-theme=...] selector, and the SAME rule also matches
  // [data-theme-scope][data-theme=...] — the attribute-scoping convention the
  // off-screen probe (readOtherSideDerivedVars) relies on to read the OTHER
  // side's base tokens without ever painting it. Light/dark values are
  // deliberately different so a real per-side derivation is provable.
  const sheet = document.createElement('style')
  sheet.textContent = `
    :root[data-theme='harbor'][data-appearance='light'], [data-theme-scope][data-theme='harbor'][data-appearance='light'] {
      --color-primary: 100 100 100;
      --color-bg-page: 255 255 255;
    }
    :root[data-theme='harbor'][data-appearance='dark'], [data-theme-scope][data-theme='harbor'][data-appearance='dark'] {
      --color-primary: 10 10 10;
      --color-bg-page: 0 0 0;
    }
  `
  document.head.append(sheet)
  localStorage.setItem('ficus-theme-id', 'harbor')
  localStorage.setItem('ficus-appearance', 'system')
  await setSystemPrefersDark(false) // starts light
  let theme!: ReturnType<typeof useTheme>
  function Controls() {
    theme = useTheme()
    return null
  }
  const { root } = dom.createRoot()
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>
    )
  })
  const doc = {
    format: 'tau-custom-theme' as const,
    version: 2 as const,
    name: 'System palette',
    base: 'harbor',
    palette: { primary: '#0ea5e9' },
    variants: { light: {}, dark: {} },
  }
  await act(async () => {
    theme.applyCustom(doc)
  })
  const stored = JSON.parse(localStorage.getItem('ficus-custom-theme-resolved')!)
  expect(Object.keys(stored.sides).sort()).toEqual(['dark', 'light'])
  expect(stored.sides.light['--color-primary']).toBeDefined()
  expect(stored.sides.dark['--color-primary']).toBeDefined()
  // Genuinely different per-side derivation, not the same value copied twice
  // (the light/dark base primaries above are far enough apart in lightness
  // to guarantee the palette derivation's offset produces different results).
  expect(stored.sides.light['--color-primary']).not.toBe(stored.sides.dark['--color-primary'])

  // The OTHER (currently non-visible, dark) side's snapshot works pre-paint
  // too — this is the actual flash-avoidance payoff, not just a storage detail.
  const { readResolvedSnapshot } = await import('../theme/custom')
  expect(readResolvedSnapshot(localStorage, theme.customTheme!, 'dark')).toEqual(stored.sides.dark)
})
