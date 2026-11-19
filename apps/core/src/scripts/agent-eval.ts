/**
 * Agent behaviour evals: run the scenarios in services/agent-evals against two versions of the
 * agent guidance and compare them with the no-regression rule.
 *
 *   bun run agents:eval [scenario…] [--old <ref>] [--new <ref|working>] [--repeat N]
 *                       [--tier deep,fast] [--record] [--markdown file] [--concurrency N]
 *   bun run agents:eval --list
 *   bun run agents:eval --prompt <scenario> [--new <ref|working>]   print the assembled system prompt
 *
 * Defaults: --old origin/main, --new working (the working tree), --repeat 3, and for each scenario
 * only its agent type's own configured tier (standard or deep); --tier replaces that tier for every
 * scenario, for example to run `fast` deliberately. Model keys come from the environment
 * only (for example ANTHROPIC_API_KEY); no database, stored account or provider settings are read.
 * Exits 1 when the new text regresses. See docs/wiki/agent-behaviour-evals.md.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flags = new Map<string, string | true>()
const names: string[] = []
const takesValue = new Set(['old', 'new', 'repeat', 'tier', 'markdown', 'prompt', 'concurrency'])
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!
  if (!arg.startsWith('--')) {
    names.push(arg)
    continue
  }
  const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined]
  flags.set(key, inline ?? (takesValue.has(key) ? (args[++index] ?? '') : true))
}
const flag = (name: string) => (typeof flags.get(name) === 'string' ? (flags.get(name) as string) : undefined)

// Prompt and tool modules import the database module; give it a URL it never uses.
process.env.DATABASE_URL ||= 'postgres://agent-evals:unused@127.0.0.1:1/unused'
// Production squads run on the vm sandbox runtime; the workspace section depends on it.
process.env.FICUS_SANDBOX_RUNTIME ||= 'vm'

const { runBatch, writeRecordingSnapshot } = await import('../services/agent-evals/batch')
const { HARNESS_REVISION } = await import('../services/agent-evals/define')
const { SCENARIOS, findScenario } = await import('../services/agent-evals/scenarios')
const { resolveVariant } = await import('../services/agent-evals/variant')
const { assembleScenarioPrompt } = await import('../services/agent-evals/prompt')
const { compareRuns, parseTierOption, piTurn, renderComparison, runScenario, selectScenarioTiers, usableModel } =
  await import('../services/agent-evals/run')
type RecordedRun = import('../services/agent-evals/run').RecordedRun

async function main(): Promise<number> {
  if (flags.has('list')) {
    for (const scenario of SCENARIOS)
      console.log(`${scenario.name}${scenario.must ? ' (must)' : ''} [${scenario.agentType}]: ${scenario.description}`)
    return 0
  }

  const newVariant = resolveVariant(flag('new') ?? 'working')
  const promptOf = flag('prompt')
  if (promptOf) {
    const scenario = findScenario(promptOf)
    if (!scenario) throw new Error(`Unknown scenario ${promptOf}; see --list`)
    console.log((await assembleScenarioPrompt(newVariant, scenario)).systemPrompt)
    return 0
  }

  const scenarios = names.length
    ? names.map((name) => findScenario(name) ?? fail(`Unknown scenario ${name}; see --list`))
    : SCENARIOS
  const selection = selectScenarioTiers(newVariant.root, scenarios, parseTierOption(newVariant.root, flags.get('tier')))
  const oldVariant = resolveVariant(flag('old') ?? 'origin/main')
  const repeat = Number(flag('repeat') ?? 3)
  const turn = await piTurn()

  // One job per scenario, tier, repeat and variant; old and new interleave so drift affects both.
  const jobs: (() => Promise<RecordedRun>)[] = []
  for (const { scenario, tier } of selection) {
    const model = await usableModel(newVariant.root, tier)
    if (!model) throw new Error(`No API key in the environment for any model in the ${tier} tier`)
    for (let index = 1; index <= repeat; index++)
      for (const variant of [oldVariant, newVariant])
        jobs.push(() => runScenario({ scenario, variant, model, turn, repeat: index }))
  }

  console.error(`Running ${jobs.length} agent turns (old: ${oldVariant.label}, new: ${newVariant.label})`)
  const markdown = flag('markdown')
  const recordFile = flags.has('record')
    ? join(
        import.meta.dir,
        '../services/agent-evals/recordings',
        `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
      )
    : undefined
  const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (markdown) writeFileSync(markdown, 'Incomplete cohort: the live batch is running. No comparison is accepted.\n')
  let reported = 0
  const batch = await runBatch(jobs, Number(flag('concurrency') ?? 3), (snapshot) => {
    if (recordFile)
      writeRecordingSnapshot(recordFile, {
        old: oldVariant.label,
        new: newVariant.label,
        harnessRevision: HARNESS_REVISION,
        harnessCommit,
        ...snapshot,
      })
    if (snapshot.runs.length !== reported && (snapshot.runs.length % 10 === 0 || snapshot.status === 'complete')) {
      reported = snapshot.runs.length
      console.error(`${reported}/${jobs.length} turns done`)
    }
  })
  if (batch.errors.length) {
    const message = `Incomplete cohort: ${batch.snapshot.runs.length}/${jobs.length} runs completed; ${batch.errors.length} jobs failed. No comparison is accepted.`
    console.error(message)
    if (recordFile) console.error(`Partial evidence: ${recordFile}`)
    if (markdown) writeFileSync(markdown, `${message}\n`)
    throw batch.errors[0]!.error
  }
  const runs = batch.snapshot.runs
  const oldRuns = runs.filter((run) => run.variant === oldVariant.label)
  const newRuns = runs.filter((run) => run.variant === newVariant.label)
  const comparison = compareRuns(scenarios, oldRuns, newRuns)
  const report = renderComparison(comparison, oldVariant.label, newVariant.label)
  const failuresByRun = runs
    .filter((run) => !run.verdict.pass)
    .map((run) => `- ${run.variant} / ${run.model} / ${run.scenario} #${run.repeat}: ${run.verdict.reason}`)
  console.log(`${report}\n\nFailed runs:\n${failuresByRun.join('\n') || '- none'}`)

  if (markdown) writeFileSync(markdown, `${report}\n\nFailed runs:\n${failuresByRun.join('\n') || '- none'}\n`)
  if (recordFile) console.error(`Recorded ${runs.length} runs in ${recordFile}`)
  return comparison.failures.length === 0 ? 0 : 1
}

function fail(message: string): never {
  throw new Error(message)
}

process.exit(await main())
