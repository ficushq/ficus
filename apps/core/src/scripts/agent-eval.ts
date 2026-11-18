/**
 * Agent behaviour evals: run the scenarios in services/agent-evals against two versions of the
 * agent guidance and compare them with the no-regression rule.
 *
 *   bun run agents:eval [scenario…] [--old <ref>] [--new <ref|working>] [--repeat N]
 *                       [--tier standard,fast] [--record] [--markdown file] [--concurrency N]
 *   bun run agents:eval --list
 *   bun run agents:eval --prompt <scenario> [--new <ref|working>]   print the assembled system prompt
 *
 * Defaults: --old origin/main, --new working (the working tree), --repeat 3, and for each scenario
 * its agent type's default tier plus the cheaper `fast` tier. Model keys come from the environment
 * only (for example ANTHROPIC_API_KEY); no database, stored account or provider settings are read.
 * Exits 1 when the new text regresses. See docs/wiki/agent-behaviour-evals.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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

const { SCENARIOS, findScenario } = await import('../services/agent-evals/scenarios')
const { resolveVariant } = await import('../services/agent-evals/variant')
const { assembleScenarioPrompt } = await import('../services/agent-evals/prompt')
const { compareRuns, piTurn, renderComparison, runScenario, tiersFor, usableModel } =
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
  const oldVariant = resolveVariant(flag('old') ?? 'origin/main')
  const repeat = Number(flag('repeat') ?? 3)
  const turn = await piTurn()

  // One job per scenario, tier, repeat and variant; old and new interleave so drift affects both.
  const jobs: (() => Promise<RecordedRun>)[] = []
  for (const scenario of scenarios) {
    const tiers = flag('tier')?.split(',') ?? tiersFor(newVariant.root, scenario.agentType)
    for (const tier of tiers) {
      const model = await usableModel(newVariant.root, tier)
      if (!model) throw new Error(`No API key in the environment for any model in the ${tier} tier`)
      for (let index = 1; index <= repeat; index++)
        for (const variant of [oldVariant, newVariant])
          jobs.push(() => runScenario({ scenario, variant, model, turn, repeat: index }))
    }
  }

  console.error(`Running ${jobs.length} agent turns (old: ${oldVariant.label}, new: ${newVariant.label})`)
  const runs = await runPool(jobs, Number(flag('concurrency') ?? 3))
  const oldRuns = runs.filter((run) => run.variant === oldVariant.label)
  const newRuns = runs.filter((run) => run.variant === newVariant.label)
  const comparison = compareRuns(scenarios, oldRuns, newRuns)
  const report = renderComparison(comparison, oldVariant.label, newVariant.label)
  const failuresByRun = runs
    .filter((run) => !run.verdict.pass)
    .map((run) => `- ${run.variant} / ${run.model} / ${run.scenario} #${run.repeat}: ${run.verdict.reason}`)
  console.log(`${report}\n\nFailed runs:\n${failuresByRun.join('\n') || '- none'}`)

  const markdown = flag('markdown')
  if (markdown) writeFileSync(markdown, `${report}\n\nFailed runs:\n${failuresByRun.join('\n') || '- none'}\n`)
  if (flags.has('record')) {
    const directory = join(import.meta.dir, '../services/agent-evals/recordings')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify({ old: oldVariant.label, new: newVariant.label, runs }, null, 1)}\n`)
    console.error(`Recorded ${runs.length} runs in ${file}`)
  }
  return comparison.failures.length === 0 ? 0 : 1
}

async function runPool<T>(jobs: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++
      results[index] = await jobs[index]!()
      done += 1
      if (done % 10 === 0 || done === jobs.length) console.error(`${done}/${jobs.length} turns done`)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return results
}

function fail(message: string): never {
  throw new Error(message)
}

process.exit(await main())
