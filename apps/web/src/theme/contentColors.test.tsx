import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../../tailwind.config.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { syntaxTheme } from './syntax'
import { readTerminalTheme, terminalTokenColor } from './terminal'
import { scanSourceForRawColors } from '../no-raw-colors.scanner'
import legacy from './fixtures/legacy-content-colors.json'

const src = join(import.meta.dir, '..')
const css = readFileSync(join(src, 'index.css'), 'utf8')
const sheet = postcss.parse(css)
const rules: Record<string, Record<string, string>> = {}
sheet.walkRules((rule) => {
  const values: Record<string, string> = {}
  rule.walkDecls((decl) => {
    values[decl.prop] = decl.value
  })
  for (const selector of rule.selectors) rules[selector] = values
})
const scopes = { light: rules[':root']!, dark: rules['.dark']! }

function substitute(value: string, variables: Record<string, string>): string {
  for (let i = 0; value.includes('var(') && i < 20; i++) {
    value = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name: string, fallback?: string) => {
      if (!variables[name] && !fallback) throw new Error(`Missing ${name}`)
      return variables[name] ?? fallback!
    })
  }
  expect(value).not.toContain('var(')
  return value.replace(/calc\(([\d.\s*]+)\)/g, (_, factors: string) =>
    String(
      factors
        .split('*')
        .map(Number)
        .reduce((a, b) => a * b, 1)
    )
  )
}

/** Normalize to painted 8-bit channels, as browsers do for the legacy HSL. */
function normalizeColors(value: string): string {
  value = value.replace(/hsla?\(([^)]+)\)/g, (_, channels: string) => {
    const [h, s, l, a = 1] = channels.match(/[\d.]+/g)!.map(Number)
    const saturation = s! / 100
    const lightness = l! / 100
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
    const x = chroma * (1 - Math.abs(((h! / 60) % 2) - 1))
    const m = lightness - chroma / 2
    const values = [
      [chroma, x, 0],
      [x, chroma, 0],
      [0, chroma, x],
      [0, x, chroma],
      [x, 0, chroma],
      [chroma, 0, x],
    ][Math.floor(h! / 60)]!
    return `rgba(${values.map((v) => (v + m) * 255).join(',')},${a})`
  })
  value = value.replace(/rgba?\(([^)]+)\)/g, (_, channels: string) => {
    const values = channels.match(/[\d.]+/g)!.map(Number)
    return (
      '#' +
      [...values.slice(0, 3), (values[3] ?? 1) * 255].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
    )
  })
  return value.replace(
    /#([\da-f]{3}|[\da-f]{6})\b/gi,
    (_, hex: string) => '#' + (hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex) + 'ff'
  )
}

const samples = {
  javascript: 'const n = 12; // note\nfunction greet(name) { return `hi ${name}`; }\nlet ok = true; const x = /a+/g;',
  typescript: 'interface Person { name: string; age?: number }\nexport const user: Person = { name: "Ficus" };',
  jsx: 'export function View() { return <div title="sample">{value + 1}</div> }',
  python: '# note\nclass Widget:\n  def run(self):\n    return True and 1.25',
  bash: '# comment\necho "$HOME" && cat file.txt | grep --color "hi"',
  json: '{"number": 1, "boolean": true, "null": null}',
  css: '/* note */ .box { color: red !important; background: url("a.png"); }',
  markdown: '# Title\n**bold** *italic* ~~gone~~\n[link](https://example.com)\n> quote\n- list\n`code`',
  diff: '+added\n-removed\n context',
  text: 'unhighlighted file content',
}

describe('default content palette parity', () => {
  for (const [appearance, variables] of Object.entries(scopes)) {
    test(`${appearance}: every rendered syntax style retains oneDark parity except the two approved contrast deltas`, () => {
      for (const [language, content] of Object.entries(samples)) {
        for (const showLineNumbers of [false, true]) {
          const before = renderToStaticMarkup(
            <SyntaxHighlighter language={language} style={oneDark} showLineNumbers={showLineNumbers}>
              {content}
            </SyntaxHighlighter>
          )
          const after = renderToStaticMarkup(
            <SyntaxHighlighter language={language} style={syntaxTheme} showLineNumbers={showLineNumbers}>
              {content}
            </SyntaxHighlighter>
          )
          // Owner approved these two palette corrections in phase 5 (2026-09-21).
          // Keep all other colors, emitted classes, grouping and typography exact.
          const expected = normalizeColors(before)
            .replaceAll('#5c6370ff', '#8e95a2ff') // comment: 2.308 → 4.634
            .replaceAll('#e06c75ff', '#e37079ff') // property: 4.375 → 4.567
          expect(normalizeColors(substitute(after, variables))).toBe(expected)
        }
      }
    })

    test(`${appearance}: xterm matches all 21 legacy surface/ANSI colors and keeps selected ANSI ink`, () => {
      const theme = readTerminalTheme({ getPropertyValue: (name) => substitute(variables[name]!, variables) })
      for (const [key, color] of Object.entries(legacy.terminal)) {
        expect(normalizeColors(theme[key as keyof typeof legacy.terminal]!)).toBe(normalizeColors(color))
      }
      expect(theme.selectionForeground).toBeUndefined()
      expect(variables['--term-scrollbar-thumb']).toBe('auto')
      expect(substitute(variables['--term-scrollbar-thumb-hover']!, variables)).toBe('auto')
      expect(substitute(variables['--term-scrollbar-thumb-active']!, variables)).toBe('auto')
    })

    test(`${appearance}: every ANSI foreground/background declaration retains its exact legacy cascade`, () => {
      for (const [className, light] of Object.entries(legacy.ansi.light)) {
        const current = { ...rules[`.${className}`], ...(appearance === 'dark' ? rules[`.dark .${className}`] : {}) }
        const expected = {
          ...light,
          ...(appearance === 'dark' ? legacy.ansi.dark[className as keyof typeof legacy.ansi.dark] : {}),
        }
        expect(Object.keys(current).sort()).toEqual(Object.keys(expected).sort())
        for (const [property, color] of Object.entries(expected)) {
          expect(normalizeColors(substitute(current[property]!, variables))).toBe(normalizeColors(color))
        }
      }
      // Light backgrounds historically do NOT suppress an explicit SGR foreground.
      if (appearance === 'light') expect(rules['.ansi-bg-red']!['color']).toBeUndefined()
    })

    test(`${appearance}: supporting component colors and intrinsic opacity metadata remain intact`, () => {
      const expected = {
        '--syntax-memory-bg': '#0e0f1a',
        '--syntax-image-bg': '#1e1e1e',
        '--syntax-error-fg': '#ef4444',
        '--syntax-human-link': '#bfdbfe',
        '--syntax-human-code-fg': '#dbeafe',
        '--syntax-human-code-bg': '#1d4ed8',
        '--term-loading-bg': '#374151',
        '--term-muted': '#767d8b', // approved contrast correction: 3.942 → 4.607,
      }
      for (const [token, color] of Object.entries(expected)) {
        expect(normalizeColors(`rgb(${variables[token]})`)).toBe(normalizeColors(color))
      }
      expect(variables['--opacity-input-border']).toBe(appearance === 'dark' ? '0.16' : '1')
      expect(variables['--opacity-panel-border']).toBe('0.12')
    })
  }

  test('generated component utilities retain fully substituted colors and human-code alpha', async () => {
    const pairs = [
      ['bg-[#0e0f1a]', 'bg-[rgb(var(--term-bg))]', 'background-color'],
      ['bg-[#1e1e1e]', 'bg-[rgb(var(--syntax-image-bg))]', 'background-color'],
      ['text-red-500', 'text-[rgb(var(--syntax-error-fg))]', 'color'],
      ['bg-gray-700', 'bg-[rgb(var(--term-loading-bg))]', 'background-color'],
      // Phase 5 approved muted ink replaces gray-500; other utility pairs retain parity.
      ['text-[#767d8b]', 'text-[rgb(var(--term-muted))]', 'color'],
      ['prose-a:text-blue-200', 'prose-a:text-[rgb(var(--syntax-human-link))]', 'color'],
      ['prose-code:text-blue-100', 'prose-code:text-[rgb(var(--syntax-human-code-fg))]', 'color'],
      [
        'prose-code:bg-blue-700/50',
        'prose-code:bg-[rgb(var(--custom-rgb-syntax-human-code-bg,var(--syntax-human-code-bg))/calc(var(--custom-alpha-syntax-human-code-bg,1)*0.5))]',
        'background-color',
      ],
    ] as const
    const compiled = await postcss([
      tailwindcss({
        ...tailwindConfig,
        content: [{ raw: pairs.flatMap(([before, after]) => [before, after]).join(' '), extension: 'html' }],
      }),
    ]).process('@tailwind utilities', { from: undefined })
    const generated: Record<string, Record<string, string>> = {}
    compiled.root.walkRules((rule) => {
      // Keep the utility itself, dropping typography's descendant selector.
      const utility = rule.selector
        .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replaceAll('\\', '')
        .split(' :is')[0]!
        .slice(1)
      const declarations: Record<string, string> = {}
      rule.walkDecls((decl) => {
        declarations[decl.prop] = decl.value
      })
      generated[utility] = declarations
    })
    for (const variables of Object.values(scopes)) {
      for (const [before, after, property] of pairs) {
        expect(generated[before]).toBeDefined()
        expect(generated[after]).toBeDefined()
        expect(normalizeColors(substitute(generated[after]![property]!, { ...variables, ...generated[after] }))).toBe(
          normalizeColors(substitute(generated[before]![property]!, { ...variables, ...generated[before] }))
        )
      }
    }
  })

  test('named consumers and the ANSI rules are guarded with no raw colors', () => {
    for (const path of [
      'components/MarkdownContent.tsx',
      'components/workspace/FileViewer.tsx',
      'components/memory/MemoryFileViewer.tsx',
      'components/workspace/Terminal.tsx',
      'components/workspace/TerminalTabs.tsx',
      'theme/syntax.ts',
      'theme/terminal.ts',
    ]) {
      const source = readFileSync(join(src, path), 'utf8')
      expect(scanSourceForRawColors(path, source)).toEqual([])
      expect(source).not.toContain('import { oneDark }')
    }
    const ansi = css.slice(css.indexOf('   ANSI TERMINAL COLORS'))
    expect(scanSourceForRawColors('index.css', ansi)).toEqual([])
  })

  test('xterm receives concrete comma-form colors, including alpha and opt-out sentinels', () => {
    expect(terminalTokenColor('1 2 3')).toBe('rgb(1, 2, 3)')
    expect(terminalTokenColor('1 2 3 / 0.2')).toBe('rgba(1, 2, 3, 0.2)')
    expect(terminalTokenColor('none')).toBeUndefined()
    expect(terminalTokenColor('auto')).toBeUndefined()
  })
})

// These ranges deliberately accommodate the legacy orange-ish terminal yellow,
// pink-ish magenta and turquoise cyan. They reject role swaps, not tasteful restyles.
const hueRanges = {
  red: [345, 20],
  green: [75, 165],
  yellow: [25, 75],
  blue: [195, 255],
  magenta: [270, 345],
  cyan: [165, 195],
}

describe('terminal content colors keep ANSI hue semantics', () => {
  for (const [appearance, variables] of Object.entries(scopes)) {
    test(`${appearance}: all standard/bright terminal and streamed ANSI slots keep their named hue`, () => {
      for (const prefix of [
        '--term-',
        '--term-bright-',
        '--ansi-',
        '--ansi-bright-',
        '--ansi-bg-',
        '--ansi-bg-bright-',
      ]) {
        for (const [slot, [low, high]] of Object.entries(hueRanges)) {
          const [r, g, b] = substitute(variables[prefix + slot]!, variables)
            .split(/\s+/)
            .map(Number) as [number, number, number]
          const max = Math.max(r, g, b),
            min = Math.min(r, g, b),
            delta = max - min
          expect(delta).toBeGreaterThan(0)
          const hue =
            ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360
          expect(low! > high! ? hue >= low! || hue <= high! : hue >= low! && hue <= high!).toBe(true)
        }
      }
    })
  }
})
