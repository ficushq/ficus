import { expect, test } from 'bun:test'
import { createDesktopHistory, type HistoryEntry, type SessionNavigation } from './desktopHistory'

function fixture(saved?: string, blockedStorage = false) {
  let entries: HistoryEntry[] = []
  const navigation = Object.assign(new EventTarget(), {
    currentEntry: null as HistoryEntry | null,
    entries: () => entries,
  }) satisfies SessionNavigation
  const savedValues = new Map(saved ? [['ficus:desktop-history:/app/', saved]] : [])
  const calls: number[] = []
  const host = {
    location: { origin: 'https://ficus.test' },
    navigation,
    sessionStorage: {
      getItem: (key: string) => {
        if (blockedStorage) throw Error('blocked')
        return savedValues.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (blockedStorage) throw Error('blocked')
        savedValues.set(key, value)
      },
    },
    history: { go: (delta: number) => calls.push(delta) },
  } as unknown as Window
  const entry = (key: string, index: number, url = `https://ficus.test/app/${key}`, id = key) => ({
    key,
    id,
    index,
    url,
    sameDocument: true,
  })
  const change = (next: HistoryEntry[], current: HistoryEntry, type = 'push') => {
    entries = next
    navigation.currentEntry = current
    navigation.dispatchEvent(Object.assign(new Event('currententrychange'), { navigationType: type }))
  }
  const a = entry('a', 1)
  change([entry('unknown', 0), a], a)
  return { host, calls, savedValues, navigation, entry, change, a }
}

test('unknown adjacent entries are unreachable, including traversing in from outside the app', () => {
  const f = fixture()
  const store = createDesktopHistory(f.host, '/app/')
  expect(store.getSnapshot()).toEqual({ back: false, forward: false })
  store.go(-1)
  expect(f.calls).toEqual([])
  const b = f.entry('b', 2)
  f.change([f.a, b], b)
  expect(store.getSnapshot().back).toBe(true)
  const unknown = f.entry('unknown', 0)
  f.change([unknown, f.a, b], unknown, 'traverse')
  expect(store.getSnapshot()).toEqual({ back: false, forward: false })
  store.dispose()
})

test('checks origin, app base, index adjacency, and the identity of replaced documents', () => {
  const f = fixture()
  const store = createDesktopHistory(f.host, '/app/')
  const b = f.entry('b', 2)
  f.change([f.a, b], b)
  for (const predecessor of [
    f.entry('a', 1, 'https://other.test/app/a'),
    f.entry('a', 1, 'https://ficus.test/app-other/a'),
    f.entry('a', 0),
    f.entry('a', 1, undefined, 'replaced-by-unrelated-document'),
  ]) {
    f.change([predecessor, b], b, 'traverse')
    expect(store.getSnapshot().back).toBe(false)
    // Restore the observed app entry for the next independent case.
    f.change([f.a, b], f.a, 'replace')
    f.change([f.a, b], b, 'traverse')
  }
  store.dispose()
})

test('storage failure keeps current-document history usable and reload fails closed', () => {
  const f = fixture(undefined, true)
  const store = createDesktopHistory(f.host, '/app/')
  const b = f.entry('b', 2)
  f.change([f.a, b], b)
  expect(store.getSnapshot().back).toBe(true)
  store.dispose()
  const reloaded = createDesktopHistory(f.host, '/app/')
  expect(reloaded.getSnapshot().back).toBe(false)
  reloaded.dispose()
})

test('repeat navigation cannot overshoot bounds while traversal is pending', () => {
  const f = fixture()
  const store = createDesktopHistory(f.host, '/app/')
  const b = f.entry('b', 2)
  f.change([f.a, b], b)
  store.go(-1)
  store.go(-1)
  expect(f.calls).toEqual([-1])
  expect(store.getSnapshot()).toEqual({ back: false, forward: false })
  f.change([f.a, b], f.a, 'traverse')
  expect(store.getSnapshot()).toEqual({ back: false, forward: true })
  store.dispose()
})

test('missing Navigation API and corrupt storage safely disable unproven directions', () => {
  const f = fixture('{bad json')
  delete (f.host as Window & { navigation?: SessionNavigation }).navigation
  const store = createDesktopHistory(f.host, '/app/')
  expect(store.getSnapshot()).toEqual({ back: false, forward: false })
  store.go(-1)
  store.go(1)
  expect(f.calls).toEqual([])
  store.dispose()
})
