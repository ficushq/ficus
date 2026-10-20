import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getLocalDeploymentBrowserUrl } from './localDeploymentBrowserUrl'

const globals = globalThis as { __FICUS_APP_BASE_PATH__?: string }

describe('getLocalDeploymentBrowserUrl', () => {
  beforeEach(() => {
    globals.__FICUS_APP_BASE_PATH__ = ''
  })
  afterEach(() => {
    delete globals.__FICUS_APP_BASE_PATH__
  })

  test('resolves a path against the server public address from runtime config', () => {
    expect(getLocalDeploymentBrowserUrl('/api/app/abc/', 'https://pub.example.com')).toBe(
      'https://pub.example.com/api/app/abc/'
    )
    expect(getLocalDeploymentBrowserUrl('api/app/abc/', 'https://pub.example.com/ficus')).toBe(
      'https://pub.example.com/ficus/api/app/abc/'
    )
  })

  test('keeps absolute hosted URLs unchanged', () => {
    expect(getLocalDeploymentBrowserUrl('https://app.apps.example.com/', 'https://pub.example.com')).toBe(
      'https://app.apps.example.com/'
    )
  })
})
