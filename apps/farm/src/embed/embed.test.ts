import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appToFarmMessage, parseFarmToAppMessage } from '@ficus/shared/farm-embed'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { embedTheme, exchangeHandoff, haptic, isEmbedded, resetEmbedForTests, startEmbed } from './embed'

let posted: string[] = []

function inWebView() {
  posted = []
  window.ReactNativeWebView = { postMessage: (message: string) => void posted.push(message) }
}

function send(data: string, target: EventTarget = window) {
  target.dispatchEvent(new window.MessageEvent('message', { data }) as unknown as Event)
}

const originalFetch = globalThis.fetch
let viewport: HTMLMetaElement

beforeEach(() => {
  viewport = document.createElement('meta')
  viewport.name = 'viewport'
  viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover'
  document.head.appendChild(viewport)
})

afterEach(() => {
  resetEmbedForTests()
  delete window.ReactNativeWebView
  delete window.__FICUS_EMBED__
  delete document.documentElement.dataset.embed
  viewport.remove()
  globalThis.fetch = originalFetch
})

describe('farm embed', () => {
  it('is a no-op in a browser', () => {
    expect(isEmbedded()).toBe(false)
    expect(startEmbed()).toEqual({ handoff: null })
    haptic('harvest')
    expect(document.documentElement.dataset.embed).toBeUndefined()
    expect(viewport.content).not.toContain('user-scalable')
  })

  it('in the app, marks the page, stops page zoom and takes the injected code once', () => {
    inWebView()
    window.__FICUS_EMBED__ = { v: 1, handoff: 'ficus_wh_abc', theme: { themeId: 'harbor', appearance: 'dark' } }
    expect(startEmbed()).toEqual({ handoff: 'ficus_wh_abc' })
    expect(document.documentElement.dataset.embed).toBe('native')
    expect(viewport.content).toContain('maximum-scale=1, user-scalable=no')
    expect(window.__FICUS_EMBED__).toBeUndefined()
    expect(embedTheme()).toEqual({ themeId: 'harbor', appearance: 'dark', customTheme: null })
  })

  it('reads Android bootstrap from the native injected object before page scripts', () => {
    inWebView()
    window.ReactNativeWebView!.injectedObjectJson = () =>
      JSON.stringify({ v: 1, theme: { themeId: 'harbor', appearance: 'dark' } })
    expect(startEmbed()).toEqual({ handoff: null })
    expect(embedTheme()).toEqual({ themeId: 'harbor', appearance: 'dark', customTheme: null })
  })
  it('ignores malformed Android bootstrap data', () => {
    inWebView()
    window.ReactNativeWebView!.injectedObjectJson = () => '{'
    expect(startEmbed()).toEqual({ handoff: null })
    expect(embedTheme()).toBeNull()
  })

  it('follows theme messages from the app, on window or document', () => {
    inWebView()
    startEmbed()
    send(appToFarmMessage({ type: 'theme', theme: { themeId: 'iris', appearance: 'light', customTheme: null } }))
    expect(embedTheme()?.themeId).toBe('iris')
    send(
      appToFarmMessage({ type: 'theme', theme: { themeId: 'ember', appearance: 'system', customTheme: null } }),
      document
    )
    expect(embedTheme()?.themeId).toBe('ember')
    send(JSON.stringify({ source: 'someone-else', v: 1, type: 'theme', theme: { themeId: 'x', appearance: 'dark' } }))
    expect(embedTheme()?.themeId).toBe('ember')
  })

  it('ignores messages posted by a frame or the page, not the app', () => {
    inWebView()
    startEmbed()
    const theme = appToFarmMessage({
      type: 'theme',
      theme: { themeId: 'iris', appearance: 'light', customTheme: null },
    })
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    window.dispatchEvent(
      new window.MessageEvent('message', { data: theme, source: frame.contentWindow as never }) as unknown as Event
    )
    window.dispatchEvent(
      new window.MessageEvent('message', { data: theme, source: window as never }) as unknown as Event
    )
    expect(embedTheme()).toBeNull()
    frame.remove()
    send(theme)
    expect(embedTheme()?.themeId).toBe('iris')
  })

  it('posts haptics to the app in the versioned envelope', () => {
    inWebView()
    haptic('wave')
    expect(posted.map((message) => parseFarmToAppMessage(message))).toEqual([{ type: 'haptic', kind: 'wave' }])
    expect(JSON.parse(posted[0]!)).toMatchObject({ source: 'ficus-farm', v: 1 })
  })

  it('trades a code with the CSRF header and credentials, the code only in the body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    expect(await exchangeHandoff('ficus_wh_abc')).toBe(true)
    const [{ url, init }] = calls
    expect(url).toEndWith('/api/auth/web-handoff/exchange')
    expect(url).not.toContain('ficus_wh_abc')
    expect(init.credentials).toBe('include')
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('1')
    expect(JSON.parse(String(init.body))).toEqual({ code: 'ficus_wh_abc' })

    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect(await exchangeHandoff('ficus_wh_used')).toBe(false)
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await exchangeHandoff('ficus_wh_offline')).toBe(false)
  })
})
