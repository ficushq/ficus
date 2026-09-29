import { describe, expect, it } from 'bun:test'
import { LAUNCHED_AS_KEY, lastSurfaceKey, resumeSurface, type AppSurface, type SurfaceStore } from './app-surface'

function store(): SurfaceStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
}

/** One page load in a window. */
function load(
  current: AppSurface,
  window: { session: SurfaceStore },
  local: SurfaceStore,
  options: { atStartUrl?: boolean; standalone?: boolean } = {}
) {
  return resumeSurface({
    current,
    standalone: options.standalone ?? true,
    atStartUrl: options.atStartUrl ?? true,
    session: window.session,
    local,
  })
}

describe('resumeSurface', () => {
  it('reopens the installed web app in the farm when it was left there', () => {
    const local = store()
    const first = { session: store() }
    expect(load('web', first, local)).toBeNull()
    expect(load('farm', first, local, { atStartUrl: false })).toBeNull() // tapped the farm icon

    const relaunch = { session: store() }
    expect(load('web', relaunch, local)).toBe('farm')
    // The farm then loads in the same window and records itself.
    expect(load('farm', relaunch, local)).toBeNull()
    expect(local.data.get(lastSurfaceKey('web'))).toBe('farm')
  })

  it('reopens where it is after switching back', () => {
    const local = store()
    const window = { session: store() }
    load('web', window, local)
    load('farm', window, local)
    load('web', window, local) // "Open Ficus" in the farmhouse, back at the web start page
    expect(load('web', { session: store() }, local)).toBeNull()
  })

  it('keeps each installed app separate when they share localStorage', () => {
    const local = store()
    const webApp = { session: store() }
    load('web', webApp, local)
    load('farm', webApp, local)

    // The Farm app, left in the farm, still opens to the farm, and its own switch is its own.
    const farmApp = { session: store() }
    expect(load('farm', farmApp, local)).toBeNull()
    load('web', farmApp, local, { atStartUrl: false })
    expect(load('farm', { session: store() }, local)).toBe('web')
    expect(load('web', { session: store() }, local)).toBe('farm')
  })

  it('does not switch on a reload or an in-window visit to the start page', () => {
    const local = store()
    local.setItem(lastSurfaceKey('web'), 'farm')
    const window = { session: store() }
    window.session.setItem(LAUNCHED_AS_KEY, 'web')
    expect(load('web', window, local)).toBeNull()
    expect(local.data.get(lastSurfaceKey('web'))).toBe('web')
  })

  it('does not redirect a deep-link launch, but records it', () => {
    const local = store()
    local.setItem(lastSurfaceKey('web'), 'farm')
    expect(load('web', { session: store() }, local, { atStartUrl: false })).toBeNull()
    expect(local.data.get(lastSurfaceKey('web'))).toBe('web')
  })

  it('leaves browser tabs alone', () => {
    const local = store()
    local.setItem(lastSurfaceKey('web'), 'farm')
    const tab = { session: store() }
    expect(load('web', tab, local, { standalone: false })).toBeNull()
    expect(load('farm', tab, local, { standalone: false })).toBeNull()
    expect(local.data.get(lastSurfaceKey('web'))).toBe('farm')
    expect(tab.session.getItem(LAUNCHED_AS_KEY)).toBeNull()
  })

  it('ignores junk in storage', () => {
    const local = store()
    local.setItem(lastSurfaceKey('web'), 'docs')
    expect(load('web', { session: store() }, local)).toBeNull()
  })
})
