/**
 * Source guard for buttons. `ficus-button` is only a base (radius, weight, transitions); alone it draws
 * no fill and no border, so a padded `ficus-button` reads as weirdly indented text until hovered. Every
 * className that carries the base must pair it with exactly one variant from design-system.css:
 *
 *   ficus-button-primary    the one main action of a page, dialog or form
 *   ficus-button-secondary  standalone actions in content (card CTAs, row actions, Cancel)
 *   ficus-button-ghost      icon-only buttons and compact controls in a toolbar, header, menu or cluster
 *   ficus-button-link       inline text actions in running text or a section header (no horizontal padding)
 *   ficus-button-danger     destructive actions
 *
 * The variant may be picked dynamically (a ternary or clsx among variants, or a same-file constant or
 * object of variant strings); every resolved path must still carry the base plus exactly one variant.
 * See AGENTS.md "Shared components" for when to use which.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUTTON_VARIANTS, scanButtonVariants, type ButtonVariantFinding } from '../test/buttonVariantAnalysis'

const SRC = join(import.meta.dir, '..')

/**
 * Class expressions the guard cannot resolve but that are correct, keyed by `path` plus a fragment of
 * the expression, each with the reason. Keep this tiny: prefer writing the base and the variant together.
 */
const ALLOWLIST: Array<{ path: string; contains: string; why: string }> = []

/** Horizontal padding classes; an inline link must have none, or it reads as an indented button. */
const HORIZONTAL_PADDING = /(?<![\w-])-?p[xlrse]?-(?:\d|\[)/

function sources(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = []
  for (const entry of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: SRC })) {
    const path = entry.replaceAll('\\', '/')
    if (/\.(test|spec)\.tsx?$/.test(path) || path.startsWith('test/')) continue
    files.push({ path, text: readFileSync(join(SRC, path), 'utf8') })
  }
  return files
}

const describe = (finding: ButtonVariantFinding) =>
  `${finding.path}:${finding.line} resolves to [${finding.combinations.join(' | ')}]: ${finding.expression.slice(0, 160)}`

function problems(findings: ButtonVariantFinding[]): string[] {
  const out: string[] = []
  for (const finding of findings) {
    if (ALLOWLIST.some((entry) => entry.path === finding.path && finding.expression.includes(entry.contains))) continue
    if (!finding.ok) out.push(describe(finding))
    else if (
      finding.combinations.some((combo) => combo.includes('ficus-button-link')) &&
      HORIZONTAL_PADDING.test(finding.expression)
    )
      out.push(`${describe(finding)} (ficus-button-link must not carry horizontal padding)`)
  }
  return out
}

function scanSnippet(source: string) {
  return problems(scanButtonVariants(source, 'fixture.tsx'))
}

test('every ficus-button className pairs the base with exactly one variant', () => {
  const findings = sources().flatMap(({ path, text }) => scanButtonVariants(text, path))
  expect(findings.length).toBeGreaterThan(300)
  expect(problems(findings)).toEqual([])
})

test('the allowlist only names expressions that still exist and still need it', () => {
  const findings = sources().flatMap(({ path, text }) => scanButtonVariants(text, path))
  for (const entry of ALLOWLIST) {
    const match = findings.find((finding) => finding.path === entry.path && finding.expression.includes(entry.contains))
    expect(match, `${entry.path}: ${entry.contains}`).toBeDefined()
    expect(match!.ok, `${entry.path}: ${entry.contains} now passes; drop it from the allowlist`).toBe(false)
  }
})

test('design-system.css defines every variant the guard accepts', () => {
  const css = readFileSync(join(SRC, 'design-system.css'), 'utf8')
  for (const variant of BUTTON_VARIANTS) expect(css).toContain(`.${variant} {`)
})

test('the guard catches the base-only ghost pattern and its look-alikes', () => {
  // The bug this guard exists for: padded, transparent text that only shows a fill on hover.
  expect(
    scanSnippet(
      `<button className="ficus-button min-h-10 px-3 py-2 text-sm text-muted hover:text-primary hover:bg-surface-hover">Review and decide</button>`
    )
  ).toHaveLength(1)
  expect(scanSnippet(`<button className="ficus-button">Retry</button>`)).toHaveLength(1)
  // A variant that only applies some of the time leaves the other path bare.
  expect(scanSnippet(`<b className={clsx('ficus-button px-3', active && 'ficus-button-primary')} />`)).toHaveLength(1)
  expect(scanSnippet(`<b className={active ? 'ficus-button ficus-button-primary' : 'ficus-button'} />`)).toHaveLength(1)
  // Two variants at once, or a variant without the base.
  expect(scanSnippet(`<b className="ficus-button ficus-button-primary ficus-button-secondary" />`)).toHaveLength(1)
  expect(scanSnippet(`<b className={clsx(SIZE, 'ficus-button-primary')} />`)).toHaveLength(1)
  // A shared base-only constant is the same trap one indirection away.
  expect(scanSnippet(`const button = 'ficus-button px-3 py-2'\nconst x = <b className={button} />`)).toHaveLength(1)
  // An inline link with horizontal padding reads as an indented button again.
  expect(scanSnippet(`<b className="ficus-button ficus-button-link px-2 text-xs">Dismiss</b>`)).toHaveLength(1)
})

test('the guard accepts a variant chosen dynamically among variants', () => {
  const ok = [
    `<b className="ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm">View</b>`,
    `<b className={clsx('ficus-button px-3', active ? 'ficus-button-primary' : 'ficus-button-secondary')} />`,
    `<b className={\`ficus-button \${danger ? 'ficus-button-danger' : 'ficus-button-ghost'} p-2\`} />`,
    `const VARIANT = { a: 'ficus-button ficus-button-ghost', b: 'ficus-button ficus-button-danger' } as const\nconst x = <b className={clsx(VARIANT[v], 'p-2')} />`,
    `const size = 'px-3 py-2'\nconst button = \`ficus-button ficus-button-secondary \${size}\`\nconst x = <b className={button} />`,
    // A branch that is not a button at all carries no button class.
    `<a className={needsAccess ? 'ficus-button ficus-button-primary px-3' : 'text-accent-light hover:underline'} />`,
    `<b className="ficus-button ficus-button-link text-xs">Dismiss</b>`,
  ]
  for (const source of ok) expect(scanSnippet(source), source).toEqual([])
})
