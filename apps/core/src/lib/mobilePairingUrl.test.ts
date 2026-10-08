import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { buildMobilePairingServerUrl } from './mobilePairingUrl'

const originalEnv = {
  APP_BASE_PATH: process.env.APP_BASE_PATH,
  APP_URL: process.env.APP_URL,
  PUBLIC_URL: process.env.PUBLIC_URL,
}

beforeEach(() => {
  delete process.env.APP_URL
  delete process.env.PUBLIC_URL
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('buildMobilePairingServerUrl', () => {
  test('includes the configured app base path with the browser origin', () => {
    process.env.APP_BASE_PATH = '/tau'
    expect(
      buildMobilePairingServerUrl({
        requestUrl: 'http://localhost:3000/api/auth/pair/start',
        originHeader: 'https://home.example.com',
      })
    ).toBe('https://home.example.com/tau')
  })

  test('derives a base path from the request URL when no configured base path is present', () => {
    delete process.env.APP_BASE_PATH
    expect(buildMobilePairingServerUrl({ requestUrl: 'https://home.example.com/tau/api/auth/pair/start' })).toBe(
      'https://home.example.com/tau'
    )
  })

  test('prefers the configured public address over a localhost or LAN browser origin', () => {
    process.env.APP_BASE_PATH = '/ficus'
    process.env.APP_URL = 'https://home.example.com/ficus/'
    expect(
      buildMobilePairingServerUrl({
        requestUrl: 'http://192.168.1.20:62832/ficus/api/auth/pair/start',
        originHeader: 'http://192.168.1.20:62832',
      })
    ).toBe('https://home.example.com/ficus')
  })
})
