import { describe, expect, test } from 'bun:test'
import { compileUtilities, evaluateColorMath, utilityDeclarations } from '../test/tailwind'
import legacyPalette from './fixtures/tailwind3-palette.json'
import { variants } from './test/palette'

// Compare the actual generated declarations, after full substitution, with the
// pre-migration Tailwind 3 classes. This catches missing utility generation,
// incorrect shades, neutral special cases, and lost/doubled intrinsic alpha.
// The legacy side is the frozen Tailwind 3 palette: Tailwind 4 changed its own.
const roles = {
  progress: 'blue',
  queue: 'cyan',
  review: 'yellow',
  'human-wait': 'purple',
  'external-wait': 'orange',
  attention: 'amber',
  danger: 'red',
  success: 'green',
  neutral: 'gray',
}
const pairs: Array<[string, string, string]> = []
for (const [role, color] of Object.entries(roles)) {
  pairs.push(
    [`bg-status-${role}-solid`, `bg-${color}-500`, `bg-${color}-500`],
    [`text-status-${role}-fg`, `text-${color}-700`, `text-${color}-400`],
    [`bg-status-${role}-surface`, `bg-${color}-50`, `bg-${color}-900/20`],
    [`border-status-${role}-border`, `border-${color}-200`, `border-${color}-800`],
    [`text-status-${role}-badge-fg`, `text-${color}-800`, `text-${color}-200`],
    [`bg-status-${role}-badge-surface`, `bg-${color}-100`, color === 'gray' ? 'bg-gray-800' : `bg-${color}-900/30`],
    [
      `hover:bg-status-${role}-badge-hover`,
      `hover:bg-${color}-200`,
      color === 'gray' ? 'hover:bg-gray-700' : `hover:bg-${color}-900/70`,
    ]
  )
}
for (const [i, color] of ['purple', 'blue', 'green', 'violet', 'orange', 'amber', 'cyan'].entries()) {
  pairs.push(
    [`text-badge-accent-${i + 1}-fg`, `text-${color}-800`, `text-${color}-200`],
    [`bg-badge-accent-${i + 1}-surface`, `bg-${color}-100`, `bg-${color}-900/30`],
    [`hover:bg-badge-accent-${i + 1}-hover`, `hover:bg-${color}-200`, `hover:bg-${color}-900/70`]
  )
}
for (const [i, [color, shade]] of [
  ['violet', 700],
  ['blue', 700],
  ['emerald', 700],
  ['amber', 800],
  ['rose', 700],
  ['cyan', 800],
].entries()) {
  pairs.push([`text-agent-type-${i + 1}`, `text-${color}-${shade}`, `text-${color}-300`])
}
pairs.push(['text-on-accent', 'text-white', 'text-white'])

function resolve(utility: Record<string, string>, variables: Record<string, string>): string {
  const declarations: Record<string, string> = { ...variables, ...utility }
  let value = declarations.color ?? declarations['background-color'] ?? declarations['border-color']!
  for (let i = 0; value.includes('var(') && i < 10; i++) {
    value = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name, fallback) => declarations[name] ?? fallback)
  }
  value = evaluateColorMath(value)
  expect(value).toMatch(/^rgb\(\d+ \d+ \d+ \/ [\d.]+\)$/)
  return value
}

/** What a Tailwind 3 palette class such as `hover:bg-blue-900/30` or `text-white` resolved to. */
function legacy(utility: string): string {
  const [, color, shade, opacity] = /^(?:hover:)?(?:bg|text|border)-([a-z]+)(?:-(\d+))?(?:\/(\d+))?$/.exec(utility)!
  const palette = legacyPalette as unknown as Record<string, string | Record<string, string>>
  const entry = palette[color!]!
  const hex = typeof entry === 'string' ? entry : entry[shade!]!
  const full = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c) : hex
  const channels = full
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16))
  return `rgb(${channels.join(' ')} / ${opacity ? Number(opacity) / 100 : 1})`
}

describe('semantic color compatibility', () => {
  test('all migrated role, Badge, identity and on-accent utilities exactly match both legacy appearances', async () => {
    const classes = [...new Set(pairs.map(([tokenClass]) => tokenClass))]
    const rules = utilityDeclarations(await compileUtilities(classes))
    expect([...rules.keys()].sort()).toEqual([...classes].sort())
    for (const [tokenClass, light, dark] of pairs) {
      for (const [variant, legacyClass] of [
        ['light', light],
        ['dark', dark],
      ] as const) {
        const [r, g, b, a] = resolve(rules.get(tokenClass)!, variants[variant])
          .match(/[\d.]+/g)!
          .map(Number)
        const [lr, lg, lb, la] = legacy(legacyClass)
          .match(/[\d.]+/g)!
          .map(Number)
        expect([r, g, b]).toEqual([lr, lg, lb])
        expect(a).toBeCloseTo(la!, 10)
      }
    }
    // Prove the indirection, not just equal constants: independently supplied
    // theme values reach real compiled utilities without rebuilding classes.
    const replacement = { ...variants.light, '--status-progress-fg': '1 2 3' }
    expect(resolve(rules.get('text-status-progress-fg')!, replacement)).toBe('rgb(1 2 3 / 1)')
  })
})
