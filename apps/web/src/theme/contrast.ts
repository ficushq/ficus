import { readTokenColor } from './tokenReader'

export function resolveToken(tokens: Record<string, string>, token: string, seen: string[] = []): string {
  if (seen.includes(token)) throw new Error(`Cyclic token: ${token}`)
  const value = tokens[token]
  if (value === undefined) throw new Error(`Missing token: ${token}`)
  return value.replace(/var\((--[\w-]+)\)/g, (_, alias) => resolveToken(tokens, alias, [...seen, token]))
}
export function tokenRgba(tokens: Record<string, string>, token: string): number[] {
  const value = readTokenColor({ getPropertyValue: (name) => (tokens[name] ? resolveToken(tokens, name) : '') }, token)
  if (!value) throw new Error(`Not a color: ${token}`)
  // readTokenColor emits comma-form RGB(A). Number parses scientific notation
  // produced by tiny valid alpha values without splitting e.g. 1e-7 into 1, 7.
  const components = /^rgba?\(([^)]+)\)$/.exec(value)?.[1]?.split(',').map(Number)
  if (!components || ![3, 4].includes(components.length) || components.some((v) => !Number.isFinite(v)))
    throw new Error(`Not a numeric color: ${token}`)
  return components
}
export function composite(fg: number[], bg: number[]): number[] {
  if ((bg[3] ?? 1) !== 1) throw new Error('Compositing requires a resolved opaque backdrop.')
  const alpha = fg[3] ?? 1
  return fg.slice(0, 3).map((v, i) => v * alpha + bg[i]! * (1 - alpha))
}
export function contrast(fg: number[], bg: number[]): number {
  const luminance = (rgb: number[]) =>
    rgb
      .slice(0, 3)
      .map((c) => c / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
  const a = luminance(composite(fg, bg)),
    b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
export interface ContrastPair {
  fg: string
  bg: string
  minimum: number
  under?: string
}
export const contrastPairs: ContrastPair[] = []
const add = (fg: string, bg: string, minimum = 4.5, under?: string) => contrastPairs.push({ fg, bg, minimum, under })
const surfaces = ['page', 'surface', 'surface-secondary', 'pill', 'surface-hover', 'inset'].map(
  (slot) => `--color-bg-${slot}`
)
for (const bg of surfaces) {
  for (const slot of ['primary', 'secondary', 'muted', 'placeholder']) add(`--color-text-${slot}`, bg)
  add('--color-focus', bg, 3)
  add('--scrollbar-thumb', bg, 3)
}
add('--color-code-text', '--color-code-bg')
for (const role of [
  'progress',
  'queue',
  'review',
  'human-wait',
  'external-wait',
  'attention',
  'danger',
  'success',
  'neutral',
]) {
  for (const under of surfaces) {
    add(`--status-${role}-fg`, `--status-${role}-surface`, 4.5, under)
    add(`--status-${role}-badge-fg`, `--status-${role}-badge-surface`, 4.5, under)
    add(`--status-${role}-badge-fg`, `--status-${role}-badge-hover`, 4.5, under)
  }
}
for (let i = 1; i <= 7; i++)
  for (const under of surfaces) {
    add(`--badge-accent-${i}-fg`, `--badge-accent-${i}-surface`, 4.5, under)
    add(`--badge-accent-${i}-fg`, `--badge-accent-${i}-hover`, 4.5, under)
  }
for (let i = 1; i <= 6; i++) for (const bg of surfaces) add(`--agent-type-${i}-fg`, bg)
for (const slot of [
  'fg',
  'comment',
  'keyword',
  'string',
  'number',
  'function',
  'punctuation',
  'operator',
  'variable',
  'property',
  'url',
]) {
  add(`--syntax-${slot}`, '--syntax-bg')
  add(`--syntax-${slot}`, '--syntax-memory-bg')
}
add('--syntax-human-code-fg', '--syntax-human-code-bg')
add('--term-fg', '--term-bg')
add('--term-muted', '--term-bg')
add('--term-cursor', '--term-bg', 3)
for (const bg of ['--color-primary', '--color-primary-hover', '--color-primary-active']) add('--on-accent-fg', bg)
// The checked checkbox's tick is drawn on the accent fill (index.css), a graphical object: 3:1.
add('--checkbox-check', '--color-primary', 3)
add('--graph-label', '--graph-bg')
add('--graph-label-muted', '--graph-bg')
for (let i = 1; i <= 6; i++) add(`--graph-link-${i}`, '--graph-bg', 3)

/** Resolve the documented surface stack from an opaque foundation upward.
 * A surface is never composited over itself. Other surfaces/islands sit on the
 * primary surface, and that surface sits on the page. Status/badge pairs can
 * name a more specific under-surface. A translucent page has an unknown external
 * backdrop: do not invent a white/black canvas or claim a safe foreground.
 */
export function pairBackground(tokens: Record<string, string>, pair: ContrastPair): number[] | null {
  const resolve = (token: string, seen: string[], under?: string): number[] | null => {
    if (seen.includes(token) || !tokens[token]) return null
    const color = tokenRgba(tokens, token)
    if ((color[3] ?? 1) === 1) return color.slice(0, 3)
    const next =
      under ??
      (token === '--color-bg-page' ? null : token === '--color-bg-surface' ? '--color-bg-page' : '--color-bg-surface')
    if (!next) return null
    const backdrop = resolve(next, [...seen, token])
    return backdrop ? composite(color, backdrop) : null
  }
  return resolve(pair.bg, [], pair.under)
}

export function pairRatio(tokens: Record<string, string>, pair: ContrastPair): number {
  const bg = pairBackground(tokens, pair)
  if (!bg) throw new Error('Contrast is unknown without an opaque page or under-surface.')
  return contrast(tokenRgba(tokens, pair.fg), bg)
}
