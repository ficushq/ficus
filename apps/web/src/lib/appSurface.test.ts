import { afterEach, describe, expect, test } from 'bun:test'
import { lastSurfaceKey } from '@ficus/shared/app-surface'
import { acquireDomHarness } from '../test/domHarness'
import { resumeLastApp } from './appSurface'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | null = null

async function open(url: string, options: { standalone?: boolean; online?: boolean } = {}) {
  dom = await acquireDomHarness({
    url,
    configureWindow: (window) => {
      const standalone = options.standalone ?? true
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({ matches: standalone && query === '(display-mode: standalone)' }),
      })
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: options.online ?? true })
    },
  })
  return dom
}

afterEach(async () => {
  await dom?.cleanup()
  dom = null
})

describe('resumeLastApp (web)', () => {
  test('an installed app launched at its start page reopens the farm it was left in', async () => {
    await open('http://localhost/', {})
    window.localStorage.setItem(lastSurfaceKey('web'), 'farm')
    const went: string[] = []
    expect(resumeLastApp('/', (url) => went.push(url))).toBe(true)
    expect(went).toEqual(['/farm/'])
  })

  test('keeps the instance base path', async () => {
    await open('http://localhost/ficus/')
    window.localStorage.setItem(lastSurfaceKey('web'), 'farm')
    const went: string[] = []
    resumeLastApp('/ficus/', (url) => went.push(url))
    expect(went).toEqual(['/ficus/farm/'])
  })

  test('stays and records itself otherwise', async () => {
    await open('http://localhost/')
    const went: string[] = []
    expect(resumeLastApp('/', (url) => went.push(url))).toBe(false)
    expect(went).toEqual([])
    expect(window.localStorage.getItem(lastSurfaceKey('web'))).toBe('web')
  })

  test('a browser tab never jumps', async () => {
    await open('http://localhost/', { standalone: false })
    window.localStorage.setItem(lastSurfaceKey('web'), 'farm')
    expect(resumeLastApp('/', () => {})).toBe(false)
  })

  test('offline, it opens here: the farm has no offline copy', async () => {
    await open('http://localhost/', { online: false })
    window.localStorage.setItem(lastSurfaceKey('web'), 'farm')
    expect(resumeLastApp('/', () => {})).toBe(false)
  })
})
