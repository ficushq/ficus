import { describe, expect, it } from 'bun:test'
import { apiUrl, instanceBasePath, webAppUrl, wsUrl } from './base'

describe('garden paths', () => {
  it('puts the API at the instance root, not under /garden', () => {
    expect(apiUrl('/squads', 'https://acme.example', '/garden/')).toBe('https://acme.example/api/squads')
  })

  it('keeps an APP_BASE_PATH prefix', () => {
    expect(instanceBasePath('/ficus/garden/')).toBe('/ficus')
    expect(apiUrl('/squads', 'https://acme.example', '/ficus/garden/')).toBe('https://acme.example/ficus/api/squads')
    expect(webAppUrl('/', '/ficus/garden/')).toBe('/ficus/')
  })

  it('switches the socket to ws(s)', () => {
    expect(wsUrl('/ws', 'https://acme.example', '/garden/')).toBe('wss://acme.example/ws')
    expect(wsUrl('/ws', 'http://localhost:5174', '/garden/')).toBe('ws://localhost:5174/ws')
  })

  it('links back to the web app root', () => {
    expect(webAppUrl('/', '/garden/')).toBe('/')
    expect(webAppUrl('settings', '/garden/')).toBe('/settings')
  })
})
