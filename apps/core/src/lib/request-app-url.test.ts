import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { publicAppUrlForRequest } from './request-app-url'

const KEYS = [
  'APP_URL',
  'PUBLIC_URL',
  'FICUS_LOCAL_APP_URL',
  'FICUS_WEB_ORIGIN',
  'WEBAUTHN_ORIGIN',
  'APP_BASE_PATH',
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
beforeEach(() => {
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function ctx(url: string, headers: Record<string, string> = {}) {
  return { req: { url, header: (name: string) => headers[name.toLowerCase()] } }
}

describe('publicAppUrlForRequest', () => {
  test('uses the configured public address with its path, whatever the request', () => {
    process.env.APP_URL = 'https://h.example/ficus'
    expect(publicAppUrlForRequest(ctx('http://127.0.0.1:3000/api/x', { host: 'localhost:3000' }))).toBe(
      'https://h.example/ficus'
    )
  })

  test('without one, the request origin plus the base path the request used', () => {
    expect(publicAppUrlForRequest(ctx('http://h.example/api/x'))).toBe('http://h.example')
    process.env.APP_BASE_PATH = '/tau'
    expect(publicAppUrlForRequest(ctx('http://127.0.0.1:3000/api/x', { 'x-forwarded-host': 'h.example' }))).toBe(
      'https://h.example/tau'
    )
  })
})
