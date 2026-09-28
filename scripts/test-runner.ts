import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const excluded = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'coverage',
  'test-fixtures',
  'ios',
  'android',
  '.expo',
])
const testFile = /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/

export function discoverTests(cwd: string, roots: string[]): string[] {
  const files = new Set<string>()
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && !excluded.has(entry.name)) visit(path)
      else if (entry.isFile() && testFile.test(entry.name)) files.add(`./${relative(cwd, path)}`)
    }
  }
  for (const root of roots) {
    const path = resolve(cwd, root)
    if (statSync(path).isDirectory()) visit(path)
    else if (testFile.test(path)) files.add(`./${relative(cwd, path)}`)
    else throw new Error(`Not a test file: ${root}`)
  }
  if (files.size === 0) throw new Error('No test files discovered')
  return [...files].sort()
}

export function assertTestCompletion(output: string, exitCode: number | null, signal: string | null, files: number) {
  if (signal) throw new Error(`Test process terminated by ${signal}`)
  if (exitCode !== 0) throw new Error(`Test process exited with status ${String(exitCode)}`)
  // FORCE_COLOR=0 below keeps this contract independent of terminal rendering.
  const summaries = [...output.matchAll(/^Ran (\d+) tests? across (\d+) files?\.(?: \[[^\]]+\])?$/gm)]
  if (summaries.length !== 1)
    throw new Error('Test process ended without exactly one final summary (possible early process.exit)')
  if (Number(summaries[0]![1]) === 0) throw new Error('Test process collected zero tests')
  if (Number(summaries[0]![2]) !== files)
    throw new Error(`Test process collected ${summaries[0]![2]} of ${files} discovered files`)
  const failures = [...output.matchAll(/^\s*(\d+) fail$/gm)]
  if (failures.length !== 1 || Number(failures[0]![1]) !== 0)
    throw new Error('Test process did not report exactly one zero-failure aggregate')
}

export async function runTests(options: {
  cwd: string
  roots: string[]
  isolated?: boolean
  concurrency?: number
  reverse?: boolean
  cacheSchema?: boolean
}) {
  const { cwd, roots, isolated = false, concurrency = 1, reverse = false } = options
  if (options.cacheSchema && (!isolated || concurrency !== 1))
    throw new Error('Schema cache requires sequential isolated files')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || (!isolated && concurrency !== 1)) {
    throw new Error('Concurrency must be a positive integer and requires isolated files')
  }
  const files = discoverTests(cwd, roots)
  if (reverse) files.reverse()
  const batches = isolated ? files.map((file) => [file]) : [files]
  const scratch = mkdtempSync(join(tmpdir(), 'tau-tests-'))
  const children = new Set<ReturnType<typeof Bun.spawn>>()
  let next = 0
  let failed = false
  const started = performance.now()
  const stop = () => {
    failed = true
    for (const child of children) child.kill('SIGTERM')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
        while (!failed && next < batches.length) {
          const index = next++
          const batch = batches[index]!
          const log = join(scratch, `${index}.log`)
          // A real fd avoids Bun test's inherited reporter IPC swallowing nested
          // test output. No shell, bounded pipe, or shared generated artifact path.
          const fd = openSync(log, 'w')
          let child: ReturnType<typeof Bun.spawn> | undefined
          try {
            child = Bun.spawn([process.execPath, 'test', ...batch], {
              cwd,
              env: {
                ...process.env,
                FORCE_COLOR: '0',
                NO_COLOR: '1',
                FICUS_TEST_SCHEMA_CACHE_FILE: options.cacheSchema ? join(scratch, 'schema.json') : undefined,
              },
              stdout: fd,
              stderr: fd,
            })
            children.add(child)
            const exitCode = await child.exited
            const output = readFileSync(log, 'utf8')
            try {
              assertTestCompletion(output, exitCode, child.signalCode, batch.length)
            } catch (error) {
              // CI stderr is a pipe: wait for the full diagnostic log before
              // propagating failure, or process exit can truncate its tail.
              await new Promise<void>((resolve, reject) => {
                process.stderr.write(output, (error) => (error ? reject(error) : resolve()))
              })
              throw error
            }
            console.log(`PASS ${isolated ? batch[0] : `${files.length} files`}: ${output.match(/^Ran .+$/m)?.[0]}`)
            // Condense successful logs without hiding unsupported-platform skips.
            for (const line of output.match(
              /^(?:Reused verified test schema|SKIP:|Skipping |\(skip\)|\s*\d+ skip).*$/gm
            ) ?? [])
              console.log(line)
          } catch (error) {
            failed = true
            console.error(
              `FAIL ${isolated ? batch[0] : `shared suite (${batch.length} files)`}: ${error instanceof Error ? error.message : String(error)}`
            )
          } finally {
            if (child) children.delete(child)
            closeSync(fd)
          }
        }
      })
    )
    if (failed) throw new Error('Test suite failed; remaining files were not started')
    console.log(`Completed ${files.length} test files in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const isolated = args.includes('--isolated')
  const reverse = args.includes('--reverse')
  const roots = args.filter((arg) => !arg.startsWith('--'))
  for (const arg of args)
    if (arg.startsWith('--') && arg !== '--isolated' && arg !== '--reverse') throw new Error(`Unknown option: ${arg}`)
  await runTests({ cwd: process.cwd(), roots: roots.length ? roots : ['src'], isolated, reverse })
}
