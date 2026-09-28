import { expect, test } from 'bun:test'
import { compile, type TopLevelSpec } from 'vega-lite'
import { parse, View, type Spec, type Config } from 'vega'
import { chartThemeConfig, hasAuthoredChartColors } from './chart'
import { variants } from './test/palette'
import { tokenColor } from './tokenReader'

const colors = Object.fromEntries(Object.entries(variants.light).map(([token, value]) => [token, tokenColor(value)]))
const bar = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  data: {
    values: [
      { label: 'A', value: 1 },
      { label: 'B', value: 2 },
    ],
  },
  mark: 'bar',
  encoding: { x: { field: 'label', type: 'nominal' }, y: { field: 'value', type: 'quantitative' } },
} as const

async function renderSvg(spec: Spec, config?: Config) {
  const view = new View(parse(spec, config), { renderer: 'none' })
  try {
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}
// Normalize colors only; keep all shapes, labels, default styling and coordinates.
const normalizeColors = (svg: string) =>
  svg
    .replace(/#([\da-f]{6}|[\da-f]{3})\b/gi, (_, hex) => {
      if (hex.length === 3) hex = [...hex].map((v) => v + v).join('')
      return `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
    })
    .replace(/="white"/g, '="rgb(255, 255, 255)"')
    .replace(/="black"/g, '="rgb(0, 0, 0)"')

for (const mark of ['bar', 'point', 'line', 'rule', 'text', 'area', 'circle', 'tick'] as const) {
  test(`Vega-Lite ${mark} defaults preserve the actual legacy render`, async () => {
    const spec = { ...bar, mark }
    const before = compile(spec as TopLevelSpec).spec
    const after = compile(spec as TopLevelSpec, { config: chartThemeConfig(spec, colors) }).spec
    expect(normalizeColors(await renderSvg(after))).toBe(normalizeColors(await renderSvg(before)))
  })
}

test('categorical range matches the real library default and can be themed without rewriting content', async () => {
  const spec = { ...bar, encoding: { ...bar.encoding, color: { field: 'label', type: 'nominal' } } }
  // A field with no palette uses the library's default categorical range.
  expect(chartThemeConfig(spec, colors)).toBeDefined()
  expect(
    normalizeColors(await renderSvg(compile(spec as TopLevelSpec, { config: chartThemeConfig(spec, colors) }).spec))
  ).toBe(normalizeColors(await renderSvg(compile(spec as TopLevelSpec).spec)))
  const categoryConfig = chartThemeConfig(spec, { ...colors, '--graph-chart-category-1': 'rgb(1, 2, 3)' })
  expect(await renderSvg(compile(spec as TopLevelSpec, { config: categoryConfig }).spec)).toContain('rgb(1, 2, 3)')
  const config = chartThemeConfig(bar, colors)!
  expect(config.range?.category).toEqual([
    'rgb(76, 120, 168)',
    'rgb(245, 133, 24)',
    'rgb(228, 87, 86)',
    'rgb(114, 183, 178)',
    'rgb(84, 162, 75)',
    'rgb(238, 202, 59)',
    'rgb(178, 121, 162)',
    'rgb(255, 157, 166)',
    'rgb(157, 117, 93)',
    'rgb(186, 176, 172)',
  ])
  const serialized = JSON.stringify(bar)
  const themed = chartThemeConfig(bar, {
    ...colors,
    '--graph-chart-mark': 'rgb(1, 2, 3)',
    '--graph-chart-fg': 'rgb(4, 5, 6)',
  })
  const svg = await renderSvg(compile(bar as TopLevelSpec, { config: themed }).spec)
  expect(svg).toContain('rgb(1, 2, 3)')
  expect(svg).toContain('rgb(4, 5, 6)')
  expect(JSON.stringify(bar)).toBe(serialized)
})

test('Vega defaults preserve the actual render, including transparent background', async () => {
  const spec: Spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 100,
    height: 100,
    marks: [
      {
        type: 'rect',
        encode: { enter: { x: { value: 1 }, y: { value: 2 }, width: { value: 20 }, height: { value: 30 } } },
      },
    ],
  }
  expect(
    normalizeColors(await renderSvg(spec, chartThemeConfig(spec as Record<string, unknown>, colors) as Config))
  ).toBe(normalizeColors(await renderSvg(spec)))
})

test('explicit colors, signals, nulls, schemes, ranges, styles and partial palettes are never recolored', () => {
  for (const patch of [
    { background: null },
    { background: 'transparent' },
    { mark: { type: 'bar', color: '#123456' } },
    { encoding: { color: { condition: { test: 'datum.value > 1', value: 'red' }, value: 'blue' } } },
    { config: { mark: { color: 'orange' } } },
    { config: { axis: { labelColor: { expr: 'datum.color' } } } },
    { config: { style: { custom: { fill: '#abcdef' } } } },
    { layer: [{ mark: 'bar', encoding: { fill: { value: null } } }] },
    { scales: [{ name: 'c', range: { scheme: 'blues' } }] },
    { marks: [{ type: 'rect', encode: { update: { fill: { signal: 'myColor' } } } }] },
    { usermeta: { embedOptions: { config: { background: 'red' } } } },
  ]) {
    const spec = { ...bar, ...patch }
    const before = JSON.stringify(spec)
    expect(hasAuthoredChartColors(spec)).toBe(true)
    expect(chartThemeConfig(spec, colors)).toBeUndefined()
    expect(JSON.stringify(spec)).toBe(before)
  }
  expect(hasAuthoredChartColors({ data: { values: [{ color: 'just data' }] }, mark: 'bar' })).toBe(false)
})

test('Vega and Vega-Lite SVG output retains parser-safe tiny custom alpha products', async () => {
  const { compileCustomTheme, validateCustomTheme } = await import('@ficus/shared/custom-theme')
  const { BUILT_IN_THEMES } = await import('./registry')
  const { color: parseColor } = await import('d3-color')
  const raw = JSON.stringify({
    format: 'tau-custom-theme',
    version: 1,
    name: 'Tiny chart',
    base: 'tau',
    appearance: 'light',
    overrides: { '--graph-chart-mark': 'rgba(10,20,30,0.0000001)' },
  })
  const result = validateCustomTheme(raw, BUILT_IN_THEMES)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  const channels = compileCustomTheme(result.document, 'light')['--graph-chart-mark']!
  const concrete = tokenColor(channels, '0.12')!
  expect(parseColor(concrete)!.opacity).toBe(0.0000001 * 0.12)
  const custom = { ...colors, '--graph-chart-mark': concrete }
  const lite = compile(bar as TopLevelSpec, { config: chartThemeConfig(bar, custom) }).spec
  expect(await renderSvg(lite)).toContain(`fill="${concrete}"`)
  const vega: Spec = {
    width: 100,
    height: 100,
    marks: [
      {
        type: 'rect',
        encode: { enter: { x: { value: 10 }, y: { value: 10 }, width: { value: 40 }, height: { value: 40 } } },
      },
    ],
  }
  expect(await renderSvg(vega, chartThemeConfig(vega as Record<string, unknown>, custom) as Config)).toContain(
    `fill="${concrete}"`
  )
})
