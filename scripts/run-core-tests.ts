import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { discoverTests, runTests } from './test-runner'

const repoRoot = resolve(import.meta.dir, '..')
const coreRoot = resolve(repoRoot, 'apps/core')

export const coreTestUsage = `Usage: bun run test [options] [file-or-directory...]

Runs Core tests with the database preload (FICUS_TEST_REQUIRE_DB=1), module-mock
and subprocess isolation, and completion checks.

With no paths, runs the full Core suite (the CI contract). With paths, runs only
the test files they name or contain; each keeps its normal lane (shared or isolated).
Paths are relative to apps/core (or the repository root) and must stay inside apps/core.

Options:
  -t, --test-name-pattern <regex>  Only run tests whose names match (passed to bun test;
                                   every isolated file must contain a match)
  --list                           Print the selected files per lane and exit without running
  --reverse                        Run files in reverse order
  --subprocess                     Full suite: run only the isolated lane (CI subprocess job)
  -h, --help                       Show this help

Examples:
  bun run test src/services/maintenance/store.test.ts
  bun run test src/services/maintenance/store.test.ts -t "lease owner"
  bun run test --list src/services/machines`

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

export type CoreTestOptions =
  | { help: true }
  | {
      help: false
      paths: string[]
      list: boolean
      reverse: boolean
      subprocessOnly: boolean
      testNamePattern?: string
    }

/** Parses runner arguments; throws on anything it cannot honor instead of falling back to the full suite. */
export function parseCoreTestArgs(args: string[]): CoreTestOptions {
  const paths: string[] = []
  let list = false
  let reverse = false
  let subprocessOnly = false
  let testNamePattern: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') return { help: true }
    else if (arg === '--list') list = true
    else if (arg === '--reverse') reverse = true
    else if (arg === '--subprocess') subprocessOnly = true
    else if (arg === '-t' || arg === '--test-name-pattern' || arg.startsWith('--test-name-pattern=')) {
      if (testNamePattern !== undefined) throw new Error('Test name pattern given more than once')
      testNamePattern = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index]
      if (!testNamePattern) throw new Error(`${arg.split('=')[0]} requires a non-empty pattern`)
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else paths.push(arg)
  }
  if (subprocessOnly && paths.length > 0)
    throw new Error('--subprocess selects the full isolated lane and cannot be combined with paths')
  if (testNamePattern !== undefined && paths.length === 0)
    throw new Error('A test name pattern requires at least one path; it would otherwise run the full suite')
  return { help: false, paths, list, reverse, subprocessOnly, testNamePattern }
}

/** Resolves path arguments to discovered Core test files, keeping each file's normal lane. */
export function selectCoreTests(
  plan: ReturnType<typeof coreTestPlan>,
  paths: string[],
  cwd = process.cwd()
): { shared: string[]; isolated: string[] } {
  if (paths.length === 0) return { shared: plan.shared, isolated: plan.isolated }
  const selected = new Set<string>()
  for (const path of paths) {
    const candidates = isAbsolute(path) ? [path] : [resolve(cwd, path), resolve(repoRoot, path)]
    const absolute = candidates.find((candidate) => existsSync(candidate))
    if (!absolute) throw new Error(`No such file or directory: ${path}`)
    const fromCore = relative(coreRoot, absolute)
    if (fromCore.startsWith('..') || isAbsolute(fromCore)) throw new Error(`Path is outside apps/core: ${path}`)
    let files: string[]
    try {
      files = discoverTests(coreRoot, [fromCore || '.'])
    } catch {
      throw new Error(`No Core test files match: ${path}`)
    }
    const known = files.filter((file) => plan.files.includes(file))
    if (known.length === 0) throw new Error(`No Core test files match: ${path}`)
    for (const file of known) selected.add(file)
  }
  return {
    shared: plan.shared.filter((file) => selected.has(file)),
    isolated: plan.isolated.filter((file) => selected.has(file)),
  }
}

if (import.meta.main) {
  let options: CoreTestOptions
  try {
    options = parseCoreTestArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${coreTestUsage}`)
    process.exit(2)
  }
  if (options.help) {
    console.log(coreTestUsage)
    process.exit(0)
  }
  // The package contract needs the database: keep the preload's fail-fast exit
  // instead of its local no-database fallback (apps/core test-db-fallback.ts).
  process.env.FICUS_TEST_REQUIRE_DB = '1'
  const plan = coreTestPlan()
  let selection: { shared: string[]; isolated: string[] }
  try {
    selection = selectCoreTests(plan, options.paths)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  const { reverse, subprocessOnly } = options
  // CI's core job skips the isolated lane, which runs in its own job. Focused
  // runs always execute what was asked for.
  const coreOnly = options.paths.length === 0 && process.env.FICUS_TEST_SKIP_SUBPROCESS === '1' && !subprocessOnly
  const runShared = !subprocessOnly && selection.shared.length > 0
  const runIsolated = !coreOnly && selection.isolated.length > 0
  if (options.list) {
    for (const file of runShared ? selection.shared : []) console.log(`shared   ${file}`)
    for (const file of runIsolated ? selection.isolated : []) console.log(`isolated ${file}`)
    process.exit(0)
  }
  const args = options.testNamePattern === undefined ? [] : [`--test-name-pattern=${options.testNamePattern}`]
  if (runShared) await runTests({ cwd: coreRoot, roots: selection.shared, reverse, args })
  if (runIsolated)
    await runTests({ cwd: coreRoot, roots: selection.isolated, isolated: true, reverse, cacheSchema: true, args })
}
