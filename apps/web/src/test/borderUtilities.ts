import { createRequire } from 'node:module'
import postcss, { type PluginCreator } from 'postcss'
import type { Config } from 'tailwindcss'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const postcssConfig = require('../../postcss.config.js').default as { plugins: Record<string, Record<string, unknown>> }
const tailwindConfig = require('../../tailwind.config.js').default as Config

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
 * Run the production PostCSS plugin chain and Tailwind configuration, replacing
 * only content discovery with the collected synthetic/static candidates. This is
 * the CSS generation stage used by Vite, not a separate utility-name validator.
 */
export async function checkBorderUtilities(sources: Source[]): Promise<string[]> {
  const candidates = sources.flatMap(collectBorderUtilities)
  if (candidates.length === 0) return []
  const plugins = Object.entries(postcssConfig.plugins).map(([name, options]) => {
    if (name === 'tailwindcss') {
      return (require(name) as PluginCreator<Config>)({
        ...tailwindConfig,
        content: [{ raw: [...new Set(candidates.map(({ utility }) => utility))].join(' '), extension: 'html' }],
      })
    }
    return (require(name) as PluginCreator<Record<string, unknown>>)(options)
  })
  const result = await postcss(plugins).process('@tailwind utilities;', { from: undefined })
  const emitted = new Set<string>()
  result.root.walkRules((rule) => {
    if (
      !rule.nodes.some(
        (node) =>
          node.type === 'decl' &&
          /^border(?:-(?:top|right|bottom|left|inline-start|inline-end))?-color$/.test(node.prop)
      )
    )
      return
    // Our bounded candidates have only ASCII word characters, :, /, ! and .;
    // decode their CSS escapes without confusing pseudo-classes with the name.
    for (const match of rule.selector.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      emitted.add(match[1]!.replace(/\\(.)/g, '$1'))
    }
  })
  return candidates
    .filter(({ utility }) => !emitted.has(utility))
    .map(
      ({ path, line, column, utility }) =>
        `${path}:${line}:${column} ${utility}: No border color declaration was emitted by the web PostCSS pipeline. Use border-th-border for neutral dividers or a mapped status color such as border-status-danger-500/30. See docs/wiki/theme/semantic-colors.md#generated-border-utilities.`
    )
}
