import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'ChannelsSection.tsx'), 'utf8')

describe('ChannelsSection template revert refresh', () => {
  test('syncs expanded row form state when refreshed channel data arrives', () => {
    // Re-seeded while rendering when the channel object changes.
    expect(source.includes('useAdjustOnChange([channel], () => {')).toBe(true)
    expect(source.includes('setForm(channelToForm(channel))')).toBe(true)
  })
})
