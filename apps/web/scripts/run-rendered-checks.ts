/**
 * Runs rendered browser checks (`check-*.ts`) one after another and fails if any of them fails or
 * runs out of time. CI runs it on the checks a pull request needs (.github/rendered-checks-gate.ts).
 *
 * From apps/web:
 *   bun scripts/run-rendered-checks.ts                       every check
 *   bun scripts/run-rendered-checks.ts --changed origin/main the checks covering what changed since origin/main
 *   bun scripts/run-rendered-checks.ts check-spend-layout.ts check-squad-cards.ts
 * Options: --list prints the selection without running it; --timeout <seconds> caps each check
 * (default 600). CHROMIUM_PATH and SCREENSHOT_DIR pass through to the checks.
 *
 * One at a time on purpose: the checks share Vite's dependency cache (fixture-server.ts), and each
 * one measures layout and motion that a busy machine would skew.
 */
import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import {
  RENDERED_CHECKS,
  checkByScript,
  coverageByCheck,
  repoRoot,
  selectChecks,
  webRoot,
  type Selection,
} from './rendered-checks'

export const DEFAULT_TIMEOUT_SECONDS = 600

export type CheckStatus = 'passed' | 'failed' | 'timed out'
export interface CheckResult {
  script: string
  status: CheckStatus
  /** Exit code, or the signal that ended it. */
  exit: number | string | null
  seconds: number
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  /** The command for one check; tests substitute their own. */
  command?: (script: string) => string[]
  /** Prints a heading before and a closing line after each check's output. */
  log?: (line: string) => void
}

/** Runs one check in its own process group and kills the whole group (browser included) when it
 * outlives the timeout, so a hung check cannot hold the next one or the job. */
export function runCheck(script: string, options: RunOptions = {}): Promise<CheckResult> {
  const {
    cwd = webRoot,
    timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
    command = (name) => ['bun', `scripts/${name}`],
  } = options
  const [file, ...args] = command(script)
  const started = performance.now()
  return new Promise((done) => {
    const child = spawn(file!, args, { cwd, stdio: 'inherit', detached: true, env: process.env })
    let timedOut = false
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    // Its own process group no longer gets the terminal's Ctrl+C, so pass it on.
    const interrupt = () => {
      killGroup()
      process.exit(130)
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    let finished = false
    const finish = (exit: number | string | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
      // A check that exits while its browser lingers would leave it running into the next check.
      killGroup()
      const seconds = Math.round((performance.now() - started) / 100) / 10
      const status: CheckStatus = timedOut ? 'timed out' : exit === 0 ? 'passed' : 'failed'
      done({ script, status, exit, seconds })
    }
    child.on('error', () => finish('spawn error'))
    child.on('exit', (code, signal) => finish(code ?? signal))
  })
}

export async function runChecks(scripts: string[], options: RunOptions = {}): Promise<CheckResult[]> {
  const log = options.log ?? console.log
  const ci = !!process.env.GITHUB_ACTIONS
  const results: CheckResult[] = []
  for (const [index, script] of scripts.entries()) {
    log(ci ? `::group::${script}` : `\n=== ${script} (${index + 1}/${scripts.length})`)
    const result = await runCheck(script, options)
    if (ci) log('::endgroup::')
    log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${script}: ${describe(result)}`)
    if (ci && result.status !== 'passed') log(`::error title=${script}::${script} ${describe(result)}`)
    results.push(result)
  }
  return results
}

function describe(result: CheckResult) {
  if (result.status === 'passed') return `passed in ${result.seconds}s`
  if (result.status === 'timed out') return `timed out after ${result.seconds}s`
  return `failed (exit ${result.exit}) after ${result.seconds}s`
}

export function summary(results: CheckResult[]): string {
  const failed = results.filter((result) => result.status !== 'passed')
  return [
    `### Rendered web checks: ${results.length - failed.length} of ${results.length} passed`,
    '',
    '| Check | Result | Seconds |',
    '| --- | --- | ---: |',
    ...results.map((result) => `| ${result.script} | ${result.status} | ${result.seconds} |`),
    '',
  ].join('\n')
}

export type Arguments = { list: boolean; timeoutSeconds: number } & (
  { mode: 'all' } | { mode: 'changed'; base: string } | { mode: 'named'; scripts: string[] }
)

export function parseArguments(args: string[]): Arguments {
  let list = false
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS
  let base: string | undefined
  const scripts: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--list') list = true
    else if (arg === '--timeout') {
      timeoutSeconds = Number(args[++index])
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('--timeout needs a positive number')
    } else if (arg === '--changed') {
      base = args[++index]
      if (!base) throw new Error('--changed needs a base ref, for example origin/main')
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else scripts.push(checkByScript(arg.replace(/^scripts\//, '')).script)
  }
  if (base && scripts.length > 0) throw new Error('give either --changed or check names, not both')
  if (base) return { mode: 'changed', base, list, timeoutSeconds }
  if (scripts.length > 0) return { mode: 'named', scripts, list, timeoutSeconds }
  return { mode: 'all', list, timeoutSeconds }
}

async function changedSince(base: string): Promise<string[]> {
  // Committed changes since the merge base, plus anything not committed yet.
  const run = async (args: string[]) => {
    const child = Bun.spawn(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
    return stdout.split('\0').filter(Boolean)
  }
  const committed = await run(['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`])
  const working = await run(['diff', '--name-only', '--no-renames', '-z', 'HEAD'])
  const untracked = await run(['ls-files', '--others', '--exclude-standard', '-z'])
  return [...new Set([...committed, ...working, ...untracked])]
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  let selection: Selection
  if (options.mode === 'named') selection = { all: false, checks: options.scripts }
  else if (options.mode === 'all')
    selection = { all: true, reason: 'every check', checks: RENDERED_CHECKS.map((c) => c.script) }
  else selection = selectChecks(await changedSince(options.base), await coverageByCheck())
  if (selection.all && options.mode === 'changed') console.log(`Every check runs: ${selection.reason} changed.`)
  if (selection.checks.length === 0) {
    console.log('No rendered check covers these changes.')
    return
  }
  if (options.list) {
    console.log(selection.checks.join('\n'))
    return
  }
  const results = await runChecks(selection.checks, { timeoutMs: options.timeoutSeconds * 1000 })
  const report = summary(results)
  console.log(`\n${report}`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (results.some((result) => result.status !== 'passed')) process.exit(1)
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(2)
  })
}
