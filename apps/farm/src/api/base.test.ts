import { describe, expect, it } from 'bun:test'
import { Window } from 'happy-dom'
import { apiUrl, farmBasePath, instanceBasePath, runtimeInstanceBasePath, webAppUrl, wsUrl } from './base'

describe('farm paths', () => {
  it('puts the API at the instance root, not under /farm', () => {
    expect(apiUrl('/squads', 'https://acme.example', '/farm/')).toBe('https://acme.example/api/squads')
  })

  it('keeps an APP_BASE_PATH prefix', () => {
    expect(instanceBasePath('/ficus/farm/')).toBe('/ficus')
    expect(apiUrl('/squads', 'https://acme.example', '/ficus/farm/')).toBe('https://acme.example/ficus/api/squads')
    expect(webAppUrl('/', '/ficus/farm/')).toBe('/ficus/')
  })

  it('switches the socket to ws(s)', () => {
    expect(wsUrl('/ws', 'https://acme.example', '/farm/')).toBe('wss://acme.example/ws')
    expect(wsUrl('/ws', 'http://localhost:5174', '/farm/')).toBe('ws://localhost:5174/ws')
  })

  it('links back to the web app root', () => {
    expect(webAppUrl('/', '/farm/')).toBe('/')
    expect(webAppUrl('settings', '/farm/')).toBe('/settings')
  })
})

describe('runtime base path', () => {
  function docWith(content: string | null): Document {
    const window = new Window()
    if (content !== null) window.document.head.innerHTML = `<meta name="ficus-base-path" content="${content}">`
    return window.document as unknown as Document
  }

  it('reads the instance base Core rendered', () => {
    expect(runtimeInstanceBasePath(docWith('/ficus/'))).toBe('/ficus')
    expect(runtimeInstanceBasePath(docWith('/'))).toBe('')
  })

  it('ignores an unrendered placeholder, a missing meta and unsafe values', () => {
    for (const content of ['__FICUS_BASE_PATH__', null, '//evil.example/', 'ficus', '/a b']) {
      expect(runtimeInstanceBasePath(docWith(content))).toBeNull()
    }
  })

  it('falls back to the build-time base without a document', () => {
    expect(instanceBasePath()).toBe('')
    expect(farmBasePath()).toBe('/farm/')
  })

  it('prefers the rendered meta over the build-time base', () => {
    const previous = globalThis.document
    globalThis.document = docWith('/ficus/')
    try {
      expect(instanceBasePath()).toBe('/ficus')
      expect(farmBasePath()).toBe('/ficus/farm/')
      expect(apiUrl('/squads', 'https://acme.example')).toBe('https://acme.example/ficus/api/squads')
      expect(webAppUrl('/')).toBe('/ficus/')
    } finally {
      globalThis.document = previous
    }
  })
})
