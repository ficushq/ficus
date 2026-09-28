import { afterEach, expect, test } from 'bun:test'
import { act, StrictMode } from 'react'
import { queryByRole } from '@testing-library/dom'
import { readFileSync } from 'node:fs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { ThemeProvider, useTheme, useThemeSyncStore } from './ThemeProvider'
import { ThemeAccountSyncSession } from './ThemeAccountSync'
import { ThemeControl } from '../components/settings/ThemeControl'
import { themePresetQueryKeys } from '../queryKeys'
import type { ThemeSyncStore, ThemeSyncApi, ThemePresetLiveLinkApi } from '../theme/sync'
import type { ThemePreference, ThemePreset } from '@ficus/shared'

function queryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(themePresetQueryKeys.list(), [])
  return client
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
let store: ThemeSyncStore
function Picker() {
  store = useThemeSyncStore()
  return <ThemeControl value={useTheme()} />
}
async function harness() {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  const previousRequest = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  globalThis.requestAnimationFrame = (fn) => {
    frames.set(++id, fn)
    return id
  }
  globalThis.cancelAnimationFrame = (key) => {
    frames.delete(key)
  }
  cleanup = async () => {
    await dom.cleanup()
    globalThis.requestAnimationFrame = previousRequest
    globalThis.cancelAnimationFrame = previousCancel
  }
  const paint = async () => {
    const batch = [...frames.values()]
    frames.clear()
    await act(async () => {
      for (const frame of batch) frame(0)
    })
  }
  return { ...dom.createRoot(), paint }
}
function fixture() {
  let theme: ThemePreference = {
    themeId: 'harbor',
    appearance: 'dark',
    customTheme: null,
    presetId: null,
    presetOwnerId: null,
  }
  let reads = 0
  const writes: ThemePreference[] = []
  const api: ThemeSyncApi = {
    getMine: async () => {
      reads++
      return { userId: 'A', theme }
    },
    updateMine: async (input) => {
      writes.push(input.theme)
      theme = input.theme
      return { userId: 'A', theme }
    },
  }
  return {
    api,
    reads: () => reads,
    writes,
    set: (value: ThemePreference) => {
      theme = value
    },
  }
}

test('cold load paints the cached theme first, reads only after paint, then adopts the account theme; no echo loop', async () => {
  const { root, container, paint } = await harness()
  localStorage.setItem('ficus-theme-id', 'ember')
  localStorage.setItem('ficus-appearance', 'light')
  const script = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').match(
    /<script data-ficus-theme-flash>([\s\S]*?)<\/script>/
  )![1]!
  new Function('window', 'document', 'localStorage', script)(window, document, localStorage)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  const remote = fixture()
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient()}>
          <ThemeProvider>
            <ThemeAccountSyncSession sessionKey={1} api={remote.api} />
            <Picker />
          </ThemeProvider>
        </QueryClientProvider>
      </StrictMode>
    )
  )
  expect(remote.reads()).toBe(0)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  await paint()
  expect(remote.reads()).toBe(0)
  expect(document.documentElement.getAttribute('data-theme')).toBe('ember')
  await paint()
  expect(remote.reads()).toBe(1)
  // Every device follows the account: the cached Ember painted first, then the account's Harbor replaces it.
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  expect(document.documentElement.getAttribute('data-appearance')).toBe('dark')
  expect(queryByRole(container, 'button', { name: /synced theme/i })).toBeNull()
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await store.refresh()
  })
  expect(remote.reads()).toBe(2)
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  expect(remote.writes).toHaveLength(0)
})
test('fresh device adopts only after paint; logout removes inherited document and scheduled/late requests cannot follow the next session', async () => {
  const { root, paint } = await harness()
  const remote = fixture()
  const render = (key: number | null | undefined) => (
    <QueryClientProvider client={queryClient()}>
      <ThemeProvider>
        <ThemeAccountSyncSession sessionKey={key} api={remote.api} />
        <Picker />
      </ThemeProvider>
    </QueryClientProvider>
  )
  await act(async () => root.render(render(undefined)))
  await paint()
  await paint()
  expect(remote.reads()).toBe(0)
  await act(async () => root.render(render(1)))
  await paint()
  await act(async () => root.render(render(null)))
  await paint()
  expect(remote.reads()).toBe(0)
  await act(async () => root.render(render(2)))
  await paint()
  await paint()
  expect(remote.reads()).toBe(1)
  expect(document.documentElement.getAttribute('data-theme')).toBe('harbor')
  await act(async () => root.render(render(null)))
  expect(document.documentElement.getAttribute('data-theme')).toBe('ficus')
  expect(store.getSnapshot().syncAvailable).toBe(false)
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await store.refresh()
  })
  expect(remote.reads()).toBe(1)
})

const sharedDoc = {
  format: 'ficus-custom-theme' as const,
  version: 2 as const,
  name: 'Shared',
  base: 'harbor',
  variants: { light: {}, dark: {} },
}
function sharedPreset(document = sharedDoc): ThemePreset {
  return {
    id: 'shared-1',
    document,
    visibility: 'instance',
    ownerUserId: 'author',
    owner: { id: 'author', displayName: 'Author' },
    revision: 1,
    createdAt: '',
    updatedAt: '',
  }
}

test('a live-linked shared preset is refetched on load (after the account read) and applied if changed', async () => {
  const { root, paint } = await harness()
  const remote = fixture()
  remote.set({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'shared-1',
    presetOwnerId: 'author',
    customTheme: sharedDoc,
  })
  const gets: string[] = []
  const editedDoc = { ...sharedDoc, name: 'Shared (edited)' }
  const themePresetsApi: ThemePresetLiveLinkApi = {
    get: async (id) => {
      gets.push(id)
      return sharedPreset(editedDoc)
    },
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient()}>
        <ThemeProvider>
          <ThemeAccountSyncSession sessionKey={1} api={remote.api} themePresetsApi={themePresetsApi} />
          <Picker />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  await paint()
  await paint()
  expect(remote.reads()).toBe(1) // account preference read happened first
  expect(gets).toEqual(['shared-1']) // then the live-link fetch
  expect(store.getSnapshot().custom?.name).toBe('Shared (edited)')
})

test('focus/online/visibility refresh also re-checks the live-linked preset', async () => {
  const { root, paint } = await harness()
  const remote = fixture()
  remote.set({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'shared-1',
    presetOwnerId: 'author',
    customTheme: sharedDoc,
  })
  const gets: string[] = []
  const themePresetsApi: ThemePresetLiveLinkApi = {
    get: async (id) => {
      gets.push(id)
      return sharedPreset()
    },
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient()}>
        <ThemeProvider>
          <ThemeAccountSyncSession sessionKey={1} api={remote.api} themePresetsApi={themePresetsApi} />
          <Picker />
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  await paint()
  await paint()
  expect(gets).toHaveLength(1)
  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await store.refresh()
  })
  expect(gets.length).toBeGreaterThanOrEqual(2)
})
