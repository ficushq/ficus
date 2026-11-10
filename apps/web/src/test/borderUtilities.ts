import ts from 'typescript'
import { compileUtilities, unescapeClass } from './tailwind'

type Source = { path: string; text: string }
type BorderUtility = { utility: string; path: string; line: number; column: number }

// This selects the bounded family we audit; it does NOT decide which utilities
// are valid. Only emitted CSS from the project's compiler can do that.
const themedBorder = /^(?:[\w/-]+:)*!?border-(?:[xytrblse]-)?(?:th-[\w-]+|status-[\w-]+|current)(?:\/[\d.]+)?$/

/** Complete literal tokens only. No evaluation of runtime data or authored HTML. */
export function collectBorderUtilities({ path, text }: Source): BorderUtility[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: BorderUtility[] = []
  function visit(node: ts.Node) {
    if (ts.isTaggedTemplateExpression(node)) return
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const openStart = ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      const openEnd = ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      for (const match of node.text.matchAll(/\S+/g)) {
        if (openStart && match.index === 0) continue
        if (openEnd && match.index + match[0].length === node.text.length) continue
        if (!themedBorder.test(match[0])) continue
        const position = source.getLineAndCharacterOfPosition(node.getStart(source) + 1 + match.index)
        found.push({ utility: match[0], path, line: position.line + 1, column: position.character + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Compile the collected synthetic/static candidates with the production Tailwind
 * configuration (src/tailwind.css), replacing only content discovery. This is the
 * CSS generation stage used by Vite, not a separate utility-name validator.
 */
export async function checkBorderUtilities(sources: Source[]): Promise<string[]> {
  const candidates = sources.flatMap(collectBorderUtilities)
  if (candidates.length === 0) return []
  const result = await compileUtilities(new Set(candidates.map(({ utility }) => utility)))
  const emitted = new Set<string>()
  result.walkRules((rule) => {
    let colored = false
    // Tailwind 4 nests the color-mix() form of an opacity modifier in @supports.
    rule.walkDecls(
      /^border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?-color$/,
      () => {
        colored = true
      }
    )
    if (!colored) return
    // Our bounded candidates have only ASCII word characters, :, /, ! and .;
    // decode their CSS escapes without confusing pseudo-classes with the name.
    for (const match of rule.selector.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      emitted.add(unescapeClass(match[1]!))
    }
  })
  return candidates
    .filter(({ utility }) => !emitted.has(utility))
    .map(
      ({ path, line, column, utility }) =>
        `${path}:${line}:${column} ${utility}: No border color declaration was emitted by the web PostCSS pipeline. Use border-th-border for neutral dividers or a mapped status color such as border-status-danger-500/30. See docs/wiki/theme/semantic-colors.md#generated-border-utilities.`
    )
}
