import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import * as shared from '../index'

const root = resolve(import.meta.dir, '../../../..')

test('the review brief fixture is available through a test-only subpath, not the production barrel', () => {
  expect('workflowReviewBriefFixture' in shared).toBe(false)
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages/shared/package.json'), 'utf8'))
  expect(manifest.exports['./test-fixtures/workflow-review']).toBe('./src/test-fixtures/workflow-review.ts')
})

test('Core resolves the fixture as an external package member within its composite project boundary', () => {
  // Check resolution/membership only, never run the full Core typecheck here.
  const file = resolve(root, 'apps/core/tsconfig.json')
  const config = ts.readConfigFile(file, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, 'apps/core'))
  for (const relative of [
    'apps/core/src/services/workflows/execution.test.ts',
    'apps/core/src/services/workflows/decision-steps.test.ts',
    'apps/core/src/services/integrations/outputs/routing-audience.test.ts',
  ]) {
    const source = resolve(root, relative)
    const imports = ts.preProcessFile(readFileSync(source, 'utf8')).importedFiles
    const fixture = imports.find((entry) => entry.fileName === '@ficus/shared/test-fixtures/workflow-review')
    expect(fixture).toBeDefined()
    const resolved = ts.resolveModuleName(fixture!.fileName, source, parsed.options, ts.sys).resolvedModule
    expect(resolved?.resolvedFileName).toEndWith('/src/test-fixtures/workflow-review.ts')
    expect(resolved?.isExternalLibraryImport || parsed.fileNames.includes(resolved!.resolvedFileName)).toBe(true)
  }
})
