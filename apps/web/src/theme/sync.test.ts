import { expect, mock, test } from 'bun:test'
import { SYNC_THEME_DESCRIPTORS, type MyThemePreferences, type ThemePreference, type ThemePreset } from '@ficus/shared'
import { HttpResponseError } from '@ficus/client-core'
import { ThemeSyncStore, LEGACY_LOCAL_OVERRIDE_KEY, type ThemeSyncApi, type ThemePresetLiveLinkApi } from './sync'
import { BUILT_IN_THEMES } from './registry'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
    removeItem: (k: string) => {
      values.delete(k)
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const harbor: ThemePreference = {
  themeId: 'harbor',
  appearance: 'dark',
  customTheme: null,
  presetId: null,
  presetOwnerId: null,
}
const ember: ThemePreference = {
  themeId: 'ember',
  appearance: 'system',
  customTheme: null,
  presetId: null,
  presetOwnerId: null,
}
function server(theme: ThemePreference | null = harbor) {
  let remote = theme
  const writes: Array<{ expectedUserId: string; theme: ThemePreference }> = []
  const api: ThemeSyncApi = {
    getMine: async () => ({ userId: 'A', theme: remote }),
    updateMine: async (input) => {
      writes.push(input)
      remote = input.theme
      return { userId: 'A', theme: remote }
    },
  }
  return {
    api,
    writes,
    set: (t: ThemePreference) => {
      remote = t
    },
  }
}

test('the retired local-override flag uses the ficus name', () => {
  expect(LEGACY_LOCAL_OVERRIDE_KEY).toBe('ficus-theme-local-override')
})

test('sync metadata matches every web builtin (no duplicated palette)', () => {
  expect(SYNC_THEME_DESCRIPTORS).toEqual(BUILT_IN_THEMES.map(({ id, label, kind }) => ({ id, label, kind })))
})
test('fresh device adopts; reload retains the adopted cache; adoption never echoes a write', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const remote = server()
  store.connect(remote.api)
  await store.refresh()
  expect(store.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
  expect(remote.writes).toHaveLength(0)
  const reloaded = new ThemeSyncStore(local)
  expect(reloaded.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
  reloaded.connect(remote.api)
  await reloaded.refresh()
  expect(reloaded.getSnapshot().selection).toEqual(store.getSnapshot().selection)
  expect(remote.writes).toHaveLength(0)
  store.disconnect()
  reloaded.disconnect()
})
test('the flag older versions used to keep a device theme is removed, and no longer stops adoption', async () => {
  const local = storage({ [LEGACY_LOCAL_OVERRIDE_KEY]: '1', 'ficus-theme-id': 'ember' })
  const store = new ThemeSyncStore(local)
  expect(local.getItem(LEGACY_LOCAL_OVERRIDE_KEY)).toBeNull()
  const remote = server()
  store.connect(remote.api)
  await store.refresh()
  expect(store.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
  expect(remote.writes).toHaveLength(0)
  store.disconnect()
})
test.each(['ficus-theme', 'ficus-theme-id', 'ficus-appearance'])(
  'pre-sync %s is never uploaded on login; the account theme is adopted',
  async (key) => {
    const store = new ThemeSyncStore(storage({ [key]: key === 'ficus-theme-id' ? 'ember' : 'dark' }))
    const remote = server()
    store.connect(remote.api)
    await store.refresh()
    expect(store.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
    expect(remote.writes).toHaveLength(0)
    store.disconnect()
  }
)
test('an account with no theme keeps the device theme and is not written to', async () => {
  const store = new ThemeSyncStore(storage({ 'ficus-theme-id': 'ember' }))
  const remote = server(null)
  store.connect(remote.api)
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(store.getSnapshot().syncAvailable).toBe(true)
  expect(remote.writes).toHaveLength(0)
  store.disconnect()
})
test('local edit wins over pending initial read and pushes once; a later change elsewhere is then adopted', async () => {
  const response = deferred<MyThemePreferences>()
  const readStarted = deferred<void>()
  const remote = server()
  const store = new ThemeSyncStore(storage())
  store.connect({
    ...remote.api,
    getMine: () => {
      readStarted.resolve()
      return response.promise
    },
  })
  await readStarted.promise
  store.change(ember)
  response.resolve({ userId: 'A', theme: harbor })
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(remote.writes).toEqual([{ expectedUserId: 'A', theme: ember }])
  store.disconnect()
  store.connect(remote.api)
  await store.refresh()
  // Another device chooses Harbor: this device follows on its next read.
  remote.set(harbor)
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('harbor')
  remote.set(ember)
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(remote.writes).toHaveLength(1)
  store.disconnect()
})
test('stale old-account read after logout/relogin cannot apply or seed a new-account write', async () => {
  const response = deferred<MyThemePreferences>()
  const started = deferred<void>()
  const store = new ThemeSyncStore(storage())
  const old = server()
  store.connect({
    ...old.api,
    getMine: () => {
      started.resolve()
      return response.promise
    },
  })
  await started.promise
  const pending = store.refresh()
  store.change(ember)
  store.disconnect(true)
  const next = server(null)
  store.connect({ ...next.api, getMine: async () => ({ userId: 'B', theme: null }) })
  await store.refresh()
  response.resolve({ userId: 'A', theme: harbor })
  await pending
  expect(store.getSnapshot().selection.themeId).toBe('ember') // deliberate device choice retained
  expect(old.writes).toHaveLength(0)
  expect(next.writes).toHaveLength(0)
  store.disconnect()
})
test('logout clears inherited custom preference; next empty account does not receive it', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const remote = server({
    ...harbor,
    customTheme: {
      format: 'ficus-custom-theme',
      version: 1,
      name: 'Private palette',
      base: 'harbor',
      appearance: 'dark',
      overrides: { '--term-bg': '#123456' },
    },
  })
  store.connect(remote.api)
  await store.refresh()
  expect(store.getSnapshot().custom?.name).toBe('Private palette')
  store.disconnect() // React cleanup, followed by the new identity boundary
  store.disconnect(true)
  expect(store.getSnapshot().custom).toBeNull()
  expect(store.getSnapshot().syncAvailable).toBe(false)
  expect(local.getItem('ficus-custom-theme')).toBeNull()
  const next = server(null)
  store.connect(next.api)
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ficus')
  expect(next.writes).toHaveLength(0)
  store.disconnect()
})
test('serialized writes coalesce to latest choice; failed writes retry only within their original session', async () => {
  const first = deferred<MyThemePreferences>()
  const remote = server()
  const writes: ThemePreference[] = []
  const store = new ThemeSyncStore(storage())
  store.connect({
    ...remote.api,
    updateMine: async ({ theme }) => {
      writes.push(theme)
      if (writes.length === 1) return first.promise
      return { userId: 'A', theme }
    },
  })
  await store.refresh()
  store.change(ember)
  store.change(harbor)
  store.change({ ...ember, appearance: 'light' })
  expect(writes).toHaveLength(1)
  first.reject(new Error('offline'))
  await store.refresh()
  await store.refresh()
  expect(writes.at(-1)?.appearance).toBe('light')
  expect(writes.some((t) => t === harbor)).toBe(false)
  store.disconnect(true)
  const next = server()
  store.connect(next.api)
  await store.refresh()
  expect(next.writes).toHaveLength(0)
  store.disconnect()
})
test('an unsent choice made offline is kept over a successful read, then uploaded once back online', async () => {
  const remote = server()
  let online = false
  const store = new ThemeSyncStore(storage())
  store.connect({
    ...remote.api,
    updateMine: async (input) => {
      if (!online) throw new Error('offline')
      return remote.api.updateMine(input)
    },
  })
  await store.refresh()
  store.change(ember)
  // The write fails but the read succeeds: the account's Harbor must not replace the choice that has not landed.
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  online = true
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect((await remote.api.getMine()).theme).toEqual(ember)
  store.disconnect()
})
test('invalid/oversized remote values and network failures leave local state intact; reconnect adopts once', async () => {
  const store = new ThemeSyncStore(storage())
  const before = store.getSnapshot().selection
  for (const bad of [
    { ...harbor, themeId: 'unknown' },
    { ...harbor, customTheme: { overrides: { '--term-bg': 'url(x)' } } },
  ]) {
    store.connect({
      getMine: async () => ({ userId: 'A', theme: bad }) as MyThemePreferences,
      updateMine: async () => {
        throw new Error('must not write')
      },
    })
    await store.refresh()
    expect(store.getSnapshot().selection).toEqual(before)
  }
  let online = false
  store.connect({
    ...server().api,
    getMine: async () => {
      if (!online) throw new Error('offline')
      return { userId: 'A', theme: harbor }
    },
  })
  await store.refresh()
  expect(store.getSnapshot().selection).toEqual(before)
  online = true
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('harbor')
  store.disconnect()
})
test('cookie identity change during reconnect discards cached preference and queued updates', async () => {
  const store = new ThemeSyncStore(storage())
  let userId = 'A'
  const remote = server()
  store.connect({ ...remote.api, getMine: async () => ({ userId, theme: harbor }) })
  await store.refresh()
  userId = 'B'
  await store.refresh()
  expect(store.getSnapshot().syncAvailable).toBe(false)
  expect(store.getSnapshot().selection.themeId).toBe('ficus')
  store.change(ember)
  expect(remote.writes).toHaveLength(0)
})
test('storage denial remains functional in memory and unauthenticated edits never need an API', () => {
  const store = new ThemeSyncStore({
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
    removeItem() {
      throw new Error('denied')
    },
  })
  store.change(ember)
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(store.getSnapshot().syncAvailable).toBe(false)
})

test('another tab choosing a theme invalidates slow reads without echo writes', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const response = deferred<MyThemePreferences>()
  const started = deferred<void>()
  const remote = server()
  store.connect({
    ...remote.api,
    getMine: () => {
      started.resolve()
      return response.promise
    },
  })
  await started.promise
  local.setItem('ficus-theme-id', 'ember')
  local.setItem('ficus-appearance', 'light')
  store.reloadFromStorage()
  response.resolve({ userId: 'A', theme: harbor })
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(remote.writes).toHaveLength(0)
  store.disconnect()
})

test('failed in-flight PUT cannot resurrect a write invalidated by a newer storage choice', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const failed = deferred<MyThemePreferences>()
  const remote = server()
  const writes: ThemePreference[] = []
  store.connect({
    ...remote.api,
    updateMine: async (input) => {
      writes.push(input.theme)
      if (writes.length === 1) return failed.promise
      return remote.api.updateMine(input)
    },
  })
  await store.refresh()
  store.change(ember)
  expect(writes).toEqual([ember])

  // Another tab has published Harbor and persisted it on this device.
  remote.set(harbor)
  local.setItem('ficus-theme-id', 'harbor')
  local.setItem('ficus-appearance', 'dark')
  store.reloadFromStorage()
  const refresh = store.refresh()
  failed.reject(new Error('old Ember request failed'))
  await refresh
  await store.refresh()

  expect(writes).toEqual([ember])
  expect(store.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
  expect((await remote.api.getMine()).theme).toEqual(harbor)
  store.disconnect()
})

test('failed in-flight PUT retries on reconnect when the deliberate intent is still current', async () => {
  const store = new ThemeSyncStore(storage())
  const failed = deferred<MyThemePreferences>()
  const remote = server()
  const writes: ThemePreference[] = []
  store.connect({
    ...remote.api,
    updateMine: async (input) => {
      writes.push(input.theme)
      if (writes.length === 1) return failed.promise
      return remote.api.updateMine(input)
    },
  })
  await store.refresh()
  store.change(ember)
  const reconnect = store.refresh()
  failed.reject(new Error('connection dropped'))
  await reconnect
  expect(writes).toEqual([ember, ember])
  expect((await remote.api.getMine()).theme).toEqual(ember)
  expect(store.getSnapshot().selection).toEqual({ themeId: 'ember', appearance: 'system' })
  store.disconnect()
})

const mineDoc = {
  format: 'ficus-custom-theme' as const,
  version: 2 as const,
  name: 'Mine',
  base: 'harbor',
  variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
}

test('presetId round-trips through change/apply and clears when the custom theme is dropped', () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const withPreset: ThemePreference = {
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: null,
    customTheme: mineDoc,
  }
  store.change(withPreset)
  expect(store.getSnapshot().presetId).toBe('p-1')
  expect(local.getItem('ficus-theme-preset-id')).toBe('p-1')
  // Reloading a fresh store instance from the same storage recovers presetId.
  const reloaded = new ThemeSyncStore(local)
  expect(reloaded.getSnapshot().presetId).toBe('p-1')
  // Deactivating the custom theme (built-in selection) clears the preset ring
  // locally without needing a server call — the library preset itself is untouched.
  store.change({ themeId: 'iris', appearance: 'dark', customTheme: null, presetId: null, presetOwnerId: null })
  expect(store.getSnapshot().presetId).toBeNull()
  expect(local.getItem('ficus-theme-preset-id')).toBeNull()
})

test('presetOwnerId round-trips alongside presetId, survives reload, and clears with the custom theme', () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const withOwner: ThemePreference = {
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  }
  store.change(withOwner)
  expect(store.getSnapshot().presetOwnerId).toBe('owner-1')
  expect(local.getItem('ficus-theme-preset-owner-id')).toBe('owner-1')
  const reloaded = new ThemeSyncStore(local)
  expect(reloaded.getSnapshot().presetOwnerId).toBe('owner-1')
  // Appearance changes (setAppearance/toggleTheme in ThemeProvider) must carry
  // presetOwnerId forward, exactly like presetId — verified via change() with
  // the same custom/presetId/presetOwnerId, only appearance flipped.
  store.change({ ...withOwner, appearance: 'light' })
  expect(store.getSnapshot().presetOwnerId).toBe('owner-1')
  store.change({ themeId: 'iris', appearance: 'dark', customTheme: null, presetId: null, presetOwnerId: null })
  expect(store.getSnapshot().presetOwnerId).toBeNull()
  expect(local.getItem('ficus-theme-preset-owner-id')).toBeNull()
})

test('presetOwnerId is retained (detached-shared) even when presetId alone is cleared', () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  // Simulates what refreshLinkedPreset does on a 404: presetId nulled, owner + doc retained.
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: null,
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  expect(store.getSnapshot().presetId).toBeNull()
  expect(store.getSnapshot().presetOwnerId).toBe('owner-1')
  expect(store.getSnapshot().custom).toEqual(mineDoc)
})

function presetFor(document: typeof mineDoc, ownerId = 'owner-1'): ThemePreset {
  return {
    id: 'p-1',
    document,
    visibility: 'instance',
    ownerUserId: ownerId,
    owner: { id: ownerId, displayName: 'Author' },
    revision: 1,
    createdAt: '',
    updatedAt: '',
  }
}

test('refreshLinkedPreset is a no-op when there is no active foreign preset (never calls the API)', async () => {
  const store = new ThemeSyncStore(storage())
  const get = mock(async () => presetFor(mineDoc))
  await store.refreshLinkedPreset({ get })
  expect(get).not.toHaveBeenCalled()

  // A preset that IS applied but has no owner (should not happen via applyPreset,
  // but the guard is presetId && presetOwnerId && custom, all three required).
  store.change({ themeId: 'harbor', appearance: 'dark', presetId: 'p-1', presetOwnerId: null, customTheme: mineDoc })
  await store.refreshLinkedPreset({ get })
  expect(get).not.toHaveBeenCalled()
})

test('refreshLinkedPreset applies a changed document through the normal apply path, keeping presetId/presetOwnerId', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  const changedDoc = { ...mineDoc, name: 'Mine (edited)' }
  const get = mock(async () => presetFor(changedDoc))
  await store.refreshLinkedPreset({ get })
  expect(get).toHaveBeenCalledTimes(1)
  expect(store.getSnapshot().custom).toEqual(changedDoc)
  expect(store.getSnapshot().presetId).toBe('p-1')
  expect(store.getSnapshot().presetOwnerId).toBe('owner-1')
  expect(local.getItem('ficus-custom-theme')).toBe(JSON.stringify(changedDoc))
})

test('refreshLinkedPreset is a no-op when the document is unchanged (identical hash)', async () => {
  const store = new ThemeSyncStore(storage())
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  const revisionBefore = store.getSnapshot()
  const get = mock(async () => presetFor(mineDoc))
  await store.refreshLinkedPreset({ get })
  expect(store.getSnapshot()).toEqual(revisionBefore)
})

test('refreshLinkedPreset on 404 marks detached: presetId cleared, presetOwnerId + snapshot retained', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  const get = mock(async () => {
    throw new HttpResponseError(404, 'gone')
  })
  await store.refreshLinkedPreset({ get })
  expect(store.getSnapshot().presetId).toBeNull()
  expect(store.getSnapshot().presetOwnerId).toBe('owner-1')
  expect(store.getSnapshot().custom).toEqual(mineDoc) // the user keeps the last-seen copy
  expect(local.getItem('ficus-theme-preset-id')).toBeNull()
  expect(local.getItem('ficus-theme-preset-owner-id')).toBe('owner-1')
})

test('refreshLinkedPreset on a network/other error silently leaves state untouched (retried later, like account sync)', async () => {
  const store = new ThemeSyncStore(storage())
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  const before = store.getSnapshot()
  const get = mock(async () => {
    throw new Error('offline')
  })
  await store.refreshLinkedPreset({ get })
  expect(store.getSnapshot()).toEqual(before)
})

test('refreshLinkedPreset discards a stale in-flight result superseded by a newer deliberate change', async () => {
  const store = new ThemeSyncStore(storage())
  store.change({
    themeId: 'harbor',
    appearance: 'dark',
    presetId: 'p-1',
    presetOwnerId: 'owner-1',
    customTheme: mineDoc,
  })
  const response = (() => {
    let resolve!: (preset: ThemePreset) => void
    const promise = new Promise<ThemePreset>((r) => (resolve = r))
    return { promise, resolve }
  })()
  const get: ThemePresetLiveLinkApi['get'] = () => response.promise
  const pending = store.refreshLinkedPreset({ get })
  // A newer deliberate change happens while the fetch is in flight.
  store.change({ themeId: 'ember', appearance: 'system', presetId: null, presetOwnerId: null, customTheme: null })
  response.resolve(presetFor({ ...mineDoc, name: 'Late arrival' }))
  await pending
  // The stale response must not clobber the newer selection.
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(store.getSnapshot().presetId).toBeNull()
})
