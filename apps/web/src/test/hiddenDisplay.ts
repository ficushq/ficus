import ts from 'typescript'
import { compileUtilities, unescapeClass } from './tailwind'

type Source = { path: string; text: string }
type ClassGroup = { tokens: string[]; path: string; line: number; column: number; component?: string }

/** Tailwind's unprefixed display utilities. */
const DISPLAY_UTILITIES = [
  'block',
  'inline-block',
  'inline',
  'flex',
  'inline-flex',
  'table',
  'inline-table',
  'table-caption',
  'table-cell',
  'table-column',
  'table-column-group',
  'table-footer-group',
  'table-header-group',
  'table-row-group',
  'table-row',
  'flow-root',
  'grid',
  'inline-grid',
  'contents',
  'list-item',
]
/** Components that render one element with exactly the caller's classes (React Router's links). */
const PLAIN_COMPONENTS = new Set(['Link', 'NavLink'])
/** A display utility behind one or more variants (md:flex, lg:inline-flex, group-hover:block). */
const variantDisplay = new RegExp(`^(?:[\\w\\[\\]()&*=.-]+:)+(?:${DISPLAY_UTILITIES.join('|')})$`)

/**
 * The display utilities the production Tailwind build emits after `hidden`, so they beat it on the
 * same element. Tailwind 3 emitted `hidden` last; Tailwind 4 orders same-property utilities by name.
 */
export async function displayUtilitiesAfterHidden(): Promise<Set<string>> {
  const order: string[] = []
  ;(await compileUtilities(['hidden', ...DISPLAY_UTILITIES])).each((node) => {
    if (node.type === 'rule') order.push(unescapeClass(node.selector.slice(1)))
  })
  return new Set(order.slice(order.indexOf('hidden') + 1))
}

/** The complete literal class tokens inside `node` (template fragments next to `${...}` are skipped). */
function literalTokens(node: ts.Node): string[] {
  const tokens: string[] = []
  const visit = (child: ts.Node) => {
    if (ts.isTaggedTemplateExpression(child)) return
    if (
      ts.isStringLiteralLike(child) ||
      ts.isTemplateHead(child) ||
      ts.isTemplateMiddle(child) ||
      ts.isTemplateTail(child)
    ) {
      const openStart = ts.isTemplateMiddle(child) || ts.isTemplateTail(child)
      const openEnd = ts.isTemplateHead(child) || ts.isTemplateMiddle(child)
      for (const match of child.text.matchAll(/\S+/g)) {
        if (openStart && match.index === 0) continue
        if (openEnd && match.index + match[0].length === child.text.length) continue
        tokens.push(match[0])
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return tokens
}

/**
 * The class lists that end up on one element: each `className` (or `...ClassName`) JSX attribute, each
 * clsx() call and each string literal. A className on a component (a capitalized tag) records the
 * component, since it may merge the classes with its own.
 */
export function collectClassGroups({ path, text }: Source): ClassGroup[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const groups: ClassGroup[] = []
  const add = (node: ts.Node, tokens: string[], component?: string) => {
    if (!tokens.includes('hidden')) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    groups.push({ tokens, path, line: position.line + 1, column: position.character + 1, component })
  }
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && /^(?:className|\w+ClassName)$/.test(node.name.getText(source)) && node.initializer) {
      const tag = node.parent.parent
      const tagName = ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag) ? tag.tagName.getText(source) : ''
      return add(
        node,
        literalTokens(node.initializer),
        /^[A-Z]|\./.test(tagName) && !PLAIN_COMPONENTS.has(tagName) ? tagName : undefined
      )
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'clsx') return add(node, literalTokens(node))
    if (ts.isStringLiteralLike(node)) return add(node, literalTokens(node))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return groups
}

/**
 * Elements whose unprefixed `hidden` can lose to another display utility under Tailwind 4:
 * - `hidden` with a display utility that the build emits after it, on the same element;
 * - `hidden` passed to a component together with a variant display utility (the `hidden md:flex`
 *   pattern): the component may add its own display utility, which then wins over `hidden`.
 */
export async function checkHiddenDisplay(sources: Source[]): Promise<string[]> {
  const after = await displayUtilitiesAfterHidden()
  const findings = new Set<string>()
  for (const group of sources.flatMap(collectClassGroups)) {
    const where = `${group.path}:${group.line}:${group.column}`
    const winners = group.tokens.filter((token) => after.has(token))
    if (winners.length > 0)
      findings.add(
        `${where} hidden with ${winners.join(', ')}: Tailwind 4 emits ${winners.join(', ')} after hidden, so the element is never hidden. Use a variant such as max-md:hidden.`
      )
    const responsive = group.tokens.filter((token) => variantDisplay.test(token))
    if (group.component && responsive.length > 0)
      findings.add(
        `${where} <${group.component}> hidden ${responsive.join(' ')}: a component can set its own display utility, which Tailwind 4 may emit after hidden. Hide it with a max-width variant instead (hidden lg:inline-flex becomes max-lg:hidden).`
      )
  }
  return [...findings]
}
