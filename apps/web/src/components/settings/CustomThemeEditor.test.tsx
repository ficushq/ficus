import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { act, useState } from 'react'
import { fireEvent, getByLabelText, getByRole, getAllByRole, queryByRole, waitFor } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { suggestPaletteSeeds } from '@ficus/shared/theme-derivation'
import { HttpResponseError } from '@ficus/client-core'
import { STATUS_TOKENS, type AssistantEditorState, type ThemePreset } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { ThemeProvider, useTheme, useThemeSyncStore } from '../../providers/ThemeProvider'
import { CustomThemeEditor } from './CustomThemeEditor'
import { palettes, resolveToken } from '../../theme/test/builtins'
import { client } from '../../api/clientInstance'
import { assistantApi } from '../../api/assistant'
import { assistantQueries, queries } from '../../queryOptions'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { MemoryRouter } from 'react-router-dom'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const existing: ThemePreset = {
  id: 'preset-1',
  document: {
    format: 'ficus-custom-theme',
    version: 2,
    name: 'Mine',
    base: 'harbor',
    variants: { light: {}, dark: { '--color-text-primary': '#ffffff', '--color-bg-surface': '#ffffff' } },
  },
  visibility: 'private',
  ownerUserId: 'u1',
  owner: { id: 'u1', displayName: 'Owner' },
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function Harness({
  preset,
  baseId,
  onClose,
  onReady,
  idleCoalesceMs,
  scheduleIdleTimeout,
  cancelIdleTimeout,
}: {
  preset: ThemePreset | null
  baseId: string
  onClose: () => void
  onReady?: (value: ReturnType<typeof useTheme>, store: ReturnType<typeof useThemeSyncStore>) => void
  idleCoalesceMs?: number
  scheduleIdleTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelIdleTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}) {
  const value = useTheme()
  const store = useThemeSyncStore()
  onReady?.(value, store)
  return (
    <CustomThemeEditor
      value={value}
      preset={preset}
      baseId={baseId}
      onClose={onClose}
      idleCoalesceMs={idleCoalesceMs}
      scheduleIdleTimeout={scheduleIdleTimeout}
      cancelIdleTimeout={cancelIdleTimeout}
    />
  )
}

async function render({
  preset = null as ThemePreset | null,
  baseId = 'harbor',
  appearance = 'dark',
  onReady = undefined as
    | ((value: ReturnType<typeof useTheme>, store: ReturnType<typeof useThemeSyncStore>) => void)
    | undefined,
  idleCoalesceMs = undefined as number | undefined,
  scheduleIdleTimeout = undefined as ((callback: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined,
  cancelIdleTimeout = undefined as ((handle: ReturnType<typeof setTimeout>) => void) | undefined,
} = {}) {
  const dom = await acquireDomHarness({ url: 'https://ficus.test' })
  cleanup = () => dom.cleanup()
  localStorage.setItem('ficus-appearance', appearance)
  if (preset) {
    // The preset being edited is also the ACTIVE applied theme, so "restore
    // on close" has something non-trivial (the preset's own unedited state)
    // to restore to, distinct from the in-editor draft.
    localStorage.setItem('ficus-theme-id', preset.document.base)
    localStorage.setItem('ficus-custom-theme', JSON.stringify(preset.document))
    localStorage.setItem('ficus-theme-preset-id', preset.id)
  }
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = mock(() => {})
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Harness
            preset={preset}
            baseId={baseId}
            onClose={onClose}
            onReady={onReady}
            idleCoalesceMs={idleCoalesceMs}
            scheduleIdleTimeout={scheduleIdleTimeout}
            cancelIdleTimeout={cancelIdleTimeout}
          />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  return { container, onClose, queryClient }
}
async function click(container: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.click(getByRole(container, 'button', { name, exact: true }))
  })
}
async function change(container: HTMLElement, label: string, value: string) {
  await act(async () => {
    fireEvent.change(getByLabelText(container, label), { target: { value } })
  })
}

test('a new theme editor previews the whole app live; Save as new creates a preset and applies it', async () => {
  const create = spyOn(client.themePresets, 'create').mockResolvedValue({
    ...existing,
    id: 'new-preset',
    document: { ...existing.document, name: 'My theme' },
  })
  try {
    const { container, onClose } = await render({ baseId: 'harbor', appearance: 'dark' })
    const before = document.documentElement.style.getPropertyValue('--color-text-primary')
    await change(container, 'Color token', '--color-text-primary')
    await change(container, 'Color value', '#00ff00')
    await click(container, 'Preview token')
    // Whole-app live preview: document.documentElement itself reflects the draft.
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).not.toBe(before)
    await click(container, 'Save as new')
    expect(create).toHaveBeenCalledTimes(1)
    const [sentDocument] = create.mock.calls[0]!
    expect((sentDocument as { variants: { dark: Record<string, string> } }).variants.dark['--color-text-primary']).toBe(
      '#00ff00'
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('ficus-theme-preset-id')).toBe('new-preset')
  } finally {
    create.mockRestore()
  }
})

test('editing an existing preset: Save sends a PUT with its revision', async () => {
  const update = spyOn(client.themePresets, 'update').mockResolvedValue({ ...existing, revision: 4 })
  try {
    const { container, onClose } = await render({ preset: existing, appearance: 'dark' })
    await click(container, 'Save')
    expect(update).toHaveBeenCalledWith('preset-1', 3, expect.anything())
    expect(onClose).toHaveBeenCalledTimes(1)
  } finally {
    update.mockRestore()
  }
})

test('a stale-revision 409 surfaces a clear reload message and does not close the editor', async () => {
  const update = spyOn(client.themePresets, 'update').mockRejectedValue(
    new HttpResponseError(409, 'Theme preset changed elsewhere — reload it before saving')
  )
  try {
    const { container, onClose } = await render({ preset: existing, appearance: 'dark' })
    await click(container, 'Save')
    expect(getByRole(container, 'status').textContent).toContain('changed elsewhere')
    expect(onClose).not.toHaveBeenCalled()
  } finally {
    update.mockRestore()
  }
})

test('Cancel closes without touching the network; the caller unmounting the editor is what restores the saved selection (see next test)', async () => {
  const create = spyOn(client.themePresets, 'create')
  const update = spyOn(client.themePresets, 'update')
  try {
    const { container, onClose } = await render({ preset: existing, appearance: 'dark' })
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('255 255 255')
    await change(container, 'Color token', '--color-text-primary')
    await change(container, 'Color value', '#00ff00')
    await click(container, 'Preview token')
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
    await click(container, 'Cancel')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  } finally {
    create.mockRestore()
    update.mockRestore()
  }
})

test('unmounting the editor (not just Cancel) also restores the saved selection', async () => {
  const dom = await acquireDomHarness({ url: 'https://ficus.test' })
  cleanup = () => dom.cleanup()
  localStorage.setItem('ficus-appearance', 'dark')
  localStorage.setItem('ficus-theme-id', existing.document.base)
  localStorage.setItem('ficus-custom-theme', JSON.stringify(existing.document))
  localStorage.setItem('ficus-theme-preset-id', existing.id)
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { root, container } = dom.createRoot()
  function Toggle() {
    const value = useTheme()
    const [open, setOpen] = useState(true)
    return (
      <div>
        {open && <CustomThemeEditor value={value} preset={existing} baseId="harbor" onClose={() => setOpen(false)} />}
        <button data-testid="force-close" onClick={() => setOpen(false)} />
      </div>
    )
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Toggle />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
  await act(async () => fireEvent.click(container.querySelector('[data-testid="force-close"]')!))
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('255 255 255')
})

async function selectTab(container: HTMLElement, name: 'Light' | 'Dark') {
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name })))
}

test('dual bases expose Light/Dark tabs that preview and edit independently', async () => {
  const { container } = await render({ preset: existing, appearance: 'dark' })
  expect(getByRole(container, 'radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true')
  await selectTab(container, 'Light')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('')
  await change(container, 'Color token', '--color-primary')
  await change(container, 'Color value', '#123456')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('18 52 86')
  // The dark side is untouched by the light-side edit.
  await selectTab(container, 'Dark')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('255 255 255')
})

test('a unified base has no variant tabs', async () => {
  const { container } = await render({ baseId: 'high-contrast' })
  expect(queryByRole(container, 'radio', { name: 'Light' })).toBeNull()
  expect(queryByRole(container, 'radio', { name: 'Dark' })).toBeNull()
})

test('status picker authors the complete grid as a set, and removing one clears the whole set', async () => {
  const { container } = await render({ preset: existing, appearance: 'dark' })
  await change(container, 'Color token', '--status-danger-fg')
  await click(container, 'Preview token')
  for (const token of STATUS_TOKENS) expect(document.documentElement.style.getPropertyValue(token)).not.toBe('')
  await click(container, 'Remove --status-danger-fg')
  for (const token of STATUS_TOKENS) expect(document.documentElement.style.getPropertyValue(token)).toBe('')
})

test('contrast warnings offer a safe value that improves the pair and clears the warning', async () => {
  const { container } = await render({ baseId: 'iris', appearance: 'light' })
  // A near-invisible pair: white text on a near-white surface.
  await change(container, 'Color token', '--color-bg-surface')
  await change(container, 'Color value', '#ffffff')
  await click(container, 'Preview token')
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#ffffff')
  await click(container, 'Preview token')
  const warning = getAllByRole(container, 'listitem').find((li) =>
    li.textContent?.startsWith('--color-text-primary on --color-bg-surface')
  )
  expect(warning).toBeDefined()
  await act(async () => fireEvent.click(getByRole(warning!, 'button')))
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 0 0')
  const stillWarning = getAllByRole(container, 'listitem').find((li) =>
    li.textContent?.startsWith('--color-text-primary on --color-bg-surface')
  )
  expect(stillWarning).toBeUndefined()
})

test('no Import JSON control in the editor: Import lives once, in the library (see ThemePresetLibrary.test.tsx)', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'dark' })
  expect(queryByRole(container, 'button', { name: /Import/ })).toBeNull()
  expect(container.querySelector('input[type="file"]')).toBeNull()
})

test('a primary seed color derives the palette live; clearing it returns to plain overrides; Advanced holds the token list', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'light' })
  expect(queryByRole(container, 'textbox', { name: 'Primary' })).not.toBeNull()
  // The token list/tabs/contrast warnings are tucked under a collapsed Advanced section.
  expect(container.querySelector('details')).not.toBeNull()
  expect(container.querySelector('details')!.hasAttribute('open')).toBe(false)

  const before = document.documentElement.style.getPropertyValue('--color-primary-hover')
  await change(container, 'Primary', '#0ea5e9')
  const derivedHover = document.documentElement.style.getPropertyValue('--color-primary-hover')
  expect(derivedHover).not.toBe('')
  expect(derivedHover).not.toBe(before)
  // Status stays static by default: unaffected by the palette.
  const baseStatus = document.documentElement.style.getPropertyValue('--status-danger-solid')
  expect(baseStatus).toBe('')

  await change(container, 'Primary', '')
  expect(document.documentElement.style.getPropertyValue('--color-primary-hover')).toBe('')
})

test('the Status colors toggle switches between static (default) and harmonized', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'light' })
  await change(container, 'Primary', '#0ea5e9')
  expect(document.documentElement.style.getPropertyValue('--status-danger-solid')).toBe('')
  await act(async () => fireEvent.click(getByRole(container, 'radio', { name: 'Harmonized' })))
  expect(document.documentElement.style.getPropertyValue('--status-danger-solid')).not.toBe('')
})

test('palette seed fields are color controls: a native color swatch plus the hex/text field, with accessible labels', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'dark' })
  const primarySwatch = container.querySelector('input[type="color"][aria-label="Primary color swatch"]')
  const primaryText = getByRole(container, 'textbox', { name: 'Primary' })
  expect(primarySwatch).not.toBeNull()
  expect(primaryText).not.toBeNull()
  // Optional seeds start with no clear button (nothing set).
  expect(queryByRole(container, 'button', { name: 'Clear Secondary' })).toBeNull()

  // Driving the native color input updates the same palette state as the text field.
  await act(async () => fireEvent.input(primarySwatch!, { target: { value: '#ff4fa3' } }))
  expect((primaryText as HTMLInputElement).value).toBe('#ff4fa3')
  expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('255 79 163')

  // Setting an optional seed shows its Clear button; clearing empties it and re-derives without it.
  await change(container, 'Secondary', '#22c55e')
  expect(queryByRole(container, 'button', { name: 'Clear Secondary' })).not.toBeNull()
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Clear Secondary' })))
  expect((getByRole(container, 'textbox', { name: 'Secondary' }) as HTMLInputElement).value).toBe('')
  expect(queryByRole(container, 'button', { name: 'Clear Secondary' })).toBeNull()
})

test('the inline clear button is an accessibly-labelled, keyboard-reachable icon button beside its field (no separate "Clear X" row)', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'light' })
  await change(container, 'Primary', '#0ea5e9')
  await change(container, 'Secondary', '#22c55e')
  const clearSecondary = getByRole(container, 'button', { name: 'Clear Secondary' })
  // Reachable by keyboard (a real, unhidden, non-disabled button — no negative tabindex trap).
  expect(clearSecondary.tagName).toBe('BUTTON')
  expect(clearSecondary.getAttribute('type')).toBe('button')
  expect(clearSecondary.hasAttribute('disabled')).toBe(false)
  expect(clearSecondary.tabIndex).toBeGreaterThanOrEqual(0)
  // Icon-only: no redundant visible "Clear Secondary" text node, the accessible
  // name comes entirely from aria-label.
  expect(clearSecondary.textContent).toBe('')
  expect(clearSecondary.getAttribute('aria-label')).toBe('Clear Secondary')
  // Sits with the Secondary field's own swatch/text row, not in a separate row below it.
  const secondaryField = getByRole(container, 'textbox', { name: 'Secondary' }).closest('div')!.parentElement!
  expect(secondaryField.contains(clearSecondary)).toBe(true)
})

function toHex(channels: string): string {
  const [r, g, b] = channels.trim().split(/\s+/).map(Number)
  const hex = (n: number) => Math.round(n!).toString(16).padStart(2, '0')
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`
}

test("an unset seed swatch reflects the active base theme's own --color-border token, not a hardcoded color", async () => {
  // Two different base themes -> two different --color-border values -> the
  // "not set yet" placeholder swatch must differ too. A hardcoded literal
  // (any fixed hex, however it's obfuscated in source) would be identical
  // across both and fail this.
  const harbor = await render({ baseId: 'harbor', appearance: 'dark' })
  await change(harbor.container, 'Primary', '#0ea5e9') // reveals Neutral, which is never auto-filled
  const harborSwatch = getByLabelText(harbor.container, 'Neutral color swatch') as HTMLInputElement
  const computedBorder = () =>
    toHex(
      document.documentElement.ownerDocument
        .defaultView!.getComputedStyle(document.documentElement)
        .getPropertyValue('--color-border')
        .trim()
    )
  const harborBorder = computedBorder()
  expect(harborSwatch.value).toBe(harborBorder)
  await cleanup?.()

  const ember = await render({ baseId: 'ember', appearance: 'dark' })
  await change(ember.container, 'Primary', '#0ea5e9')
  const emberSwatch = getByLabelText(ember.container, 'Neutral color swatch') as HTMLInputElement
  const emberBorder = computedBorder()
  expect(emberSwatch.value).toBe(emberBorder)

  expect(emberBorder).not.toBe(harborBorder)
  expect(emberSwatch.value).not.toBe(harborSwatch.value)
})

test('setting Primary fills blank Secondary and Tertiary with its companions, which follow Primary until edited', async () => {
  const { container } = await render({ baseId: 'iris', appearance: 'light' })
  const field = (name: string) => getByLabelText(container, name) as HTMLInputElement
  await change(container, 'Primary', '#3f6b4f')
  const first = suggestPaletteSeeds('#3f6b4f')!
  expect([field('Secondary').value, field('Tertiary').value]).toEqual([first.secondary, first.tertiary])
  // Still the companions: a new Primary moves them along.
  await change(container, 'Primary', '#0ea5e9')
  const second = suggestPaletteSeeds('#0ea5e9')!
  expect([field('Secondary').value, field('Tertiary').value]).toEqual([second.secondary, second.tertiary])
  // An edited seed is the user's: a later Primary leaves it alone.
  await change(container, 'Secondary', '#f97316')
  await change(container, 'Primary', '#97371d')
  expect(field('Secondary').value).toBe('#f97316')
  expect(field('Tertiary').value).toBe(suggestPaletteSeeds('#97371d')!.tertiary)
  expect(field('Neutral').value).toBe('')
})

test('the editor draft preview survives an appearance change made elsewhere while editing', async () => {
  let value: ReturnType<typeof useTheme> | undefined
  const { container } = await render({
    preset: existing,
    appearance: 'dark',
    onReady: (v) => {
      value = v
    },
  })
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')

  // A real ThemeProvider repaint triggered by something OTHER than the editor
  // (here: the app's own Light/Dark/System control) must not clobber the
  // still-open draft preview: the provider reapplies the active preview
  // painter right after its own paint, every time it paints.
  await act(async () => value!.setAppearance('light'))
  // The REAL underlying selection did change...
  expect(localStorage.getItem('ficus-appearance')).toBe('light')
  // ...but the editor's own draft (still on its own independent 'Dark' tab)
  // is what's actually on screen, reapplied after that real repaint.
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
})

test('the editor draft preview survives a storage event from another tab while editing', async () => {
  const { container } = await render({ preset: existing, appearance: 'dark' })
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')

  // Simulate another tab/window changing the appearance: a real storage
  // event, exactly like the browser dispatches on a cross-document write.
  await act(async () => {
    localStorage.setItem('ficus-appearance', 'light')
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'ficus-appearance', newValue: 'light' }))
  })
  expect(localStorage.getItem('ficus-appearance')).toBe('light')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
})

test('the editor draft preview survives remote account-sync adoption while editing', async () => {
  let store: ReturnType<typeof useThemeSyncStore> | undefined
  const { container } = await render({
    preset: existing,
    appearance: 'dark',
    onReady: (_value, s) => {
      store = s
    },
  })
  await change(container, 'Color token', '--color-text-primary')
  await change(container, 'Color value', '#00ff00')
  await click(container, 'Preview token')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')

  // A different account preference (chosen on another device) lands while the
  // editor is open. This connects a fake sync API and drives the real
  // refresh() adoption — the same codepath ThemeAccountSync uses — rather
  // than a synthetic stand-in.
  const adopted = { themeId: 'ember', appearance: 'light' as const, customTheme: null, presetId: null }
  const api = {
    getMine: async () => ({ userId: 'u1', theme: adopted }),
    updateMine: async (input: { theme: typeof adopted }) => ({ userId: 'u1', theme: input.theme }),
  }
  await act(async () => {
    store!.connect(api)
    await store!.refresh()
  })
  // The REAL underlying selection adopted the remote preference...
  expect(store!.getSnapshot().selection).toEqual({ themeId: 'ember', appearance: 'light' })
  // ...but the editor's own draft (still on 'harbor'/'Dark', its own tab) is
  // what's actually on screen, reapplied after that real repaint.
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('0 255 0')
})

function createManualScheduler() {
  let handleSeq = 0
  const timers = new Map<number, () => void>()
  return {
    schedule: (callback: () => void, _ms: number) => {
      const handle = ++handleSeq
      timers.set(handle, callback)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    cancel: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number)
    },
    /** Fires every currently-pending idle timer (there is at most one open
     * coalescing session, so at most one is ever pending) — the deterministic
     * stand-in for "~800ms passes without typing". */
    fireAll: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) callback()
    },
  }
}

test('typing "abc" in the theme name field is one undo step', async () => {
  const { container } = await render()
  await change(container, 'Theme name', 'a')
  await change(container, 'Theme name', 'ab')
  await change(container, 'Theme name', 'abc')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('abc')
  await click(container, 'Undo')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('New theme')
  expect((getByRole(container, 'button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
})

test('switching from the name field to a palette field starts a new undo step', async () => {
  const { container } = await render()
  // Three keystrokes in "name" must coalesce, or this test's second Undo
  // below (which expects the WHOLE burst reverted in one step) would fail.
  await change(container, 'Theme name', 'a')
  await change(container, 'Theme name', 'ab')
  await change(container, 'Theme name', 'abc')
  await change(container, 'Primary', '#112233')
  expect((getByLabelText(container, 'Primary') as HTMLInputElement).value).toBe('#112233')
  await click(container, 'Undo')
  expect((getByLabelText(container, 'Primary') as HTMLInputElement).value).toBe('')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('abc')
  await click(container, 'Undo')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('New theme')
  expect((getByRole(container, 'button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
})

test('an idle pause starts a new undo step even in the same field', async () => {
  const scheduler = createManualScheduler()
  const { container } = await render({
    idleCoalesceMs: 800,
    scheduleIdleTimeout: scheduler.schedule,
    cancelIdleTimeout: scheduler.cancel,
  })
  // Two keystrokes, an idle pause, then two more: each pair must coalesce
  // into its own step, or the two Undos below wouldn't reach "New theme".
  await change(container, 'Theme name', 'a')
  await change(container, 'Theme name', 'ab')
  await act(async () => scheduler.fireAll())
  await change(container, 'Theme name', 'abc')
  await change(container, 'Theme name', 'abcd')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('abcd')
  await click(container, 'Undo')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('ab')
  await click(container, 'Undo')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('New theme')
  expect((getByRole(container, 'button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
})

test('redo replays a coalesced typed edit', async () => {
  const { container } = await render()
  await change(container, 'Theme name', 'a')
  await change(container, 'Theme name', 'ab')
  await change(container, 'Theme name', 'abc')
  await click(container, 'Undo')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('New theme')
  expect((getByRole(container, 'button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
  await click(container, 'Redo')
  expect((getByLabelText(container, 'Theme name') as HTMLInputElement).value).toBe('abc')
  expect((getByRole(container, 'button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true)
})

test('the theme assistant panel proposes a live-previewing edit, shares undo/redo with manual edits, and cannot save', async () => {
  const { useAssistantConversationBridge } = await import('../../voice/AssistantConversationContext')
  const dom = await acquireDomHarness({ url: 'https://ficus.test' })
  localStorage.setItem('ficus-appearance', 'dark')
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
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queries.voice.status().queryKey, { enabled: false })
  let id = ''
  let stored!: AssistantEditorState
  let bridge: ReturnType<typeof useAssistantConversationBridge>
  const create = spyOn(assistantApi, 'create').mockImplementation(async (next) => {
    id = next
    return { id } as any
  })
  const sync = spyOn(assistantApi, 'syncEditor').mockImplementation(async (_id, draft) => {
    stored = structuredClone(draft) as AssistantEditorState
    return stored
  })
  const read = spyOn(assistantApi, 'editor').mockImplementation(async () => ({ ...stored, contract: '' }))
  const close = spyOn(assistantApi, 'closeEditor').mockResolvedValue({})
  const dependencies = {
    api: {
      ...assistantApi,
      history: async () => ({ entries: [], hasMore: false }),
      inbox: async () => ({ acquired: true, messages: [], pending: 0 }),
      release: async () => ({}),
    } as any,
    useAssistant: (() => {
      bridge = useAssistantConversationBridge()
      return {
        history: [],
        status: 'idle',
        error: null,
        isLiveAudio: false,
        isConnected: false,
        disconnect() {},
        setLiveAudio: async () => {},
      }
    }) as any,
  }
  function Harness() {
    const value = useTheme()
    return (
      <CustomThemeEditor
        value={value}
        preset={null}
        baseId="iris"
        onClose={() => {}}
        assistantDependencies={dependencies}
      />
    )
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <PermissionsProvider
              usePermissions={() => ({ can: () => true, permissions: ['*'], isLoading: false, isError: false })}
            >
              <ThemeProvider>
                <Harness />
              </ThemeProvider>
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await dom.act(async () => waitFor(() => expect(bridge?.pageEditor).toBeDefined()))
    expect(document.body.textContent).toContain('What theme do you want?')
    expect((getByLabelText(document.body, 'Theme name') as HTMLInputElement).value).toBe('New theme')

    // A `set-palette` proposal (the assistant's preferred edit) applies live.
    const proposal = {
      id: crypto.randomUUID(),
      baseRevision: stored.revision,
      summary: 'Made it teal',
      document: { ...(stored.document as any), palette: { primary: '#14b8a6' } },
    }
    await dom.act(async () => cache.setQueryData(assistantQueries.editor(id).queryKey, { ...stored, proposal }))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('20 184 166'))
    await waitFor(() => expect(stored.revision).toBe(1))
    expect(stored.history).toEqual({ canUndo: true, canRedo: false })

    // Duplicate delivery of the same proposal id does not add a second history entry.
    const revisionAfterFirst = stored.revision
    await dom.act(async () => cache.setQueryData(assistantQueries.editor(id).queryKey, { ...stored, proposal }))
    expect(stored.revision).toBe(revisionAfterFirst)

    // Undo/Redo buttons share the same history as the assistant's edit.
    await click(document.body, 'Undo')
    expect(document.documentElement.style.getPropertyValue('--color-primary')).not.toBe('20 184 166')
    await waitFor(() => expect(stored.history).toEqual({ canUndo: false, canRedo: true }))
    await click(document.body, 'Redo')
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('20 184 166'))

    // The assistant can propose, but never save/publish: no Save call happens here.
    const saveCreate = spyOn(client.themePresets, 'create')
    expect(saveCreate).not.toHaveBeenCalled()
    saveCreate.mockRestore()
  } finally {
    await dom.cleanup()
    for (const spy of [create, sync, read, close]) spy.mockRestore()
  }
})

test('typing bumps the revision every keystroke (stale assistant edits are still rejected) and an assistant proposal mid-typing is its own undo step', async () => {
  const { useAssistantConversationBridge } = await import('../../voice/AssistantConversationContext')
  const dom = await acquireDomHarness({ url: 'https://ficus.test' })
  localStorage.setItem('ficus-appearance', 'dark')
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
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queries.voice.status().queryKey, { enabled: false })
  let id = ''
  let stored!: AssistantEditorState
  let bridge: ReturnType<typeof useAssistantConversationBridge>
  const create = spyOn(assistantApi, 'create').mockImplementation(async (next) => {
    id = next
    return { id } as any
  })
  const sync = spyOn(assistantApi, 'syncEditor').mockImplementation(async (_id, draft) => {
    stored = structuredClone(draft) as AssistantEditorState
    return stored
  })
  const read = spyOn(assistantApi, 'editor').mockImplementation(async () => ({ ...stored, contract: '' }))
  const close = spyOn(assistantApi, 'closeEditor').mockResolvedValue({})
  const dependencies = {
    api: {
      ...assistantApi,
      history: async () => ({ entries: [], hasMore: false }),
      inbox: async () => ({ acquired: true, messages: [], pending: 0 }),
      release: async () => ({}),
    } as any,
    useAssistant: (() => {
      bridge = useAssistantConversationBridge()
      return {
        history: [],
        status: 'idle',
        error: null,
        isLiveAudio: false,
        isConnected: false,
        disconnect() {},
        setLiveAudio: async () => {},
      }
    }) as any,
  }
  function Harness() {
    const value = useTheme()
    return (
      <CustomThemeEditor
        value={value}
        preset={null}
        baseId="iris"
        onClose={() => {}}
        assistantDependencies={dependencies}
      />
    )
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <PermissionsProvider
              usePermissions={() => ({ can: () => true, permissions: ['*'], isLoading: false, isError: false })}
            >
              <ThemeProvider>
                <Harness />
              </ThemeProvider>
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await dom.act(async () => waitFor(() => expect(bridge?.pageEditor).toBeDefined()))
    await waitFor(() => expect(stored.revision).toBe(0))
    const nameInput = () => getByLabelText(document.body, 'Theme name') as HTMLInputElement

    // Three keystrokes in the same field: the revision bumps every time (the
    // page-editor sync and the assistant's baseRevision staleness check both
    // depend on this), but coalesce into ONE undo step below.
    await dom.act(async () => fireEvent.change(nameInput(), { target: { value: 'T' } }))
    await waitFor(() => expect(stored.revision).toBe(1))
    await dom.act(async () => fireEvent.change(nameInput(), { target: { value: 'Te' } }))
    await waitFor(() => expect(stored.revision).toBe(2))
    await dom.act(async () => fireEvent.change(nameInput(), { target: { value: 'Tea' } }))
    await waitFor(() => expect(stored.revision).toBe(3))
    expect(stored.history).toEqual({ canUndo: true, canRedo: false })

    // A proposal computed against a now-stale revision (from before typing
    // started) is rejected — WorkflowBuilder-style staleness protection still
    // holds for coalesced typed edits, not just single-shot ones.
    const staleProposal = {
      id: crypto.randomUUID(),
      baseRevision: 0,
      summary: 'stale',
      document: { ...(stored.document as any), name: 'Stale' },
    }
    await dom.act(async () =>
      cache.setQueryData(assistantQueries.editor(id).queryKey, { ...stored, proposal: staleProposal })
    )
    await waitFor(() => expect(document.body.textContent).toContain('The draft changed before this edit arrived'))
    expect(nameInput().value).toBe('Tea')

    // A proposal against the CURRENT revision applies live and is its own
    // undo step — it never merges with the coalesced typed burst before it.
    const proposal = {
      id: crypto.randomUUID(),
      baseRevision: stored.revision,
      summary: 'Made it teal',
      document: { ...(stored.document as any), palette: { primary: '#14b8a6' } },
    }
    await dom.act(async () => cache.setQueryData(assistantQueries.editor(id).queryKey, { ...stored, proposal }))
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('20 184 166'))
    expect(nameInput().value).toBe('Tea')

    // Undo once: reverts only the assistant's edit — the typed burst
    // ("T" -> "Te" -> "Tea") is intact as its own step underneath it.
    await click(document.body, 'Undo')
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--color-primary')).not.toBe('20 184 166')
    )
    expect(nameInput().value).toBe('Tea')
    await waitFor(() => expect(stored.history.canRedo).toBe(true))

    // Undo again: reverts the WHOLE typed burst in one step, back to the
    // pristine default — not three separate undos for "T", "Te", "Tea".
    await click(document.body, 'Undo')
    await waitFor(() => expect(nameInput().value).toBe('New theme'))
    await waitFor(() => expect(stored.history).toEqual({ canUndo: false, canRedo: true }))

    // Redo replays the typed burst, then the assistant's edit, in order.
    await click(document.body, 'Redo')
    await waitFor(() => expect(nameInput().value).toBe('Tea'))
    await click(document.body, 'Redo')
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('20 184 166'))
    await waitFor(() => expect(stored.history).toEqual({ canUndo: true, canRedo: false }))
  } finally {
    await dom.cleanup()
    for (const spy of [create, sync, read, close]) spy.mockRestore()
  }
})

test('setting Neutral first starts the palette from the base theme primary, with its companions', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'dark' })
  const field = (name: string) => getByLabelText(container, name) as HTMLInputElement
  // All four seed fields render before any palette exists.
  expect([field('Primary').value, field('Secondary').value, field('Tertiary').value, field('Neutral').value]).toEqual([
    '',
    '',
    '',
    '',
  ])
  await change(container, 'Neutral', '#4a4a3f')
  const primary = field('Primary').value
  expect(primary).toMatch(/^#[0-9a-f]{6}$/)
  const companions = suggestPaletteSeeds(primary)!
  expect([field('Secondary').value, field('Tertiary').value, field('Neutral').value]).toEqual([
    companions.secondary,
    companions.tertiary,
    '#4a4a3f',
  ])
  expect(queryByRole(container, 'alert')).toBeNull()
})

test('Based on sits beside the name, not under Advanced', async () => {
  const { container } = await render({ baseId: 'harbor', appearance: 'dark' })
  const based = getByLabelText(container, 'Based on') as HTMLSelectElement
  expect(based.value).toBe('harbor')
  expect(based.closest('details')).toBeNull()
  expect(container.textContent).toContain('Colors you don’t set come from Harbor')
})
