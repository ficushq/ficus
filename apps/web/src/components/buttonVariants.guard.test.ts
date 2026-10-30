/**
 * Source guard for buttons. `ficus-button` is only a base (radius, weight, transitions); alone it draws
 * no fill and no border, so a padded `ficus-button` reads as weirdly indented text until hovered. Every
 * className that carries the base must pair it with exactly one variant from design-system.css:
 *
 *   ficus-button-primary    the one main action of a page, dialog or form
 *   ficus-button-secondary  actions needing emphasis or a visible boundary (card CTAs, row actions, Cancel)
 *   ficus-button-ghost      non-primary actions, icon-only buttons and compact toolbar controls
 *   ficus-button-link       navigation only (no horizontal padding)
 *   ficus-button-danger     destructive actions
 *
 * The variant may be picked dynamically (a ternary or clsx among variants, or a same-file constant or
 * object of variant strings); every resolved path must still carry the base plus exactly one variant.
 * A `<button>` acts rather than navigates, so it may resolve to the link variant only when listed in
 * NAVIGATING_BUTTONS. See AGENTS.md "Shared components" for when to use which.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUTTON_VARIANTS,
  scanButtonVariants,
  scanLinkStyledButtons,
  type ButtonVariantFinding,
} from '../test/buttonVariantAnalysis'

const SRC = join(import.meta.dir, '..')

/**
 * Class expressions the guard cannot resolve but that are correct, keyed by `path` plus a fragment of
 * the expression, each with the reason. Keep this tiny: prefer writing the base and the variant together.
 */
const ALLOWLIST: Array<{ path: string; contains: string; why: string }> = []

/**
 * `<button>` elements that keep link styling because activating them navigates: they show another
 * entity or view in place of the current one, with no URL to put in an anchor. Every other action on a
 * `<button>` uses a real button variant (usually ghost). Keyed by `path` plus a fragment of the
 * `className` that matches exactly one button, each with the reason. Keep this short: prefer an anchor
 * or router `Link` for navigation, and a button variant for anything else.
 */
const NAVIGATING_BUTTONS: Array<{ path: string; contains: string; why: string }> = [
  {
    path: 'components/EntityReferenceLink.tsx',
    contains: 'inline underline',
    why: 'An entity reference inside prose that opens the entity; padding would break the line of text.',
  },
  {
    path: 'components/MessageContent.tsx',
    contains: 'mt-2 inline-flex',
    why: 'View work stream: opens the work stream panel.',
  },
  {
    path: 'components/ToolInlineActions.tsx',
    contains: 'truncate text-left',
    why: 'Opens the monitor, work stream, artifact or other entity a tool call names.',
  },
  {
    path: 'components/UnifiedAssistant.tsx',
    contains: 'ml-auto shrink-0',
    why: 'Assistant: goes back to the Assistant view in the panel’s navigation stack.',
  },
  {
    path: 'components/UnifiedAssistant.tsx',
    contains: 'ficus-button-link text-xs',
    why: 'Continue current chat: pushes the current Assistant chat onto the panel’s navigation stack.',
  },
  {
    path: 'components/WorkStreamDependencies.tsx',
    contains: 'col-span-2 grid',
    why: 'A dependency title that opens that work stream.',
  },
  {
    path: 'components/WorkflowReviewModal.tsx',
    contains: 'linkClass',
    why: 'Opens the work stream under review; the same control is a router Link when there is no handler.',
  },
  {
    path: 'components/WorkflowRevisionChanges.tsx',
    contains: 'text-left text-sm',
    why: 'A changed or added file name in the review’s “what changed” list that opens that file’s tab.',
  },
  {
    path: 'components/monitors/MonitorsList.tsx',
    contains: 'font-medium',
    why: 'A monitor’s name in its table row that opens the monitor’s details.',
  },
  {
    path: 'components/settings/AgentTypesSection.tsx',
    contains: 'ficus-button-link text-sm',
    why: 'Used by N types: switches to the agent types list filtered to this tier.',
  },
]

/** Horizontal padding classes; an inline link must have none, or it reads as an indented button. */
const HORIZONTAL_PADDING = /(?<![\w-])-?p[xlrse]?-(?:\d|\[)/

/**
 * A link quieted to a neutral color: muted at rest, or hovering to primary text. Either way the hover jumps
 * to bright, underlined text (near-white in dark mode) unlike any other control. Use the plain link, or
 * ghost/secondary for a quiet control. Tinted links (`text-status-*`) keep their own hover shade, and
 * state prefixes (`disabled:text-secondary`) are fine.
 */
const NEUTRAL_LINK_COLOR =
  /(?<![\w:-])text-(?:muted|secondary|placeholder)(?![\w-])|(?<![\w:-])hover:text-(?:primary|secondary|muted)(?![\w-])/

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
    else if (
      finding.combinations.some((combo) => combo.includes('ficus-button-link')) &&
      NEUTRAL_LINK_COLOR.test(finding.expression)
    )
      out.push(`${describe(finding)} (ficus-button-link must not be recolored to a neutral text color)`)
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

const describeLinkButton = (finding: { path: string; line: number; expression: string }) =>
  `${finding.path}:${finding.line} is a <button> with link styling: ${finding.expression.slice(0, 160)}`

const isNavigating = (finding: { path: string; expression: string }) =>
  NAVIGATING_BUTTONS.some((entry) => entry.path === finding.path && finding.expression.includes(entry.contains))

test('a <button> uses link styling only when it navigates', () => {
  const findings = sources().flatMap(({ path, text }) => scanLinkStyledButtons(text, path))
  expect(findings.filter((finding) => !isNavigating(finding)).map(describeLinkButton)).toEqual([])
})

test('each navigating-button entry matches exactly one link-styled button', () => {
  const findings = sources().flatMap(({ path, text }) => scanLinkStyledButtons(text, path))
  for (const entry of NAVIGATING_BUTTONS) {
    const matches = findings.filter(
      (finding) => finding.path === entry.path && finding.expression.includes(entry.contains)
    )
    expect(matches.map(describeLinkButton), `${entry.path}: ${entry.contains}`).toHaveLength(1)
  }
})

test('the link-styled button check catches actions and ignores real navigation', () => {
  const scan = (source: string) => scanLinkStyledButtons(source, 'fixture.tsx')
  // Actions on a <button>, written directly, picked by a branch, or through a same-file constant.
  expect(scan(`<button onClick={retry} className="ficus-button ficus-button-link">Retry</button>`)).toHaveLength(1)
  expect(
    scan(
      `<button className={clsx(open ? 'ficus-button ficus-button-link' : 'ficus-button ficus-button-ghost', 'px-2')} />`
    )
  ).toHaveLength(1)
  expect(
    scan(
      `const action = 'ficus-button ficus-button-link text-sm'\nconst x = <button type="button" className={action} />`
    )
  ).toHaveLength(1)
  // Navigation elements and real button variants pass.
  for (const source of [
    `<a href="/settings" className="ficus-button ficus-button-link">Settings</a>`,
    `<Link to="/settings" className="ficus-button ficus-button-link">Settings</Link>`,
    `<button onClick={retry} className="ficus-button ficus-button-ghost px-2 py-1">Retry</button>`,
    `<button onClick={retry} className="ficus-button-linkish">Retry</button>`,
  ])
    expect(scan(source), source).toEqual([])
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

test('the guard catches missing variants and invalid variant styling', () => {
  // A hand-styled base without an explicit variant bypasses the shared button styles.
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
  expect(
    scanSnippet(`<a href="/settings" className="ficus-button ficus-button-link px-2 text-xs">Settings</a>`)
  ).toHaveLength(1)
  // A muted link that hovers to bright, underlined text instead of the variant's own hover.
  expect(
    scanSnippet(
      `<a href="/settings" className="ficus-button ficus-button-link text-xs text-muted hover:text-primary">Settings</a>`
    )
  ).toHaveLength(1)
  expect(
    scanSnippet(
      `<a href="/settings" className="ficus-button ficus-button-link text-xs hover:text-secondary">View all</a>`
    )
  ).toHaveLength(1)
  // A muted link with no override still hovers to the variant's bright, underlined link color.
  expect(
    scanSnippet(`<a href="/settings" className="ficus-button ficus-button-link py-1 text-xs text-muted">View all</a>`)
  ).toHaveLength(1)
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
    `<a href="/settings" className="ficus-button ficus-button-link text-xs">Settings</a>`,
    // A tinted link keeps its own hover shade, and a ghost may recolor its hover.
    `<a href="/settings" className="ficus-button ficus-button-link text-xs text-status-attention-600 hover:text-status-attention-800">Review storage</a>`,
    `<b className="ficus-button ficus-button-ghost p-2 text-muted hover:text-status-danger-600">x</b>`,
    `<a href="/settings" className="ficus-button ficus-button-link disabled:text-secondary disabled:no-underline">Dependency</a>`,
  ]
  for (const source of ok) expect(scanSnippet(source), source).toEqual([])
})
