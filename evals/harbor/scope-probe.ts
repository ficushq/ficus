/** Focused role-prompt diagnostic, not a coding benchmark or full orchestration run.
 * All inference goes through the existing capped proxy and its durable ledger.
 */
import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { configureHarborProvider } from '../../apps/core/src/scripts/harbor-provider'

type Decision = { ready: boolean; disposition: 'repair' | 'follow-up' | 'blocked' | 'investigate' }
type Case = { id: string; role: 'manager' | 'reviewer'; scenario: string; expected: Decision }
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const contract = `This is a decision-only checkpoint with the case evidence supplied below. Do not execute tools or claim to have performed new checks. Return one JSON object with ready (boolean: overall requested deliverable may finish now), disposition (one of repair, follow-up, blocked, investigate for the described outstanding issue), and reason (a brief explanation grounded in the evidence). Repair means authorized work should address the issue before delivery. Follow-up means it may be tracked separately without blocking this deliverable. Blocked means an authorization or delivery condition prevents completion. Investigate means the next action is to establish relevance or cause. No markdown fences.`

// Same own-prompt + ordered-includes composition as composeFromYaml. Read Git
// objects for the baseline, never reconstruct it by deleting selected sentences.
export async function snapshotPrompt(root: string, role: string, revision?: string): Promise<string> {
  const read = async (path: string) => {
    if (!revision) return readFile(resolve(root, path), 'utf8')
    const proc = Bun.spawnSync(['git', 'show', `${revision}:${path}`], { cwd: root })
    if (proc.exitCode !== 0) throw new Error(`Cannot read prompt at ${revision}: ${path}`)
    return proc.stdout.toString()
  }
  const own = yaml.load(await read(`config/agent-types/${role}.yaml`)) as {
    systemPrompt: string
    includes: string[]
  }
  return [
    own.systemPrompt,
    ...(await Promise.all(own.includes.map((id) => read(`config/agent-types/shared/${id}.md`)))),
  ].join('\n\n')
}

export function caseMessage(c: Pick<Case, 'role' | 'scenario'>): string {
  return `${contract}\n\nRole at this checkpoint: ${c.role}.\n\n${c.scenario}`
}

export function grade(text: string, expected: Decision): { pass: boolean; answer: unknown } {
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    return { pass: false, answer: null }
  }
  const a = answer as Record<string, unknown> | null
  return {
    pass:
      !!a &&
      a.ready === expected.ready &&
      a.disposition === expected.disposition &&
      typeof a.reason === 'string' &&
      a.reason.trim().length > 0,
    answer,
  }
}

async function main() {
  const [mode, rootArg, baseline, output, accessPath] = process.argv.slice(2)
  if (!['freeze', 'run'].includes(mode!) || !rootArg || !baseline || !output) {
    throw new Error('Usage: scope-probe.ts freeze|run ROOT BASELINE MANIFEST [ACCESS]')
  }
  const root = resolve(rootArg)
  const cases = JSON.parse(await readFile(resolve(root, 'evals/harbor/scope-cases.json'), 'utf8')) as Case[]
  const prompts: Record<string, string> = {}
  for (const role of ['manager', 'reviewer']) {
    prompts[`baseline-${role}`] = await snapshotPrompt(root, role, baseline)
    prompts[`candidate-${role}`] = await snapshotPrompt(root, role)
  }
  const manifest = {
    baseline,
    model: 'gpt-6.1-sol',
    thinking: 'medium',
    maxTokens: 2048,
    repeats: 2,
    scope:
      'Synthetic decision checkpoints with static role + includes; no tools, skills or dynamic runtime context. Not a held-out coding benchmark.',
    casesSha256: sha256(JSON.stringify(cases)),
    contractSha256: sha256(contract),
    promptSha256: Object.fromEntries(Object.entries(prompts).map(([key, value]) => [key, sha256(value)])),
    calls: [0, 1].flatMap((repeat) =>
      cases.flatMap((c, index) =>
        ((repeat + index) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map((variant) => ({
          caseId: c.id,
          role: c.role,
          variant,
          repeat,
        }))
      )
    ),
  }
  if (mode === 'freeze') {
    await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    console.log(`Frozen ${manifest.calls.length} calls; expected labels are never sent to the model.`)
    return
  }
  const frozen = JSON.parse(await readFile(output, 'utf8'))
  if (JSON.stringify(frozen) !== JSON.stringify(manifest)) throw new Error('Frozen inputs changed; refuse to run')
  if (!accessPath) throw new Error('A private budget-proxy access file is required')
  const resultsPath = `${output}.results.jsonl`
  await writeFile(resultsPath, '', { flag: 'wx' })
  const access = JSON.parse(await readFile(accessPath, 'utf8'))
  if (access.model !== manifest.model || !access.clients['scope-probes'])
    throw new Error('Wrong model or missing scoped client')
  const credentials = new InMemoryCredentialStore()
  await credentials.modify('openai', async () => ({ type: 'api_key', key: access.clients['scope-probes'] }))
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  configureHarborProvider(runtime, `http://127.0.0.1:${access.port}/v1`)
  const model = runtime.getModel('openai', manifest.model)!
  for (const call of manifest.calls) {
    const c = cases.find((c) => c.id === call.caseId)!
    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: prompts[`${call.variant}-${call.role}`],
        messages: [{ role: 'user', content: caseMessage(c), timestamp: Date.now() }],
      },
      { reasoning: 'medium', maxTokens: manifest.maxTokens }
    )
    const text = response.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()
    const result = { ...call, stopReason: response.stopReason, ...grade(text, c.expected), text, usage: response.usage }
    await appendFile(resultsPath, JSON.stringify(result) + '\n')
    console.log(
      `${call.caseId} ${call.variant} repeat=${call.repeat}: ${result.pass ? 'pass' : 'FAIL'} (${response.stopReason})`
    )
    if (response.stopReason !== 'stop') throw new Error('Incomplete/error response retained; stopped without retry')
  }
}
if (import.meta.main) await main()
