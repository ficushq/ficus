import { describe, expect, test } from 'bun:test'
import { dirname, normalize, resolve } from 'node:path'
import ts from 'typescript'

const sourceRoot = new URL('../', import.meta.url)

type ModuleMock = { path: string; specifier: string }
type SourceMap = ReadonlyMap<string, string>

function stringValue(node: ts.Expression, constants: ReadonlyMap<string, string | undefined>): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node)) return constants.get(node.text)
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const expression = stringValue(span.expression, constants)
      if (expression === undefined) return undefined
      value += expression + span.literal.text
    }
    return value
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValue(node.left, constants)
    const right = stringValue(node.right, constants)
    return left === undefined || right === undefined ? undefined : left + right
  }
  return undefined
}

/** Finds Bun module mocks without relying on source-text regexes or literal arguments. */
export function findModuleMocks(source: string, path: string): ModuleMock[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const constants = new Map<string, string | undefined>()
  const mockObjects = new Set(['mock'])
  const bunTestNamespaces = new Set<string>()
  const moduleFunctions = new Set<string>()
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(node)) node = node.expression
    return node
  }
  const accessedProperty = (node: ts.Expression): { object: ts.Expression; name?: string } | undefined => {
    const expression = unwrap(node)
    if (ts.isPropertyAccessExpression(expression)) return { object: expression.expression, name: expression.name.text }
    if (ts.isElementAccessExpression(expression)) {
      const argument = expression.argumentExpression && unwrap(expression.argumentExpression)
      return {
        object: expression.expression,
        name: argument && ts.isStringLiteralLike(argument) ? argument.text : undefined,
      }
    }
    return undefined
  }
  const isMockObject = (node: ts.Expression): boolean => {
    const expression = unwrap(node)
    if (ts.isIdentifier(expression) && mockObjects.has(expression.text)) return true
    const access = accessedProperty(expression)
    return !!(
      access &&
      access.name === 'mock' &&
      ts.isIdentifier(unwrap(access.object)) &&
      bunTestNamespaces.has((unwrap(access.object) as ts.Identifier).text)
    )
  }
  const isModuleFunction = (node: ts.Expression): boolean => {
    const expression = unwrap(node)
    if (ts.isIdentifier(expression) && moduleFunctions.has(expression.text)) return true
    const access = accessedProperty(expression)
    return !!(access && access.name === 'module' && isMockObject(access.object))
  }
  const bindingProperty = (element: ts.BindingElement): string | undefined => {
    const property = element.propertyName ?? element.name
    if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) return property.text
    if (ts.isComputedPropertyName(property)) {
      const expression = unwrap(property.expression)
      return ts.isStringLiteralLike(expression) ? expression.text : undefined
    }
    return undefined
  }

  const collectBindings = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (node.moduleSpecifier.text === 'bun:test' && bindings) {
        if (ts.isNamespaceImport(bindings)) bunTestNamespaces.add(bindings.name.text)
        else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === 'mock') mockObjects.add(element.name.text)
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const value = stringValue(unwrap(node.initializer), constants)
        if (value !== undefined) {
          if (!constants.has(node.name.text)) constants.set(node.name.text, value)
          else if (constants.get(node.name.text) !== value) constants.set(node.name.text, undefined)
        }
        if (isMockObject(node.initializer)) mockObjects.add(node.name.text)
        if (isModuleFunction(node.initializer)) moduleFunctions.add(node.name.text)
      } else if (ts.isObjectBindingPattern(node.name) && isMockObject(node.initializer)) {
        for (const element of node.name.elements) {
          if (bindingProperty(element) === 'module' && ts.isIdentifier(element.name)) {
            moduleFunctions.add(element.name.text)
          }
        }
      }
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(file)

  const mocks: ModuleMock[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      if (isModuleFunction(expression)) {
        const first = node.arguments[0]
        // An unresolved argument is unsafe by construction: a helper/dynamic mock
        // can target a production API at runtime and cannot be allow-listed safely.
        mocks.push({
          path,
          specifier: first
            ? (stringValue(first, constants) ?? `<dynamic:${first.getText(file)}>`)
            : '<dynamic:missing>',
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return mocks
}

function resolveLocal(path: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return normalize(resolve(dirname(resolve(sourceRoot.pathname, path)), specifier))
  const alias = specifier.match(/^(?:@\/|~\/|src\/)(.+)$/)
  return alias ? normalize(resolve(sourceRoot.pathname, alias[1])) : undefined
}

function isPublicApiAlias(specifier: string): boolean {
  return /^(?:@\/|~\/|src\/)?api(?:\/|$)/.test(specifier)
}

function reexportsApi(path: string, sources: SourceMap, seen = new Set<string>()): boolean {
  const normalized = normalize(path)
  if (seen.has(normalized)) return false
  seen.add(normalized)
  const relative = normalized.startsWith(sourceRoot.pathname)
    ? normalized.slice(sourceRoot.pathname.length)
    : normalized
  const candidates = [relative, `${relative}.ts`, `${relative}.tsx`, `${relative}/index.ts`, `${relative}/index.tsx`]
  const entry = candidates.find((candidate) => sources.has(candidate))
  if (!entry) return false
  const file = ts.createSourceFile(entry, sources.get(entry)!, ts.ScriptTarget.Latest, true)
  return file.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false
    }
    const specifier = statement.moduleSpecifier.text
    if (isPublicApiAlias(specifier)) return true
    const target = resolveLocal(entry, specifier)
    return target ? isApiPath(target) || reexportsApi(target, sources, seen) : false
  })
}

function isApiPath(path: string): boolean {
  const apiRoot = normalize(resolve(sourceRoot.pathname, 'api'))
  return path === apiRoot || path.startsWith(`${apiRoot}/`)
}

export function isSharedProductionModuleMock(mock: ModuleMock, sources: SourceMap = new Map()): boolean {
  const { path, specifier } = mock
  // The preload pins exactly these six duplicate React entry points to one
  // instance. No other computed target in test-setup (especially an API target)
  // is exempt.
  const safePreloadTargets = new Set([
    '<dynamic:`${ROOT}/react/index.js`>',
    '<dynamic:`${ROOT}/react/jsx-runtime.js`>',
    '<dynamic:`${ROOT}/react/jsx-dev-runtime.js`>',
    '<dynamic:`${ROOT}/react/cjs/react.development.js`>',
    '<dynamic:`${ROOT}/react-dom/index.js`>',
    '<dynamic:`${ROOT}/react-dom/server.js`>',
  ])
  if (path === 'test-setup.ts' && safePreloadTargets.has(specifier)) return false
  if (specifier.startsWith('<dynamic:')) return true
  // The router package and its subpath entries (react-router/dom) share one
  // module-level context; replacing any of them breaks every routed suite.
  if (specifier === 'react-router' || specifier.startsWith('react-router/')) return true
  if (specifier === '@tanstack/react-query' || /(?:^|\/)usePermissions$/.test(specifier)) return true
  // Public aliases are covered even when tsconfig/bundler resolution is unavailable to this standalone guard.
  if (isPublicApiAlias(specifier)) return true
  const resolved = resolveLocal(path, specifier)
  if (!resolved) return false
  // Every application-local replacement shares Bun's process-global module
  // registry. Even a leaf component or hook can be imported transitively by an
  // unrelated suite, so local production targets are never safe to replace.
  const sourcePath = normalize(sourceRoot.pathname)
  return resolved.startsWith(sourcePath) || isApiPath(resolved) || reexportsApi(resolved, sources)
}

type ModuleMockScan = { scannedFiles: number; violations: ModuleMock[] }

async function moduleMockScan(): Promise<ModuleMockScan> {
  const mocks: ModuleMock[] = []
  const sources = new Map<string, string>()
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  let scannedFiles = 0
  for await (const path of glob.scan({ cwd: sourceRoot.pathname, absolute: true })) {
    const relativePath = path.slice(sourceRoot.pathname.length)
    const source = await Bun.file(path).text()
    scannedFiles += 1
    sources.set(relativePath, source)
    mocks.push(...findModuleMocks(source, relativePath))
  }
  return { scannedFiles, violations: mocks.filter((mock) => isSharedProductionModuleMock(mock, sources)) }
}

function validateModuleMockScan(scan: ModuleMockScan): string[] {
  return scan.scannedFiles === 0 ? ['scanned zero source files'] : []
}

describe('shared module mock isolation', () => {
  test('foundational and application modules are never replaced process-globally', async () => {
    const scan = await moduleMockScan()
    expect(scan.scannedFiles).toBeGreaterThan(0)
    expect(scan.violations).toEqual([])
  }, 15_000)

  test('fails closed when the source scan finds no files', () => {
    expect(validateModuleMockScan({ scannedFiles: 0, violations: [] })).toEqual(['scanned zero source files'])
  })

  test('detects literal, computed, aliased, destructured, and helper-wrapped module mocks', () => {
    const source = `
      import { mock as bunMock } from 'bun:test'
      const leaf = 'squads'
      const target = '../api/' + leaf
      const moduleMock = bunMock.module
      const { module: destructuredMock } = bunMock
      bunMock.module('../api/agents', () => ({}))
      moduleMock(target, () => ({}))
      destructuredMock(\`../api/\${leaf}\`, () => ({}))
      function helper(specifier: string) { bunMock.module(specifier, () => ({})) }
    `
    const found = findModuleMocks(source, 'components/a.test.ts')
    expect(found).toEqual([
      { path: 'components/a.test.ts', specifier: '../api/agents' },
      { path: 'components/a.test.ts', specifier: '../api/squads' },
      { path: 'components/a.test.ts', specifier: '../api/squads' },
      { path: 'components/a.test.ts', specifier: '<dynamic:specifier>' },
    ])
    expect(found.every((moduleMock) => isSharedProductionModuleMock(moduleMock))).toBe(true)
  })

  test('classifies direct, barrel-style, and source-aliased application targets', () => {
    const mocks = [
      { path: 'components/a.test.tsx', specifier: './Chat' },
      { path: 'components/a.test.tsx', specifier: '../hooks/useWebSocket' },
      { path: 'components/a.test.tsx', specifier: '@/components' },
      { path: 'components/a.test.tsx', specifier: '~/providers/AuthProvider' },
    ]
    expect(mocks.map((moduleMock) => isSharedProductionModuleMock(moduleMock))).toEqual([true, true, true, true])
    expect(isSharedProductionModuleMock({ path: 'components/a.test.tsx', specifier: 'react-router/dom' })).toBe(true)
    expect(isSharedProductionModuleMock({ path: 'components/a.test.tsx', specifier: 'react-router' })).toBe(true)
  })

  test('detects nested lexical aliases, destructuring, constants, element access, and parentheses', () => {
    const source = `
      import { mock as bunMock } from 'bun:test'
      test('nested', () => {
        const leaf = 'squads'
        const target = '../api/' + leaf
        const moduleMock = (bunMock['module'])
        const { ['module']: destructuredMock } = bunMock
        moduleMock(target, () => ({}))
        destructuredMock('../hooks/useWebSocket', () => ({}))
        ;(bunMock)['module']('../components/Chat', () => ({}))
      })
    `
    expect(findModuleMocks(source, 'components/nested.test.ts')).toEqual([
      { path: 'components/nested.test.ts', specifier: '../api/squads' },
      { path: 'components/nested.test.ts', specifier: '../hooks/useWebSocket' },
      { path: 'components/nested.test.ts', specifier: '../components/Chat' },
    ])
  })

  test('conservatively rejects shadowed lexical constants instead of resolving the wrong scope', () => {
    const source = `
      import { mock } from 'bun:test'
      test('local', () => { const target = '../hooks/usePWA'; mock.module(target, () => ({})) })
      test('package', () => { const target = 'react-router/dom'; mock.module(target, () => ({})) })
    `
    const found = findModuleMocks(source, 'components/shadowed.test.ts')
    expect(found).toEqual([
      { path: 'components/shadowed.test.ts', specifier: '<dynamic:target>' },
      { path: 'components/shadowed.test.ts', specifier: '<dynamic:target>' },
    ])
    expect(found.every((moduleMock) => isSharedProductionModuleMock(moduleMock))).toBe(true)
  })

  test('detects namespace imports and chained mock-object/module aliases', () => {
    const source = `
      import * as bt from 'bun:test'
      const firstMock = bt.mock
      const secondMock = firstMock
      const firstModule = secondMock.module
      const secondModule = firstModule
      secondModule('../api/squads', () => ({}))
    `
    expect(findModuleMocks(source, 'components/namespace.test.ts')).toEqual([
      { path: 'components/namespace.test.ts', specifier: '../api/squads' },
    ])
  })

  test('covers public aliases, API-local aliases, and genuine multi-hop alias barrels', () => {
    const sources = new Map([
      ['test/publicApi.ts', `export * from './middle'`],
      ['test/middle.ts', `export * from '@/api/squads'`],
    ])
    expect(isSharedProductionModuleMock({ path: 'components/a.test.ts', specifier: '@/api/squads' }, sources)).toBe(
      true
    )
    expect(isSharedProductionModuleMock({ path: 'api/squads.test.ts', specifier: './client' }, sources)).toBe(true)
    expect(isSharedProductionModuleMock({ path: 'test/a.test.ts', specifier: './publicApi' }, sources)).toBe(true)
  })

  test('only exempts the six target-specific React preload mocks', () => {
    expect(
      isSharedProductionModuleMock({ path: 'test-setup.ts', specifier: '<dynamic:`${ROOT}/react/index.js`>' })
    ).toBe(false)
    expect(isSharedProductionModuleMock({ path: 'test-setup.ts', specifier: '<dynamic:`${ROOT}/api/${leaf}`>' })).toBe(
      true
    )
  })

  test('scans this guard while ignoring mock-shaped fixture strings', async () => {
    const source = await Bun.file(import.meta.path).text()
    expect(findModuleMocks(source, import.meta.path.slice(sourceRoot.pathname.length))).toEqual([])
  })

  test('allows unrelated third-party mocks while rejecting routers and local test fixtures', () => {
    const thirdParty = findModuleMocks(`mock.module('qrcode', () => ({}))`, 'components/a.test.ts')
    const routers = findModuleMocks(
      `mock.module('react-router/dom', () => ({})); mock.module('react-router', () => ({}))`,
      'components/a.test.ts'
    )
    const localFixture = findModuleMocks(`mock.module('./Fixture', () => ({}))`, 'components/a.test.ts')
    expect(thirdParty.filter((mock) => isSharedProductionModuleMock(mock))).toEqual([])
    expect(routers.filter((mock) => isSharedProductionModuleMock(mock))).toEqual(routers)
    expect(localFixture.filter((mock) => isSharedProductionModuleMock(mock))).toEqual(localFixture)
  })
})
