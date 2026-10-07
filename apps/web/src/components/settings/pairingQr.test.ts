import { describe, expect, test } from 'bun:test'
import { canOpenFicusApp, renderPairing } from './pairingQr'
import { acquireDomHarness } from '../../test/domHarness'

describe('renderPairing', () => {
  test('emits a ficus://pair deep link carrying the server URL and code', async () => {
    const pairing = await renderPairing({
      code: 'abc123',
      serverUrl: 'https://example.ficus.sh',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(pairing.deepLink).toStartWith('ficus://pair?url=')
    expect(pairing.deepLink).toBe(
      `ficus://pair?url=${encodeURIComponent('https://example.ficus.sh')}&code=${encodeURIComponent('abc123')}`
    )
    expect(pairing.dataUrl).toStartWith('data:image/png;base64,')
  })
})

describe('canOpenFicusApp', () => {
  for (const [label, touch, expected] of [
    ['a wide desktop viewport', false, false],
    ['a narrow or touch viewport', true, true],
  ] as const) {
    test(`offers the same-phone deep link on ${label}: ${expected}`, async () => {
      const dom = await acquireDomHarness({
        url: 'https://ficus.example.com/',
        configureWindow(window) {
          ;(window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
            matches: touch && query.includes('max-width: 639px') && query.includes('pointer: coarse'),
            media: query,
          })
        },
      })
      try {
        expect(canOpenFicusApp()).toBe(expected)
      } finally {
        await dom.cleanup()
      }
    })
  }
})
