import type { FarmHairStyle, FarmHat, FarmLook, FarmPiercing } from '@ficus/shared'

/*
 * The head-side parts of a person, shared by every style: hair, hats and
 * piercings as paths around a unit head (centre 0,0, radius 10, facing +x).
 * A style draws them inside `translate(0 headY) scale(headR / 10)` and paints
 * each piece its own way (flat colour and ink, bubbly shading, lines, pencil).
 */

/** A circle as a path, so a pen can redraw it. */
export function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
}

const SMOOTH_CAP = 'M-10.4 0 Q-10.8 -11.4 0 -11.4 Q10.8 -11.4 10.4 0 Q8.5 -6.5 0 -7 Q-8.5 -6.5 -10.4 0 Z'
const CURLS =
  'M-11.5 1 A3 3 0 0 1 -10.5 -5 A3.2 3.2 0 0 1 -7.5 -10 A3.4 3.4 0 0 1 -2.5 -12.4 A3.4 3.4 0 0 1 2.5 -12.4 A3.4 3.4 0 0 1 7.5 -10 A3.2 3.2 0 0 1 10.5 -5 A3 3 0 0 1 11.5 1 Q8 -5 0 -5.6 Q-8 -5 -11.5 1 Z'

/** Hair behind the head (drawn before it) and over it (after the face). */
export const HAIR: Record<FarmHairStyle, { back?: string; front?: string }> = {
  bald: {},
  buzz: { front: 'M-10 -1.5 Q-10.2 -10.6 0 -10.6 Q10.2 -10.6 10 -1.5 Q7 -7.8 0 -8.2 Q-7 -7.8 -10 -1.5 Z' },
  short: {
    front: 'M-10.4 1 Q-10.9 -11.6 0 -11.6 Q10.9 -11.6 10.4 1 Q9 -4.5 4 -5.2 Q0 -3.2 -4.5 -5.6 Q-9 -4 -10.4 1 Z',
  },
  swept: { front: 'M-10.6 2 Q-11.2 -11.8 0 -11.8 Q11.2 -11.8 10.6 1 Q9.8 -5.6 5.5 -6.2 Q-1 -7.5 -10.6 2 Z' },
  curly: { front: CURLS },
  afro: { back: circle(0, -3.5, 13.8), front: CURLS },
  long: {
    back: 'M-10.8 -1 Q-12.2 -12.4 0 -12.4 Q12.2 -12.4 10.8 -1 L11.8 15 Q6 17 0 16 Q-6 17 -11.8 15 Z',
    front: 'M-10.6 3 Q-11.2 -11.8 0 -11.8 Q11.2 -11.8 10.6 3 Q9.6 -5 1 -6.5 L0 -5 L-1 -6.5 Q-9.6 -5 -10.6 3 Z',
  },
  ponytail: { back: 'M-8 -6 Q-17 -6 -16 6 Q-15.5 12 -12.5 13 Q-13.5 6 -9 1 Z', front: SMOOTH_CAP },
  bun: { back: circle(0, -12.8, 4.6), front: SMOOTH_CAP },
  mohawk: { front: 'M-2.6 -9.6 Q-4 -14 -2.8 -17.5 Q0 -19.5 2.8 -17.5 Q4 -14 2.6 -9.6 Z' },
}

/** Whether a hairstyle shows at all under a hat (a mohawk doesn't). */
export function hairUnderHat(look: FarmLook): { back?: string; front?: string } {
  if (look.hat !== 'none' && look.hair === 'mohawk') return {}
  return HAIR[look.hair]
}

/**
 * How each piece of a hat is painted: `hat` its chosen colour, `straw` woven
 * straw, `band` a darker band of the hat colour, `trim` a lighter one, and
 * `flower` a little flower. `line` pieces are strokes, the rest are shapes.
 */
export type HatPaint = 'hat' | 'straw' | 'band' | 'trim' | 'flower'
export interface HatPiece {
  d: string
  paint: HatPaint
  line?: boolean
}

export const HATS: Record<Exclude<FarmHat, 'none'>, HatPiece[]> = {
  straw: [
    { d: 'M-15.5 -7 A15.5 3.8 0 1 0 15.5 -7 A15.5 3.8 0 1 0 -15.5 -7 Z', paint: 'straw' },
    { d: 'M-7.5 -7 Q-7.5 -15.5 0 -15.5 Q7.5 -15.5 7.5 -7 Z', paint: 'straw' },
    { d: 'M-7.3 -9.4 H7.3', paint: 'hat', line: true },
  ],
  sunhat: [
    { d: 'M-16.5 -6 A16.5 4.6 0 1 0 16.5 -6 A16.5 4.6 0 1 0 -16.5 -6 Z', paint: 'hat' },
    { d: 'M-7 -6 Q-7 -13.5 0 -13.5 Q7 -13.5 7 -6 Z', paint: 'hat' },
    { d: circle(5.5, -9, 2.2), paint: 'flower' },
  ],
  cap: [
    { d: 'M-10 -3 Q-10 -12.8 0 -12.8 Q10 -12.8 10 -3 Z', paint: 'hat' },
    { d: 'M8.5 -4.2 Q17 -4.4 18.2 -1.6 H8.5 Z', paint: 'band' },
    { d: circle(0, -12.8, 1), paint: 'band' },
  ],
  beanie: [
    { d: 'M-10 -2 Q-10 -14 0 -14 Q10 -14 10 -2 Z', paint: 'hat' },
    { d: roundRect(-11, -4.8, 22, 4.8, 2.4), paint: 'trim' },
    { d: circle(0, -14.6, 3), paint: 'trim' },
  ],
  cowboy: [
    { d: 'M-7.5 -6 L-8.5 -15 Q-4.5 -17.5 0 -14.8 Q4.5 -17.5 8.5 -15 L7.5 -6 Z', paint: 'hat' },
    { d: 'M-17.5 -9.5 Q-15 -3.5 0 -4 Q15 -3.5 17.5 -9.5 Q13 -6.5 0 -7.2 Q-13 -6.5 -17.5 -9.5 Z', paint: 'hat' },
    { d: 'M-7.8 -8.6 H7.8', paint: 'band', line: true },
  ],
  bucket: [
    { d: 'M-8.5 -5.5 Q-8.8 -13.5 0 -13.5 Q8.8 -13.5 8.5 -5.5 Z', paint: 'hat' },
    { d: 'M-9 -6.5 L-13.5 -1.5 Q0 1 13.5 -1.5 L9 -6.5 Z', paint: 'band' },
  ],
}

/** Piercings on the face (drawn head-on): studs are dots, rings are small hoops. */
export const PIERCINGS: Record<FarmPiercing, Array<{ d: string; ring: boolean }>> = {
  ears: [
    { d: circle(-10.2, 3.8, 1.7), ring: true },
    { d: circle(10.2, 3.8, 1.7), ring: true },
  ],
  nose: [{ d: circle(1.4, 3.2, 1), ring: false }],
  eyebrow: [
    { d: circle(2.5, -2.9, 0.7), ring: false },
    { d: circle(4.4, -2.1, 0.7), ring: false },
  ],
  lip: [{ d: circle(1.6, 6.7, 1.2), ring: true }],
}

export const METAL = '#d8dbe3'
export const STRAW = '#e9c46a'
