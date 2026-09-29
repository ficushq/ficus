import {
  FARM_CLOTHES_COLORS,
  FARM_HAIR_COLORS,
  FARM_HAIR_STYLES,
  FARM_HATS,
  FARM_PANTS,
  FARM_SHIRTS,
  FARM_SHOES,
  FARM_SKIN_TONES,
  type FarmLook,
} from '@ficus/shared'
import { hash, pick } from '../farm/appearance'

/*
 * How a person looks on the farm: what they chose in the character builder
 * (a farm setting, sent with their presence), else a look the farm picks for
 * them, stable per user id. Each style draws a FarmLook its own way.
 */

// The farm's picks stay everyday: natural hair colours, no piercings.
const NATURAL_HAIR = FARM_HAIR_COLORS.slice(0, 8)
const SHOE_COLORS = ['#5a3a24', '#6b5a45', '#4b4b55', '#f4efe6', '#8c3b22'] as const

/** The look the farm picks for someone who hasn't chosen one. */
export function defaultLookFor(userId: string): FarmLook {
  const seed = (part: string) => hash(`person:${userId}:${part}`)
  return {
    skin: pick(FARM_SKIN_TONES, seed('skin')),
    hair: pick(FARM_HAIR_STYLES.slice(1), seed('hair-style')),
    hairColor: pick(NATURAL_HAIR, seed('hair')),
    hat: pick(FARM_HATS, seed('hat')),
    hatColor: pick(FARM_CLOTHES_COLORS, seed('hat-color')),
    shirt: pick(FARM_SHIRTS, seed('shirt-style')),
    shirtColor: pick(FARM_CLOTHES_COLORS, seed('shirt')),
    pants: pick(FARM_PANTS, seed('pants-style')),
    pantsColor: pick(['#4b5d7a', '#6b5a45', '#3f8f5f', '#3d4a7a', '#4b4b55'], seed('pants')),
    shoes: pick(FARM_SHOES, seed('shoes-style')),
    shoesColor: pick(SHOE_COLORS, seed('shoes')),
    piercings: [],
  }
}

/** Someone's look: theirs if they chose one, else the farm's pick. */
export function lookFor(userId: string, chosen: FarmLook | null | undefined): FarmLook {
  return chosen ?? defaultLookFor(userId)
}

/** A colour mixed toward black (amount < 0) or white (amount > 0), -1…1. */
export function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const target = amount < 0 ? 0 : 255
  const t = Math.min(1, Math.abs(amount))
  const channel = (shift: number) => Math.round(((n >> shift) & 255) + (target - ((n >> shift) & 255)) * t)
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`
}
