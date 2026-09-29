import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { LAUNCHED_AS_KEY, lastSurfaceKey } from '@ficus/shared/app-surface'
import { resumeLastApp } from './appSurface'

// The preloaded happy-dom window sits at http://localhost/farm/.
const original = window.matchMedia

function installed(standalone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: standalone && query === '(display-mode: standalone)' }),
  })
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: original })
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('resumeLastApp (farm)', () => {
  it('an installed Farm app reopens the web app it was left in', () => {
    installed(true)
    window.localStorage.setItem(lastSurfaceKey('farm'), 'web')
    const went: string[] = []
    expect(resumeLastApp('/farm/', (url) => went.push(url))).toBe(true)
    expect(went).toEqual(['/'])
  })

  it('opens the farm, and records it, when it was left in the farm', () => {
    installed(true)
    const went: string[] = []
    expect(resumeLastApp('/farm/', (url) => went.push(url))).toBe(false)
    expect(went).toEqual([])
    expect(window.sessionStorage.getItem(LAUNCHED_AS_KEY)).toBe('farm')
    expect(window.localStorage.getItem(lastSurfaceKey('farm'))).toBe('farm')
  })

  it('switching in from the web app records the farm for the web app', () => {
    installed(true)
    window.sessionStorage.setItem(LAUNCHED_AS_KEY, 'web')
    window.localStorage.setItem(lastSurfaceKey('web'), 'web')
    expect(resumeLastApp('/farm/', () => {})).toBe(false)
    expect(window.localStorage.getItem(lastSurfaceKey('web'))).toBe('farm')
  })

  it('a browser tab never jumps', () => {
    installed(false)
    window.localStorage.setItem(lastSurfaceKey('farm'), 'web')
    expect(resumeLastApp('/farm/', () => {})).toBe(false)
  })
})
