import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

/** CI-only diagnostic, not a runtime file-selection heuristic. Database-backed
 * suites must await module readiness before test clocks start. Follow runtime
 * static imports/reexports to catch indirect db/index loads; type imports do
 * not evaluate modules. Awaited literal dynamic imports at module scope also establish
 * readiness. A test-body import must not be the first request for the DB.
 */
export function lateTestDatabaseImports(files: string[], entries: { database: string; readiness: string }) {
  type Dynamic = { module: string; file: string; line: number; topLevel: boolean }
  const cache = new Map<string, { imports: string[]; dynamic: Dynamic[] }>()
  function moduleFile(from: string, name: string): string | undefined {
    if (!name.startsWith('.')) return undefined
    const base = resolve(dirname(from), name)
    return [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find(
      (file) => existsSync(file) && statSync(file).isFile()
    )
  }
  function parse(file: string) {
    const cached = cache.get(file)
    if (cached) return cached
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports: string[] = []
    const dynamic: Dynamic[] = []
    for (const node of source.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause
        if (clause?.isTypeOnly) continue
        const bindings = clause?.namedBindings
        if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every((x) => x.isTypeOnly))
          continue
        const target = moduleFile(file, node.moduleSpecifier.text)
        if (target) imports.push(target)
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        if (
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.every((x) => x.isTypeOnly)
        )
          continue
        const target = moduleFile(file, node.moduleSpecifier.text)
        if (target) imports.push(target)
      }
    }
    function visit(node: ts.Node, nested: boolean) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteral(arg)) {
          const target = moduleFile(file, arg.text)
          if (target)
            dynamic.push({
              module: arg.text,
              file: target,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              topLevel: !nested && ts.isAwaitExpression(node.parent),
            })
        }
      }
      ts.forEachChild(node, (child) => visit(child, nested || ts.isFunctionLike(node) || ts.isClassLike(node)))
    }
    visit(source, false)
    const result = { imports, dynamic }
    cache.set(file, result)
    return result
  }
  function requestsDatabase(file: string, seen = new Set<string>()): boolean {
    if (file === entries.database || file === entries.readiness) return true
    if (seen.has(file)) return false
    seen.add(file)
    const { imports, dynamic } = parse(file)
    return [...imports, ...dynamic.filter((x) => x.topLevel).map((x) => x.file)].some((target) =>
      requestsDatabase(target, seen)
    )
  }
  return files.flatMap((file) => {
    if (requestsDatabase(file)) return []
    return parse(file)
      .dynamic.filter((entry) => !entry.topLevel && requestsDatabase(entry.file))
      .map((entry) => ({ file, module: entry.module, line: entry.line }))
  })
}
