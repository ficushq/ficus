import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import ts from 'typescript'

const cliRoot = resolve(import.meta.dir, '../../../../cli/src')

/** Literal cross-project imports enter Core's composite TypeScript project; computed imports do not. */
function staticCliImports(path: string, source: string): string[] {
  const found: string[] = []
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      specifier = node.arguments[0]
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      resolve(dirname(path), specifier.text).startsWith(`${cliRoot}${sep}`)
    )
      found.push(specifier.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test('the boundary detector distinguishes literal CLI dependencies from computed runtime loading', () => {
  const file = join(import.meta.dir, 'example.ts')
  expect(staticCliImports(file, "const cli = await import('../../../../cli/src/program')")).toEqual([
    '../../../../cli/src/program',
  ])
  expect(
    staticCliImports(file, "const cli = await import(join(import.meta.dir, '../../../../cli/src/program.ts'))")
  ).toEqual([])
})

test('Core eval sources do not statically pull the CLI project into Core typechecking', () => {
  const imports = readdirSync(import.meta.dir)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => {
      const path = join(import.meta.dir, file)
      return staticCliImports(path, readFileSync(path, 'utf8')).map((specifier) => ({ file, specifier }))
    })
  expect(imports).toEqual([])
})
