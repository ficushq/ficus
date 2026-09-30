import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

interface ParserCall {
  file: string
  function: string
  line: number
}
interface SwallowFinding extends ParserCall {
  kind: 'promise-catch' | 'try-catch'
}

const JSON_PARSE_ALLOWLIST = [
  {
    file: 'services/shell.ts',
    function: 'handleShell',
    classification: 'websocket-frame',
    rationale: 'WebSocket frames are not Fetch Request bodies and require protocol-local recovery.',
  },
  {
    file: 'services/devbox-env.ts',
    function: 'devboxHasPackages',
    classification: 'local-file',
    rationale: 'Reads local devbox.json, not network request data.',
  },
  {
    file: 'services/devbox-env.ts',
    function: 'prepareDevboxShellEnv',
    classification: 'local-file',
    rationale: 'Reads local devbox.json to decide whether its package environment needs activation.',
  },
  {
    file: 'services/bash-invocation-registry.ts',
    function: '<anonymous>',
    classification: 'local-file',
    rationale:
      "readGeneration: deserializes the registry's own generation-tracking record from " +
      '<runtimeDir>/generations/<key>.json, written by this same class via atomicWrite. Not network request data.',
  },
  {
    file: 'services/bash-invocation-registry.ts',
    function: '<anonymous>',
    classification: 'local-file',
    rationale:
      "read: deserializes the registry's own active/legacy invocation record from " +
      '<runtimeDir>/active/<key>.json or the legacy path, written by this same class via atomicWrite. Not network request data.',
  },
  {
    file: 'services/bash-invocation-registry.ts',
    function: '<anonymous>',
    classification: 'local-file',
    rationale:
      'writeImmutable: on an EEXIST race, re-reads the terminal record it just lost the write race for ' +
      '(to compare against the record this call attempted to write) — deserializes its own persisted state, not network request data.',
  },
  {
    file: 'services/processes.ts',
    function: 'parseJsonLines',
    classification: 'local-command-output',
    rationale:
      "Parses the box's own `docker ps`/`docker stats --format '{{json .}}'` output line by line; " +
      'malformed lines are skipped. Not network request data.',
  },
] as const

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    expression = expression.expression
  }
  return expression
}

function enclosingFunctionName(node: ts.Node): string {
  let name = '<anonymous>'
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) name = current.name.text
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      name = current.parent.name.text
    }
  }
  return name
}

function isRequestJsonCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callee = unwrap(node.expression)
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'json' &&
    ts.isIdentifier(unwrap(callee.expression)) &&
    (unwrap(callee.expression) as ts.Identifier).text === 'req'
  )
}

function containsRequestJson(node: ts.Node): boolean {
  if (isRequestJsonCall(node)) return true
  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsRequestJson(child)) found = true
  })
  return found
}

function catchAlwaysThrows(catchClause: ts.CatchClause): boolean {
  let hasReturn = false
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) hasReturn = true
    ts.forEachChild(node, visit)
  }
  visit(catchClause.block)
  return !hasReturn && ts.isThrowStatement(catchClause.block.statements.at(-1)!)
}

export function scanRequestJson(source: string, file = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: ParserCall[] = []
  const swallowed: SwallowFinding[] = []
  const finding = (node: ts.Node, kind?: SwallowFinding['kind']) => ({
    file,
    function: enclosingFunctionName(node),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    ...(kind ? { kind } : {}),
  })

  function visit(node: ts.Node) {
    if (isRequestJsonCall(node)) calls.push(finding(node))
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(unwrap(node.expression)) &&
      (unwrap(node.expression) as ts.PropertyAccessExpression).name.text === 'catch' &&
      containsRequestJson((unwrap(node.expression) as ts.PropertyAccessExpression).expression)
    ) {
      swallowed.push(finding(node, 'promise-catch') as SwallowFinding)
    }
    if (
      ts.isTryStatement(node) &&
      node.catchClause &&
      containsRequestJson(node.tryBlock) &&
      !catchAlwaysThrows(node.catchClause)
    ) {
      swallowed.push(finding(node, 'try-catch') as SwallowFinding)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { calls, swallowed }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

function scanJsonParse(source: string, file: string) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: Array<{ file: string; function: string }> = []
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'JSON' &&
      node.expression.name.text === 'parse'
    ) {
      calls.push({ file, function: enclosingFunctionName(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

describe('sandbox-server inbound JSON boundary guard', () => {
  test('detects fallback catches and permits a classifier that always throws', () => {
    const fixture = `
async function promiseFallback(req: Request) { return req.json().catch(() => ({})) }
async function caughtFallback(req: Request) { try { return await req.json() } catch { return {} } }
async function classifier(req: Request) {
  try { return await req.json() } catch (error) {
    if (error instanceof SyntaxError) throw new Error('invalid')
    throw error
  }
}
`
    const result = scanRequestJson(fixture)
    expect(result.swallowed.map(({ kind }) => kind)).toEqual(['promise-catch', 'try-catch'])
    expect(result.calls.map(({ function: name }) => name)).toEqual(['promiseFallback', 'caughtFallback', 'classifier'])
  })

  test('ignores comments and response or file parser lookalikes', () => {
    const fixture = `
// req.json().catch(() => ({}))
const example = "req.json().catch(() => null)"
await response.json().catch(() => null)
JSON.parse(fileContents)
`
    expect(scanRequestJson(fixture)).toEqual({ calls: [], swallowed: [] })
  })

  test('keeps one canonical Fetch request parser with no fallback', () => {
    const sourceRoot = import.meta.dir
    const results = sourceFiles(sourceRoot).map((path) => ({
      path,
      result: scanRequestJson(readFileSync(path, 'utf8'), relative(sourceRoot, path)),
    }))
    expect(results.flatMap(({ result }) => result.swallowed)).toEqual([])
    expect(
      results.flatMap(({ result }) => result.calls).map(({ file, function: name }) => ({ file, function: name }))
    ).toEqual([{ file: 'server.ts', function: 'parseJsonRequestBody' }])
  })

  test('service cgroup census never inspects process secrets or identities', () => {
    const source = readFileSync(join(import.meta.dir, 'services/service-cgroup.ts'), 'utf8')
    for (const forbidden of ['/cmdline', '/environ', '/stat', 'child_process', 'exec(', 'spawn(', 'nodeReadFile']) {
      expect(source).not.toContain(forbidden)
    }
  })

  test('keeps non-HTTP JSON parsers on the reviewed allowlist', () => {
    expect(JSON_PARSE_ALLOWLIST.every(({ rationale }) => rationale.length > 0)).toBe(true)
    const sourceRoot = import.meta.dir
    const parsers = sourceFiles(sourceRoot)
      .flatMap((path) => scanJsonParse(readFileSync(path, 'utf8'), relative(sourceRoot, path)))
      .sort(
        (left, right) =>
          JSON_PARSE_ALLOWLIST.findIndex(({ file }) => file === left.file) -
          JSON_PARSE_ALLOWLIST.findIndex(({ file }) => file === right.file)
      )
    expect(parsers).toEqual(JSON_PARSE_ALLOWLIST.map(({ file, function: name }) => ({ file, function: name })))
  })
})
