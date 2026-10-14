/**
 * Decision evals: run labelled cases for decision-powered features against real decision
 * providers, record and diff their answers, and review saved corrections.
 *
 *   bun run decisions:eval [eval…] [--from local|env|backend:<label>] [--provider id|kind,…]
 *                          [--repeat N] [--variant name] [--record] [--diff] [--max-cost dollars]
 *                          [--markdown file] [--json file]
 *   bun run decisions:eval --list
 *   bun run decisions:eval --inbox                       saved corrections waiting for review
 *   bun run decisions:eval --accept <id> [--shared]      keep one as a case (local file unless --shared)
 *   bun run decisions:eval --dismiss <id>
 *
 * See AGENTS.md → "Decision features need evals".
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRootEnvForStandaloneScript } from '../db/load-root-env'

const args = process.argv.slice(2)
const flags = new Map<string, string | true>()
const names: string[] = []
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!
  if (!arg.startsWith('--')) {
    names.push(arg)
    continue
  }
  const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined]
  const takesValue = [
    'from',
    'provider',
    'repeat',
    'variant',
    'max-cost',
    'markdown',
    'json',
    'accept',
    'dismiss',
    'name',
  ].includes(key)
  flags.set(key, inline ?? (takesValue ? (args[++index] ?? '') : true))
}
const flag = (name: string) => (typeof flags.get(name) === 'string' ? (flags.get(name) as string) : undefined)

const from = flag('from') ?? 'local'
const usesInstance = from === 'local' || flags.has('inbox') || flags.has('accept') || flags.has('dismiss')
const root = join(import.meta.dir, '../../../..')
if (usesInstance) loadRootEnvForStandaloneScript(root)
const { PLACEHOLDER_DATABASE_URL, resolveProviders, selectProviders } =
  await import('../services/decisions/evals/providers')
// Feature modules import the database module; without an instance, give it a URL it never uses.
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = PLACEHOLDER_DATABASE_URL

const { discoverEvals, readSnapshot, runEval, writeSnapshot } = await import('../services/decisions/evals/run')
const { failures, formatMarkdown, formatRun, summarize } = await import('../services/decisions/evals/report')

async function main(): Promise<number> {
  const evals = await discoverEvals()

  if (flags.has('list')) {
    for (const { evaluation, file } of evals)
      console.log(
        `${evaluation.name.padEnd(26)} ${evaluation.purpose.padEnd(20)} ${String(evaluation.cases.length).padStart(3)} cases  ${file.slice(root.length + 1)}`
      )
    return 0
  }

  if (flags.has('inbox') || flags.has('accept') || flags.has('dismiss')) {
    const inbox = await import('../services/decisions/evals/inbox')
    if (flags.has('inbox')) return inbox.listInbox()
    if (flag('accept'))
      return inbox.acceptCandidate(flag('accept')!, evals, { shared: flags.has('shared'), name: flag('name') })
    return inbox.dismissCandidate(flag('dismiss')!)
  }

  const selected = names.length ? evals.filter(({ evaluation }) => names.includes(evaluation.name)) : evals
  const unknown = names.filter((name) => !evals.some(({ evaluation }) => evaluation.name === name))
  if (unknown.length) throw new Error(`No eval named ${unknown.join(', ')}; see --list`)
  const providers = selectProviders(
    await resolveProviders(from),
    (flag('provider') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  )
  if (!providers.length) throw new Error(`No enabled decision providers from "${from}"`)
  console.log(
    `Providers: ${providers.map((provider) => `${provider.id} (${provider.kind} ${provider.model})`).join(', ')}\n`
  )

  const problems: string[] = []
  const all: unknown[] = []
  let spentNanodollars = 0
  const maxCost = flag('max-cost') ? Number(flag('max-cost')) : 1
  for (const { file, evaluation } of selected) {
    const results = await runEval(evaluation, providers, {
      repeat: Number(flag('repeat') ?? 1),
      variant: flag('variant'),
      maxCostDollars: Math.max(0, maxCost - spentNanodollars / 1e9),
    })
    spentNanodollars += results.reduce((sum, result) => sum + (result.costNanodollars ?? 0), 0)
    console.log(
      formatRun(evaluation, results, { snapshot: readSnapshot(file, evaluation.name), diff: flags.has('diff') })
    )
    if (flags.has('record')) console.log(`Recorded ${writeSnapshot(file, evaluation, results).slice(root.length + 1)}`)
    console.log('')
    problems.push(...failures(evaluation, summarize(results)).map((problem) => `${evaluation.name}: ${problem}`))
    if (flag('markdown')) appendFileSync(flag('markdown')!, formatMarkdown(evaluation, results) + '\n')
    all.push(...results)
  }
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(all, null, 2))
  console.log(`Spent $${(spentNanodollars / 1e9).toFixed(5)} (limit $${maxCost}).`)
  if (problems.length) {
    console.log(
      `\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`
    )
    return 1
  }
  return 0
}

try {
  process.exit(await main())
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
}
