import { describe, expect, it } from 'bun:test'
import { openBrowser } from './open-browser'

describe('openBrowser', () => {
  it('passes the URL as a separate process argument', async () => {
    let command: string[] = []
    expect(
      await openBrowser('https://ficus.test/a?b=c', {
        platform: 'linux',
        spawn: async (args) => {
          command = args
          return true
        },
      })
    ).toBe(true)
    expect(command).toEqual(['xdg-open', 'https://ficus.test/a?b=c'])
  })
})
