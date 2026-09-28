import { afterEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ThemePreset } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { ThemeProvider, useTheme } from '../../providers/ThemeProvider'
import { ThemePresetLibrary } from './ThemePresetLibrary'
import { themePresetQueryKeys, queryKeys } from '../../queryKeys'
import { client } from '../../api/clientInstance'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const mine: ThemePreset = {
  id: 'preset-1',
  document: {
    format: 'ficus-custom-theme',
    version: 2,
    name: 'Mine',
    base: 'harbor',
    variants: { light: {}, dark: {} },
  },
  visibility: 'private',
  ownerUserId: 'u1',
  owner: { id: 'u1', displayName: 'Owner' },
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const sharedByAuthor: ThemePreset = {
  id: 'preset-shared',
  document: {
    format: 'ficus-custom-theme',
    version: 2,
    name: 'Author theme',
    base: 'harbor',
    variants: { light: {}, dark: {} },
  },
  visibility: 'instance',
  ownerUserId: 'author',
  owner: { id: 'author', displayName: 'Ann Author' },
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function Harness() {
  const value = useTheme()
  return <ThemePresetLibrary value={value} />
}

async function render(
  mine: ThemePreset[],
  opts: { shared?: ThemePreset[]; permissions?: string[]; userId?: string; themeId?: string } = {}
) {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  if (opts.themeId) localStorage.setItem('ficus-theme-id', opts.themeId)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(themePresetQueryKeys.list('mine'), mine)
  queryClient.setQueryData(themePresetQueryKeys.list('shared'), opts.shared ?? [])
  queryClient.setQueryData(queryKeys.auth.permissions(), {
    permissions: opts.permissions ?? [],
    identity: { type: 'user', userId: opts.userId ?? 'u1' },
  })
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  return { container, queryClient }
}

/** Opens a preset row's overflow menu, where its secondary actions live. */
async function openActions(container: HTMLElement) {
  await act(async () => fireEvent.click(getAllByRole(container, 'button', { name: /^More actions for / })[0]!))
}

test('with no presets, shows an empty state', async () => {
  const { container } = await render([])
  expect(container.textContent).toContain('No saved themes yet.')
})

test('lists a preset with its name, and applies it via Use (applyPreset)', async () => {
  const { container } = await render([mine])
  expect(container.textContent).toContain('Mine')
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Use' })))
  expect(localStorage.getItem('ficus-theme-preset-id')).toBe('preset-1')
  expect(localStorage.getItem('ficus-theme-id')).toBe('harbor')
})

test('Duplicate calls the server-side duplicate endpoint (works identically for own and shared presets)', async () => {
  const duplicate = spyOn(client.themePresets, 'duplicate').mockResolvedValue({
    ...mine,
    id: 'preset-2',
    document: { ...mine.document, name: 'Copy of Mine' },
  })
  try {
    const { container } = await render([mine])
    await openActions(container)
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Duplicate' })))
    expect(duplicate).toHaveBeenCalledWith('preset-1')
  } finally {
    duplicate.mockRestore()
  }
})

test('Rename shows an inline form and sends a PUT with the current revision', async () => {
  const update = spyOn(client.themePresets, 'update').mockResolvedValue({
    ...mine,
    document: { ...mine.document, name: 'Renamed' },
    revision: 2,
  })
  try {
    const { container } = await render([mine])
    await openActions(container)
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Rename' })))
    const input = container.querySelector('input.ficus-field') as HTMLInputElement
    await act(async () => fireEvent.change(input, { target: { value: 'Renamed' } }))
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Save' })))
    expect(update).toHaveBeenCalledWith('preset-1', 1, expect.objectContaining({ name: 'Renamed' }))
  } finally {
    update.mockRestore()
  }
})

test('Delete asks for confirmation, then sends the revision', async () => {
  const remove = spyOn(client.themePresets, 'delete').mockResolvedValue({ ok: true })
  try {
    const { container } = await render([mine])
    let confirmed = false
    window.confirm = () => {
      confirmed = true
      return true
    }
    await openActions(container)
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Delete' })))
    expect(confirmed).toBe(true)
    expect(remove).toHaveBeenCalledWith('preset-1', 1)
  } finally {
    remove.mockRestore()
  }
})

test('Delete does nothing when the confirmation is declined', async () => {
  const remove = spyOn(client.themePresets, 'delete').mockResolvedValue({ ok: true })
  try {
    const { container } = await render([mine])
    window.confirm = () => false
    await openActions(container)
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Delete' })))
    expect(remove).not.toHaveBeenCalled()
  } finally {
    remove.mockRestore()
  }
})

test('a single New theme action (no separate "with assistant" button) opens the editor for a fresh document based on the selected base', async () => {
  const { container } = await render([])
  expect(queryByRole(container, 'button', { name: 'New theme with assistant' })).toBeNull()
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'New theme' })))
  expect(queryByRole(container, 'textbox', { name: 'Theme name' })).not.toBeNull()
  expect((queryByRole(container, 'textbox', { name: 'Theme name' }) as HTMLInputElement).value).toBe('New theme')
})

test('the row overflow menu (narrow widths) exposes aria-haspopup/expanded and its actions work the same as the inline desktop buttons', async () => {
  const remove = spyOn(client.themePresets, 'delete').mockResolvedValue({ ok: true })
  try {
    const { container } = await render([mine])
    const trigger = getByRole(container, 'button', { name: 'More actions for Mine' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await act(async () => fireEvent.click(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // Reachable by keyboard: opening focuses the first action inside the menu.
    expect(document.activeElement?.textContent).toBe('Rename')

    window.confirm = () => true
    const menu = container.querySelector('[data-theme-preset-actions]')!
    // Menu items are plain rows, not bordered secondary buttons.
    expect(menu.querySelectorAll('button.ficus-button-secondary')).toHaveLength(0)
    await act(async () => fireEvent.click(getByRole(menu, 'button', { name: 'Delete' })))
    expect(remove).toHaveBeenCalledWith('preset-1', 1)
    // Selecting an action closes the menu and returns focus to the trigger.
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  } finally {
    remove.mockRestore()
  }
})

test('tapping a menu action in Safari (focus leaves with no relatedTarget) still activates it', async () => {
  const remove = spyOn(client.themePresets, 'delete').mockResolvedValue({ ok: true })
  try {
    const { container } = await render([mine])
    const trigger = getByRole(container, 'button', { name: 'More actions for Mine' })
    await act(async () => fireEvent.click(trigger))
    const menu = container.querySelector('[data-theme-preset-actions]')!
    // Safari doesn't focus a tapped button: the focused first item blurs to nothing.
    await act(async () => fireEvent.focusOut(getByRole(menu, 'button', { name: 'Rename' }), { relatedTarget: null }))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    window.confirm = () => true
    await act(async () => fireEvent.click(getByRole(menu, 'button', { name: 'Delete' })))
    expect(remove).toHaveBeenCalledWith('preset-1', 1)
  } finally {
    remove.mockRestore()
  }
})

test('moving focus outside the row overflow menu closes it', async () => {
  const { container } = await render([mine])
  const trigger = getByRole(container, 'button', { name: 'More actions for Mine' })
  await act(async () => fireEvent.click(trigger))
  const menu = container.querySelector('[data-theme-preset-actions]')!
  const outside = getByRole(container, 'button', { name: 'Use' })
  await act(async () => fireEvent.focusOut(getByRole(menu, 'button', { name: 'Rename' }), { relatedTarget: outside }))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('Escape closes the row overflow menu and returns focus to its trigger', async () => {
  const { container } = await render([mine])
  const trigger = getByRole(container, 'button', { name: 'More actions for Mine' })
  await act(async () => fireEvent.click(trigger))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await act(async () => fireEvent.keyDown(document, { key: 'Escape' }))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
})

test('a palette-only preset (no explicit overrides) still resolves a real swatch color, not an empty circle', async () => {
  const { palettes, resolveToken } = await import('../../theme/test/builtins')
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  const style = document.createElement('style')
  style.textContent = palettes
    .map((p) => {
      const attrs = `[data-theme="${p.id}"]${p.appearance === 'constant' ? '' : `[data-appearance="${p.appearance}"]`}`
      return `:root${attrs}, [data-theme-scope]${attrs} { ${Object.entries(p.tokens)
        .map(([key]) => `${key}: ${resolveToken(p.tokens, key)};`)
        .join(' ')} }`
    })
    .join('\n')
  document.head.append(style)
  const paletteOnly: ThemePreset = {
    id: 'preset-2',
    document: {
      format: 'ficus-custom-theme',
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(themePresetQueryKeys.list(), [paletteOnly])
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  const swatch = container.querySelector('[data-theme-scope]')!
  const resolvedPrimary = window.getComputedStyle(swatch).getPropertyValue('--color-primary').trim()
  expect(resolvedPrimary).not.toBe('')
  // Not the plain Harbor base primary (proves derivation ran, not a fallback)...
  expect(resolvedPrimary).not.toBe('14 95 109')
  // ...and recognizably derived FROM the seed (#0ea5e9): a blue hue, not the
  // exact seed necessarily (a contrast pass may nudge lightness), but well
  // within the blue family, never a neutral/gray/other-hue washout.
  const { srgbToOklch } = await import('@ficus/shared/color-oklch')
  const [r, g, b] = resolvedPrimary.split(/\s+/).map(Number)
  const oklch = srgbToOklch([r!, g!, b!])
  expect(oklch.h).toBeGreaterThan(200)
  expect(oklch.h).toBeLessThan(260)
  expect(oklch.c).toBeGreaterThan(0.05)
})

test('the swatch element carries the shared theme-swatch paint class (regression: a missing class left it visually blank)', async () => {
  const { container } = await render([mine])
  const swatch = container.querySelector('[data-theme-scope]')!
  expect(swatch.classList.contains('theme-swatch')).toBe(true)
})

// ── Phase 2: sharing ────────────────────────────────────────────────────────

test('My themes: Share toggles a private preset to instance visibility; the row then offers Unshare', async () => {
  const setVisibility = spyOn(client.themePresets, 'setVisibility').mockResolvedValue({
    ...mine,
    visibility: 'instance',
    revision: 2,
  })
  try {
    const { container } = await render([mine])
    expect(queryByRole(container, 'button', { name: 'Unshare' })).toBeNull()
    await openActions(container)
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Share' })))
    expect(setVisibility).toHaveBeenCalledWith('preset-1', 1, 'instance')
  } finally {
    setVisibility.mockRestore()
  }
})

test('My themes: an already-shared preset shows Unshare, which reverts to private', async () => {
  const setVisibility = spyOn(client.themePresets, 'setVisibility').mockResolvedValue({
    ...mine,
    visibility: 'private',
    revision: 2,
  })
  try {
    const shared = { ...mine, visibility: 'instance' as const }
    const { container } = await render([shared])
    expect(queryByRole(container, 'button', { name: 'Share' })).toBeNull()
    await openActions(container)
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Unshare' })))
    expect(setVisibility).toHaveBeenCalledWith('preset-1', 1, 'private')
  } finally {
    setVisibility.mockRestore()
  }
})

test('Shared themes section lists other users’ shared presets with attribution, and Use applies it', async () => {
  const { container } = await render([], { shared: [sharedByAuthor] })
  expect(container.textContent).toContain('Shared themes')
  expect(container.textContent).toContain('Author theme')
  expect(container.textContent).toContain('Ann Author')
  const useButtons = getAllByRole(container, 'button', { name: 'Use' })
  await act(async () => fireEvent.click(useButtons[0]!))
  expect(localStorage.getItem('ficus-theme-preset-id')).toBe('preset-shared')
  expect(localStorage.getItem('ficus-theme-preset-owner-id')).toBe('author')
})

test('with no shared presets, the Shared themes section is omitted entirely', async () => {
  const { container } = await render([mine], { shared: [] })
  expect(container.textContent).not.toContain('Shared themes')
})

test('Shared themes: Duplicate is available for a shared preset (not just My themes)', async () => {
  const duplicate = spyOn(client.themePresets, 'duplicate').mockResolvedValue({
    ...sharedByAuthor,
    id: 'preset-copy',
    ownerUserId: 'u1',
    owner: { id: 'u1', displayName: 'Me' },
    visibility: 'private',
    document: { ...sharedByAuthor.document, name: 'Copy of Author theme' },
  })
  try {
    const { container } = await render([], { shared: [sharedByAuthor] })
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Duplicate' })))
    expect(duplicate).toHaveBeenCalledWith('preset-shared')
  } finally {
    duplicate.mockRestore()
  }
})

test('Shared themes: a non-admin/operator never sees a Remove action', async () => {
  const { container } = await render([], { shared: [sharedByAuthor], permissions: [] })
  expect(queryByRole(container, 'button', { name: /Remove/ })).toBeNull()
})

test('Shared themes: an admin/operator sees Remove, confirms, and it unshares (owner keeps the preset)', async () => {
  const removeShare = spyOn(client.themePresets, 'removeShare').mockResolvedValue({
    ...sharedByAuthor,
    visibility: 'private',
    revision: 2,
  })
  try {
    const { container } = await render([], { shared: [sharedByAuthor], permissions: ['theme-presets:moderate'] })
    let confirmed = false
    window.confirm = () => {
      confirmed = true
      return true
    }
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: /Remove/ })))
    expect(confirmed).toBe(true)
    expect(removeShare).toHaveBeenCalledWith('preset-shared')
  } finally {
    removeShare.mockRestore()
  }
})

test('Shared themes: Remove does nothing when the confirmation is declined', async () => {
  const removeShare = spyOn(client.themePresets, 'removeShare').mockResolvedValue({
    ...sharedByAuthor,
    visibility: 'private',
  })
  try {
    const { container } = await render([], { shared: [sharedByAuthor], permissions: ['theme-presets:moderate'] })
    window.confirm = () => false
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: /Remove/ })))
    expect(removeShare).not.toHaveBeenCalled()
  } finally {
    removeShare.mockRestore()
  }
})

test('detached-shared: a foreign preset that 404s is shown as no longer available, with a "keep a copy" action', async () => {
  const dom = await acquireDomHarness({ url: 'https://tau.test' })
  cleanup = () => dom.cleanup()
  // Simulate ThemeSyncStore.refreshLinkedPreset's 404 outcome directly via
  // localStorage: presetId cleared, presetOwnerId + document retained.
  localStorage.setItem('ficus-custom-theme', JSON.stringify(sharedByAuthor.document))
  localStorage.setItem('ficus-theme-preset-owner-id', 'author')
  localStorage.setItem('ficus-theme-id', 'harbor')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(themePresetQueryKeys.list('mine'), [])
  queryClient.setQueryData(themePresetQueryKeys.list('shared'), [])
  queryClient.setQueryData(queryKeys.auth.permissions(), { permissions: [], identity: { type: 'user', userId: 'u1' } })
  const create = spyOn(client.themePresets, 'create').mockResolvedValue({
    ...sharedByAuthor,
    id: 'kept-copy',
    ownerUserId: 'u1',
    owner: { id: 'u1', displayName: 'Me' },
    visibility: 'private',
  })
  try {
    const { root, container } = dom.createRoot()
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <Harness />
          </ThemeProvider>
        </QueryClientProvider>
      )
    )
    expect(container.textContent).toContain('no longer available')
    await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'Keep a copy' })))
    expect(create).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('ficus-theme-preset-id')).toBe('kept-copy')
  } finally {
    create.mockRestore()
  }
})

test('New theme and Import JSON sit beside the My themes heading; New theme starts from the theme in use', async () => {
  const { container } = await render([], { themeId: 'ember' })
  expect(container.querySelector('select')).toBeNull()
  await act(async () => fireEvent.click(getByRole(container, 'button', { name: 'New theme' })))
  expect((container.querySelector('select') as HTMLSelectElement | null)?.value).toBe('ember')
})
