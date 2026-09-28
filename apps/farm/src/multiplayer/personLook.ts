import { hash, pick } from '../farm/appearance'

/** Everything that makes one person look like themselves on the farm. Stable per user id; each style draws it its own way. */
export interface PersonLook {
  skin: string
  hair: string
  shirt: string
  pants: string
  hat: 'straw' | 'cap' | 'beanie' | 'sunhat' | null
  hatColor: string
}

const SKINS = ['#f6d7bd', '#eec39f', '#d9a37a', '#b87c55', '#8d5a3b', '#f3cfb3'] as const
const HAIR = ['#3b2a20', '#6b4426', '#a8612e', '#e1b35c', '#2d2d3a', '#8a8a92'] as const
const SHIRTS = ['#e36c5a', '#5f9fd6', '#f2c14e', '#7cbf7a', '#b58ad6', '#f29bb4', '#4fb3a6'] as const
const PANTS = ['#4b5d7a', '#6b5a45', '#3f6b4f', '#5a4b7a'] as const
const HATS: readonly PersonLook['hat'][] = ['straw', 'cap', 'beanie', 'sunhat', null]

export function personLookFor(userId: string): PersonLook {
  const seed = (part: string) => hash(`person:${userId}:${part}`)
  return {
    skin: pick(SKINS, seed('skin')),
    hair: pick(HAIR, seed('hair')),
    shirt: pick(SHIRTS, seed('shirt')),
    pants: pick(PANTS, seed('pants')),
    hat: pick(HATS, seed('hat')),
    hatColor: pick(SHIRTS, seed('hat-color')),
  }
}
