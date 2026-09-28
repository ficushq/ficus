import { describe, expect, it } from 'bun:test'
import { apiUrl, instanceBasePath, webAppUrl, wsUrl } from './base'

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
