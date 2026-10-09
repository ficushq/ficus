import ts from 'typescript'

/**
 * `ficus-button` is only a base (radius, weight, transitions): on its own it renders as padded text with
 * no fill and no border, so it reads as weirdly indented text until hovered. Every use must pair it
 * with exactly one variant. This module finds each class expression that carries the base and works
 * out which variant(s) it can resolve to; `buttonVariants.guard.test.ts` enforces the rule.
 */
export const BUTTON_VARIANTS = [
  'ficus-button-primary',
  'ficus-button-secondary',
  'ficus-button-ghost',
  'ficus-button-link',
  'ficus-button-danger',
] as const

export type ButtonVariantFinding = {
  path: string
  line: number
  /** Source text of the whole class expression that carries the base class. */
  expression: string
  /** Every combination of the base and variants the expression can produce (sorted, space-joined). */
  combinations: string[]
  ok: boolean
}

const BASE = 'ficus-button'
/** The base or any variant, as whole class tokens. */
const BUTTON_CLASS = /(?<![\w-])ficus-button(?:-(?:primary|secondary|ghost|link|danger))?(?![\w-])/g
/** Class-joining helpers whose arguments are concatenated. */
const CLASS_HELPERS = new Set(['clsx', 'cn', 'cx', 'classNames'])
const MAX_COMBINATIONS = 64

type Combos = Set<string>

const UNKNOWN: Combos = new Set([''])

function classesIn(text: string): string[] {
  return [...new Set(text.match(BUTTON_CLASS) ?? [])].sort()
}

function join(a: string, b: string): string {
  return [...new Set([...a.split(' '), ...b.split(' ')].filter(Boolean))].sort().join(' ')
}

function product(left: Combos, right: Combos): Combos {
  const out: Combos = new Set()
  for (const a of left) for (const b of right) if (out.size < MAX_COMBINATIONS) out.add(join(a, b))
  return out
}

function union(...sets: Combos[]): Combos {
  const out: Combos = new Set()
  for (const set of sets) for (const value of set) if (out.size < MAX_COMBINATIONS) out.add(value)
  return out
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return `.${callee.name.text}`
  return undefined
}

/** A call that concatenates class strings: `clsx(...)`, `cn(...)`, `[...].join(' ')`, `[...].filter(Boolean)`. */
function isJoiningCall(call: ts.CallExpression): boolean {
  const name = calleeName(call)
  return name !== undefined && (CLASS_HELPERS.has(name) || name === '.join' || name === '.filter')
}

function declarationsByName(sf: ts.SourceFile): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !map.has(node.name.text))
      map.set(node.name.text, node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return map
}

function evaluate(node: ts.Node, decls: Map<string, ts.Expression>, seen: Set<string>): Combos {
  if (ts.isStringLiteralLike(node)) return new Set([classesIn(node.text).join(' ')])
  if (ts.isTemplateExpression(node)) {
    let combos: Combos = new Set([classesIn(node.head.text).join(' ')])
    for (const span of node.templateSpans) {
      combos = product(combos, evaluate(span.expression, decls, seen))
      combos = product(combos, new Set([classesIn(span.literal.text).join(' ')]))
    }
    return combos
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isSpreadElement(node) ||
    ts.isJsxExpression(node)
  )
    return node.expression ? evaluate(node.expression, decls, seen) : UNKNOWN
  if (ts.isConditionalExpression(node))
    return union(evaluate(node.whenTrue, decls, seen), evaluate(node.whenFalse, decls, seen))
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.PlusToken)
      return product(evaluate(node.left, decls, seen), evaluate(node.right, decls, seen))
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return union(evaluate(node.right, decls, seen), UNKNOWN)
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
      return union(evaluate(node.left, decls, seen), evaluate(node.right, decls, seen))
    return UNKNOWN
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.reduce<Combos>((acc, element) => product(acc, evaluate(element, decls, seen)), UNKNOWN)
  if (ts.isCallExpression(node) && isJoiningCall(node)) {
    const name = calleeName(node)!
    if (CLASS_HELPERS.has(name))
      return node.arguments.reduce<Combos>((acc, arg) => product(acc, evaluate(arg, decls, seen)), UNKNOWN)
    return evaluate((node.expression as ts.PropertyAccessExpression).expression, decls, seen)
  }
  if (ts.isObjectLiteralExpression(node)) {
    // clsx({ 'ficus-button-primary': active }): each key may or may not apply.
    let combos = UNKNOWN
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const key = ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name) ? property.name.text : ''
      combos = product(combos, union(new Set([classesIn(key).join(' ')]), UNKNOWN))
    }
    return combos
  }
  if (ts.isIdentifier(node)) {
    const initializer = decls.get(node.text)
    if (!initializer || seen.has(node.text)) return UNKNOWN
    return evaluate(initializer, decls, new Set([...seen, node.text]))
  }
  // VARIANT_CLASS[tone] / VARIANT_CLASS.key on a same-file object literal of class strings.
  if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) && ts.isIdentifier(node.expression)) {
    let initializer = decls.get(node.expression.text)
    while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)))
      initializer = initializer.expression
    if (initializer && ts.isObjectLiteralExpression(initializer)) {
      const values = initializer.properties
        .filter(ts.isPropertyAssignment)
        .filter((p) => ts.isPropertyAccessExpression(node) === false || p.name.getText() === node.name.text)
        .map((p) => evaluate(p.initializer, decls, seen))
      return values.length ? union(...values) : UNKNOWN
    }
  }
  return UNKNOWN
}

/** Climbs from a class string to the outermost expression that composes it into one className. */
function classExpressionRoot(node: ts.Node): ts.Node {
  let current = node
  for (;;) {
    const parent = current.parent
    if (!parent) return current
    const composes =
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(parent.operatorToken.kind)) ||
      (ts.isCallExpression(parent) && isJoiningCall(parent) && parent.expression !== current) ||
      (ts.isPropertyAccessExpression(parent) &&
        ['join', 'filter'].includes(parent.name.text) &&
        parent.expression === current &&
        ts.isCallExpression(parent.parent))
    if (!composes) return current
    current = ts.isPropertyAccessExpression(parent) ? parent.parent : parent
  }
}

/**
 * A className is fine when it carries no button class at all (a branch that is not a button), or the
 * base plus exactly one variant. The base alone, a variant without the base, or two variants fail.
 */
function isValidCombination(combo: string): boolean {
  if (combo === '') return true
  const classes = combo.split(' ')
  return classes.includes(BASE) && classes.length === 2
}

/** The outermost class expression around every string that carries the button base or a variant. */
export function buttonClassRoots(sf: ts.SourceFile): ts.Node[] {
  const roots = new Set<ts.Node>()
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && classesIn(node.text).length > 0) {
      const literal =
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.parent : node
      roots.add(classExpressionRoot(ts.isTemplateSpan(literal) ? literal.parent : literal))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...roots]
}

export function parseSource(source: string, path: string): ts.SourceFile {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
}

/** Every class expression in `source` that carries the button base or a variant, with its analysis. */
export function scanButtonVariants(source: string, path: string): ButtonVariantFinding[] {
  const sf = parseSource(source, path)
  const decls = declarationsByName(sf)
  return buttonClassRoots(sf).map((root) => {
    const combinations = [...evaluate(root, decls, new Set())].sort()
    return {
      path,
      line: sf.getLineAndCharacterOfPosition(root.getStart(sf)).line + 1,
      expression: root.getText(sf).replace(/\s+/g, ' '),
      combinations,
      ok: combinations.every(isValidCombination),
    }
  })
}
