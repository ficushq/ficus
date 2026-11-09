import { describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { getLocalDeploymentBrowserUrl } from './localDeploymentBrowserUrl'

describe('getLocalDeploymentBrowserUrl', () => {
  test('without a public address it uses the page origin and the runtime base path', async () => {
    const dom = await acquireDomHarness({
      url: 'http://h.local/ficus/squads/1',
      configureWindow: (w) =>
        w.document.head.insertAdjacentHTML('beforeend', '<meta name="ficus-base-path" content="/ficus/">'),
    })
    try {
      expect(getLocalDeploymentBrowserUrl('/api/app/abc/')).toBe('http://h.local/ficus/api/app/abc/')
      expect(getLocalDeploymentBrowserUrl('/api/app/abc/', 'https://pub.example.com/ficus')).toBe(
        'https://pub.example.com/ficus/api/app/abc/'
      )
    } finally {
      await dom.cleanup()
    }
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
