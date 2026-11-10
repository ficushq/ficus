import { compile } from '@tailwindcss/node'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Root } from 'postcss'

const srcRoot = join(import.meta.dir, '..')

/** The production Tailwind configuration: theme, variants and plugins (src/tailwind.css). */
export const tailwindConfigPath = join(srcRoot, 'tailwind.css')

/**
 * Compile exactly these candidates with the production configuration (src/tailwind.css) and return
 * the generated utilities as a PostCSS root. Content scanning is replaced by the candidate list, so
 * the output is what Vite would emit for these classes and nothing else.
 */
export async function compileUtilities(candidates: Iterable<string>): Promise<Root> {
  const compiler = await compile(
    "@import 'tailwindcss/theme.css' layer(theme);\n@import './tailwind.css';\n@tailwind utilities;\n",
    { base: srcRoot, onDependency: () => {} }
  )
  const root = postcss.parse(compiler.build([...candidates]))
  // @tailwind utilities is not wrapped in a layer here: keep the top-level rules and the at-rules
  // that wrap variants (@media, @supports), and drop the theme and base layers and @property.
  root.each((node) => {
    if (node.type === 'atrule' && (node.name === 'layer' || node.name === 'property')) node.remove()
  })
  // Theme values keep Prettier's line breaks from src/tailwind.css; the production build minifies them.
  root.walkDecls((decl) => {
    decl.value = oneLine(decl.value)
  })
  return root
}

/** Collapse Prettier's line breaks inside a CSS value onto one line, without padding inside parentheses. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')')
}

/** Unescape a CSS class selector fragment (`hover\:bg-surface\/50` → `hover:bg-surface/50`). */
export function unescapeClass(escaped: string): string {
  return escaped
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(.)/g, '$1')
}

/**
 * Declarations per generated class, keyed by the class name as written in markup. Declarations in
 * nested at-rules (Tailwind wraps the color-mix() form of an opacity modifier in @supports) come
 * later and replace the fallback, which is what every browser Tailwind 4 supports applies.
 */
export function utilityDeclarations(root: Root): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>()
  root.walkRules((rule) => {
    if (rule.parent?.type === 'rule') return
    // Drop :where() groups (group/peer markers, typography's not-prose guard), then the first class
    // is the utility: `.prose-a\:x :is(...)`, `:is(:where(.group):hover .group-hover\:x)`.
    let selector = rule.selector
    while (/:where\([^()]*\)/.test(selector)) selector = selector.replace(/:where\([^()]*\)/g, '')
    const match = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/.exec(selector)
    if (!match) return
    const name = unescapeClass(match[1]!)
    const declarations = result.get(name) ?? {}
    rule.walkDecls((decl) => {
      declarations[decl.prop] = decl.value
    })
    result.set(name, declarations)
  })
  return result
}

/**
 * Evaluate the color arithmetic Tailwind emits once variables are substituted: calc() products of
 * scalar alphas, then an opacity modifier's color-mix() of a channel color with `transparent` at
 * P%, which only scales the alpha by P/100 (premultiplied interpolation keeps the channels).
 */
export function evaluateColorMath(value: string): string {
  const product = (factors: string) =>
    String(
      factors
        .split('*')
        .map(Number)
        .reduce((a, b) => a * b, 1)
    )
  value = value.replace(/calc\(([\d.\s*]+)\)/g, (_, factors: string) => product(factors))
  return value.replace(
    /color-mix\(in oklab, rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\) ([\d.]+)%, transparent\)/g,
    (_, r: string, g: string, b: string, alpha: string, percent: string) =>
      `rgb(${r} ${g} ${b} / ${product(`${alpha} * ${Number(percent) / 100}`)})`
  )
}

/** The `--color-*` utility colors declared in src/tailwind.css, as [utility name, value]. */
export function themeColors(): Array<[string, string]> {
  const colors: Array<[string, string]> = []
  postcss.parse(readFileSync(tailwindConfigPath, 'utf8')).walkAtRules('theme', (theme) => {
    theme.walkDecls(/^--color-/, (decl) => {
      colors.push([decl.prop.slice('--color-'.length), oneLine(decl.value)])
    })
  })
  return colors
}
