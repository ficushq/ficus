/**
 * Tiny synthesized chimes (Web Audio, no asset files). Off unless the player
 * turns sound on; the choice is remembered in this browser under the farm's
 * own prefix, and on the account (see useFarmSounds.ts).
 */
export type Chime = 'needsYou' | 'planted' | 'harvested'

const STORAGE_KEY = 'ficus-farm:sound'

const NOTES: Record<Chime, Array<[freq: number, at: number, length: number]>> = {
  // A gentle two-note "ding-dong" when something new needs you.
  needsYou: [
    [880, 0, 0.18],
    [660, 0.16, 0.26],
  ],
  // A soft rising pop for a new plant.
  planted: [
    [392, 0, 0.1],
    [587, 0.08, 0.16],
  ],
  // A little major arpeggio for a harvest.
  harvested: [
    [523, 0, 0.12],
    [659, 0.1, 0.12],
    [784, 0.2, 0.24],
  ],
}

export function readSoundPreference(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  return storage?.getItem(STORAGE_KEY) === 'on'
}

export function writeSoundPreference(on: boolean, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // Storage unavailable: the toggle still works for this visit.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

let context: AudioContext | null = null

export function playChime(chime: Chime) {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return
  context ??= new AudioContext()
  const ctx = context
  if (ctx.state === 'suspended') void ctx.resume()
  const start = ctx.currentTime + 0.01
  for (const [freq, at, length] of NOTES[chime]) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, start + at)
    gain.gain.linearRampToValueAtTime(0.08, start + at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start + at)
    osc.stop(start + at + length + 0.02)
  }
}
