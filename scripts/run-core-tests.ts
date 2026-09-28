import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { discoverTests, runTests } from './test-runner'

const repoRoot = resolve(import.meta.dir, '..')
const coreRoot = resolve(repoRoot, 'apps/core')

export function coreTestPlan() {
  const workflow = Bun.YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
  }
  const step = workflow.jobs['subprocess-tests']!.steps.find((entry) => entry.name === 'Run real-subprocess tests')
  const subprocess = [...(step?.run ?? '').matchAll(/\bsrc\/[\w./-]+\.test\.ts\b/g)].map((match) => `./${match[0]}`)
  if (subprocess.length === 0 || new Set(subprocess).size !== subprocess.length)
    throw new Error('Subprocess lane inventory is empty or duplicated')
  const files = discoverTests(coreRoot, ['src'])
  for (const file of subprocess) if (!files.includes(file)) throw new Error(`Subprocess lane file is missing: ${file}`)
  // Bun's module replacements persist for the life of a process. Detect these
  // tests automatically so a new SDK mock cannot silently poison other files.
  const moduleMocks = files.filter((file) =>
    /\bmock\s*\.\s*module\s*\(/.test(readFileSync(resolve(coreRoot, file), 'utf8'))
  )
  const isolated = new Set([...subprocess, ...moduleMocks])
  return { shared: files.filter((file) => !isolated.has(file)), isolated: [...isolated].sort(), files }
}

if (import.meta.main) {
  // The package contract needs the database: keep the preload's fail-fast exit
  // instead of its local no-database fallback (apps/core test-db-fallback.ts).
  process.env.FICUS_TEST_REQUIRE_DB = '1'
  const plan = coreTestPlan()
  const subprocessOnly = process.argv.includes('--subprocess')
  const reverse = process.argv.includes('--reverse')
  const coreOnly = process.env.FICUS_TEST_SKIP_SUBPROCESS === '1' && !subprocessOnly
  if (!subprocessOnly) await runTests({ cwd: coreRoot, roots: plan.shared, reverse })
  if (!coreOnly) await runTests({ cwd: coreRoot, roots: plan.isolated, isolated: true, reverse, cacheSchema: true })
}
