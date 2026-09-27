import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isBlockedWrite, resolveDevBackend } from './devProxy'

describe('garden dev backend', () => {
  it('defaults to local Core with cookies and writes allowed', () => {
    expect(resolveDevBackend({})).toEqual({ label: 'local', target: 'http://localhost:3000', writes: true })
  })

  it('uses a CLI-stored backend read-only unless writes are allowed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'garden-dev-'))
    try {
      const store = join(dir, 'auth.json')
      writeFileSync(
        store,
        JSON.stringify({ backends: { home: { apiUrl: 'https://home.example/ficus/', password: 'secret' } } })
      )
      const backend = resolveDevBackend({ FICUS_GARDEN_BACKEND: 'home', FICUS_DEV_AUTH_STORE_PATH: store })
      expect(backend).toEqual({ label: 'home', target: 'https://home.example/ficus', bearer: 'secret', writes: false })
      const loopback = resolveDevBackend({
        FICUS_GARDEN_BACKEND: 'home',
        FICUS_DEV_AUTH_STORE_PATH: store,
        FICUS_API_URL: 'http://127.0.0.1:9',
        FICUS_GARDEN_ALLOW_WRITES: '1',
      })
      expect(loopback.target).toBe('http://127.0.0.1:9')
      expect(loopback.writes).toBe(true)
      expect(() => resolveDevBackend({ FICUS_GARDEN_BACKEND: 'nope', FICUS_DEV_AUTH_STORE_PATH: store })).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('blocks every API write in read-only mode except the socket ticket', () => {
    const ro = { label: 'home', target: 'x', bearer: 't', writes: false }
    expect(isBlockedWrite(ro, 'GET', '/api/squads')).toBe(false)
    expect(isBlockedWrite(ro, 'POST', '/api/workstreams/1/waits/2/resolve')).toBe(true)
    expect(isBlockedWrite(ro, 'POST', '/api/agents/a/message')).toBe(true)
    expect(isBlockedWrite(ro, 'DELETE', '/api/agent-questions/q')).toBe(true)
    expect(isBlockedWrite(ro, 'POST', '/api/auth/ws-ticket')).toBe(false)
    expect(isBlockedWrite({ ...ro, writes: true }, 'POST', '/api/agents/a/message')).toBe(false)
  })
})
