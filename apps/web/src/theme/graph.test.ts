import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { THEME_TOKEN_FAMILIES } from '@ficus/shared'
import { variants, contrastRatio } from './test/palette'
import { readTokenColor } from './tokenReader'
import { agentGraphColor, squadGraphColor, relationshipGraphColor } from './graph'
import { scanSourceForRawColors } from '../no-raw-colors.scanner'

function resolve(variant: 'light' | 'dark', token: string): string {
  const value = variants[variant][token] ?? ''
  return value.replace(/var\((--[\w-]+)\)/g, (_, alias) => resolve(variant, alias))
}
export function graphPalette(variant: 'light' | 'dark') {
  const style = { getPropertyValue: (token: string) => resolve(variant, token) }
  return Object.fromEntries(Object.keys(variants[variant]).map((token) => [token, readTokenColor(style, token)]))
}
function compositeHex(color: string, background: string): string {
  const channels = (value: string) => value.match(/[\d.]+/g)!.map(Number)
  const [r, g, b, a = 1] = channels(color)
  const bg = channels(background)
  return (
    '#' +
    [r!, g!, b!]
      .map((v, i) =>
        Math.round(v * a + bg[i]! * (1 - a))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

test('graph family active; default palettes retain parity in both appearances', () => {
  expect(THEME_TOKEN_FAMILIES.find((f) => f.family === 'graph')?.status).toBe('active')
  for (const variant of ['light', 'dark'] as const) {
    const colors = graphPalette(variant)
    expect(colors['--graph-bg']).toBe('rgb(17, 24, 39)')
    expect(colors['--graph-label']).toBe('rgb(255, 255, 255)')
    expect(colors['--graph-label-muted']).toBe('rgba(255, 255, 255, 0.5)')
    expect(colors['--graph-node-selected']).toBe('rgb(99, 102, 241)')
    expect(squadGraphColor(colors, 'active')).toBe('rgb(34, 197, 94)')
    expect(squadGraphColor(colors, 'paused')).toBe('rgb(245, 158, 11)')
    expect(squadGraphColor(colors, 'archived')).toBe('rgb(107, 114, 128)')
    expect(relationshipGraphColor(colors, 'collaborates')).toBe('rgb(59, 130, 246)')
    expect(relationshipGraphColor(colors, 'depends_on')).toBe('rgb(16, 185, 129)')
    expect(agentGraphColor(colors, 'active')).toBe(colors['--status-progress-solid']!)
    expect(agentGraphColor(colors, 'waiting-input')).toBe(colors['--status-human-wait-solid']!)
    for (const [state, role] of [
      ['active', 'success'],
      ['paused', 'attention'],
      ['archived', 'neutral'],
    ]) {
      expect(variants[variant][`--graph-node-${state}`]).toBe(`var(--status-${role}-solid)`)
    }
  }
})

test('both appearances meet label 4.5:1 and link 3:1 contrast, including alpha on the dark canvas', () => {
  for (const variant of ['light', 'dark'] as const) {
    const colors = graphPalette(variant)
    const bg = colors['--graph-bg']!
    const bgHex = compositeHex(bg, bg)
    for (const token of ['--graph-label', '--graph-label-muted']) {
      expect(contrastRatio(compositeHex(colors[token]!, bg), bgHex)).toBeGreaterThanOrEqual(4.5)
    }
    for (let i = 1; i <= 6; i++) {
      expect(contrastRatio(compositeHex(colors[`--graph-link-${i}`]!, bg), bgHex)).toBeGreaterThanOrEqual(3)
    }
    // The original edges fail even before WebGL's default linkOpacity=.2 multiplier.
    expect(contrastRatio(compositeHex('rgba(255, 255, 255, 0.2)', bg), bgHex)).toBeLessThan(3)
    expect(contrastRatio(compositeHex('rgba(255, 255, 255, 0.1)', bg), bgHex)).toBeLessThan(3)
  }
})

test('all graph renderers subscribe and send concrete colors to 2D/3D, not raw colors or stale data fields', () => {
  for (const name of ['AgentVisualization', 'OrgGraph', 'SquadUniverse']) {
    const path = `components/squads/${name}.tsx`
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    expect(scanSourceForRawColors(path, source).filter((f) => f.category !== 'inline-color-style')).toEqual([])
    expect(source).toContain('const colors = useThemeColors()')
    expect(source).toContain('linkOpacity={1}')
    expect(source).toContain("backgroundColor={graphColor(colors, '--graph-bg')}")
    expect(source).toContain("nameLabel.color = graphColor(colors, '--graph-label')")
    expect(source).toContain("graphColor(colors, '--graph-label-muted')")
    expect(source).not.toContain('node.color')
    expect(source).not.toContain('link.color')
    expect(source).not.toContain('.markerColor')
    expect(source).not.toContain('&& !SpriteText)')
    expect(source).toContain('useGraphModulesReady(')
    expect(source).toContain(', spriteTextReady)')
  }
})
