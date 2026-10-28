import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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

export function assertTestCompletion(
  output: string,
  exitCode: number | null,
  signal: string | number | null,
  files: number
) {
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
  /** Cleanup gets up to 15s (ownership probe + down); then force-stop a stuck child. */
  stopGraceMs?: number
  /** Absolute epoch milliseconds: includes CI setup, not just test-body time. */
  deadline?: number
  /** Extra `bun test` arguments placed before the files, such as a test name pattern. */
  args?: string[]
}) {
  const { cwd, roots, isolated = false, concurrency = 1, reverse = false, args = [] } = options
  if (options.cacheSchema && (!isolated || concurrency !== 1))
    throw new Error('Schema cache requires sequential isolated files')
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || (!isolated && concurrency !== 1)) {
    throw new Error('Concurrency must be a positive integer and requires isolated files')
  }
  const stopGraceMs = options.stopGraceMs ?? 20000
  if (!Number.isFinite(stopGraceMs) || stopGraceMs < 0 || stopGraceMs > 20000)
    throw new Error('Stop grace must be between 0 and 20000ms')
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline <= 0))
    throw new Error('Deadline must be a positive finite epoch timestamp')
  const files = discoverTests(cwd, roots)
  if (reverse) files.reverse()
  const batches = isolated ? files.map((file) => [file]) : [files]
  const scratch = mkdtempSync(join(tmpdir(), 'ficus-tests-'))
  const children = new Set<ReturnType<typeof Bun.spawn>>()
  const timings = batches.map((batch) => ({ files: batch, status: 'UNSTARTED', durationMs: 0 }))
  let deadlineExceeded = false
  let next = 0
  let failed = false
  const started = performance.now()
  const killTimers = new Map<ReturnType<typeof Bun.spawn>, ReturnType<typeof setTimeout>>()
  const stop = () => {
    failed = true
    for (const child of children) {
      child.kill('SIGTERM')
      if (!killTimers.has(child))
        killTimers.set(
          child,
          setTimeout(() => child.kill('SIGKILL'), stopGraceMs)
        )
    }
  }
  const expire = () => {
    deadlineExceeded = true
    stop()
  }
  const remaining = options.deadline === undefined ? undefined : options.deadline - Date.now()
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  if (remaining !== undefined) {
    if (remaining <= 0) expire()
    else deadlineTimer = setTimeout(expire, remaining)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
        while (!failed && next < batches.length) {
          if (options.deadline !== undefined && Date.now() >= options.deadline) {
            expire()
            break
          }
          const index = next++
          const batch = batches[index]!
          const timing = timings[index]!
          timing.status = 'INCOMPLETE'
          const fileStarted = performance.now()
          const log = join(scratch, `${index}.log`)
          // A real fd avoids Bun test's inherited reporter IPC swallowing nested
          // test output. No shell, bounded pipe, or shared generated artifact path.
          const fd = openSync(log, 'w')
          let child: ReturnType<typeof Bun.spawn> | undefined
          try {
            child = Bun.spawn([process.execPath, 'test', ...args, ...batch], {
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
            timing.status = 'PASSED'
            console.log(`PASS ${isolated ? batch[0] : `${files.length} files`}: ${output.match(/^Ran .+$/m)?.[0]}`)
            // Condense successful logs without hiding unsupported-platform skips.
            for (const line of output.match(
              /^(?:Reused verified test schema|SKIP:|Skipping |\(skip\)|\s*\d+ skip).*$/gm
            ) ?? [])
              console.log(line)
          } catch (error) {
            timing.status = deadlineExceeded || child?.signalCode ? 'INCOMPLETE' : 'FAILED'
            failed = true
            console.error(
              `FAIL ${isolated ? batch[0] : `shared suite (${batch.length} files)`}: ${error instanceof Error ? error.message : String(error)}`
            )
          } finally {
            timing.durationMs = performance.now() - fileStarted
            if (child) {
              children.delete(child)
              clearTimeout(killTimers.get(child))
              killTimers.delete(child)
            }
            closeSync(fd)
          }
        }
      })
    )
    if (options.deadline !== undefined && Date.now() >= options.deadline) expire()
    if (failed) throw new Error('Test suite failed; remaining files were not started')
    console.log(`Completed ${files.length} test files in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  } finally {
    clearTimeout(deadlineTimer)
    const rows = [...timings]
      .sort((a, b) => b.durationMs - a.durationMs || a.files[0]!.localeCompare(b.files[0]!))
      .map(({ status, durationMs, files }) => `${status} ${(durationMs / 1000).toFixed(3)}s ${files.join(', ')}`)
    const report = [
      'Per-file timing (slowest first; shared batches report combined wall time)',
      deadlineExceeded ? 'Lane deadline exceeded — FAIL' : failed ? 'Test suite failed' : 'Test suite passed',
      `Runner wall time: ${((performance.now() - started) / 1000).toFixed(3)}s`,
      ...rows,
      '',
    ].join('\n')
    // Flush even on failure before an entrypoint can exit. Persist the same
    // complete inventory to the Actions summary, not just the slowest N files.
    try {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(report, (error) => (error ? reject(error) : resolve()))
      })
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Test runner\n\n\`\`\`text\n${report}\`\`\`\n`)
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      rmSync(scratch, { recursive: true, force: true })
    }
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
