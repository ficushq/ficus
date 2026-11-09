import { describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { scheduleWebhookUrl } from './scheduleWebhookUrl'

describe('scheduleWebhookUrl', () => {
  test('uses the runtime base path when no public address is configured', async () => {
    const dom = await acquireDomHarness({
      url: 'http://h.local/ficus/schedules',
      configureWindow: (w) =>
        w.document.head.insertAdjacentHTML('beforeend', '<meta name="ficus-base-path" content="/ficus/">'),
    })
    try {
      expect(scheduleWebhookUrl('s1')).toBe('http://h.local/ficus/api/webhooks/trigger/s1')
      expect(scheduleWebhookUrl('s1', null)).toBe('http://h.local/ficus/api/webhooks/trigger/s1')
    } finally {
      await dom.cleanup()
    }
  })

  test('prefers the public address, which carries its own path', () => {
    expect(scheduleWebhookUrl('s1', 'https://team.example.com/ficus')).toBe(
      'https://team.example.com/ficus/api/webhooks/trigger/s1'
    )
    expect(scheduleWebhookUrl('s1', 'https://team.example.com/')).toBe(
      'https://team.example.com/api/webhooks/trigger/s1'
    )
  })
})
