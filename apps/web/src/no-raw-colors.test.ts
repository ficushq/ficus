import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanSourceForRawColors, type RawColorCategory } from './no-raw-colors.scanner'

// Complete app-owned color coverage. Palette utilities (including black/white),
// literal colors, and unreviewed inline color styles fail CI. Only bounded
// content/definition exceptions below remain; there is no legacy-file waiver.

type RawCategoryType = RawColorCategory
const srcRoot = join(import.meta.dir)

function isTestArtifact(path: string): boolean {
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx') ||
    path.endsWith('.fixture.ts') ||
    path.endsWith('.fixture.tsx') ||
    path.includes('/test/') ||
    path.includes('/tests/') ||
    path.includes('/fixtures/') ||
    path.includes('/__tests__/') ||
    path.includes('test-setup')
  )
}

// Only genuine content/definition exceptions survive the complete rollout.
// Match-level caps below prevent adding unrelated raw colors to these files.
const ALLOWLIST: Readonly<Record<RawCategoryType, readonly string[]>> = {
  'palette-utility': [
    'components/settings/PairingCode.tsx',
    'components/artifacts/ArtifactRenderer.tsx',
    'components/artifacts/PresentationRenderer.tsx',
  ],
  'palette-lookup': [],
  'literal-hex': ['components/settings/CustomThemeEditor.tsx'],
  'color-function': ['theme/flash.ts'],
  'inline-color-style': ['components/squads/SquadUniverse.tsx'],
}
const ENTRY_REASONS: Readonly<Record<string, string>> = {
  'components/settings/PairingCode.tsx': 'QR-code quiet zone belongs to the generated image, not app chrome.',
  'components/artifacts/ArtifactRenderer.tsx': 'Sandboxed user-authored HTML retains its document canvas.',
  'components/artifacts/PresentationRenderer.tsx':
    'Only sandboxed HTML canvas is exempt; surrounding presentation chrome is tokenized.',
  'components/settings/CustomThemeEditor.tsx': 'Theme-authoring sample and contrast endpoints, not app chrome.',
  'theme/flash.ts': 'Minimal pre-CSS builtin surface definitions, verified against authored CSS.',
  'components/squads/SquadUniverse.tsx': 'Hovered-node swatch comes from the live graph/status token reader.',
}

describe('no-raw-colors guard', () => {
  test('content exceptions allow only one white image/document canvas each', () => {
    for (const path of ALLOWLIST['palette-utility']) {
      const findings = scanSourceForRawColors(path, readFileSync(join(srcRoot, path), 'utf8'))
      expect(findings.map(({ category, match }) => ({ category, match }))).toEqual([
        { category: 'palette-utility', match: 'bg-white' },
      ])
    }
  })

  test('the Universe exception is one live token-derived swatch, not arbitrary inline colors', () => {
    const source = readFileSync(join(srcRoot, 'components/squads/SquadUniverse.tsx'), 'utf8')
    expect(scanSourceForRawColors('universe.tsx', source).map(({ category, match }) => ({ category, match }))).toEqual([
      { category: 'inline-color-style', match: 'style={{ … backgroundColor … }}' },
    ])
    expect(source).toContain('squadGraphColor(colors, hoveredNode.status)')
    expect(source).toContain("agentGraphColor(colors, hoveredNode.status as Agent['status'])")
  })

  test('theme authoring exceptions remain bounded to color data, not UI styles', () => {
    const editor = scanSourceForRawColors(
      'editor.tsx',
      readFileSync(join(srcRoot, 'components/settings/CustomThemeEditor.tsx'), 'utf8')
    )
    expect(editor.map(({ category, match }) => ({ category, match }))).toEqual([
      { category: 'literal-hex', match: '#336699' },
      { category: 'literal-hex', match: '#000000' },
      { category: 'literal-hex', match: '#ffffff' },
    ])
    // 15 = one --color-bg-surface fallback per built-in theme (ficus/iris/
    // harbor/ember light+dark = 8, high-contrast = 1, six BigBrain-ported
    // constants = 6).
    const flash = scanSourceForRawColors('flash.ts', readFileSync(join(srcRoot, 'theme/flash.ts'), 'utf8'))
    expect(flash).toHaveLength(15)
    expect(flash.every(({ category }) => category === 'color-function')).toBe(true)
  })
  test('every raw-color category in apps/web/src is allowlisted (no NEW violations)', () => {
    const files = [...new Bun.Glob('**/*.{ts,tsx,js,jsx,css}').scanSync({ cwd: srcRoot })]
      .filter((path) => !isTestArtifact(path))
      .sort()
    expect(files.length).toBeGreaterThan(500)

    const offenders: string[] = []
    const allowlistHits = new Set<string>()
    for (const path of files) {
      const findings = scanSourceForRawColors(path, readFileSync(join(srcRoot, path), 'utf8'))
      for (const finding of findings) {
        const allowed = ALLOWLIST[finding.category]!.includes(path)
        const key = `${finding.category}:${path}`
        if (allowed) {
          allowlistHits.add(key)
          continue
        }
        offenders.push(`${path}:${finding.line} [${finding.category}] ${finding.match}`)
      }
    }

    // Stale allowlist entries are failures too: they hide shrinkage and make
    // the ratchet meaningless. When a file is migrated, remove its entry.
    const stale: string[] = []
    for (const [category, paths] of Object.entries(ALLOWLIST)) {
      for (const path of paths) {
        if (!allowlistHits.has(`${category}:${path}`)) stale.push(`${category}: ${path}`)
      }
    }

    expect(
      `NEW raw colors (use theme tokens; see src/index.css + tailwind.config.js):\n${offenders.join('\n')}\nSTALE allowlist entries (migrated files must be removed from the allowlist):\n${stale.join('\n')}`
    ).toBe(
      `NEW raw colors (use theme tokens; see src/index.css + tailwind.config.js):\n\nSTALE allowlist entries (migrated files must be removed from the allowlist):\n`
    )
  })

  test('exception-policy annotations reference allowlisted files only', () => {
    const allowed = new Set(Object.values(ALLOWLIST).flatMap((paths) => [...paths]))
    const unknown = Object.keys(ENTRY_REASONS).filter((path) => !allowed.has(path))
    expect(unknown).toEqual([])
  })

  test('every allowlisted path exists on disk (the inventory tracks real files)', () => {
    const missing: string[] = []
    for (const paths of Object.values(ALLOWLIST)) {
      for (const path of paths) {
        if (!existsSync(join(srcRoot, path))) missing.push(path)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('raw-color detector', () => {
  test('flags Tailwind palette utilities, including under variant prefixes', () => {
    const source = '<div className="bg-gray-50 dark:text-blue-700 md:bg-red-500/30 border-slate-200" />'
    const findings = scanSourceForRawColors('synthetic.tsx', source)
    expect(findings.filter((f) => f.category === 'palette-utility').map((f) => f.match)).toEqual([
      'bg-gray-50',
      'dark:text-blue-700',
      'md:bg-red-500/30',
      'border-slate-200',
    ])
  })

  test('detects black/white escape hatches but ignores numeric HTML entities', () => {
    const source = '<div className="bg-black/50 dark:text-white hover:border-white/20">&#10003;</div>'
    expect(scanSourceForRawColors('synthetic.tsx', source).map((f) => f.match)).toEqual([
      'bg-black/50',
      'dark:text-white',
      'hover:border-white/20',
    ])
  })

  test('does not flag semantic token utilities or bare words', () => {
    const source = '<div className="bg-surface text-primary border-th-border divide-th-border/50 bg-page" />'
    expect(scanSourceForRawColors('synthetic.tsx', source)).toEqual([])
  })

  test('flags literal hex colors', () => {
    const findings = scanSourceForRawColors('synthetic.tsx', "const c = '#c4b5fd'; const d = '#ff000080';")
    expect(findings.map((f) => f.match)).toEqual(['#c4b5fd', '#ff000080'])
  })

  test('flags literal color functions but not token-wrapped or dynamic ones', () => {
    const source = [
      'a { background: rgb(var(--color-bg-surface)); }', // sanctioned channel wrapper
      'b { background: rgb(var(--color-bg-surface) / 0.5); }', // wrapper + alpha
      'c { background: color-mix(in srgb, rgb(var(--color-primary)) 10%, transparent); }', // token-only mix
      'd { background: rgba(156, 163, 175, 0.5); }', // literal
      'e { background: rgb(16 17 28); }', // literal channels
      'f { background: rgb(${channels}); }', // dynamic construction (runtime token read)
    ].join('\n')
    const findings = scanSourceForRawColors('synthetic.css', source).filter((f) => f.category === 'color-function')
    expect(findings.map((f) => f.line)).toEqual([4, 5])
  })

  test('accepts relative colors derived from a token but not from a literal origin', () => {
    for (const source of [
      'oklch(from rgb(var(--color-primary)) l c calc(h + 45))',
      'oklch(from rgb(var(--color-primary)) calc(l + 0.2) calc(c * 0.6) h)',
      'oklch(from var(--brand) l c h / 0.5)',
      'oklch(from rgb(var(--color-primary)) 0.62 max(c, 0.14) calc(h + 30))',
    ])
      expect(scanSourceForRawColors('synthetic.css', source)).toEqual([])
    for (const source of [
      'oklch(from #336699 l c h)',
      'oklch(from rgb(1 2 3) l c calc(h + 45))',
      'oklch(from rgb(var(--color-primary)) l c red)',
    ])
      expect(scanSourceForRawColors('synthetic.css', source).length).toBeGreaterThan(0)
  })

  test('accepts channel and opacity tokens together without allowing literal channels', () => {
    const compliant = 'border-color: rgb(var(--color-panel-border) / var(--opacity-panel-border))'
    expect(scanSourceForRawColors('synthetic.css', compliant)).toEqual([])
    const literal = 'border-color: rgb(94 75 132 / var(--opacity-panel-border))'
    expect(scanSourceForRawColors('synthetic.css', literal).map((finding) => finding.category)).toEqual([
      'color-function',
    ])
  })

  test('accepts compiler split channels and alpha but still rejects literal channel fallbacks', () => {
    for (const source of [
      'rgb(var(--custom-rgb-color-primary, var(--color-primary)) / calc(var(--custom-alpha-color-primary, 1) * 0.5))',
      'rgb(var(--custom-rgb-status-danger-surface, var(--status-danger-surface)) / calc(var(--custom-alpha-status-danger-surface, 1) * var(--opacity-status-danger-surface) * 0.5))',
    ])
      expect(scanSourceForRawColors('example.ts', source)).toEqual([])
    for (const source of [
      'rgb(var(--x, 1 2 3))',
      'rgb(var(--x, rgb(1 2 3)) / 0.5)',
      'rgb(1 2 3 / calc(var(--alpha, 1) * 0.5))',
    ])
      expect(scanSourceForRawColors('example.ts', source).length).toBeGreaterThan(0)
  })

  test('flags color-bearing inline styles but not layout-only ones', () => {
    const colorBearing = '<span style={{ backgroundColor: node.color }} />'
    const layoutOnly = '<div style={{ height: 120, translateY: 4, maxWidth: `calc(${n}px)` }} />'
    expect(scanSourceForRawColors('synthetic.tsx', colorBearing).map((f) => f.category)).toEqual(['inline-color-style'])
    expect(scanSourceForRawColors('synthetic.tsx', layoutOnly)).toEqual([])
  })
})

test('detects directional, axis, logical and ring-offset palette escapes', () => {
  for (const prefix of [
    'border-t',
    'border-r',
    'border-b',
    'border-l',
    'border-x',
    'border-y',
    'border-s',
    'border-e',
    'ring-offset',
  ]) {
    for (const color of ['purple-600', 'gray-950', 'white', 'black/50']) {
      const utility = `dark:hover:${prefix}-${color}`
      expect(scanSourceForRawColors('example.tsx', `<span className="${utility}" />`).map((f) => f.match)).toEqual([
        utility,
      ])
    }
    expect(scanSourceForRawColors('example.tsx', `${prefix}-status-danger-600 ${prefix}-transparent`)).toEqual([])
  }
})

test('detects raw CSS theme palette lookups without rejecting semantic lookups', () => {
  for (const lookup of [
    "theme('colors.red.600')",
    'theme("colors.red.400 / 50%")',
    "theme('colors.white')",
    'theme(colors.black)',
    "theme('colors[blue][500]')",
  ]) {
    expect(scanSourceForRawColors('example.css', `a { color: ${lookup}; }`).map((f) => f.match)).toEqual([lookup])
  }
  expect(
    scanSourceForRawColors(
      'example.css',
      "a { color: theme('colors.status-danger-600'); } b { color: rgb(var(--status-danger-600)); }"
    )
  ).toEqual([])
})
