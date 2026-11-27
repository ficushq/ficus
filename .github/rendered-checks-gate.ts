/**
 * CI plumbing for the rendered web checks (apps/web/scripts/check-*.ts).
 *
 * `plan` decides which checks a run needs from the event's diff and the mapping in
 * apps/web/scripts/rendered-checks.ts, and splits them into shards for the job matrix. It fails
 * closed: when the range or the import graph cannot be read, every check runs.
 *
 * `verify-result` is the verdict of the `rendered checks` job. Nothing to run is a pass only when
 * the plan succeeded and said so; otherwise every shard must have succeeded.
 */
import { appendFile } from 'node:fs/promises'
import { classifyEvent } from './macos-ci-gate'
import { RENDERED_CHECKS, coverageByCheck, planShards, selectChecks } from '../apps/web/scripts/rendered-checks'

export interface Shard {
  name: string
  checks: string
}

export function shardMatrix(scripts: string[]): Shard[] {
  const shards = planShards(scripts)
  return shards.map((checks, index) => ({ name: `${index + 1} of ${shards.length}`, checks: checks.join(' ') }))
}

type Outcome = { ok: true } | { ok: false; reason: string }

export function validatePlanOutcome(planResult: string, run: string, runResult: string): Outcome {
  if (planResult === 'success' && run === 'false' && runResult === 'skipped') return { ok: true }
  if (planResult === 'success' && run === 'true' && runResult === 'success') return { ok: true }
  return {
    ok: false,
    reason: `plan=${planResult || 'missing'}, run=${run || 'missing'}, checks=${runResult || 'missing'}`,
  }
}

async function changedPaths(range: string): Promise<string[]> {
  // --no-renames lists both sides of a rename, so a moved component still selects its checks.
  const child = Bun.spawn(['git', 'diff', '--name-only', '--no-renames', '-z', range], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git diff failed (${exitCode}): ${stderr.trim()}`)
  return new TextDecoder().decode(stdout).split('\0').filter(Boolean)
}

async function selection(): Promise<{ checks: string[]; reason: string }> {
  const every = RENDERED_CHECKS.map((check) => check.script)
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH
    if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set')
    const decision = classifyEvent(process.env.GITHUB_EVENT_NAME ?? '', await Bun.file(eventPath).json())
    if (decision.mode === 'always') {
      if (decision.reason === 'invalid-range')
        console.warn('::warning::rendered check selection failed closed: invalid-range')
      return { checks: every, reason: decision.reason }
    }
    const paths = await changedPaths(`${decision.base}${decision.separator}${decision.head}`)
    const selected = selectChecks(paths, await coverageByCheck())
    return { checks: selected.checks, reason: selected.all ? `${selected.reason} changed` : 'covered paths changed' }
  } catch (error) {
    console.warn(
      `::warning::rendered check selection failed closed: ${error instanceof Error ? error.message : String(error)}`
    )
    return { checks: every, reason: 'selection error' }
  }
}

async function plan(): Promise<void> {
  const output = process.env.GITHUB_OUTPUT
  if (!output) throw new Error('GITHUB_OUTPUT is not set')
  const { checks, reason } = await selection()
  const shards = shardMatrix(checks)
  console.log(`${checks.length} of ${RENDERED_CHECKS.length} rendered checks selected (${reason}).`)
  for (const shard of shards) console.log(`shard ${shard.name}: ${shard.checks}`)
  await appendFile(output, `run=${checks.length > 0}\nshards=${JSON.stringify(shards)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = checks.length
      ? [`Rendered web checks selected (${reason}):`, '', ...checks.map((check) => `- ${check}`)]
      : ['No rendered web check covers this change.']
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
}

function verifyResult(): void {
  const outcome = validatePlanOutcome(
    process.env.PLAN_RESULT ?? '',
    process.env.RUN_CHECKS ?? '',
    process.env.CHECKS_RESULT ?? ''
  )
  if (!outcome.ok) {
    console.error(`::error::rendered web checks did not pass: ${outcome.reason}`)
    process.exit(1)
  }
  console.log(process.env.RUN_CHECKS === 'true' ? 'every selected rendered check passed' : 'no rendered check needed')
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode === 'plan') await plan()
  else if (mode === 'verify-result') verifyResult()
  else {
    console.error('Usage: bun .github/rendered-checks-gate.ts <plan|verify-result>')
    process.exit(2)
  }
}
