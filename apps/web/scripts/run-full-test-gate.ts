import { realpath, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

export type TestBaseline = {
  schemaVersion: 1
  fileCount: number
  testCount: number
  skipCount: number
  files: string[]
}

export type BunTestSummary = { pass: number; fail: number; skip: number; todo: number; tests: number; files: number }

const webRoot = resolve(dirname(import.meta.dir))
const checkoutRoot = resolve(webRoot, '../..')
const testFilePattern = /(^|\/).*((\.(test|spec))|(_(test|spec)))\.[cm]?[jt]sx?$/

export function stripTerminalControls(value: string): string {
  /* eslint-disable no-control-regex -- terminal escape bytes are the input being stripped */
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
}

export function parseBunTestSummary(output: string): BunTestSummary {
  const clean = stripTerminalControls(output).replace(
    /^(Ran \d+ tests? across \d+ files?\.) \[\d+(?:\.\d+)?(?:ms|s)\]$/gm,
    '$1'
  )
  const terminal = [...clean.matchAll(/^Ran (\d+) tests? across (\d+) files?\.$/gm)]
  if (terminal.length !== 1) throw new Error(`expected exactly one complete terminal summary, found ${terminal.length}`)
  const aggregate = (label: 'pass' | 'fail' | 'skip' | 'todo', required = false) => {
    const matches = [...clean.matchAll(new RegExp(`^\\s*(\\d+) ${label}$`, 'gm'))]
    if (matches.length > 1) throw new Error(`found conflicting ${label} aggregates`)
    if (required && matches.length === 0) throw new Error(`missing ${label} aggregate`)
    return matches.length === 0 ? 0 : Number(matches[0]![1])
  }
  return {
    pass: aggregate('pass', true),
    fail: aggregate('fail'),
    skip: aggregate('skip'),
    todo: aggregate('todo'),
    tests: Number(terminal[0]![1]),
    files: Number(terminal[0]![2]),
  }
}

export async function discoverTestFiles(root = resolve(webRoot, 'src')): Promise<string[]> {
  const canonicalRoot = await realpath(root)
  const files: string[] = []
  const glob = new Bun.Glob('**/*')
  // Include symlinks in the walk so a test-shaped link cannot disappear from discovery.
  for await (const entry of glob.scan({ cwd: root, onlyFiles: false })) {
    const normalized = entry.replaceAll('\\', '/')
    if (!testFilePattern.test(normalized)) continue
    const canonical = await realpath(resolve(root, entry))
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error(`test file escapes source root: ${entry}`)
    }
    if (!(await stat(canonical)).isFile()) continue
    files.push(`src/${normalized}`)
  }
  files.sort()
  if (new Set(files).size !== files.length) throw new Error('test discovery returned duplicate files')
  if (files.length === 0) throw new Error('test discovery scanned zero files')
  return files
}

export function validateBaselineAndInventory(baseline: TestBaseline, discovered: string[]): string[] {
  const errors: string[] = []
  if (baseline.schemaVersion !== 1 || baseline.fileCount <= 0 || baseline.testCount <= 0) {
    errors.push('invalid non-positive test baseline')
  }
  if (baseline.fileCount !== baseline.files.length || new Set(baseline.files).size !== baseline.files.length) {
    errors.push('test baseline file count/list is inconsistent')
  }
  // The baseline is a one-directional FLOOR, not an exact pin (operator
  // decision 2026-08-27: exact pins made every added test a baseline edit).
  // Its cross-PR job is catching silent LOSS — a glob regression shrinks the
  // live discovery and the collected run together, so only a remembered floor
  // can see it. New files/tests never require a baseline change; deliberate
  // removals lower the floor explicitly in test-baseline.json.
  const discoveredSet = new Set(discovered)
  const missing = baseline.files.filter((file) => !discoveredSet.has(file))
  if (missing.length > 0) {
    errors.push(`baseline test files missing from discovery: ${missing.join(', ')}`)
  }
  return errors
}

export function validateFullTestResult(
  baseline: TestBaseline,
  discovered: string[],
  output: string,
  exitCode: number
): string[] {
  const errors = validateBaselineAndInventory(baseline, discovered)
  let summary: BunTestSummary
  try {
    summary = parseBunTestSummary(output)
  } catch (error) {
    return [...errors, error instanceof Error ? error.message : String(error)]
  }
  if (exitCode !== 0) errors.push(`test process exited ${exitCode}`)
  if (summary.fail !== 0) errors.push(`expected 0 failures, received ${summary.fail}`)
  if (summary.skip !== baseline.skipCount || summary.skip !== 0)
    errors.push(`expected 0 skipped tests, received ${summary.skip}`)
  if (summary.todo !== 0) errors.push(`expected 0 todo tests, received ${summary.todo}`)
  if (summary.pass + summary.fail + summary.skip + summary.todo !== summary.tests) {
    errors.push('aggregate counts do not equal collected tests')
  }
  if (summary.files !== discovered.length) {
    errors.push(`collected ${summary.files} files but discovered ${discovered.length} — collection lost files`)
  }
  if (summary.files < baseline.fileCount) {
    errors.push(`collected files fell below the baseline floor (${summary.files} < ${baseline.fileCount})`)
  }
  if (summary.tests < baseline.testCount) {
    errors.push(
      `collected tests fell below the baseline floor (${summary.tests} < ${baseline.testCount}); deliberate removals must lower the floor in test-baseline.json`
    )
  }
  return errors
}

async function readStream(stream: ReadableStream<Uint8Array>, sink: { write(value: Uint8Array): unknown }) {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    sink.write(chunk)
  }
  return Buffer.concat(chunks).toString()
}

export async function runFullTestGate() {
  const pinned = (await Bun.file(resolve(checkoutRoot, '.bun-version')).text()).trim()
  if (Bun.version !== pinned) throw new Error(`Bun version mismatch: expected ${pinned}, received ${Bun.version}`)

  for (const specifier of ['react', 'react-dom', 'react-router-dom', '@ficus/shared', '@ficus/client-core']) {
    const resolved = Bun.resolveSync(specifier, webRoot)
    const rel = relative(checkoutRoot, resolved)
    if (rel.startsWith('..') || resolve(checkoutRoot, rel) !== resolved) {
      throw new Error(`${specifier} resolved outside checkout: ${resolved}`)
    }
  }

  const baseline = (await Bun.file(resolve(webRoot, 'test-baseline.json')).json()) as TestBaseline
  const discovered = await discoverTestFiles()
  const preflightErrors = validateBaselineAndInventory(baseline, discovered)
  if (preflightErrors.length) throw new Error(preflightErrors.join('; '))

  const child = Bun.spawn(['bun', 'test', './src'], { cwd: webRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout, process.stdout),
    readStream(child.stderr, process.stderr),
    child.exited,
  ])
  const output = `${stdout}\n${stderr}`
  const errors = validateFullTestResult(baseline, discovered, output, exitCode)
  if (errors.length) throw new Error(errors.join('; '))
  const summary = parseBunTestSummary(output)
  console.log(`Full web test gate passed: ${summary.tests} tests across ${summary.files} files.`)
}

if (import.meta.main) {
  await runFullTestGate()
}
