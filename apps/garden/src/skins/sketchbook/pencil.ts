import { hash } from '../../farm/appearance'

/*
 * Pencil: redraws an exact SVG path the way a hand would, twice over, with
 * lines that bow a little and ends that don't quite meet. It's deterministic
 * (seeded by the path itself), so a sprite looks the same every render, and
 * it's plain geometry, so panning and zooming cost nothing extra.
 */

type Pt = [number, number]

/** A path as absolute segments; H/V become L and relative commands are resolved. */
export type Segment =
  | { c: 'M' | 'L'; p: Pt }
  | { c: 'Q'; q: Pt; p: Pt }
  | { c: 'C'; q: Pt; r: Pt; p: Pt }
  | { c: 'A'; rx: number; ry: number; rot: number; large: number; sweep: number; p: Pt }
  | { c: 'Z' }

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Q: 4, T: 2, C: 6, S: 4, A: 7, Z: 0 }

/** Parses the path grammar the sprites use: M L H V Q C A Z, absolute or relative. */
export function parse(d: string): Segment[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  const out: Segment[] = []
  let cur: Pt = [0, 0]
  let start: Pt = [0, 0]
  let k = 0
  let cmd = ''
  const num = () => Number(tokens[k++])
  while (k < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[k]!)) cmd = tokens[k++]!
    else if (!cmd) break
    const upper = cmd.toUpperCase()
    const rel = cmd !== upper
    if (!(upper in ARITY)) break
    if (upper === 'Z') {
      out.push({ c: 'Z' })
      cur = [...start]
      continue
    }
    const at = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y])
    switch (upper) {
      case 'M': {
        cur = at(num(), num())
        start = [...cur]
        out.push({ c: 'M', p: cur })
        // Further pairs after a move are lines.
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
        cur = at(num(), num())
        out.push({ c: 'L', p: cur })
        break
      case 'H': {
        const x = num()
        cur = [rel ? cur[0] + x : x, cur[1]]
        out.push({ c: 'L', p: cur })
        break
      }
      case 'V': {
        const y = num()
        cur = [cur[0], rel ? cur[1] + y : y]
        out.push({ c: 'L', p: cur })
        break
      }
      case 'Q': {
        const q = at(num(), num())
        cur = at(num(), num())
        out.push({ c: 'Q', q, p: cur })
        break
      }
      case 'C': {
        const q = at(num(), num())
        const r = at(num(), num())
        cur = at(num(), num())
        out.push({ c: 'C', q, r, p: cur })
        break
      }
      case 'A': {
        const [rx, ry, rot, large, sweep] = [num(), num(), num(), num(), num()]
        cur = at(num(), num())
        out.push({ c: 'A', rx, ry, rot, large, sweep, p: cur })
        break
      }
      default:
        // T and S aren't used by any sprite; skip their numbers rather than misread them.
        k += ARITY[upper]!
    }
  }
  return out
}

/** A small seeded generator (mulberry32), so every path wobbles its own way, the same way each time. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const f = (n: number) => (Math.round(n * 10) / 10).toString()
const pt = (p: Pt) => `${f(p[0])} ${f(p[1])}`

/** One pass of the pencil over the segments. */
function pass(segments: Segment[], rand: () => number, shift: Pt): string {
  const wobble = (amount: number) => (rand() * 2 - 1) * amount
  const nudge = (p: Pt, amount: number): Pt => [p[0] + shift[0] + wobble(amount), p[1] + shift[1] + wobble(amount)]
  let cur: Pt = [0, 0]
  let start: Pt = [0, 0]
  let out = ''
  // How far a curve's points may stray: half a pixel, less for tiny curves.
  const steady = (to: Pt) => Math.min(0.5, Math.hypot(to[0] - cur[0], to[1] - cur[1]) * 0.06)
  const line = (to: Pt) => {
    const len = Math.hypot(to[0] - cur[0], to[1] - cur[1])
    // Short strokes (eyes, rivets) stay steady; long ones bow up to a pixel and a half.
    const bow = wobble(Math.min(1.5, len * 0.035))
    const [nx, ny] = len ? [-(to[1] - cur[1]) / len, (to[0] - cur[0]) / len] : [0, 0]
    const mid: Pt = [(cur[0] + to[0]) / 2 + nx * bow + shift[0], (cur[1] + to[1]) / 2 + ny * bow + shift[1]]
    out += `Q${pt(mid)} ${pt(nudge(to, Math.min(0.6, len * 0.06)))} `
    cur = to
  }
  for (const s of segments) {
    switch (s.c) {
      case 'M':
        out += `M${pt(nudge(s.p, 0.3))} `
        cur = s.p
        start = s.p
        break
      case 'L':
        line(s.p)
        break
      case 'Q': {
        const k = steady(s.p)
        out += `Q${pt(nudge(s.q, 1.6 * k))} ${pt(nudge(s.p, k))} `
        cur = s.p
        break
      }
      case 'C': {
        const k = steady(s.p)
        out += `C${pt(nudge(s.q, 1.6 * k))} ${pt(nudge(s.r, 1.6 * k))} ${pt(nudge(s.p, k))} `
        cur = s.p
        break
      }
      case 'A': {
        const k = Math.min(0.5, Math.min(s.rx, s.ry) * 0.12)
        out += `A${f(s.rx)} ${f(s.ry)} ${f(s.rot)} ${s.large} ${s.sweep} ${pt(nudge(s.p, k))} `
        cur = s.p
        break
      }
      case 'Z':
        // Close by hand: a stroke back to the start that needn't land exactly on it.
        if (cur[0] !== start[0] || cur[1] !== start[1]) line(start)
        break
    }
  }
  return out
}

/** The diagonal of the points' bounding box. */
function size(segments: Segment[]): number {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const s of segments) {
    if (s.c === 'Z') continue
    x0 = Math.min(x0, s.p[0])
    y0 = Math.min(y0, s.p[1])
    x1 = Math.max(x1, s.p[0])
    y1 = Math.max(y1, s.p[1])
  }
  return x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0) : 0
}

const cache = new Map<string, string>()

/** The path drawn in pencil: two passes, the second a hair off the first. */
export function pencil(d: string): string {
  const hit = cache.get(d)
  if (hit !== undefined) return hit
  const segments = parse(d)
  const rand = random(hash(d))
  // The second pass sits up to 0.6px off the first, less on small shapes.
  const reach = Math.min(0.6, size(segments) * 0.04)
  const again: Pt = [(rand() * 2 - 1) * reach, (rand() * 2 - 1) * reach]
  const drawn = `${pass(segments, rand, [0, 0])}${pass(segments, rand, again)}`.trim()
  if (cache.size > 5000) cache.clear()
  cache.set(d, drawn)
  return drawn
}
