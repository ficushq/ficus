import { describe, expect, test } from 'bun:test'
import { renderPairing } from './pairingQr'

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
