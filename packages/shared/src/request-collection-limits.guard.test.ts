import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Audited request boundaries. Upstream responses, persisted delivery/CI history, artifact
// contents and the raw keyedRecord constructor are intentionally not request validators.
const shared = [
  'schemas',
  'workflows',
  'decisions',
  'integration-outputs',
  'event-rule-sample',
  'squad-event-rules',
  'theme-assistant',
  'assistant-editors',
]
const core = [
  'routes/machines',
  'routes/memory',
  'routes/grants',
  'routes/artifacts',
  'routes/squad-env',
  'routes/roles',
  'routes/system-tokens',
  'routes/remote-hosts',
  'routes/auth',
  'routes/deployments',
  'routes/integrations',
  'services/integrations/credential-settings',
  'services/integrations/google-cloud/settings',
  'services/integrations/push/settings',
]
function unbounded(source: string): string[] {
  const ast = ts.createSourceFile('schema.ts', source, ts.ScriptTarget.Latest, true)
  const findings: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast).replace(/\s/g, '')
      if (['z.array', 'z.record', 'z.partialRecord', 'keyedRecord'].includes(name)) {
        let bounded = false
        if (name === 'z.array') {
          let current: ts.Node = node
          while (ts.isPropertyAccessExpression(current.parent) && ts.isCallExpression(current.parent.parent)) {
            if (current.parent.name.text === 'max') bounded = true
            current = current.parent.parent
          }
        } else
          bounded =
            ts.isCallExpression(node.parent) &&
            node.parent.expression.getText(ast) === 'boundedRecord' &&
            node.parent.arguments[0] === node
        if (!bounded) findings.push(`${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${name}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return findings
}
test('guard distinguishes an array maximum from an inner string maximum', () => {
  expect(unbounded('z.array(z.string().max(100))')).toEqual(['1: z.array'])
  expect(unbounded('z.array(z.string()).max(100)')).toEqual([])
  expect(unbounded('boundedRecord(z.record(z.string(),z.unknown()),256)')).toEqual([])
})
test('every audited request array and map preflights cardinality', () => {
  const root = resolve(import.meta.dir, '../../..')
  const files = [...shared.map((p) => `packages/shared/src/${p}.ts`), ...core.map((p) => `apps/core/src/${p}.ts`)]
  expect(
    files.flatMap((file) => unbounded(readFileSync(resolve(root, file), 'utf8')).map((f) => `${file}:${f}`))
  ).toEqual([])
})
