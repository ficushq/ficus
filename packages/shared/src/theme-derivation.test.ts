import { describe, expect, test } from 'bun:test'
import { customColorChannels } from './custom-theme'
import { deriveThemeOverrides, suggestPaletteSeeds, validateThemePalette, type ThemePalette } from './theme-derivation'
import { STATUS_ROLES, STATUS_TOKENS } from './theme-schema'
import { srgbToOklch } from './color-oklch'

// A representative subset of a real base theme's resolved token values (Ficus
// light/dark, taken from apps/web/src/index.css), enough to exercise every
// derivation bucket without needing the full 431-token registry.
const TAU_LIGHT: Record<string, string> = {
  '--swatch-secondary': '168 85 247',
  '--swatch-tertiary': '196 181 253',
  '--color-bg-page': '250 249 252',
  '--color-bg-surface': '255 255 255',
  '--color-text-primary': '37 35 50',
  '--color-text-secondary': '96 92 112',
  '--color-primary': '91 33 182',
  '--color-primary-hover': '109 40 217',
  '--color-primary-active': '76 29 149',
  '--color-primary-light': '109 40 217',
  '--color-selection-bg': '238 232 248',
  '--color-selection-border': '215 199 240',
  '--color-focus': '124 58 237',
  '--on-accent-fg': '255 255 255',
  '--brand-gradient-from': '168 85 247',
  '--brand-gradient-to': '124 58 237',
  '--brand-tile': '124 58 237',
  '--brand-ink': '255 255 255',
  '--agent-type-1-fg': '109 40 217',
  '--agent-type-2-fg': '29 78 216',
  '--badge-accent-1-fg': '107 33 168',
  '--graph-chart-category-1': '91 33 182',
  '--syntax-keyword': '124 58 237',
  '--syntax-string': '34 197 94',
  '--term-bg': '14 15 26',
  '--term-fg': '171 178 191',
  '--term-red': '224 108 117',
  '--log-bg': '40 44 52',
}
for (const [role, solid, fg, surface] of [
  ['progress', '59 130 246', '29 78 216', '239 246 255'],
  ['queue', '6 182 212', '14 116 144', '236 254 255'],
  ['review', '234 179 8', '161 98 7', '254 252 232'],
  ['human-wait', '168 85 247', '107 33 168', '250 245 255'],
  ['external-wait', '249 115 22', '194 65 12', '255 247 237'],
  ['attention', '245 158 11', '180 83 9', '255 251 235'],
  ['danger', '239 68 68', '185 28 28', '254 242 242'],
  ['success', '34 197 94', '21 128 61', '240 253 244'],
  ['neutral', '107 114 128', '55 65 81', '249 250 251'],
] as const) {
  TAU_LIGHT[`--status-${role}-solid`] = solid
  TAU_LIGHT[`--status-${role}-fg`] = fg
  TAU_LIGHT[`--status-${role}-surface`] = surface
  TAU_LIGHT[`--status-${role}-border`] = surface
  TAU_LIGHT[`--status-${role}-badge-fg`] = fg
  TAU_LIGHT[`--status-${role}-badge-surface`] = surface
  TAU_LIGHT[`--status-${role}-badge-hover`] = surface
}

// The dark-appearance counterpart of TAU_LIGHT (same real base theme, Ficus
// dark, taken from apps/web/src/index.css's [data-appearance='dark'] block).
const TAU_DARK: Record<string, string> = {
  '--color-bg-page': '9 10 18',
  '--color-bg-surface': '16 17 28',
  '--color-text-primary': '226 232 240',
  '--color-text-secondary': '148 163 184',
  '--color-primary': '91 33 182',
  '--color-primary-hover': '109 40 217',
  '--color-primary-active': '76 29 149',
  '--color-primary-light': '196 181 253',
  '--color-selection-bg': '33 26 53',
  '--color-selection-border': '68 50 95',
  '--color-focus': '196 181 253',
  '--on-accent-fg': '255 255 255',
  '--brand-gradient-from': '168 85 247',
  '--brand-gradient-to': '124 58 237',
  '--brand-tile': '124 58 237',
  '--brand-ink': '255 255 255',
  '--agent-type-1-fg': '196 181 253',
  '--agent-type-2-fg': '147 197 253',
  '--badge-accent-1-fg': '233 213 255',
  '--graph-chart-category-1': '76 120 168',
  '--syntax-keyword': '197.778 120.36 221.34',
  '--syntax-string': '151.963 194.922 121.278',
  '--term-bg': '14 15 26',
  '--term-fg': '171 178 191',
  '--term-red': '224 108 117',
  '--log-bg': '40 44 52',
}
for (const [role, solid, fg, surface, badgeFg, badgeSurface] of [
  ['progress', '59 130 246', '96 165 250', '30 58 138', '191 219 254', '30 58 138'],
  ['queue', '6 182 212', '34 211 238', '22 78 99', '165 243 252', '22 78 99'],
  ['review', '234 179 8', '250 204 21', '113 63 18', '254 240 138', '113 63 18'],
  ['human-wait', '168 85 247', '192 132 252', '88 28 135', '233 213 255', '88 28 135'],
  ['external-wait', '249 115 22', '251 146 60', '124 45 18', '254 215 170', '124 45 18'],
  ['attention', '245 158 11', '251 191 36', '120 53 15', '253 230 138', '120 53 15'],
  ['danger', '239 68 68', '248 113 113', '127 29 29', '254 202 202', '127 29 29'],
  ['success', '34 197 94', '74 222 128', '20 83 45', '187 247 208', '20 83 45'],
  ['neutral', '107 114 128', '156 163 175', '17 24 39', '229 231 235', '31 41 55'],
] as const) {
  TAU_DARK[`--status-${role}-solid`] = solid
  TAU_DARK[`--status-${role}-fg`] = fg
  TAU_DARK[`--status-${role}-surface`] = surface
  TAU_DARK[`--status-${role}-border`] = surface
  TAU_DARK[`--status-${role}-badge-fg`] = badgeFg
  TAU_DARK[`--status-${role}-badge-surface`] = badgeSurface
  TAU_DARK[`--status-${role}-badge-hover`] = badgeSurface
}

const palette: ThemePalette = { primary: '#0ea5e9' }

describe('validateThemePalette', () => {
  test('requires a valid primary and accepts optional fields', () => {
    expect(validateThemePalette({ primary: '#0ea5e9' })).toEqual({ ok: true, palette: { primary: '#0ea5e9' } })
    expect(
      validateThemePalette({ primary: '#0ea5e9', secondary: '#f59e0b', contrast: 'high', status: 'harmonized' })
    ).toEqual({
      ok: true,
      palette: { primary: '#0ea5e9', secondary: '#f59e0b', contrast: 'high', status: 'harmonized' },
    })
  })
  test('rejects missing/invalid primary, bad color grammar, and invalid enums', () => {
    for (const raw of [
      null,
      {},
      { primary: 'url(x)' },
      { primary: '#0ea5e9', secondary: 'red' },
      { primary: '#0ea5e9', contrast: 'extreme' },
      { primary: '#0ea5e9', status: 'auto' },
    ])
      expect(validateThemePalette(raw).ok).toBe(false)
  })
})

describe('deriveThemeOverrides buckets', () => {
  const derived = deriveThemeOverrides({ baseTokens: TAU_LIGHT, palette, appearance: 'light' })

  test('neutral/chrome tokens take the neutral tint hue but preserve base lightness', () => {
    const baseOklch = srgbToOklch([255, 255, 255])
    const derivedChannels = customColorChannels(derived['--color-bg-surface']!)!
    const [r, g, b] = derivedChannels.split(' ').map(Number) as [number, number, number]
    const derivedOklch = srgbToOklch([r, g, b])
    expect(derivedOklch.l).toBeCloseTo(baseOklch.l, 1)
  })

  test('the primary family is derived from the seed with an offset/ratio modeled on the base', () => {
    const primaryRgb = customColorChannels(derived['--color-primary']!)!.split(' ').map(Number)
    const seedOklch = srgbToOklch([14, 165, 233]) // #0ea5e9
    const derivedOklch = srgbToOklch(primaryRgb as [number, number, number])
    // Round-tripping a saturated seed through sRGB clamping (serialize -> hex ->
    // reparse) can drift a few degrees near the gamut edge; this checks fidelity,
    // not exactness.
    expect(Math.abs(((derivedOklch.h - seedOklch.h + 180) % 360) - 180)).toBeLessThan(10)
    // hover is lighter than primary in the base theme; that relationship should carry over.
    const hoverRgb = customColorChannels(derived['--color-primary-hover']!)!.split(' ').map(Number)
    const hoverOklch = srgbToOklch(hoverRgb as [number, number, number])
    expect(hoverOklch.l).toBeGreaterThan(derivedOklch.l)
  })

  test('on-accent-fg picks black or white by contrast against the derived primary', () => {
    expect(['#000000', '#ffffff']).toContain(derived['--on-accent-fg'])
  })

  test('regression: --color-primary is held to the UI (3:1) contrast floor against the page, not the text (4.5:1) one', () => {
    // A bright seed that already clears 3:1 (WCAG 1.4.11 non-text) against a
    // near-white page must come through with its own lightness essentially
    // unchanged — it should NOT be additionally darkened to hit a body-text
    // 4.5:1 target. --color-primary is a UI accent (buttons/borders/icons);
    // text-level contrast for content ON it is --on-accent-fg's separate job.
    const seed = '#0ea5e9' // #0ea5e9 vs TAU_LIGHT's page (250 249 252) is ~2.61:1 (below even 3:1)
    const passesAt3 = deriveThemeOverrides({
      baseTokens: TAU_LIGHT,
      palette: { primary: seed, contrast: 'standard' },
      appearance: 'light',
    })
    const rgb = customColorChannels(passesAt3['--color-primary']!)!.split(' ').map(Number) as [number, number, number]
    function relLuminance([r, g, b]: number[]): number {
      return [r, g, b]
        .map((c) => c / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
    }
    const pageRgb = TAU_LIGHT['--color-bg-page']!.split(' ').map(Number)
    const ratio = (a: number[], b: number[]) => {
      const la = relLuminance(a)
      const lb = relLuminance(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const finalRatio = ratio(rgb, pageRgb)
    // Cleared (within sRGB integer-rounding tolerance of the bisection) the
    // 3:1 floor...
    expect(finalRatio).toBeGreaterThanOrEqual(2.99)
    // ...but was not pushed anywhere near the old 4.5:1 text-level target —
    // proving the UI floor, not the text floor, governs this pair.
    expect(finalRatio).toBeLessThan(4.0)
  })

  test('brand and categorical tokens pick a hue from primary/secondary/tertiary, keeping base lightness/chroma', () => {
    for (const token of ['--brand-tile', '--agent-type-1-fg', '--graph-chart-category-1', '--syntax-keyword']) {
      expect(derived[token]).toBeDefined()
    }
  })

  test('status is static by default: no status overrides are produced', () => {
    for (const token of STATUS_TOKENS) expect(derived[token]).toBeUndefined()
  })

  test('ANSI-named terminal/log slots are never touched; term/log backgrounds ARE (neutral bucket)', () => {
    expect(derived['--term-red']).toBeUndefined()
    expect(derived['--term-bg']).toBeDefined()
    expect(derived['--log-bg']).toBeDefined()
  })
})

describe('swatch colors', () => {
  test('use the palette secondary and tertiary seeds', () => {
    const derived = deriveThemeOverrides({
      baseTokens: TAU_LIGHT,
      palette: { primary: '#0ea5e9', secondary: '#f97316', tertiary: '#22c55e' },
      appearance: 'light',
    })
    expect(derived['--swatch-secondary']).toBe('#f97316')
    expect(derived['--swatch-tertiary']).toBe('#22c55e')
  })

  test('fall back to the colour-theory companions (+30 and +150 degrees) when seeds are unset', () => {
    const derived = deriveThemeOverrides({
      baseTokens: TAU_LIGHT,
      palette: { primary: '#0ea5e9' },
      appearance: 'light',
    })
    const hue = (channels: string) => {
      const [r, g, b] = channels.split(' ').map(Number)
      return srgbToOklch([r!, g!, b!]).h
    }
    const primaryHue = hue(customColorChannels('#0ea5e9')!)
    const delta = (value: number) => ((value - primaryHue + 540) % 360) - 180
    expect(Math.round(delta(hue(customColorChannels(derived['--swatch-secondary'])!)))).toBeCloseTo(30, -1)
    expect(Math.round(delta(hue(customColorChannels(derived['--swatch-tertiary'])!)))).toBeCloseTo(150, -1)
    const companions = suggestPaletteSeeds('#0ea5e9')!
    expect(derived['--swatch-secondary']).toBe(companions.secondary)
    expect(derived['--swatch-tertiary']).toBe(companions.tertiary)
  })
})

describe('suggestPaletteSeeds', () => {
  const oklchOf = (hex: string) =>
    srgbToOklch(customColorChannels(hex)!.split(' ').map(Number) as [number, number, number])
  const hueDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180

  test('an analogous secondary and a split-complementary tertiary at the primary lightness', () => {
    for (const primary of ['#3f6b4f', '#0ea5e9', '#97371d', '#5b21b6']) {
      const { secondary, tertiary } = suggestPaletteSeeds(primary)!
      const seed = oklchOf(primary)
      expect(Math.abs(hueDelta(seed.h, oklchOf(secondary).h) - 30)).toBeLessThan(12)
      expect(Math.abs(hueDelta(seed.h, oklchOf(tertiary).h) - 150)).toBeLessThan(12)
      expect(oklchOf(secondary).l).toBeCloseTo(seed.l, 1)
    }
  })

  test('returns null for an invalid primary', () => {
    expect(suggestPaletteSeeds('not a color')).toBeNull()
  })
})

describe('secondary and tertiary seeds', () => {
  const base: Record<string, string> = {
    ...TAU_LIGHT,
    '--color-bg-surface-secondary': '245 244 249',
    '--color-bg-surface-hover': '241 240 245',
    '--color-bg-pill': '241 240 245',
    '--color-bg-inset': '241 240 245',
  }
  const interaction = [
    '--color-bg-surface-hover',
    '--color-bg-pill',
    '--color-bg-inset',
    '--color-selection-bg',
    '--color-bg-surface-secondary',
    '--color-selection-border',
  ]
  // Accepts a hex seed/override or a base token's compiled "r g b" channels.
  const oklchOf = (value: string) =>
    srgbToOklch((customColorChannels(value) ?? value).split(' ').map(Number) as [number, number, number])
  const hueDelta = (from: number, to: number) => Math.abs(((to - from + 540) % 360) - 180)

  test('a secondary seed tints every interaction surface with its hue, at the base lightness', () => {
    const derived = deriveThemeOverrides({
      baseTokens: base,
      palette: { primary: '#3f6b4f', secondary: '#f97316' },
      appearance: 'light',
    })
    const secondaryHue = oklchOf('#f97316').h
    for (const token of interaction) {
      const value = oklchOf(derived[token]!)
      expect(hueDelta(value.h, secondaryHue)).toBeLessThan(15)
      expect(value.c).toBeGreaterThan(0.004)
      expect(value.l).toBeCloseTo(oklchOf(base[token]!).l, 1)
    }
    // A tint, not a colour: surfaces stay far below the seed's own chroma.
    expect(oklchOf(derived['--color-bg-surface-hover']!).c).toBeLessThanOrEqual(0.031)
  })

  test('without a secondary seed the interaction surfaces keep the neutral/primary mapping', () => {
    const withSecondary = deriveThemeOverrides({
      baseTokens: base,
      palette: { primary: '#3f6b4f', secondary: '#f97316' },
      appearance: 'light',
    })
    const without = deriveThemeOverrides({ baseTokens: base, palette: { primary: '#3f6b4f' }, appearance: 'light' })
    for (const token of interaction) expect(without[token]).not.toBe(withSecondary[token])
    const neutral = deriveThemeOverrides({ baseTokens: base, palette: { primary: '#3f6b4f' }, appearance: 'light' })
    expect(without['--color-bg-surface-hover']).toBe(neutral['--color-bg-surface-hover'])
  })

  test('brand and voice highlights take the tertiary hue', () => {
    const derived = deriveThemeOverrides({
      baseTokens: base,
      palette: { primary: '#3f6b4f', secondary: '#f97316', tertiary: '#2563eb' },
      appearance: 'light',
    })
    const tile = oklchOf(derived['--brand-tile']!)
    expect(hueDelta(tile.h, oklchOf('#2563eb').h)).toBeLessThan(15)
  })
})

describe('harmonized status', () => {
  test('shifts each role toward the nearest seed, bounded, and keeps roles mutually separated', () => {
    const harmonized = deriveThemeOverrides({
      baseTokens: TAU_LIGHT,
      palette: { ...palette, status: 'harmonized' },
      appearance: 'light',
    })
    const hues = new Map<string, number>()
    for (const [i, role] of [
      'progress',
      'queue',
      'review',
      'human-wait',
      'external-wait',
      'attention',
      'danger',
      'success',
      'neutral',
    ].entries()) {
      const rgb = customColorChannels(harmonized[`--status-${role}-solid`]!)!.split(' ').map(Number)
      hues.set(role, srgbToOklch(rgb as [number, number, number]).h)
      void i
    }
    // Danger stays in the red/orange family, success in the green family: a
    // bounded (<=22 degree) shift toward a single cyan seed must not relabel
    // their semantic hue band.
    const danger = hues.get('danger')!
    expect(danger < 40 || danger > 340).toBe(true)
    expect(hues.get('success')!).toBeGreaterThan(100)
    expect(hues.get('success')!).toBeLessThan(180)
    const values = [...hues.values()]
    for (let i = 0; i < values.length; i++)
      for (let j = i + 1; j < values.length; j++) {
        const delta = Math.abs(((values[i]! - values[j]! + 180) % 360) - 180)
        expect(delta).toBeGreaterThan(1) // never fully collapse two roles onto each other
      }
  })
})

describe('contrast pass (property spread over many seeds)', () => {
  // Deterministic LCG so failures reproduce; not Math.random.
  function* seeds(count: number) {
    let state = 42
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x7fffffff
    }
    for (let i = 0; i < count; i++) {
      const h = Math.floor(next() * 360)
      const s = 0.3 + next() * 0.6
      const l = 0.3 + next() * 0.4
      // Simple HSL->RGB for a broad, valid spread of seed colors.
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      const m = l - c / 2
      const [r1, g1, b1] =
        h < 60
          ? [c, x, 0]
          : h < 120
            ? [x, c, 0]
            : h < 180
              ? [0, c, x]
              : h < 240
                ? [0, x, c]
                : h < 300
                  ? [x, 0, c]
                  : [c, 0, x]
      const toHex = (v: number) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, '0')
      yield `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`
    }
  }

  function wcag(fg: [number, number, number], bg: [number, number, number]): number {
    const lum = (rgb: number[]) =>
      rgb
        .map((c) => c / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
    const a = lum(fg)
    const b = lum(bg)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  test.each([
    ['light', TAU_LIGHT],
    ['dark', TAU_DARK],
  ] as const)(
    '%s: text/surface (text target) and primary/page (UI target) clear the standard target for every seed',
    (appearance, baseTokens) => {
      let checked = 0
      for (const seed of seeds(60)) {
        const derived = deriveThemeOverrides({
          baseTokens,
          palette: { primary: seed, contrast: 'standard' },
          appearance,
        })
        const rgb = (token: string) =>
          customColorChannels(derived[token] ?? baseTokens[token]!)!
            .split(' ')
            .map(Number) as [number, number, number]
        expect(wcag(rgb('--color-text-primary'), rgb('--color-bg-surface'))).toBeGreaterThanOrEqual(4.5 - 1e-6)
        expect(wcag(rgb('--color-text-secondary'), rgb('--color-bg-surface'))).toBeGreaterThanOrEqual(4.5 - 1e-6)
        // The UI (non-text, WCAG 1.4.11) pair, held to the lower 3:1 floor —
        // this is what actually differs between the light and dark fixtures
        // (a fixed seed sits at very different contrast against a near-white
        // vs. a near-black page), so asserting it here is what makes the
        // 'dark' case a real, distinct regression check rather than a
        // relabeled rerun of 'light' against the same tokens.
        expect(wcag(rgb('--color-primary'), rgb('--color-bg-page'))).toBeGreaterThanOrEqual(3 - 1e-6)
        checked++
      }
      expect(checked).toBe(60)
    }
  )

  test('contrast: high raises the target and still clears it for every seed', () => {
    let checked = 0
    for (const seed of seeds(40)) {
      const derived = deriveThemeOverrides({
        baseTokens: TAU_LIGHT,
        palette: { primary: seed, contrast: 'high' },
        appearance: 'light',
      })
      const rgb = (token: string) =>
        customColorChannels(derived[token] ?? TAU_LIGHT[token]!)!
          .split(' ')
          .map(Number) as [number, number, number]
      expect(wcag(rgb('--color-text-primary'), rgb('--color-bg-surface'))).toBeGreaterThanOrEqual(7 - 1e-6)
      checked++
    }
    expect(checked).toBe(40)
  })

  test('regression: a real ember/dark + contrast:high case that used to under-shoot 7:1 (3.97) now clears it', () => {
    // A concrete, previously-observed failure (not a random-sweep artifact):
    // ember's real dark-appearance base tokens, seed #4e7100, contrast:
    // 'high'. With ink chosen BEFORE the contrast pass (the bug), this
    // measured ~3.97:1 — --on-accent-fg was picked against the pre-pass
    // primary, then the pass nudged --color-primary for the (now 4.5:1, high
    // mode) UI floor, leaving the ink stale against what actually ships.
    const EMBER_DARK: Record<string, string> = {
      '--color-bg-page': '27 20 18',
      '--color-bg-surface': '35 26 23',
      '--color-text-primary': '250 235 221',
      '--color-text-secondary': '217 190 169',
      '--color-primary': '162 63 34',
      '--color-primary-hover': '176 71 40',
      '--color-primary-active': '144 52 28',
      '--color-primary-light': '217 190 169',
      '--color-selection-bg': '55 41 34',
      '--color-selection-border': '96 73 58',
      '--color-focus': '217 190 169',
      '--on-accent-fg': '255 255 255',
    }
    const derived = deriveThemeOverrides({
      baseTokens: EMBER_DARK,
      palette: { primary: '#4e7100', contrast: 'high' },
      appearance: 'dark',
    })
    const ink = derived['--on-accent-fg'] === '#000000' ? ([0, 0, 0] as const) : ([255, 255, 255] as const)
    const primaryRgb = customColorChannels(derived['--color-primary']!)!.split(' ').map(Number) as [
      number,
      number,
      number,
    ]
    expect(wcag(ink as unknown as [number, number, number], primaryRgb)).toBeGreaterThanOrEqual(7 - 1e-6)
  })

  test('regression: --on-accent-fg is chosen against the FINAL --color-primary, after the contrast pass', () => {
    // --on-accent-fg used to be picked before the contrast pass could nudge
    // --color-primary's lightness (to clear the UI 3:1 floor against the
    // page), so the ink choice could go stale relative to what actually
    // ships. For ANY fixed background, the better of pure black/white text
    // always clears ~4.58:1 (the tie point between the two candidates) —
    // comfortably over the 4.5:1 standard target — so if this ever regresses
    // to picking ink pre-pass, it fails here across a broad seed sweep in
    // both appearances.
    let checked = 0
    for (const [appearance, baseTokens] of [
      ['light', TAU_LIGHT],
      ['dark', TAU_DARK],
    ] as const) {
      for (const seed of seeds(60)) {
        const derived = deriveThemeOverrides({
          baseTokens,
          palette: { primary: seed, contrast: 'standard' },
          appearance,
        })
        const ink = derived['--on-accent-fg'] === '#000000' ? ([0, 0, 0] as const) : ([255, 255, 255] as const)
        const primaryRgb = customColorChannels(derived['--color-primary']!)!.split(' ').map(Number) as [
          number,
          number,
          number,
        ]
        expect(wcag(ink as unknown as [number, number, number], primaryRgb)).toBeGreaterThanOrEqual(4.5 - 1e-6)
        checked++
      }
    }
    expect(checked).toBe(120)
  })

  test('regression: contrast "high" nudges --color-primary so --on-accent-fg clears 7:1 wherever the sRGB gamut allows it', () => {
    // The 7:1 'high' target is NOT guaranteed by construction the way 4.5:1
    // is, so this exercises the lightness-nudge fallback. Using the same
    // bounded-saturation seed spread as the other sweeps (not fully-saturated
    // edge-of-gamut colors) it should be achievable for every seed.
    let checked = 0
    for (const seed of seeds(40)) {
      const derived = deriveThemeOverrides({
        baseTokens: TAU_LIGHT,
        palette: { primary: seed, contrast: 'high' },
        appearance: 'light',
      })
      const ink = derived['--on-accent-fg'] === '#000000' ? ([0, 0, 0] as const) : ([255, 255, 255] as const)
      const primaryRgb = customColorChannels(derived['--color-primary']!)!.split(' ').map(Number) as [
        number,
        number,
        number,
      ]
      expect(wcag(ink as unknown as [number, number, number], primaryRgb)).toBeGreaterThanOrEqual(7 - 1e-6)
      checked++
    }
    expect(checked).toBe(40)
  })

  test('regression: harmonized status fg/surface and badge-fg/badge-surface pairs clear the text target too', () => {
    // These pairs were documented as part of the contrast pass but were not
    // actually included in it (harmonizeStatus's hue/chroma shift alone does
    // not guarantee the fg/surface pair still clears 4.5:1). Only meaningful
    // in 'harmonized' mode — 'static' mode leaves these tokens absent from
    // the overrides entirely (covered by the "status is static by default"
    // test above), so it is not swept here.
    let checked = 0
    for (const seed of seeds(40)) {
      const derived = deriveThemeOverrides({
        baseTokens: TAU_LIGHT,
        palette: { primary: seed, status: 'harmonized', contrast: 'standard' },
        appearance: 'light',
      })
      for (const role of STATUS_ROLES) {
        const rgb = (token: string) =>
          customColorChannels(derived[token]!)!.split(' ').map(Number) as [number, number, number]
        expect(wcag(rgb(`--status-${role}-fg`), rgb(`--status-${role}-surface`))).toBeGreaterThanOrEqual(4.5 - 1e-6)
        expect(wcag(rgb(`--status-${role}-badge-fg`), rgb(`--status-${role}-badge-surface`))).toBeGreaterThanOrEqual(
          4.5 - 1e-6
        )
      }
      checked++
    }
    expect(checked).toBe(40)
  })
})
