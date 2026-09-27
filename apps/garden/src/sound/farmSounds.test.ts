import { describe, expect, it } from 'bun:test'
import { chimeFor } from './farmSounds'
import { readSoundPreference, writeSoundPreference } from './chimes'

const t = (badges: number, plots: number, harvested: number) => ({ badges, plots, harvested })

describe('farm sounds', () => {
  it('stays quiet on the first snapshot and when nothing grew', () => {
    expect(chimeFor(null, t(3, 5, 1))).toBeNull()
    expect(chimeFor(t(3, 5, 1), t(2, 5, 1))).toBeNull()
  })

  it('prefers "needs you" over harvests over plantings', () => {
    expect(chimeFor(t(1, 5, 1), t(2, 6, 2))).toBe('needsYou')
    expect(chimeFor(t(1, 5, 1), t(1, 6, 2))).toBe('harvested')
    expect(chimeFor(t(1, 5, 1), t(1, 6, 1))).toBe('planted')
  })

  it('is off unless turned on, and remembers the choice', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    expect(readSoundPreference(storage)).toBe(false)
    writeSoundPreference(true, storage)
    expect(readSoundPreference(storage)).toBe(true)
    expect([...store.keys()]).toEqual(['ficus-garden:sound'])
  })
})
