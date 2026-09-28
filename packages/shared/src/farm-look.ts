/**
 * How someone looks on the farm, as they chose it in the character builder:
 * a hat, hair (or none), clothes and shoes each with a colour, piercings and a
 * skin tone. It's one of their farm settings (farm-preferences.ts), and Core
 * sends it with their presence so everyone sees them as they dressed. Each
 * visual style draws it its own way (the line styles by shape, not colour).
 *
 * Colours are any `#rrggbb`; the palettes here are what the builder offers.
 */

export const FARM_HAIR_STYLES = [
  'bald',
  'buzz',
  'short',
  'swept',
  'curly',
  'afro',
  'long',
  'ponytail',
  'bun',
  'mohawk',
] as const
export const FARM_HATS = ['none', 'straw', 'cap', 'beanie', 'sunhat', 'cowboy', 'bucket'] as const
export const FARM_SHIRTS = ['tee', 'tank', 'longsleeve', 'hoodie', 'flannel'] as const
export const FARM_PANTS = ['long', 'shorts', 'skirt', 'overalls'] as const
export const FARM_SHOES = ['boots', 'sneakers', 'sandals', 'clogs'] as const
export const FARM_PIERCINGS = ['ears', 'nose', 'eyebrow', 'lip'] as const

export type FarmHairStyle = (typeof FARM_HAIR_STYLES)[number]
export type FarmHat = (typeof FARM_HATS)[number]
export type FarmShirt = (typeof FARM_SHIRTS)[number]
export type FarmPants = (typeof FARM_PANTS)[number]
export type FarmShoes = (typeof FARM_SHOES)[number]
export type FarmPiercing = (typeof FARM_PIERCINGS)[number]

export const FARM_SKIN_TONES = [
  '#fbe3d0',
  '#f6d7bd',
  '#eec39f',
  '#d9a37a',
  '#c68a5f',
  '#a86f4a',
  '#8d5a3b',
  '#5e3a26',
] as const
export const FARM_HAIR_COLORS = [
  '#2a211c',
  '#3b2a20',
  '#6b4426',
  '#8c3b22',
  '#c8642e',
  '#e1b35c',
  '#efe3bf',
  '#9a9aa2',
  '#f29bb4',
  '#5f8fd6',
  '#5fae7a',
  '#8e6bc4',
] as const
export const FARM_CLOTHES_COLORS = [
  '#e36c5a',
  '#f29e4c',
  '#f2c14e',
  '#7cbf7a',
  '#3f8f5f',
  '#4fb3a6',
  '#5f9fd6',
  '#4b5d7a',
  '#3d4a7a',
  '#b58ad6',
  '#f29bb4',
  '#f4efe6',
  '#8a8a92',
  '#4b4b55',
  '#6b5a45',
  '#5a3a24',
] as const

export interface FarmLook {
  skin: string
  hair: FarmHairStyle
  hairColor: string
  hat: FarmHat
  hatColor: string
  shirt: FarmShirt
  shirtColor: string
  pants: FarmPants
  pantsColor: string
  shoes: FarmShoes
  shoesColor: string
  /** Which piercings they wear, each at most once. */
  piercings: FarmPiercing[]
}

const COLOR = /^#[0-9a-f]{6}$/i
const COLOR_KEYS = ['skin', 'hairColor', 'hatColor', 'shirtColor', 'pantsColor', 'shoesColor'] as const
const CHOICES = {
  hair: FARM_HAIR_STYLES,
  hat: FARM_HATS,
  shirt: FARM_SHIRTS,
  pants: FARM_PANTS,
  shoes: FARM_SHOES,
} as const
const KEYS = new Set<string>([...COLOR_KEYS, ...Object.keys(CHOICES), 'piercings'])

/** A complete look, exactly: every part, each a known choice or a `#rrggbb` colour, and nothing else. */
export function isFarmLook(value: unknown): value is FarmLook {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const look = value as Record<string, unknown>
  if (Object.keys(look).some((key) => !KEYS.has(key))) return false
  for (const key of COLOR_KEYS) if (typeof look[key] !== 'string' || !COLOR.test(look[key] as string)) return false
  for (const [key, options] of Object.entries(CHOICES))
    if (!(options as readonly unknown[]).includes(look[key])) return false
  const piercings = look.piercings
  return (
    Array.isArray(piercings) &&
    piercings.every((p) => (FARM_PIERCINGS as readonly unknown[]).includes(p)) &&
    new Set(piercings).size === piercings.length
  )
}
